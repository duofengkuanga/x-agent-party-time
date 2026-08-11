import { randomUUID } from 'node:crypto';
import type { Execution } from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import { ExecutionService } from '@/server/execution/service';
import { DeploymentMethodSchema } from '@/features/cooking/engineering/contract';
import type {
  CookingInteractionView,
  CookingVisualPresentation,
} from '@/features/cooking/shared/contract';
import {
  projectCookingInteraction,
  type CookingInteractionRow,
} from '@/features/cooking/shared/interaction-projection';
import { CookingWriteStore } from '@/features/cooking/shared/write-store';
import {
  CiCdUpdateExecutionResultSchema,
  RetryUpdateInputSchema,
  ExternalDeploymentReportInputSchema,
  FreezeUpdateInputSchema,
  LocalScriptUpdateExecutionResultSchema,
  ResolveUpdateInteractionInputSchema,
  UpdateBatchCommandInputSchema,
  UpdateBatchViewSchema,
  UpdateMutationResultSchema,
  UpdateWorkspaceProjectionSchema,
  type RetryUpdateInput,
  type ExternalDeploymentReportInput,
  type ResolveUpdateInteractionInput,
  type UpdateBatchCommandInput,
  type UpdateBatchView,
  type UpdateMutationResult,
  type UpdateWorkspaceProjection,
} from '../contract';
import {
  buildContinuationCiCdUpdatePrompt,
  buildInitialCiCdUpdatePrompt,
  buildInitialLocalScriptUpdatePrompt,
  buildRetryCiCdUpdatePrompt,
  buildRetryLocalScriptUpdatePrompt,
} from '../prompt';

const QUIET_WINDOW_MS = 2 * 60 * 1_000;

type ItemSourceRow = {
  submission_id: string;
  submission_item_id: string;
  project_id: string;
  submission_status: 'ACTIVE' | 'CLOSED';
  submission_title: string;
  engineering_name: string;
  repository_url: string;
  target_branch: string;
  environment_name: string;
  deployment_json: string;
  responsible_user_id: string;
  binding_id: string;
  runner_id: string;
};

type CandidateRow = {
  bug_id: string;
  short_id: number;
  title: string;
  pending_commits_json: string;
  last_candidate_at: string;
};

type BatchRow = {
  id: string;
  submission_id: string;
  submission_item_id: string;
  state: 'READY' | 'RUNNING' | 'WAITING_EXTERNAL' | 'FAILED' | 'COMPLETED';
  version: number;
  active_execution_id: string | null;
  session_id: string | null;
  deployment_json: string;
  frozen_at: string;
  created_at: string;
  updated_at: string;
};

type AttemptRow = {
  id: string;
  batch_id: string;
  execution_id: string;
  continuation_report_id: string | null;
  attempt: number;
  outcome_json: string | null;
  created_at: string;
  finished_at: string | null;
  state: Execution['state'];
  session_id: string | null;
};

type ExternalReportRow = {
  id: string;
  batch_id: string;
  round: number;
  outcome: 'SUCCEEDED' | 'FAILED';
  summary: string | null;
  reported_by_user_id: string;
  created_at: string;
};

type ExternalReportAttachmentRow = {
  id: string;
  original_name: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
};

type FrozenBatch = {
  batchId: string;
  executionId: string;
  revision: number;
};

export class UpdateService {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService = new ExecutionService(db),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly onInvalidated: (
      submissionId: string,
      revision: number,
    ) => void = () => {},
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  recordCandidateAvailable(bugId: string, candidateAt: string): void {
    const row = this.db
      .prepare(
        `SELECT submission_item_id FROM cooking_bug
         WHERE id = ? AND stage = 'WAITING_FOR_UPDATE'`,
      )
      .get(bugId) as { submission_item_id: string | null } | undefined;
    if (!row?.submission_item_id) return;
    const eligibleAt = new Date(
      Date.parse(candidateAt) + QUIET_WINDOW_MS,
    ).toISOString();
    this.db
      .prepare(
        `INSERT INTO cooking_pending_delivery(
           submission_item_id, last_candidate_at, eligible_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(submission_item_id) DO UPDATE SET
           last_candidate_at = excluded.last_candidate_at,
           eligible_at = excluded.eligible_at`,
      )
      .run(row.submission_item_id, candidateAt, eligibleAt);
  }

  recalculatePendingDeliveryForBug(bugId: string): void {
    const row = this.db
      .prepare('SELECT submission_item_id FROM cooking_bug WHERE id = ?')
      .get(bugId) as { submission_item_id: string | null } | undefined;
    if (!row?.submission_item_id) return;
    this.recalculatePendingDelivery(row.submission_item_id);
  }

  prepareDueExecutions(nowValue: Date = this.now()): string[] {
    const now = nowValue.toISOString();
    const due = this.db
      .prepare(
        `SELECT pending.submission_item_id
         FROM cooking_pending_delivery pending
         JOIN cooking_submission_item item
           ON item.id = pending.submission_item_id
         JOIN cooking_test_submission submission
           ON submission.id = item.submission_id
         WHERE pending.eligible_at <= ?
           AND submission.status = 'ACTIVE'
         ORDER BY pending.eligible_at, pending.submission_item_id`,
      )
      .all(now) as Array<{ submission_item_id: string }>;
    const prepared: Array<FrozenBatch & { submissionId: string }> = [];
    for (const { submission_item_id } of due) {
      const frozen = this.db.transaction(() =>
        this.freezeItem(submission_item_id, now, true),
      )();
      if (frozen)
        prepared.push({
          ...frozen,
          submissionId: this.itemSource(submission_item_id).submission_id,
        });
    }
    for (const item of prepared)
      this.onInvalidated(item.submissionId, item.revision);
    return prepared.map(({ executionId }) => executionId);
  }

