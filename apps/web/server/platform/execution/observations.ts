import {
  ObservationBatchSchema,
  ObservationReportSchema,
  OBSERVATION_LIMITS,
  observationCanonicalJson,
  observationDigest,
  type ObservationBatch,
  type ObservationReceipt,
  type ObservationReport,
} from '@agent-party-time/execution-contract/observability';
import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import { createHash } from 'node:crypto';

export type ObservationAccess = (
  userId: string,
  executionId: string,
  mode: 'read' | 'upload',
) => void;
type ReportRow = {
  report_id: string;
  revision: number;
  parent_report_id: string | null;
  content_json: string;
  detail_json: string | null;
  content_digest: string;
  detail_until: string;
  accepted_at: string;
};

export class ExecutionObservations {
  constructor(
    private readonly db: AppDatabase,
    private readonly access: ObservationAccess,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async accept(runnerId: string, input: ObservationBatch): Promise<ObservationReceipt> {
    const batch = ObservationBatchSchema.parse(input);
    const { digest, ...payload } = batch;
    if (
      new TextEncoder().encode(JSON.stringify(batch)).byteLength >
      OBSERVATION_LIMITS.batchBytes
    )
      throw new PlatformError('FILE_TOO_LARGE', '耗时记录批次超过预算');
    if ((await observationDigest(payload)) !== digest)
      throw new PlatformError('VALIDATION_FAILED', '耗时记录摘要不一致');
    return this.db.transaction(() => {
      const owner = this.db.get<{ owner_user_id: string }>(
        `SELECT runner.owner_user_id FROM platform_execution execution
         JOIN platform_runner runner ON runner.id=execution.runner_id
         WHERE execution.id=? AND runner.id=? AND runner.revoked_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM platform_observation_tombstone WHERE execution_id=execution.id)`,
        batch.executionId,
        runnerId,
      );
      if (!owner) throw new PlatformError('NOT_FOUND', '执行不存在或不可补报');
      this.access(owner.owner_user_id, batch.executionId, 'upload');
      const previous = this.db.get<{ digest: string }>(
        'SELECT digest FROM platform_observation_batch WHERE execution_id=? AND batch_id=?',
        batch.executionId,
        batch.batchId,
      );
      if (previous) {
        if (previous.digest !== digest)
          throw new PlatformError('RESOURCE_CONFLICT', '耗时记录批次内容冲突');
        return {
          batchId: batch.batchId,
          digest,
          accepted: true as const,
          duplicate: true,
        };
      }
      const now = this.now().toISOString();
      this.prune();
      for (const event of batch.events) {
        const json = observationCanonicalJson(event);
        if (new TextEncoder().encode(json).byteLength > OBSERVATION_LIMITS.eventBytes)
          throw new PlatformError('FILE_TOO_LARGE', '耗时事件超过预算');
        const existing = this.db.get<{ content_json: string }>(
          'SELECT content_json FROM platform_observation_event WHERE execution_id=? AND event_id=?',
          batch.executionId,
          event.eventId,
        );
        if (existing) {
          if (existing.content_json !== json)
            throw new PlatformError('RESOURCE_CONFLICT', '耗时事件身份冲突');
          continue;
        }
        const sequence = this.db.get(
          'SELECT 1 FROM platform_observation_event WHERE execution_id=? AND segment_id=? AND sequence=?',
          batch.executionId,
          event.segmentId,
          event.sequence,
        );
        if (sequence)
          throw new PlatformError('RESOURCE_CONFLICT', '耗时事件顺序身份冲突');
        this.db.run('INSERT INTO platform_observation_event VALUES(?,?,?,?,?,?)', [
          batch.executionId,
          event.eventId,
          event.segmentId,
          event.sequence,
          json,
          now,
        ]);
      }
      if (batch.report) this.saveReport(batch.report, now);
      this.advanceHead(batch.executionId);
      const bytes = this.db.get<{ size: number }>(
        `SELECT COALESCE((SELECT SUM(length(CAST(content_json AS BLOB))) FROM platform_observation_event WHERE execution_id=?),0)
          + COALESCE((SELECT SUM(COALESCE(length(CAST(detail_json AS BLOB)),0)) FROM platform_observation_report WHERE execution_id=?),0) size`,
        batch.executionId,
        batch.executionId,
      )!.size;
      if (
        bytes > OBSERVATION_LIMITS.executionBytes &&
        (batch.events.length > 0 ||
          (batch.report &&
            batch.report.intervals.length +
              batch.report.unplaced.length +
              batch.report.incompleteActivities.length >
              0))
      )
        throw new PlatformError('FILE_TOO_LARGE', '该执行的归因明细已达容量上限');
      const stateBytes = this.db.get<{ size: number }>(
        `SELECT
        COALESCE((SELECT SUM(length(CAST(content_json AS BLOB))) FROM platform_observation_report WHERE execution_id=?),0)
        + COALESCE((SELECT SUM(length(batch_id)+length(digest)+length(accepted_at)+length(execution_id)) FROM platform_observation_batch WHERE execution_id=?),0) size`,
        batch.executionId,
        batch.executionId,
      )!.size;
      if (stateBytes + 256 > 1024 * 1024)
        throw new PlatformError('FILE_TOO_LARGE', '该执行的归因状态已达容量上限');
      this.db.run('INSERT INTO platform_observation_batch VALUES(?,?,?,?)', [
        batch.executionId,
        batch.batchId,
        digest,
        now,
      ]);
      this.advanceHead(batch.executionId);
      this.prune();
      return {
        batchId: batch.batchId,
        digest,
        accepted: true as const,
        duplicate: false,
      };
    })();
  }

  private saveReport(report: ObservationReport, now: string): void {
    const json = observationCanonicalJson(report);
    if (new TextEncoder().encode(json).byteLength > OBSERVATION_LIMITS.summaryBytes)
      throw new PlatformError('FILE_TOO_LARGE', '归因摘要超过预算');
    const digest = createHash('sha256').update(json).digest('hex');
    const previous = this.db.get<{ content_digest: string }>(
      'SELECT content_digest FROM platform_observation_report WHERE execution_id=? AND (revision=? OR report_id=?)',
      report.executionId,
      report.revision,
      report.reportId,
    );
    if (previous) {
      if (previous.content_digest !== digest)
        throw new PlatformError('RESOURCE_CONFLICT', '归因摘要版本冲突');
      return;
    }
    if (report.revision === 1 && report.parentReportId !== null)
      throw new PlatformError('VALIDATION_FAILED', '归因首版本关联无效');
    if (report.revision > 1 && report.parentReportId === null)
      throw new PlatformError('VALIDATION_FAILED', '归因后续版本缺少来源');
    const staged = this.db.get<{ count: number }>(
      `SELECT COUNT(*) count FROM platform_observation_report WHERE execution_id=? AND revision > COALESCE((SELECT revision FROM platform_observation_head WHERE execution_id=?),0)`,
      report.executionId,
      report.executionId,
    )!.count;
    if (staged >= 10)
      throw new PlatformError('FILE_TOO_LARGE', '未关联的归因版本超过预算');
    const detail = observationCanonicalJson({
      intervals: report.intervals,
      unplaced: report.unplaced,
      incompleteActivities: report.incompleteActivities,
    });
    const summary = observationCanonicalJson({
      ...report,
      intervals: [],
      unplaced: [],
      incompleteActivities: [],
    });
    this.db.run('INSERT INTO platform_observation_report VALUES(?,?,?,?,?,?,?,?,?)', [
      report.executionId,
      report.reportId,
      report.revision,
      report.parentReportId,
      summary,
      detail,
      digest,
      new Date(
        Date.parse(now) + OBSERVATION_LIMITS.detailDays * 86_400_000,
      ).toISOString(),
      now,
    ]);
  }

  private advanceHead(executionId: string): void {
    let head = this.db.get<{ report_id: string; revision: number }>(
      'SELECT report_id,revision FROM platform_observation_head WHERE execution_id=?',
      executionId,
    );
    for (;;) {
      const next = this.db.get<ReportRow>(
        'SELECT * FROM platform_observation_report WHERE execution_id=? AND revision=?',
        executionId,
        (head?.revision ?? 0) + 1,
      );
      if (!next || next.parent_report_id !== (head?.report_id ?? null)) break;
      this.db.run(
        `INSERT INTO platform_observation_head VALUES(?,?,?)
        ON CONFLICT(execution_id) DO UPDATE SET report_id=excluded.report_id,revision=excluded.revision`,
        [executionId, next.report_id, next.revision],
      );
      head = next;
    }
    if (head)
      this.db.run(
        'DELETE FROM platform_observation_report WHERE execution_id=? AND revision < ?',
        [executionId, Math.max(1, head.revision - 9)],
      );
  }

  metadata(userId: string, executionId: string) {
    this.access(userId, executionId, 'read');
    this.prune();
    const row = this.current(executionId);
    return {
      reportId: row?.report_id ?? null,
      revision: row?.revision ?? null,
      detailAvailable: !!row?.detail_json && row.detail_until > this.now().toISOString(),
      available: row !== null,
      receivedAt: row?.accepted_at ?? null,
    };
  }

  read(
    userId: string,
    executionId: string,
    reportId?: string,
  ): {
    report: ObservationReport;
    detailAvailable: boolean;
    storedEventCount: number;
  } | null {
    this.access(userId, executionId, 'read');
    this.prune();
    const row = reportId
      ? this.db.get<ReportRow>(
          'SELECT * FROM platform_observation_report WHERE execution_id=? AND report_id=?',
          executionId,
          reportId,
        )
      : this.current(executionId);
    if (
      !row ||
      Date.parse(row.accepted_at) <
        this.now().getTime() - OBSERVATION_LIMITS.summaryDays * 86_400_000
    )
      return null;
    const detailAvailable =
      row.detail_json !== null && row.detail_until > this.now().toISOString();
    const report = ObservationReportSchema.parse({
      ...JSON.parse(row.content_json),
      ...(detailAvailable ? JSON.parse(row.detail_json!) : {}),
    });
    const storedEventCount = this.db.get<{ count: number }>(
      'SELECT COUNT(*) count FROM platform_observation_event WHERE execution_id=?',
      executionId,
    )!.count;
    return { report, detailAvailable, storedEventCount };
  }

  private current(executionId: string): ReportRow | null {
    return this.db.get<ReportRow>(
      `SELECT report.* FROM platform_observation_head head
      JOIN platform_observation_report report ON report.report_id=head.report_id
      WHERE head.execution_id=? AND report.accepted_at>=?`,
      executionId,
      new Date(
        this.now().getTime() - OBSERVATION_LIMITS.summaryDays * 86_400_000,
      ).toISOString(),
    );
  }

  prune(): void {
    const now = this.now().getTime();
    this.db.run('DELETE FROM platform_observation_event WHERE accepted_at < ?', [
      new Date(now - OBSERVATION_LIMITS.detailDays * 86_400_000).toISOString(),
    ]);
    this.db.run(
      'UPDATE platform_observation_report SET detail_json=NULL WHERE detail_until < ?',
      [this.now().toISOString()],
    );
    for (const table of ['platform_observation_report', 'platform_observation_batch'])
      this.db.run(`DELETE FROM ${table} WHERE accepted_at < ?`, [
        new Date(now - OBSERVATION_LIMITS.summaryDays * 86_400_000).toISOString(),
      ]);
    this.db.run(
      'DELETE FROM platform_observation_head WHERE NOT EXISTS(SELECT 1 FROM platform_observation_report WHERE report_id=platform_observation_head.report_id)',
    );
  }
}
