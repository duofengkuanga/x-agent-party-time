import { DeploymentMethodSchema } from '@/cooking/engineering/contract';
import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import {
  projectCookingInteraction,
  type CookingInteractionRow,
} from '@/cooking/shared/server/interaction-projection';
import { environmentOwned } from '@/cooking/submissions/server/environment-access';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ExecutionService } from '@/platform/execution/service';
import {
  UpdateBatchViewSchema,
  UpdateWorkspaceProjectionSchema,
  type UpdateBatchView,
  type UpdateWorkspaceProjection,
} from '../contract';
import type {
  AttemptRow,
  BatchRow,
  CandidateRow,
  ExternalReportAttachmentRow,
  ExternalReportRow,
  ItemSourceRow,
} from './records';
import {
  batchStateLabel,
  isTerminal,
  parseCommits,
  parseManualOperations,
  projectUpdateAttemptResult,
  updateVisual,
} from './results';
export class UpdateQueries {
  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService,
  ) {}
  workspace(userId: string, submissionId: string): UpdateWorkspaceProjection {
    requireSubmissionAccess(this.db, userId, submissionId);
    const pendingDeliveries = this.db
      .all<{
        submission_item_id: string;
        last_candidate_at: string;
        eligible_at: string;
        responsible_user_id: string;
        deployment_kind: string;
      }>(
        `SELECT pending.*, item.responsible_user_id,
                  json_extract(item.deployment_json, '$.kind') deployment_kind
           FROM cooking_pending_delivery pending
           JOIN cooking_submission_item item
             ON item.id = pending.submission_item_id
           WHERE item.submission_id = ?
           ORDER BY item.position`,
        submissionId,
      )
      .map((row) => ({
        submissionItemId: row.submission_item_id,
        lastCandidateAt: row.last_candidate_at,
        eligibleAt: row.eligible_at,
        availableActions:
          row.responsible_user_id === userId &&
          environmentOwned(this.db, row.submission_item_id)
            ? (['FREEZE_NOW'] as const)
            : [],
      }));
    const batchIds = this.db
      .all<{ id: string }>(
        `SELECT id FROM cooking_update_batch
           WHERE submission_id = ?
             AND EXISTS (
               SELECT 1 FROM cooking_update_batch_entry entry
               WHERE entry.batch_id = cooking_update_batch.id
             )
           ORDER BY created_at, id`,
        submissionId,
      )
      .map(({ id }) => id);
    return UpdateWorkspaceProjectionSchema.parse({
      pendingDeliveries,
      updateBatches: batchIds.map((id) => this.batchView(userId, id)),
    });
  }

  batchView(userId: string, batchId: string): UpdateBatchView {
    const batch = this.batch(batchId);
    const source = this.itemSource(batch.submission_item_id);
    requireSubmissionAccess(this.db, userId, batch.submission_id);
    const technical = source.responsible_user_id === userId;
    const attempts = this.attempts(batchId);
    const latest = attempts.at(-1);
    const entries = this.batchEntries(batchId);
    const active = batch.active_execution_id
      ? this.executions.get(batch.active_execution_id)
      : null;
    const deployment = DeploymentMethodSchema.parse(
      JSON.parse(batch.deployment_json),
    );
    const hasManualDatabaseOperation = entries.some((entry) =>
      parseManualOperations(entry.manual_operations_json).some(
        (operation) => operation.kind === 'DATABASE_SQL',
      ),
    );
    const projectedInteractions = this.interactionsForBatch(batchId).map(
      (row) => ({
        executionId: row.execution_id,
        interaction: projectCookingInteraction(row, technical),
      }),
    );
    const interactions = projectedInteractions.map(
      ({ interaction }) => interaction,
    );
    const statusLabel = batchStateLabel(batch.state);
    const timeline = [
      {
        id: `formed:${batch.id}`,
        kind: 'BATCH_FORMED' as const,
        occurredAt: batch.frozen_at,
        bugCount: entries.length,
      },
      ...[
        ...attempts.map((attempt) => ({
          id: attempt.id,
          kind: 'UPDATE_ATTEMPT' as const,
          executionId: attempt.execution_id,
          sessionId: technical ? attempt.session_id : null,
          attempt: attempt.attempt,
          executionState: attempt.state,
          queuedAt: attempt.created_at,
          finishedAt: attempt.finished_at,
          interactions: projectedInteractions
            .filter(({ executionId }) => executionId === attempt.execution_id)
            .map(({ interaction }) => interaction),
          result: attempt.outcome_json
            ? projectUpdateAttemptResult(attempt.outcome_json, technical)
            : null,
          sortAt: attempt.created_at,
        })),
        ...this.externalReports(batchId).map((report) => ({
          id: report.id,
          kind: 'EXTERNAL_REPORT' as const,
          round: report.round,
          outcome: report.outcome,
          summary: report.summary,
          attachments: technical
            ? this.externalReportAttachments(report.id).map((attachment) => ({
                id: attachment.id,
                originalName: attachment.original_name,
                mediaType: attachment.media_type,
                sizeBytes: attachment.size_bytes,
                createdAt: attachment.created_at,
              }))
            : [],
          occurredAt: report.created_at,
          sortAt: report.created_at,
        })),
      ]
        .sort((left, right) => left.sortAt.localeCompare(right.sortAt))
        .map(({ sortAt: _sortAt, ...node }) => node),
    ];
    return UpdateBatchViewSchema.parse({
      id: batch.id,
      submissionId: batch.submission_id,
      submissionItemId: batch.submission_item_id,
      state: batch.state,
      version: batch.version,
      activeExecutionId: technical ? batch.active_execution_id : null,
      frozenAt: batch.frozen_at,
      engineeringName: source.engineering_name,
      targetBranch: source.target_branch,
      environmentName: source.environment_name,
      deploymentKind: deployment.kind,
      hasManualDatabaseOperation,
      synchronizationError: technical
        ? this.sessionSynchronizationError(batch.id)
        : null,
      entries: entries.map((entry) => ({
        bugId: entry.bug_id,
        bugShortId: entry.short_id,
        bugTitle: entry.title,
        commits: technical ? parseCommits(entry.commits_json) : null,
      })),
      timeline,
      availableActions:
        technical && environmentOwned(this.db, batch.submission_item_id)
          ? [
              ...(batch.state === 'FAILED' &&
              latest &&
              isTerminal(latest.state) &&
              batch.session_id &&
              !this.hasActiveSessionSync(batch.id)
                ? (['SYNC_SESSION'] as const)
                : []),
              ...(batch.state === 'WAITING_EXTERNAL' &&
              deployment.kind === 'CI_CD'
                ? (['REPORT_EXTERNAL'] as const)
                : []),
            ]
          : [],
      presentation: {
        statusLabel,
        visual: updateVisual(
          batch,
          latest,
          interactions,
          technical,
          statusLabel,
          latest ? this.executions.queueStatus(latest.execution_id) : undefined,
        ),
      },
    });
  }

  interactionsForBatch(batchId: string): CookingInteractionRow[] {
    return this.db.all<CookingInteractionRow>(
      `SELECT interaction.*
         FROM platform_execution_interaction interaction
         JOIN cooking_update_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         WHERE attempt.batch_id = ?
           AND interaction.state IN ('PENDING', 'RESOLVED')
         ORDER BY interaction.created_at, interaction.id`,
      batchId,
    );
  }

  requireExternalAttachmentAccess(userId: string, fileId: string): void {
    const row = this.db.get(
      `SELECT batch.submission_id, item.responsible_user_id
         FROM cooking_external_deployment_report_attachment attachment
         JOIN cooking_external_deployment_report report
           ON report.id = attachment.report_id
         JOIN cooking_update_batch batch ON batch.id = report.batch_id
         JOIN cooking_submission_item item ON item.id = batch.submission_item_id
         WHERE attachment.file_id = ?`,
      fileId,
    ) as { submission_id: string; responsible_user_id: string } | undefined;
    if (!row || row.responsible_user_id !== userId)
      throw new PlatformError('NOT_FOUND', '附件不存在或无权访问');
    try {
      requireSubmissionAccess(this.db, userId, row.submission_id);
    } catch {
      throw new PlatformError('NOT_FOUND', '附件不存在或无权访问');
    }
  }

  nextExternalReportRound(batchId: string): number {
    const row = this.db.get(
      `SELECT COALESCE(MAX(round), 0) + 1 round
         FROM cooking_external_deployment_report WHERE batch_id = ?`,
      batchId,
    ) as { round: number };
    return row.round;
  }

  externalReports(batchId: string): ExternalReportRow[] {
    return this.db.all<ExternalReportRow>(
      `SELECT * FROM cooking_external_deployment_report
         WHERE batch_id = ? ORDER BY round, created_at, id`,
      batchId,
    );
  }

  latestUnconsumedFailedReport(batchId: string): ExternalReportRow | undefined {
    return this.db.get(
      `SELECT report.*
         FROM cooking_external_deployment_report report
         LEFT JOIN cooking_update_attempt attempt
           ON attempt.continuation_report_id = report.id
         WHERE report.batch_id = ? AND report.outcome = 'FAILED'
           AND attempt.id IS NULL
         ORDER BY report.round DESC LIMIT 1`,
      batchId,
    ) as ExternalReportRow | undefined;
  }

  externalReportAttachmentIds(reportId: string): string[] {
    return this.db
      .all<{ file_id: string }>(
        `SELECT file_id
           FROM cooking_external_deployment_report_attachment
           WHERE report_id = ? ORDER BY position`,
        reportId,
      )
      .map(({ file_id }) => file_id);
  }

  externalReportAttachments(reportId: string): ExternalReportAttachmentRow[] {
    return this.db.all<ExternalReportAttachmentRow>(
      `SELECT file.id, file.original_name, file.media_type,
                file.size_bytes, file.created_at
         FROM cooking_external_deployment_report_attachment attachment
         JOIN platform_file file ON file.id = attachment.file_id
         WHERE attachment.report_id = ? ORDER BY attachment.position`,
      reportId,
    );
  }

  candidates(submissionItemId: string): CandidateRow[] {
    return this.db.all<CandidateRow>(
      `SELECT bug.id bug_id, bug.short_id, bug.title,
                context.pending_commits_json,
                context.pending_manual_operations_json,
                context.last_candidate_at
         FROM cooking_bug bug
         JOIN cooking_bug_repair_context context ON context.bug_id = bug.id
         WHERE bug.submission_item_id = ?
           AND bug.stage = 'WAITING_FOR_UPDATE'
           AND context.last_candidate_at IS NOT NULL
           AND context.pending_commits_json <> '[]'
         ORDER BY bug.short_id, bug.id`,
      submissionItemId,
    );
  }

  batchEntries(batchId: string): Array<{
    bug_id: string;
    short_id: number;
    title: string;
    commits_json: string;
    manual_operations_json: string;
  }> {
    return this.db.all<{
      bug_id: string;
      short_id: number;
      title: string;
      commits_json: string;
      manual_operations_json: string;
    }>(
      `SELECT entry.bug_id, bug.short_id, bug.title, entry.commits_json,
                entry.manual_operations_json
         FROM cooking_update_batch_entry entry
         JOIN cooking_bug bug ON bug.id = entry.bug_id
         WHERE entry.batch_id = ? ORDER BY entry.position`,
      batchId,
    );
  }

  itemSource(submissionItemId: string): ItemSourceRow {
    const row = this.db.get(
      `SELECT submission.id submission_id, item.id submission_item_id,
                submission.project_id, submission.status submission_status,
                submission.title submission_title,
                item.engineering_name, item.repository_url, item.target_branch,
                item.environment_name, item.deployment_json,
                item.responsible_user_id, item.binding_id, binding.runner_id
         FROM cooking_submission_item item
         JOIN cooking_test_submission submission ON submission.id = item.submission_id
         JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         WHERE item.id = ?`,
      submissionItemId,
    ) as ItemSourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Submission Item 不存在');
    return row;
  }

  batch(batchId: string): BatchRow {
    const row = this.db.get(
      'SELECT * FROM cooking_update_batch WHERE id = ?',
      batchId,
    ) as BatchRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '更新批次不存在');
    return row;
  }

  activeBatch(submissionItemId: string): BatchRow | undefined {
    return this.db.get(
      `SELECT * FROM cooking_update_batch
         WHERE submission_item_id = ?
           AND state IN ('READY', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED')`,
      submissionItemId,
    ) as BatchRow | undefined;
  }

  attempts(batchId: string): AttemptRow[] {
    return this.db.all<AttemptRow>(
      `SELECT attempt.*, execution.state, execution.session_id
         FROM cooking_update_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.batch_id = ? ORDER BY attempt.attempt`,
      batchId,
    );
  }

  latestAttempt(batchId: string): AttemptRow | undefined {
    return this.attempts(batchId).at(-1);
  }

  hasActiveSessionSync(batchId: string): boolean {
    return Boolean(
      this.db.get(
        `SELECT 1 FROM cooking_update_session_sync sync
           JOIN platform_execution execution ON execution.id = sync.execution_id
           WHERE sync.batch_id = ? AND execution.state IN ('QUEUED', 'CLAIMED', 'RUNNING')
           LIMIT 1`,
        batchId,
      ),
    );
  }

  sessionSynchronizationError(batchId: string): string | null {
    const row = this.db.get(
      `SELECT execution.outcome_json
         FROM cooking_update_session_sync sync
         JOIN platform_execution execution ON execution.id = sync.execution_id
         WHERE sync.batch_id = ? AND execution.state = 'FAILED'
         ORDER BY sync.created_at DESC LIMIT 1`,
      batchId,
    ) as { outcome_json: string | null } | undefined;
    const failure = row?.outcome_json
      ? (JSON.parse(row.outcome_json) as { failure?: { message?: unknown } })
      : null;
    return typeof failure?.failure?.message === 'string'
      ? failure.failure.message
      : null;
  }

  attemptForExecution(executionId: string): AttemptRow | undefined {
    return this.db.get(
      `SELECT attempt.*, execution.state, execution.session_id
         FROM cooking_update_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.execution_id = ?`,
      executionId,
    ) as AttemptRow | undefined;
  }

  interactionSource(interactionId: string): {
    batch_id: string;
    execution_id: string;
  } {
    const row = this.db.get(
      `SELECT attempt.batch_id, interaction.execution_id
         FROM platform_execution_interaction interaction
         JOIN cooking_update_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         WHERE interaction.id = ?`,
      interactionId,
    ) as { batch_id: string; execution_id: string } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '更新操作请求不存在');
    return row;
  }
}