  freezeNow(
    actorUserId: string,
    submissionItemId: string,
    inputValue: { mutationId: string },
  ): UpdateMutationResult {
    const input = FreezeUpdateInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_FREEZE',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      perform: () => {
        const source = this.requireResponsible(actorUserId, submissionItemId);
        DeploymentMethodSchema.parse(JSON.parse(source.deployment_json));
        const now = this.now().toISOString();
        const frozen = this.freezeItem(submissionItemId, now, false);
        if (!frozen)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前没有可以冻结的待更新缺陷',
          );
        return {
          result: {
            batchId: frozen.batchId,
            batchVersion: 1,
            executionId: frozen.executionId,
            revision: frozen.revision,
          },
          resourceId: frozen.batchId,
          audits: [
            {
              projectId: source.project_id,
              action: 'UPDATE_BATCH_FROZEN',
              targetType: 'UPDATE_BATCH',
              targetId: frozen.batchId,
              details: { submissionItemId, mode: 'IMMEDIATE' },
            },
          ],
        };
      },
    });
    if (!replay) {
      const source = this.itemSource(submissionItemId);
      this.onInvalidated(source.submission_id, result.revision);
    }
    return result;
  }

  retryUpdate(
    actorUserId: string,
    batchId: string,
    inputValue: RetryUpdateInput,
  ): UpdateMutationResult {
    const input = RetryUpdateInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_RETRY',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      perform: () => {
        const batch = this.requireBatchResponsible(actorUserId, batchId);
        this.requireBatchVersion(batch, input.expectedVersion);
        if (batch.state !== 'FAILED')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有失败的更新批次可以重新执行',
          );
        const latest = this.latestAttempt(batchId);
        if (!latest || !isTerminal(latest.state))
          throw new PlatformError('RESOURCE_CONFLICT', '当前更新执行尚未结束');
        const source = this.itemSource(batch.submission_item_id);
        const deployment = DeploymentMethodSchema.parse(
          JSON.parse(batch.deployment_json),
        );
        const externalReport =
          deployment.kind === 'CI_CD'
            ? this.latestUnconsumedFailedReport(batchId)
            : undefined;
        const attachmentIds = externalReport
          ? this.externalReportAttachmentIds(externalReport.id)
          : [];
        const prompt = externalReport
          ? buildContinuationCiCdUpdatePrompt({
              reportRound: externalReport.round,
              summary: externalReport.summary!,
              attachmentNames: this.externalReportAttachments(
                externalReport.id,
              ).map(({ original_name }) => original_name),
            })
          : deployment.kind === 'LOCAL_SCRIPT'
            ? buildRetryLocalScriptUpdatePrompt()
            : buildRetryCiCdUpdatePrompt();
        const attemptId = this.createId();
        const execution = this.executions.enqueue({
          owner: { namespace: 'cooking', kind: 'UPDATE_BATCH', id: attemptId },
          attempt: latest.attempt + 1,
          previousExecutionId: latest.execution_id,
          runnerId: source.runner_id,
          bindingId: source.binding_id,
          priority: 0,
          promptKind: prompt.kind,
          promptVersion: prompt.version,
          renderedPrompt: prompt.renderedPrompt,
          renderedPromptHash: prompt.renderedPromptHash,
          outputJsonSchema: prompt.outputJsonSchema,
          workspace: {
            key: `update-batch:${batchId}`,
            isolation: 'DETACHED_WORKTREE',
            baseRef: `origin/${source.target_branch}`,
          },
          attachmentIds,
          resumeSessionId: batch.session_id,
        });
        const now = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_update_attempt(
               id, batch_id, execution_id, continuation_report_id, attempt,
               outcome_json, created_at, finished_at
             ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
          )
          .run(
            attemptId,
            batchId,
            execution.id,
            externalReport?.id ?? null,
            latest.attempt + 1,
            now,
          );
        const update = this.db
          .prepare(
            `UPDATE cooking_update_batch
             SET state = 'READY', active_execution_id = ?,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'FAILED'`,
          )
          .run(execution.id, now, batchId, input.expectedVersion);
        if (update.changes !== 1) throw staleBatch();
        const revision = this.bumpRevision(batch.submission_id, now);
        return {
          result: {
            batchId,
            batchVersion: input.expectedVersion + 1,
            executionId: execution.id,
            revision,
          },
          resourceId: batchId,
          audits: [
            {
              projectId: this.itemSource(batch.submission_item_id).project_id,
              action: 'UPDATE_BATCH_RETRIED',
              targetType: 'UPDATE_BATCH',
              targetId: batchId,
              details: { executionId: execution.id },
            },
          ],
        };
      },
    });
    if (!replay) {
      const batch = this.batch(batchId);
      this.onInvalidated(batch.submission_id, result.revision);
    }
    return result;
  }

  reportExternalDeployment(
    actorUserId: string,
    batchId: string,
    inputValue: ExternalDeploymentReportInput,
  ): UpdateMutationResult {
    const input = ExternalDeploymentReportInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_REPORT_EXTERNAL',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      perform: () => {
        const batch = this.requireBatchResponsible(actorUserId, batchId);
        this.requireBatchVersion(batch, input.expectedVersion);
        const deployment = DeploymentMethodSchema.parse(
          JSON.parse(batch.deployment_json),
        );
        if (deployment.kind !== 'CI_CD')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有 CI/CD 更新批次需要外部结果',
          );
        if (batch.state !== 'WAITING_EXTERNAL')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前更新批次不在等待外部结果',
          );
        this.requireBindableExternalFiles(actorUserId, input.attachmentIds);
        const now = this.now().toISOString();
        const reportId = this.createId();
        const reportRound = this.nextExternalReportRound(batchId);
        this.db
          .prepare(
            `INSERT INTO cooking_external_deployment_report(
               id, batch_id, round, outcome, summary,
               reported_by_user_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            reportId,
            batchId,
            reportRound,
            input.outcome,
            input.summary?.trim() || null,
            actorUserId,
            now,
          );
        input.attachmentIds.forEach((fileId, position) =>
          this.db
            .prepare(
              `INSERT INTO cooking_external_deployment_report_attachment(
                 file_id, report_id, position
               ) VALUES (?, ?, ?)`,
            )
            .run(fileId, reportId, position),
        );
        const state = input.outcome === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED';
        const batchUpdate = this.db
          .prepare(
            `UPDATE cooking_update_batch
             SET state = ?, active_execution_id = NULL,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'WAITING_EXTERNAL'`,
          )
          .run(state, now, batchId, input.expectedVersion);
        if (batchUpdate.changes !== 1) throw staleBatch();
        if (input.outcome === 'SUCCEEDED') this.completeBatchBugs(batchId, now);
        const revision = this.bumpRevision(batch.submission_id, now);
        return {
          result: {
            batchId,
            batchVersion: input.expectedVersion + 1,
            executionId: null,
            revision,
          },
          resourceId: batchId,
          audits: [
            {
              projectId: this.itemSource(batch.submission_item_id).project_id,
              action:
                input.outcome === 'SUCCEEDED'
                  ? 'EXTERNAL_DEPLOYMENT_SUCCEEDED'
                  : 'EXTERNAL_DEPLOYMENT_FAILED',
              targetType: 'UPDATE_BATCH',
              targetId: batchId,
              details: {
                reportId,
                round: reportRound,
                attachmentCount: input.attachmentIds.length,
              },
            },
          ],
        };
      },
    });
    if (!replay) {
      const batch = this.batch(batchId);
      this.onInvalidated(batch.submission_id, result.revision);
    }
    return result;
  }

  resolveInteraction(
    actorUserId: string,
    interactionId: string,
    inputValue: ResolveUpdateInteractionInput,
  ): UpdateMutationResult {
    const input = ResolveUpdateInteractionInputSchema.parse(inputValue);
    const source = this.interactionSource(interactionId);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_INTERACTION_RESOLVE',
      resourceType: 'EXECUTION_INTERACTION',
      resultSchema: UpdateMutationResultSchema,
      perform: () => {
        const batch = this.requireBatchResponsible(
          actorUserId,
          source.batch_id,
        );
        this.requireBatchVersion(batch, input.expectedVersion);
        if (batch.state !== 'RUNNING')
          throw new PlatformError('INVALID_TRANSITION', '更新批次不在运行中');
        this.executions.resolveInteraction(interactionId, input.resolution);
        const now = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_update_batch
             SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'RUNNING'`,
          )
          .run(now, batch.id, input.expectedVersion);
        if (update.changes !== 1) throw staleBatch();
        const revision = this.bumpRevision(batch.submission_id, now);
        return {
          result: {
            batchId: batch.id,
            batchVersion: input.expectedVersion + 1,
            executionId: source.execution_id,
            revision,
          },
          resourceId: interactionId,
          audits: [
            {
              projectId: this.itemSource(batch.submission_item_id).project_id,
              action: 'UPDATE_INTERACTION_RESOLVED',
              targetType: 'EXECUTION_INTERACTION',
              targetId: interactionId,
              details: { batchId: batch.id, executionId: source.execution_id },
            },
          ],
        };
      },
    });
    if (!replay) {
      const batch = this.batch(source.batch_id);
      this.onInvalidated(batch.submission_id, result.revision);
    }
    return result;
  }

  applyStartedExecution(execution: Execution): void {
    if (!isUpdateExecution(execution)) return;
    const attempt = this.attemptForExecution(execution.id);
    if (!attempt) return;
    const batch = this.batch(attempt.batch_id);
    if (batch.state !== 'READY') return;
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE cooking_update_batch
         SET state = 'RUNNING', version = version + 1, updated_at = ?
         WHERE id = ? AND state = 'READY'`,
      )
      .run(now, batch.id);
    this.auditForBatch(
      batch,
      'UPDATE_ATTEMPT_STARTED',
      { executionId: execution.id, attempt: attempt.attempt },
      now,
    );
    this.bumpRevision(batch.submission_id, now);
  }

  applyTerminalExecution(execution: Execution): void {
    if (!isUpdateExecution(execution)) return;
    const attempt = this.attemptForExecution(execution.id);
    if (!attempt || attempt.outcome_json) return;
    const batch = this.batch(attempt.batch_id);
    const now = this.now().toISOString();
    const interpreted = this.interpret(execution, batch);
    if (interpreted.kind === 'COMPLETED') {
      const batchUpdate = this.db
        .prepare(
          `UPDATE cooking_update_batch
           SET state = 'COMPLETED', active_execution_id = NULL,
               session_id = COALESCE(?, session_id),
               version = version + 1, updated_at = ?
           WHERE id = ? AND state IN ('READY', 'RUNNING')`,
        )
        .run(execution.sessionId, now, batch.id);
      if (batchUpdate.changes !== 1) throw staleBatch();
      this.completeBatchBugs(batch.id, now);
    } else if (interpreted.kind === 'PUSHED') {
      const batchUpdate = this.db
        .prepare(
          `UPDATE cooking_update_batch
           SET state = 'WAITING_EXTERNAL', active_execution_id = NULL,
               session_id = COALESCE(?, session_id),
               version = version + 1, updated_at = ?
           WHERE id = ? AND state IN ('READY', 'RUNNING')`,
        )
        .run(execution.sessionId, now, batch.id);
      if (batchUpdate.changes !== 1) throw staleBatch();
    } else {
      const batchUpdate = this.db
        .prepare(
          `UPDATE cooking_update_batch
           SET state = 'FAILED', session_id = COALESCE(?, session_id),
               version = version + 1, updated_at = ?
           WHERE id = ? AND state IN ('READY', 'RUNNING')`,
        )
        .run(execution.sessionId, now, batch.id);
      if (batchUpdate.changes !== 1) throw staleBatch();
    }
    this.db
      .prepare(
        `UPDATE cooking_update_attempt
         SET outcome_json = ?, finished_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(interpreted.attemptOutcome), now, attempt.id);
    this.auditForBatch(
      batch,
      interpreted.kind === 'FAILED'
        ? 'UPDATE_ATTEMPT_FAILED'
        : interpreted.kind === 'PUSHED'
          ? 'UPDATE_ATTEMPT_PUSHED'
          : 'UPDATE_ATTEMPT_COMPLETED',
      {
        executionId: execution.id,
        attempt: attempt.attempt,
        outcome: interpreted.kind,
      },
      now,
    );
    this.bumpRevision(batch.submission_id, now);
  }

  applyInteractionOpened(executionId: string, interactionId: string): void {
    const attempt = this.attemptForExecution(executionId);
    if (!attempt) return;
    const batch = this.batch(attempt.batch_id);
    const now = this.now().toISOString();
    this.auditForBatch(
      batch,
      'UPDATE_INTERACTION_OPENED',
      { executionId, interactionId, attempt: attempt.attempt },
      now,
    );
    this.bumpRevision(batch.submission_id, now);
  }

  afterStartedExecution(execution: Execution): void {
    if (isUpdateExecution(execution)) this.publishExecution(execution.id);
  }

  afterTerminalExecution(execution: Execution): void {
    if (isUpdateExecution(execution)) this.publishExecution(execution.id);
  }

  afterInteractionOpened(executionId: string): void {
    this.publishExecution(executionId);
  }

  workspace(userId: string, submissionId: string): UpdateWorkspaceProjection {
    this.requireSubmissionAccess(userId, submissionId);
    const pendingDeliveries = (
      this.db
        .prepare(
          `SELECT pending.*, item.responsible_user_id,
                  json_extract(item.deployment_json, '$.kind') deployment_kind
           FROM cooking_pending_delivery pending
           JOIN cooking_submission_item item
             ON item.id = pending.submission_item_id
           WHERE item.submission_id = ?
           ORDER BY item.position`,
        )
        .all(submissionId) as Array<{
        submission_item_id: string;
        last_candidate_at: string;
        eligible_at: string;
        responsible_user_id: string;
        deployment_kind: string;
      }>
    ).map((row) => ({
      submissionItemId: row.submission_item_id,
      lastCandidateAt: row.last_candidate_at,
      eligibleAt: row.eligible_at,
      availableActions:
        row.responsible_user_id === userId ? (['FREEZE_NOW'] as const) : [],
    }));
    const batchIds = (
      this.db
        .prepare(
          `SELECT id FROM cooking_update_batch
           WHERE submission_id = ?
             AND EXISTS (
               SELECT 1 FROM cooking_update_batch_entry entry
               WHERE entry.batch_id = cooking_update_batch.id
             )
           ORDER BY created_at, id`,
        )
        .all(submissionId) as Array<{ id: string }>
    ).map(({ id }) => id);
    return UpdateWorkspaceProjectionSchema.parse({
      pendingDeliveries,
      updateBatches: batchIds.map((id) => this.batchView(userId, id)),
    });
  }

  batchView(userId: string, batchId: string): UpdateBatchView {
    const batch = this.batch(batchId);
    const source = this.itemSource(batch.submission_item_id);
    this.requireSubmissionAccess(userId, batch.submission_id);
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
      entries: entries.map((entry) => ({
        bugId: entry.bug_id,
        bugShortId: entry.short_id,
        bugTitle: entry.title,
        commits: technical ? parseCommits(entry.commits_json) : null,
      })),
      timeline,
      availableActions: technical
        ? [
            ...(batch.state === 'FAILED' && latest && isTerminal(latest.state)
              ? (['RETRY_UPDATE'] as const)
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

  private interactionsForBatch(batchId: string): CookingInteractionRow[] {
    return this.db
      .prepare(
        `SELECT interaction.*
         FROM platform_execution_interaction interaction
         JOIN cooking_update_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         WHERE attempt.batch_id = ?
           AND interaction.state IN ('PENDING', 'RESOLVED')
         ORDER BY interaction.created_at, interaction.id`,
      )
      .all(batchId) as CookingInteractionRow[];
  }

  requireExternalAttachmentAccess(userId: string, fileId: string): void {
    const row = this.db
      .prepare(
        `SELECT batch.submission_id, item.responsible_user_id
         FROM cooking_external_deployment_report_attachment attachment
         JOIN cooking_external_deployment_report report
           ON report.id = attachment.report_id
         JOIN cooking_update_batch batch ON batch.id = report.batch_id
         JOIN cooking_submission_item item ON item.id = batch.submission_item_id
         WHERE attachment.file_id = ?`,
      )
      .get(fileId) as
      { submission_id: string; responsible_user_id: string } | undefined;
    if (!row || row.responsible_user_id !== userId)
      throw new PlatformError('NOT_FOUND', '附件不存在或无权访问');
    try {
      this.requireSubmissionAccess(userId, row.submission_id);
    } catch {
      throw new PlatformError('NOT_FOUND', '附件不存在或无权访问');
    }
  }

  private freezeItem(
    submissionItemId: string,
    now: string,
    requireDue: boolean,
  ): FrozenBatch | undefined {
    const source = this.itemSource(submissionItemId);
    if (source.submission_status !== 'ACTIVE') return undefined;
    const deployment = DeploymentMethodSchema.parse(
      JSON.parse(source.deployment_json),
    );
    const pending = this.db
      .prepare(
        `SELECT last_candidate_at, eligible_at
         FROM cooking_pending_delivery WHERE submission_item_id = ?`,
      )
      .get(submissionItemId) as
      { last_candidate_at: string; eligible_at: string } | undefined;
    if (!pending || (requireDue && pending.eligible_at > now)) return undefined;
    if (this.activeBatch(submissionItemId)) return undefined;
    const candidates = this.candidates(submissionItemId);
    if (!candidates.length) {
      this.db
        .prepare(
          'DELETE FROM cooking_pending_delivery WHERE submission_item_id = ?',
        )
        .run(submissionItemId);
      return undefined;
    }
    const batchId = this.createId();
    const attemptId = this.createId();
    const promptInput = {
      workspaceKey: `update-batch:${batchId}`,
      submissionTitle: source.submission_title,
      engineeringName: source.engineering_name,
      repositoryUrl: source.repository_url,
      targetBranch: source.target_branch,
      environmentName: source.environment_name,
      entries: candidates.map((candidate) => ({
        bugShortId: candidate.short_id,
        bugTitle: candidate.title,
        commits: parseCommits(candidate.pending_commits_json),
      })),
    };
    const prompt =
      deployment.kind === 'LOCAL_SCRIPT'
        ? buildInitialLocalScriptUpdatePrompt({
            ...promptInput,
            deploymentCommand: deployment.command,
          })
        : buildInitialCiCdUpdatePrompt(promptInput);
    this.db
      .prepare(
        `INSERT INTO cooking_update_batch(
           id, submission_id, submission_item_id, state, version,
           active_execution_id, session_id, deployment_json, frozen_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'READY', 1, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        batchId,
        source.submission_id,
        submissionItemId,
        source.deployment_json,
        now,
        now,
        now,
      );
    const insertEntry = this.db.prepare(
      `INSERT INTO cooking_update_batch_entry(
         batch_id, bug_id, position, commits_json
       ) VALUES (?, ?, ?, ?)`,
    );
    candidates.forEach((candidate, position) =>
      insertEntry.run(
        batchId,
        candidate.bug_id,
        position,
        candidate.pending_commits_json,
      ),
    );
    const execution = this.executions.enqueue({
      owner: { namespace: 'cooking', kind: 'UPDATE_BATCH', id: attemptId },
      attempt: 1,
      previousExecutionId: null,
      runnerId: source.runner_id,
      bindingId: source.binding_id,
      priority: 0,
      promptKind: prompt.kind,
      promptVersion: prompt.version,
      renderedPrompt: prompt.renderedPrompt,
      renderedPromptHash: prompt.renderedPromptHash,
      outputJsonSchema: prompt.outputJsonSchema,
      workspace: {
        key: promptInput.workspaceKey,
        isolation: 'DETACHED_WORKTREE',
        baseRef: `origin/${source.target_branch}`,
      },
      attachmentIds: [],
      resumeSessionId: null,
    });
    this.db
      .prepare(
        `INSERT INTO cooking_update_attempt(
           id, batch_id, execution_id, continuation_report_id, attempt,
           outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, NULL, 1, NULL, ?, NULL)`,
      )
      .run(attemptId, batchId, execution.id, now);
    this.db
      .prepare(
        `UPDATE cooking_update_batch SET active_execution_id = ? WHERE id = ?`,
      )
      .run(execution.id, batchId);
    const bugUpdate = this.db
      .prepare(
        `UPDATE cooking_bug
         SET stage = 'UPDATING', version = version + 1, updated_at = ?
         WHERE submission_item_id = ? AND stage = 'WAITING_FOR_UPDATE'
           AND id IN (
             SELECT bug_id FROM cooking_update_batch_entry WHERE batch_id = ?
           )`,
      )
      .run(now, submissionItemId, batchId);
    if (bugUpdate.changes !== candidates.length)
      throw new PlatformError('STALE_STATE', '待更新缺陷集合已变化');
    this.db
      .prepare(
        'DELETE FROM cooking_pending_delivery WHERE submission_item_id = ?',
      )
      .run(submissionItemId);
    const revision = this.bumpRevision(source.submission_id, now);
    return { batchId, executionId: execution.id, revision };
  }

  private interpret(
    execution: Execution,
    batch: BatchRow,
  ):
    | { kind: 'COMPLETED'; attemptOutcome: unknown }
    | { kind: 'PUSHED'; attemptOutcome: unknown }
    | { kind: 'FAILED'; attemptOutcome: unknown } {
    if (execution.outcome?.kind === 'SUCCEEDED') {
      const deployment = DeploymentMethodSchema.parse(
        JSON.parse(batch.deployment_json),
      );
      const parsed =
        deployment.kind === 'LOCAL_SCRIPT'
          ? LocalScriptUpdateExecutionResultSchema.safeParse(
              execution.outcome.result,
            )
          : CiCdUpdateExecutionResultSchema.safeParse(execution.outcome.result);
      if (parsed.success && parsed.data.outcome === 'COMPLETED')
        return { kind: 'COMPLETED', attemptOutcome: parsed.data };
      if (parsed.success && parsed.data.outcome === 'PUSHED')
        return { kind: 'PUSHED', attemptOutcome: parsed.data };
      if (parsed.success)
        return { kind: 'FAILED', attemptOutcome: parsed.data };
      this.markExecutionResultInvalid(execution.id);
      return {
        kind: 'FAILED',
        attemptOutcome: {
          outcome: 'FAILED',
          summary: '更新结果格式无效',
          failedStep: '解析结构化结果',
          reason: 'Agent 返回内容不符合统一更新结果 Schema',
          completedActions: [],
          pendingActions: ['重新执行统一更新'],
          technicalFailure: 'RESULT_SCHEMA_INVALID',
        },
      };
    }
    const cancelled = execution.outcome?.kind === 'CANCELLED';
    const summary = cancelled ? '更新执行已停止' : '统一更新未完成';
    return {
      kind: 'FAILED',
      attemptOutcome: {
        outcome: 'FAILED',
        summary,
        failedStep: cancelled ? '执行停止' : '执行统一更新',
        reason:
          execution.outcome?.kind === 'FAILED'
            ? execution.outcome.failure.message
            : summary,
        completedActions: [],
        pendingActions: ['重新执行统一更新'],
        technicalFailure:
          execution.outcome?.kind === 'FAILED'
            ? execution.outcome.failure.code
            : execution.outcome?.kind,
      },
    };
  }

  private markExecutionResultInvalid(executionId: string): void {
    this.db
      .prepare(
        `UPDATE platform_execution
         SET state = 'FAILED', outcome_json = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          kind: 'FAILED',
          failure: {
            code: 'CODEX_EXECUTION_FAILED',
            message: 'Codex 返回的更新结果无效',
            retryable: true,
          },
        }),
        executionId,
      );
  }

  private completeBatchBugs(batchId: string, now: string): void {
    const entries = this.batchEntries(batchId);
    const bugUpdate = this.db
      .prepare(
        `UPDATE cooking_bug
         SET stage = 'WAITING_FOR_VERIFICATION', version = version + 1,
             updated_at = ?
         WHERE id IN (
           SELECT bug_id FROM cooking_update_batch_entry WHERE batch_id = ?
         ) AND stage = 'UPDATING'`,
      )
      .run(now, batchId);
    if (bugUpdate.changes !== entries.length)
      throw new PlatformError('STALE_STATE', '更新批次中的缺陷状态已变化');
    const contextUpdate = this.db
      .prepare(
        `UPDATE cooking_bug_repair_context
         SET pending_commits_json = '[]', last_candidate_at = NULL,
             version = version + 1, updated_at = ?
         WHERE bug_id IN (
           SELECT bug_id FROM cooking_update_batch_entry WHERE batch_id = ?
         )`,
      )
      .run(now, batchId);
    if (contextUpdate.changes !== entries.length)
      throw new PlatformError('INTERNAL_ERROR', '更新批次候选提交上下文不完整');
  }

  private nextExternalReportRound(batchId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(round), 0) + 1 round
         FROM cooking_external_deployment_report WHERE batch_id = ?`,
      )
      .get(batchId) as { round: number };
    return row.round;
  }

  private externalReports(batchId: string): ExternalReportRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cooking_external_deployment_report
         WHERE batch_id = ? ORDER BY round, created_at, id`,
      )
      .all(batchId) as ExternalReportRow[];
  }

  private latestUnconsumedFailedReport(
    batchId: string,
  ): ExternalReportRow | undefined {
    return this.db
      .prepare(
        `SELECT report.*
         FROM cooking_external_deployment_report report
         LEFT JOIN cooking_update_attempt attempt
           ON attempt.continuation_report_id = report.id
         WHERE report.batch_id = ? AND report.outcome = 'FAILED'
           AND attempt.id IS NULL
         ORDER BY report.round DESC LIMIT 1`,
      )
      .get(batchId) as ExternalReportRow | undefined;
  }

  private externalReportAttachmentIds(reportId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT file_id
           FROM cooking_external_deployment_report_attachment
           WHERE report_id = ? ORDER BY position`,
        )
        .all(reportId) as Array<{ file_id: string }>
    ).map(({ file_id }) => file_id);
  }

  private externalReportAttachments(
    reportId: string,
  ): ExternalReportAttachmentRow[] {
    return this.db
      .prepare(
        `SELECT file.id, file.original_name, file.media_type,
                file.size_bytes, file.created_at
         FROM cooking_external_deployment_report_attachment attachment
         JOIN platform_file file ON file.id = attachment.file_id
         WHERE attachment.report_id = ? ORDER BY attachment.position`,
      )
      .all(reportId) as ExternalReportAttachmentRow[];
  }

  private requireBindableExternalFiles(
    actorUserId: string,
    fileIds: string[],
  ): void {
    for (const fileId of fileIds) {
      const row = this.db
        .prepare(
          `SELECT file.uploaded_by_user_id,
                  bug_attachment.file_id bug_file_id,
                  report_attachment.file_id report_file_id
           FROM platform_file file
           LEFT JOIN cooking_bug_attachment bug_attachment
             ON bug_attachment.file_id = file.id
           LEFT JOIN cooking_external_deployment_report_attachment report_attachment
             ON report_attachment.file_id = file.id
           WHERE file.id = ?`,
        )
        .get(fileId) as
        | {
            uploaded_by_user_id: string;
            bug_file_id: string | null;
            report_file_id: string | null;
          }
        | undefined;
      if (
        !row ||
        row.uploaded_by_user_id !== actorUserId ||
        row.bug_file_id ||
        row.report_file_id
      )
        throw new PlatformError(
          'VALIDATION_FAILED',
          '附件不存在、已被使用或不属于当前用户',
        );
    }
  }

  private recalculatePendingDelivery(submissionItemId: string): void {
    const latest = this.db
      .prepare(
        `SELECT MAX(context.last_candidate_at) last_candidate_at
         FROM cooking_bug bug
         JOIN cooking_bug_repair_context context ON context.bug_id = bug.id
         WHERE bug.submission_item_id = ?
           AND bug.stage = 'WAITING_FOR_UPDATE'
           AND context.last_candidate_at IS NOT NULL
           AND context.pending_commits_json <> '[]'`,
      )
      .get(submissionItemId) as { last_candidate_at: string | null };
    if (!latest.last_candidate_at) {
      this.db
        .prepare(
          'DELETE FROM cooking_pending_delivery WHERE submission_item_id = ?',
        )
        .run(submissionItemId);
      return;
    }
    this.recordPendingDelivery(submissionItemId, latest.last_candidate_at);
  }

  private resetPendingDelivery(submissionItemId: string, now: string): void {
    this.recordPendingDelivery(submissionItemId, now);
  }

  private recordPendingDelivery(
    submissionItemId: string,
    candidateAt: string,
  ): void {
    const eligibleAt = new Date(
      Date.parse(candidateAt) + QUIET_WINDOW_MS,
    ).toISOString();
    this.db
      .prepare(
        `INSERT INTO cooking_pending_delivery(
           submission_item_id, last_candidate_at, eligible_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(submission_item_id) DO UPDATE SET
           last_candidate_at = excluded.last_candidate_at,
           eligible_at = excluded.eligible_at`,
      )
      .run(submissionItemId, candidateAt, eligibleAt);
  }

  private candidates(submissionItemId: string): CandidateRow[] {
    return this.db
      .prepare(
        `SELECT bug.id bug_id, bug.short_id, bug.title,
                context.pending_commits_json, context.last_candidate_at
         FROM cooking_bug bug
         JOIN cooking_bug_repair_context context ON context.bug_id = bug.id
         WHERE bug.submission_item_id = ?
           AND bug.stage = 'WAITING_FOR_UPDATE'
           AND context.last_candidate_at IS NOT NULL
           AND context.pending_commits_json <> '[]'
         ORDER BY bug.short_id, bug.id`,
      )
      .all(submissionItemId) as CandidateRow[];
  }

  private batchEntries(batchId: string): Array<{
    bug_id: string;
    short_id: number;
    title: string;
    commits_json: string;
  }> {
    return this.db
      .prepare(
        `SELECT entry.bug_id, bug.short_id, bug.title, entry.commits_json
         FROM cooking_update_batch_entry entry
         JOIN cooking_bug bug ON bug.id = entry.bug_id
         WHERE entry.batch_id = ? ORDER BY entry.position`,
      )
      .all(batchId) as Array<{
      bug_id: string;
      short_id: number;
      title: string;
      commits_json: string;
    }>;
  }

  private itemSource(submissionItemId: string): ItemSourceRow {
    const row = this.db
      .prepare(
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
      )
      .get(submissionItemId) as ItemSourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Submission Item 不存在');
    return row;
  }

  private batch(batchId: string): BatchRow {
    const row = this.db
      .prepare('SELECT * FROM cooking_update_batch WHERE id = ?')
      .get(batchId) as BatchRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Update Batch 不存在');
    return row;
  }

  private activeBatch(submissionItemId: string): BatchRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM cooking_update_batch
         WHERE submission_item_id = ?
           AND state IN ('READY', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED')`,
      )
      .get(submissionItemId) as BatchRow | undefined;
  }

  private attempts(batchId: string): AttemptRow[] {
    return this.db
      .prepare(
        `SELECT attempt.*, execution.state, execution.session_id
         FROM cooking_update_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.batch_id = ? ORDER BY attempt.attempt`,
      )
      .all(batchId) as AttemptRow[];
  }

  private latestAttempt(batchId: string): AttemptRow | undefined {
    return this.attempts(batchId).at(-1);
  }

  private attemptForExecution(executionId: string): AttemptRow | undefined {
    return this.db
      .prepare(
        `SELECT attempt.*, execution.state, execution.session_id
         FROM cooking_update_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.execution_id = ?`,
      )
      .get(executionId) as AttemptRow | undefined;
  }

  private requireResponsible(
    userId: string,
    submissionItemId: string,
  ): ItemSourceRow {
    const source = this.itemSource(submissionItemId);
    this.requireSubmissionAccess(userId, source.submission_id);
    if (source.responsible_user_id !== userId)
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有该工程负责人可以操作更新批次',
      );
    if (source.submission_status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能更新');
    return source;
  }

  private requireBatchResponsible(userId: string, batchId: string): BatchRow {
    const batch = this.batch(batchId);
    this.requireResponsible(userId, batch.submission_item_id);
    return batch;
  }

  private requireBatchVersion(batch: BatchRow, expectedVersion: number): void {
    if (batch.version !== expectedVersion) throw staleBatch();
  }

  private requireSubmissionAccess(userId: string, submissionId: string): void {
    const row = this.db
      .prepare(
        `SELECT 1 allowed
         FROM cooking_test_submission submission
         JOIN cooking_project_membership membership
           ON membership.project_id = submission.project_id
         WHERE submission.id = ? AND membership.user_id = ?`,
      )
      .get(submissionId, userId) as { allowed: number } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '提测单不存在');
  }

  private interactionSource(interactionId: string): {
    batch_id: string;
    execution_id: string;
  } {
    const row = this.db
      .prepare(
        `SELECT attempt.batch_id, interaction.execution_id
         FROM platform_execution_interaction interaction
         JOIN cooking_update_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         WHERE interaction.id = ?`,
      )
      .get(interactionId) as
      { batch_id: string; execution_id: string } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Update Interaction 不存在');
    return row;
  }

  private auditForBatch(
    batch: BatchRow,
    action: string,
    details: unknown,
    createdAt: string,
  ): void {
    const source = this.itemSource(batch.submission_item_id);
    this.db
      .prepare(
        `INSERT INTO cooking_audit_event(
           id, project_id, actor_user_id, action, target_type, target_id,
           details_json, created_at
         ) VALUES (?, ?, ?, ?, 'UPDATE_BATCH', ?, ?, ?)`,
      )
      .run(
        this.createId(),
        source.project_id,
        source.responsible_user_id,
        action,
        batch.id,
        JSON.stringify({ source: 'EXECUTION', ...asDetails(details) }),
        createdAt,
      );
  }

  private publishExecution(executionId: string): void {
    const row = this.db
      .prepare(
        `SELECT batch.submission_id, submission.workspace_revision
         FROM cooking_update_attempt attempt
         JOIN cooking_update_batch batch ON batch.id = attempt.batch_id
         JOIN cooking_test_submission submission ON submission.id = batch.submission_id
         WHERE attempt.execution_id = ?`,
      )
      .get(executionId) as
      { submission_id: string; workspace_revision: number } | undefined;
    if (row) this.onInvalidated(row.submission_id, row.workspace_revision);
  }

  private hasRecordedMutation(mutationId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 recorded FROM cooking_mutation WHERE id = ?')
        .get(mutationId),
    );
  }

  private bumpRevision(submissionId: string, now: string): number {
    const row = this.db
      .prepare(
        `UPDATE cooking_test_submission
         SET workspace_revision = workspace_revision + 1, updated_at = ?
         WHERE id = ? RETURNING workspace_revision`,
      )
      .get(now, submissionId) as { workspace_revision: number };
    return row.workspace_revision;
  }
}

