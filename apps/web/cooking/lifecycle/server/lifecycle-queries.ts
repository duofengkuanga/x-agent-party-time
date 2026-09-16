import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { sanitizeExecutionInteractionPayload } from '@agent-party-time/execution-contract';
import {
  CleanupInteractionViewSchema,
  LifecycleWorkspaceProjectionSchema,
  type CleanupInteractionView,
  type LifecycleWorkspaceProjection,
} from '../contract';
import type {
  BugSourceRow,
  CleanupAttemptRow,
  CleanupSourceRow,
} from './records';
import { cleanupStateLabel } from './results';

export class LifecycleQueries {
  constructor(private readonly db: AppDatabase) {}
  workspace(
    userId: string,
    submissionId: string,
  ): LifecycleWorkspaceProjection {
    requireSubmissionAccess(this.db, userId, submissionId);
    const bugIds = (
      this.db
        .prepare('SELECT id FROM cooking_bug WHERE submission_id = ?')
        .all(submissionId) as Array<{ id: string }>
    ).map(({ id }) => id);
    const verificationsByBug = Object.fromEntries(
      bugIds.map((bugId) => [bugId, this.verificationViews(bugId)]),
    );
    const reopensByBug = Object.fromEntries(
      bugIds.map((bugId) => [bugId, this.reopenViews(bugId)]),
    );
    const transitionsByBug = Object.fromEntries(
      bugIds.map((bugId) => [bugId, this.bugTransitionViews(bugId)]),
    );
    const cleanupIds = (
      this.db
        .prepare(
          `SELECT id FROM cooking_cleanup
           WHERE submission_id = ? ORDER BY created_at, id`,
        )
        .all(submissionId) as Array<{ id: string }>
    ).map(({ id }) => id);
    return LifecycleWorkspaceProjectionSchema.parse({
      verificationsByBug,
      reopensByBug,
      transitionsByBug,
      cleanups: cleanupIds.map((id) => this.cleanupView(userId, id)),
      cleanupInteractions: this.cleanupInteractions(userId, submissionId),
      timeline: this.timeline(submissionId),
    });
  }

  cleanupInteractions(
    userId: string,
    submissionId: string,
  ): CleanupInteractionView[] {
    requireSubmissionAccess(this.db, userId, submissionId);
    const rows = this.db
      .prepare(
        `SELECT interaction.*, cleanup.id cleanup_id,
                cleanup.submission_item_id, item.responsible_user_id
         FROM platform_execution_interaction interaction
         JOIN cooking_cleanup_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         JOIN cooking_cleanup cleanup ON cleanup.id = attempt.cleanup_id
         JOIN cooking_submission_item item
           ON item.id = cleanup.submission_item_id
         WHERE cleanup.submission_id = ? AND interaction.state = 'PENDING'
         ORDER BY interaction.created_at, interaction.id`,
      )
      .all(submissionId) as Array<{
      id: string;
      execution_id: string;
      cleanup_id: string;
      submission_item_id: string;
      responsible_user_id: string;
      kind: 'APPROVAL' | 'USER_INPUT';
      state: 'PENDING';
      method: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => {
      const responsible = row.responsible_user_id === userId;
      return CleanupInteractionViewSchema.parse({
        id: row.id,
        executionId: row.execution_id,
        cleanupId: row.cleanup_id,
        submissionItemId: row.submission_item_id,
        kind: row.kind,
        state: row.state,
        method: responsible ? row.method : null,
        payload: responsible
          ? sanitizeExecutionInteractionPayload(
              row.method,
              JSON.parse(row.payload_json),
            )
          : null,
        canResolve: responsible,
        createdAt: row.created_at,
      });
    });
  }

  cleanupScopeForItem(submissionItemId: string): string[] {
    const repairs = this.db
      .prepare(
        `SELECT context.workspace_key key
         FROM cooking_bug bug
         JOIN cooking_bug_repair_context context ON context.bug_id = bug.id
         WHERE bug.submission_item_id = ?`,
      )
      .all(submissionItemId) as Array<{ key: string }>;
    const updates = this.db
      .prepare(
        `SELECT 'update-batch:' || id key FROM cooking_update_batch
         WHERE submission_item_id = ?`,
      )
      .all(submissionItemId) as Array<{ key: string }>;
    return [...new Set([...repairs, ...updates].map(({ key }) => key))];
  }