function parseCommits(value: string): string[] {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new PlatformError('INTERNAL_ERROR', 'Pending Commit Chain 无效');
  return parsed;
}

function projectUpdateAttemptResult(outcomeJson: string, technical: boolean) {
  const outcome = JSON.parse(outcomeJson) as Record<string, unknown>;
  if (outcome.outcome === 'COMPLETED' || outcome.outcome === 'PUSHED')
    return {
      outcome: outcome.outcome,
      completedActions: stringArray(outcome.completedActions),
      validations: Array.isArray(outcome.validations)
        ? outcome.validations
        : [],
      warnings: stringArray(outcome.warnings),
      rawSummary:
        technical && typeof outcome.summary === 'string'
          ? outcome.summary
          : null,
    };
  return {
    outcome: 'FAILED' as const,
    failedStep:
      typeof outcome.failedStep === 'string'
        ? outcome.failedStep
        : '执行统一更新',
    reason:
      !technical &&
      typeof outcome.technicalFailure === 'string' &&
      outcome.technicalFailure !== 'CANCELLED'
        ? '统一更新执行未完成，工程负责人可查看详细原因。'
        : typeof outcome.reason === 'string'
          ? outcome.reason
          : typeof outcome.summary === 'string'
            ? outcome.summary
            : '统一更新未完成',
    completedActions: stringArray(outcome.completedActions),
    pendingActions: stringArray(outcome.pendingActions),
    failureCode:
      technical && typeof outcome.technicalFailure === 'string'
        ? outcome.technicalFailure
        : null,
    rawSummary:
      technical && typeof outcome.summary === 'string' ? outcome.summary : null,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isUpdateExecution(execution: Execution): boolean {
  return (
    execution.owner.namespace === 'cooking' &&
    execution.owner.kind === 'UPDATE_BATCH'
  );
}

function isTerminal(state: Execution['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

function batchStateLabel(state: BatchRow['state']): string {
  return {
    READY: '等待 Agent',
    RUNNING: '正在统一更新',
    WAITING_EXTERNAL: '等待外部部署结果',
    FAILED: '统一更新未完成',
    COMPLETED: '统一更新已完成',
  }[state];
}

function updateVisual(
  batch: BatchRow,
  latest: AttemptRow | undefined,
  interactions: CookingInteractionView[],
  responsible: boolean,
  idleLabel: string,
  queue: { state: Execution['state']; aheadCount: number } | undefined,
): CookingVisualPresentation {
  const pending = interactions.filter(
    (interaction) => interaction.state === 'PENDING',
  );
  if (pending.length > 1)
    throw new PlatformError(
      'INTERNAL_ERROR',
      '同一 Update Attempt 存在多个待处理 Interaction',
    );
  const interaction = pending[0];
  if (interaction) {
    if (!latest || latest.state !== 'WAITING_FOR_INTERACTION')
      throw new PlatformError(
        'INTERNAL_ERROR',
        'Update Interaction 与 Execution state 不一致',
      );
    return interaction.kind === 'APPROVAL'
      ? {
          state: 'NEEDS_APPROVAL',
          label: responsible ? '需要你审批' : '等待工程负责人审批',
          symbol: '!',
        }
      : {
          state: 'NEEDS_INPUT',
          label: responsible ? '需要你回答' : '等待工程负责人回答',
          symbol: '?',
        };
  }
  if (latest?.state === 'WAITING_FOR_INTERACTION')
    throw new PlatformError(
      'INTERNAL_ERROR',
      '等待 Interaction 的 Update Execution 缺少待处理记录',
    );
  if (batch.state === 'FAILED' || latest?.state === 'FAILED')
    return { state: 'FAILED', label: '统一更新未完成', symbol: '×' };
  if (batch.state === 'READY' || latest?.state === 'QUEUED')
    return {
      state: 'QUEUED_FOR_ENGINEERING',
      label: `等待工程执行通道（前方 ${queue?.aheadCount ?? 0} 项）`,
      symbol: '…',
      aheadCount: queue?.aheadCount ?? 0,
    };
  if (latest?.state === 'WAITING_TO_RESUME')
    return { state: 'WAITING_TO_RESUME', label: '等待继续', symbol: 'Ⅱ' };
  if (latest && ['CLAIMED', 'RUNNING'].includes(latest.state))
    return { state: 'RUNNING', label: '正在自动处理', symbol: '●' };
  if (
    batch.state === 'WAITING_EXTERNAL' ||
    (latest && ['CANCEL_REQUESTED', 'CANCELLED'].includes(latest.state))
  )
    return {
      state: 'WAITING_TO_RESUME',
      label:
        batch.state === 'WAITING_EXTERNAL' ? '等待部署结果' : '等待重新处理',
      symbol: 'Ⅱ',
    };
  return { state: 'IDLE', label: idleLabel, symbol: '·' };
}

function staleBatch(): PlatformError {
  return new PlatformError('STALE_STATE', '更新批次已变化，请刷新后重试');
}

function asDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