  bugTransitionViews(bugId: string) {
    return (
      this.db
        .prepare(
          `SELECT id, kind, created_at FROM cooking_bug_lifecycle_event
           WHERE bug_id = ? ORDER BY created_at, rowid`,
        )
        .all(bugId) as Array<{
        id: string;
        kind: 'CANCELLED' | 'RESTORED';
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      bugId,
      kind: row.kind,
      createdAt: row.created_at,
    }));
  }

  verificationViews(bugId: string) {
    const records = this.db
      .prepare(
        `SELECT id, round, result, comment, repair_attempt, created_at
         FROM cooking_verification_record
         WHERE bug_id = ? ORDER BY round`,
      )
      .all(bugId) as Array<{
      id: string;
      round: number;
      result: 'PASSED' | 'FAILED';
      comment: string | null;
      repair_attempt: number | null;
      created_at: string;
    }>;
    return records.map((record) => ({
      id: record.id,
      bugId,
      round: record.round,
      result: record.result,
      comment: record.comment,
      repairAttempt: record.repair_attempt,
      attachments: this.lifecycleAttachments(
        'cooking_verification_attachment',
        'verification_id',
        record.id,
      ),
      createdAt: record.created_at,
    }));
  }

  reopenViews(bugId: string) {
    const records = this.db
      .prepare(
        `SELECT id, round, feedback, repair_attempt, created_at
         FROM cooking_reopen_record WHERE bug_id = ? ORDER BY round`,
      )
      .all(bugId) as Array<{
      id: string;
      round: number;
      feedback: string;
      repair_attempt: number;
      created_at: string;
    }>;
    return records.map((record) => ({
      id: record.id,
      bugId,
      round: record.round,
      feedback: record.feedback,
      repairAttempt: record.repair_attempt,
      attachments: this.lifecycleAttachments(
        'cooking_reopen_attachment',
        'reopen_id',
        record.id,
      ),
      createdAt: record.created_at,
    }));
  }

  lifecycleAttachments(
    table: 'cooking_verification_attachment' | 'cooking_reopen_attachment',
    ownerColumn: 'verification_id' | 'reopen_id',
    ownerId: string,
  ) {
    return (
      this.db
        .prepare(
          `SELECT file.id, file.original_name, file.media_type,
                  file.size_bytes, file.created_at
           FROM ${table} attachment
           JOIN platform_file file ON file.id = attachment.file_id
           WHERE attachment.${ownerColumn} = ? ORDER BY attachment.position`,
        )
        .all(ownerId) as Array<{
        id: string;
        original_name: string;
        media_type: string;
        size_bytes: number;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      originalName: row.original_name,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    }));
  }

  cleanupView(userId: string, cleanupId: string) {
    const cleanup = this.cleanupSource(cleanupId);
    const technical = cleanup.responsible_user_id === userId;
    return {
      id: cleanup.id,
      submissionId: cleanup.submission_id,
      submissionItemId: cleanup.submission_item_id,
      reason: cleanup.reason,
      subjectId: cleanup.subject_id,
      state: cleanup.state,
      version: cleanup.version,
      attempts: technical
        ? this.cleanupAttempts(cleanupId).map((attempt) => {
            const outcome = attempt.outcome_json
              ? (JSON.parse(attempt.outcome_json) as {
                  outcome?: string;
                  summary?: string;
                  technicalFailure?: string;
                })
              : null;
            return {
              id: attempt.id,
              attempt: attempt.attempt,
              executionState: attempt.state,
              summary: outcome?.summary ?? null,
              technicalFailure: outcome?.technicalFailure ?? null,
              createdAt: attempt.created_at,
              finishedAt: attempt.finished_at,
            };
          })
        : [],
      availableActions:
        technical && cleanup.state === 'FAILED' ? ['RETRY_CLEANUP'] : [],
      presentation: { statusLabel: cleanupStateLabel(cleanup.state) },
      createdAt: cleanup.created_at,
    };
  }

  timeline(submissionId: string) {
    const entries: Array<{
      id: string;
      kind:
        | 'VERIFICATION'
        | 'REOPEN'
        | 'REPAIR'
        | 'UPDATE'
        | 'EXTERNAL_DEPLOYMENT'
        | 'CLEANUP'
        | 'SUBMISSION';
      bugId: string | null;
      title: string;
      summary: string;
      createdAt: string;
    }> = [];
    const verifications = this.db
      .prepare(
        `SELECT verification.id, verification.bug_id, verification.round,
                verification.result, verification.comment,
                verification.created_at, bug.short_id
         FROM cooking_verification_record verification
         JOIN cooking_bug bug ON bug.id = verification.bug_id
         WHERE bug.submission_id = ?`,
      )
      .all(submissionId) as Array<{
      id: string;
      bug_id: string;
      round: number;
      result: 'PASSED' | 'FAILED';
      comment: string | null;
      repair_attempt: number | null;
      created_at: string;
      short_id: number;
    }>;
    for (const row of verifications)
      entries.push({
        id: `verification:${row.id}`,
        kind: 'VERIFICATION',
        bugId: row.bug_id,
        title: `缺陷-${String(row.short_id).padStart(3, '0')} 第 ${row.round} 轮验证`,
        summary:
          row.result === 'PASSED'
            ? row.comment || '测试负责人已确认验证通过。'
            : `${row.comment || '验证未通过'}；已进入第 ${row.repair_attempt} 轮修复。`,
        createdAt: row.created_at,
      });
    const reopens = this.db
      .prepare(
        `SELECT reopen.id, reopen.bug_id, reopen.round, reopen.feedback,
                reopen.repair_attempt, reopen.created_at, bug.short_id
         FROM cooking_reopen_record reopen
         JOIN cooking_bug bug ON bug.id = reopen.bug_id
         WHERE bug.submission_id = ?`,
      )
      .all(submissionId) as Array<{
      id: string;
      bug_id: string;
      round: number;
      feedback: string;
      repair_attempt: number;
      created_at: string;
      short_id: number;
    }>;
    for (const row of reopens)
      entries.push({
        id: `reopen:${row.id}`,
        kind: 'REOPEN',
        bugId: row.bug_id,
        title: `缺陷-${String(row.short_id).padStart(3, '0')} 第 ${row.round} 次重新打开`,
        summary: `${row.feedback}；已进入第 ${row.repair_attempt} 轮修复。`,
        createdAt: row.created_at,
      });
    const reports = this.db
      .prepare(
        `SELECT report.id, report.round, report.outcome, report.created_at,
                batch.id batch_id
         FROM cooking_external_deployment_report report
         JOIN cooking_update_batch batch ON batch.id = report.batch_id
         WHERE batch.submission_id = ?`,
      )
      .all(submissionId) as Array<{
      id: string;
      round: number;
      outcome: 'SUCCEEDED' | 'FAILED';
      created_at: string;
      batch_id: string;
    }>;
    for (const row of reports)
      entries.push({
        id: `external:${row.id}`,
        kind: 'EXTERNAL_DEPLOYMENT',
        bugId: null,
        title: `第 ${row.round} 轮外部部署结果`,
        summary:
          row.outcome === 'SUCCEEDED'
            ? '工程负责人已确认外部部署成功。'
            : '外部部署失败，等待工程负责人继续原批次。',
        createdAt: row.created_at,
      });
    const cleanups = this.db
      .prepare(
        `SELECT id, reason, state, created_at FROM cooking_cleanup
         WHERE submission_id = ?`,
      )
      .all(submissionId) as Array<{
      id: string;
      reason: 'SUBMISSION_CLOSED';
      state: 'READY' | 'RUNNING' | 'FAILED' | 'COMPLETED';
      created_at: string;
    }>;
    for (const row of cleanups)
      entries.push({
        id: `cleanup:${row.id}`,
        kind: 'CLEANUP',
        bugId: null,
        title: '关闭后资源清理',
        summary: cleanupStateLabel(row.state),
        createdAt: row.created_at,
      });
    const submission = this.db
      .prepare(
        `SELECT status, closed_at FROM cooking_test_submission WHERE id = ?`,
      )
      .get(submissionId) as {
      status: 'ACTIVE' | 'CLOSED';
      closed_at: string | null;
    };
    if (submission.status === 'CLOSED' && submission.closed_at)
      entries.push({
        id: `submission:${submissionId}:closed`,
        kind: 'SUBMISSION',
        bugId: null,
        title: '提测单已关闭',
        summary: '全部缺陷已终结，本提测单持有的环境使用权已释放。',
        createdAt: submission.closed_at,
      });
    return entries.sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }

  bugSource(bugId: string): BugSourceRow {
    const row = this.db
      .prepare(
        `SELECT bug.id, bug.submission_id, bug.submission_item_id, bug.stage,
                bug.version, bug.short_id, bug.title, submission.project_id,
                submission.status submission_status,
                submission.title submission_title,
                submission.tester_user_id, item.responsible_user_id,
                item.binding_id, binding.runner_id, item.engineering_name,
                item.target_branch, bug.archived_at,
                bug.archived_by_user_id
         FROM cooking_bug bug
         JOIN cooking_test_submission submission ON submission.id = bug.submission_id
         LEFT JOIN cooking_submission_item item ON item.id = bug.submission_item_id
         LEFT JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         WHERE bug.id = ?`,
      )
      .get(bugId) as BugSourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '缺陷不存在');
    return row;
  }

  itemCleanupSource(submissionItemId: string) {
    const row = this.db
      .prepare(
        `SELECT item.binding_id, binding.runner_id, item.engineering_name,
                item.target_branch, submission.title submission_title
         FROM cooking_submission_item item
         JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         JOIN cooking_test_submission submission ON submission.id = item.submission_id
         WHERE item.id = ?`,
      )
      .get(submissionItemId) as
      | {
          binding_id: string;
          runner_id: string;
          engineering_name: string;
          target_branch: string;
          submission_title: string;
        }
      | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '提测项不存在');
    return row;
  }

  cleanupSource(cleanupId: string): CleanupSourceRow {
    const row = this.db
      .prepare(
        `SELECT cleanup.*, item.responsible_user_id, item.binding_id,
                binding.runner_id, item.engineering_name, item.target_branch,
                submission.title submission_title, submission.project_id
         FROM cooking_cleanup cleanup
         JOIN cooking_submission_item item ON item.id = cleanup.submission_item_id
         JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         JOIN cooking_test_submission submission ON submission.id = cleanup.submission_id
         WHERE cleanup.id = ?`,
      )
      .get(cleanupId) as CleanupSourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '清理任务不存在');
    return row;
  }

  cleanupAttempts(cleanupId: string): CleanupAttemptRow[] {
    return this.db
      .prepare(
        `SELECT attempt.*, execution.state, execution.session_id
         FROM cooking_cleanup_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.cleanup_id = ? ORDER BY attempt.attempt`,
      )
      .all(cleanupId) as CleanupAttemptRow[];
  }

  latestCleanupAttempt(cleanupId: string): CleanupAttemptRow | undefined {
    return this.cleanupAttempts(cleanupId).at(-1);
  }

  cleanupInteractionSource(interactionId: string): {
    cleanup_id: string;
    execution_id: string;
  } {
    const row = this.db
      .prepare(
        `SELECT attempt.cleanup_id, interaction.execution_id
         FROM platform_execution_interaction interaction
         JOIN cooking_cleanup_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         WHERE interaction.id = ?`,
      )
      .get(interactionId) as
      { cleanup_id: string; execution_id: string } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '清理操作请求不存在');
    return row;
  }

  cleanupAttemptForExecution(
    executionId: string,
  ): CleanupAttemptRow | undefined {
    return this.db
      .prepare(
        `SELECT attempt.*, execution.state, execution.session_id
         FROM cooking_cleanup_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.execution_id = ?`,
      )
      .get(executionId) as CleanupAttemptRow | undefined;
  }
}
