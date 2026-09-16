import { DeploymentMethodSchema } from '@/cooking/engineering/contract';
import type { CookingExecutionProjectionEvent } from '@/cooking/runtime/execution-projection';
import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import { requireBindableFiles } from '@/cooking/shared/server/attachments';
import {
  environmentOwned,
  requireEnvironment,
} from '@/cooking/submissions/server/environment-access';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  createContinuationCodexTurn,
  createInitialCodexTurn,
} from '@/platform/execution/codex-turn';
import { ExecutionService } from '@/platform/execution/service';
import type { JsonObject } from '@agent-party-time/execution-contract';
import { randomUUID } from 'node:crypto';
import {
  buildInitialUpdateBrief,
  buildUpdateExternalFailureInput,
  buildUpdateRetryInput,
} from '../brief';
import {
  CiCdUpdateOutputJsonSchema,
  ExternalDeploymentReportInputSchema,
  FreezeUpdateInputSchema,
  LocalScriptUpdateOutputJsonSchema,
  ResolveUpdateInteractionInputSchema,
  RetryUpdateInputSchema,
  UpdateMutationResultSchema,
  type ExternalDeploymentReportInput,
  type ResolveUpdateInteractionInput,
  type RetryUpdateInput,
  type SynchronizeUpdateSessionInput,
  type UpdateBatchView,
  type UpdateMutationResult,
  type UpdateWorkspaceProjection,
} from '../contract';
import type { BatchRow, FrozenBatch, ItemSourceRow } from './records';
import { UpdateProjection } from './update-projection';
import { UpdateQueries } from './update-queries';

import {
  isTerminal,
  parseCommits,
  requireTaskSkillBinding,
  staleBatch,
} from './results';

const QUIET_WINDOW_MS = 2 * 60 * 1_000;

export class UpdateService {
  private readonly writes: TestSubmissionWriteStore;
  private readonly queries: UpdateQueries;
  private readonly projection: UpdateProjection;
  projectExecution(event: CookingExecutionProjectionEvent): void {
    this.projection.projectExecution(event);
  }
  workspace(userId: string, submissionId: string): UpdateWorkspaceProjection {
    return this.queries.workspace(userId, submissionId);
  }
  batchView(userId: string, batchId: string): UpdateBatchView {
    return this.queries.batchView(userId, batchId);
  }
  requireExternalAttachmentAccess(userId: string, fileId: string): void {
    this.queries.requireExternalAttachmentAccess(userId, fileId);
  }

  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService = new ExecutionService(db),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    onInvalidated: (submissionId: string, revision: number) => void = () => {},
  ) {
    this.queries = new UpdateQueries(db, executions);
    this.writes = new TestSubmissionWriteStore(
      db,
      now,
      createId,
      onInvalidated,
    );
    this.projection = new UpdateProjection(
      db,
      this.queries,
      this.writes,
      now,
      createId,
    );
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
    this.db.run(
      `INSERT INTO cooking_pending_delivery(
           submission_item_id, last_candidate_at, eligible_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(submission_item_id) DO UPDATE SET
           last_candidate_at = excluded.last_candidate_at,
           eligible_at = excluded.eligible_at`,
      [row.submission_item_id, candidateAt, eligibleAt],
    );
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
          submissionId:
            this.queries.itemSource(submission_item_id).submission_id,
        });
    }
    for (const item of prepared)
      this.writes.publishInvalidation(item.submissionId, item.revision);
    return prepared.map(({ executionId }) => executionId);
  }

  freezeNow(
    actorUserId: string,
    submissionItemId: string,
    inputValue: { mutationId: string },
  ): UpdateMutationResult {
    const input = FreezeUpdateInputSchema.parse(inputValue);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_FREEZE',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.queries.itemSource(submissionItemId).submission_id,
        revision: mutation.revision,
      }),
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
    return result;
  }

  retryUpdate(
    actorUserId: string,
    batchId: string,
    inputValue: RetryUpdateInput,
  ): UpdateMutationResult {
    const input = RetryUpdateInputSchema.parse(inputValue);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_RETRY',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.queries.batch(batchId).submission_id,
        revision: mutation.revision,
      }),
      perform: () => {
        const batch = this.requireBatchResponsible(actorUserId, batchId);
        this.requireBatchVersion(batch, input.expectedVersion);
        if (batch.state !== 'FAILED')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有失败的更新批次可以重新执行',
          );
        const latest = this.queries.latestAttempt(batchId);
        if (!latest || !isTerminal(latest.state))
          throw new PlatformError('RESOURCE_CONFLICT', '当前更新执行尚未结束');
        const source = this.queries.itemSource(batch.submission_item_id);
        const deployment = DeploymentMethodSchema.parse(
          JSON.parse(batch.deployment_json),
        );
        const externalReport =
          deployment.kind === 'CI_CD'
            ? this.queries.latestUnconsumedFailedReport(batchId)
            : undefined;
        const attachmentIds = externalReport
          ? this.queries.externalReportAttachmentIds(externalReport.id)
          : [];
        if (!batch.session_id)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '原更新任务不存在，不能自动重建',
          );
        const previousExecution = this.executions.get(latest.execution_id);
        const continuationInput = externalReport
          ? buildUpdateExternalFailureInput({
              reportRound: externalReport.round,
              summary: externalReport.summary!,
              attachments: this.queries
                .externalReportAttachments(externalReport.id)
                .map(({ id, original_name }) => ({
                  fileId: id,
                  originalName: original_name,
                })),
            })
          : buildUpdateRetryInput();
        const attemptId = this.createId();
        const execution = this.executions.enqueue({
          owner: { namespace: 'cooking', kind: 'UPDATE_BATCH', id: attemptId },
          attempt: latest.attempt + 1,
          previousExecutionId: latest.execution_id,
          runnerId: source.runner_id,
          bindingId: source.binding_id,
          priority: 0,
          approvalPolicy: 'never',
          codexTurn: createContinuationCodexTurn({
            taskId: batch.session_id,
            taskSkillBinding: requireTaskSkillBinding(previousExecution),
            text: continuationInput,
            outputJsonSchema:
              deployment.kind === 'LOCAL_SCRIPT'
                ? (LocalScriptUpdateOutputJsonSchema as JsonObject)
                : (CiCdUpdateOutputJsonSchema as JsonObject),
          }),
          workspace: {
            key: `update-batch:${batchId}`,
            isolation: 'DETACHED_WORKTREE',
            baseRef: `origin/${source.target_branch}`,
          },
          attachmentIds,
        });
        const now = this.now().toISOString();
        this.db.run(
          `INSERT INTO cooking_update_attempt(
               id, batch_id, execution_id, continuation_report_id, attempt,
               outcome_json, created_at, finished_at
             ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
          [
            attemptId,
            batchId,
            execution.id,
            externalReport?.id ?? null,
            latest.attempt + 1,
            now,
          ],
        );
        const update = this.db.run(
          `UPDATE cooking_update_batch
             SET state = 'READY', active_execution_id = ?,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'FAILED'`,
          [execution.id, now, batchId, input.expectedVersion],
        );
        if (update.changes !== 1) throw staleBatch();
        const revision = this.writes.bumpRevision(batch.submission_id, now);
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
              projectId: this.queries.itemSource(batch.submission_item_id)
                .project_id,
              action: 'UPDATE_BATCH_RETRIED',
              targetType: 'UPDATE_BATCH',
              targetId: batchId,
              details: { executionId: execution.id },
            },
          ],
        };
      },
    });
    return result;
  }

  synchronizeSession(
    actorUserId: string,
    batchId: string,
    inputValue: SynchronizeUpdateSessionInput,
  ): UpdateMutationResult {
    const input = RetryUpdateInputSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_SESSION_SYNC',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.queries.batch(batchId).submission_id,
        revision: mutation.revision,
      }),
      perform: () => {
        const batch = this.requireBatchResponsible(actorUserId, batchId);
        this.requireBatchVersion(batch, input.expectedVersion);
        const latest = this.queries.latestAttempt(batchId);
        if (
          batch.state !== 'FAILED' ||
          !latest ||
          !isTerminal(latest.state) ||
          !batch.session_id
        )
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前没有可同步的失败更新会话',
          );
        if (this.queries.hasActiveSessionSync(batchId))
          throw new PlatformError('RESOURCE_CONFLICT', '更新会话正在同步');
        const source = this.queries.itemSource(batch.submission_item_id);
        const previousExecution = this.executions.get(latest.execution_id);
        if (!previousExecution.codexTurn)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '原更新任务缺少结果约束，不能同步',
          );
        const syncId = this.createId();
        const execution = this.executions.enqueue({
          id: this.createId(),
          owner: { namespace: 'cooking', kind: 'SESSION_SYNC', id: syncId },
          attempt: 1,
          previousExecutionId: latest.execution_id,
          runnerId: source.runner_id,
          bindingId: source.binding_id,
          priority: 0,
          approvalPolicy: 'never',
          codexTurn: {
            kind: 'READ_SESSION',
            taskId: batch.session_id,
            outputJsonSchema: previousExecution.codexTurn.outputJsonSchema,
            resultAssertions: previousExecution.codexTurn.resultAssertions,
          },
          workspace: null,
          attachmentIds: [],
        });
        const now = this.now().toISOString();
        this.db.run(
          `INSERT INTO cooking_update_session_sync(id, batch_id, execution_id, session_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [syncId, batchId, execution.id, batch.session_id, now],
        );
        const revision = this.writes.bumpRevision(batch.submission_id, now);
        return {
          result: {
            batchId,
            batchVersion: batch.version,
            executionId: execution.id,
            revision,
          },
          resourceId: batchId,
          audits: [
            {
              projectId: source.project_id,
              action: 'UPDATE_SESSION_SYNC_REQUESTED',
              targetType: 'UPDATE_BATCH',
              targetId: batchId,
              details: { executionId: execution.id },
            },
          ],
        };
      },
    });
  }

  reportExternalDeployment(
    actorUserId: string,
    batchId: string,
    inputValue: ExternalDeploymentReportInput,
  ): UpdateMutationResult {
    const input = ExternalDeploymentReportInputSchema.parse(inputValue);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_REPORT_EXTERNAL',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.queries.batch(batchId).submission_id,
        revision: mutation.revision,
      }),
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
        requireBindableFiles(this.db, actorUserId, input.attachmentIds);
        const now = this.now().toISOString();
        const reportId = this.createId();
        const reportRound = this.queries.nextExternalReportRound(batchId);
        this.db.run(
          `INSERT INTO cooking_external_deployment_report(
               id, batch_id, round, outcome, summary,
               reported_by_user_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            reportId,
            batchId,
            reportRound,
            input.outcome,
            input.summary?.trim() || null,
            actorUserId,
            now,
          ],
        );
        input.attachmentIds.forEach((fileId, position) =>
          this.db.run(
            `INSERT INTO cooking_external_deployment_report_attachment(
                 file_id, report_id, position
               ) VALUES (?, ?, ?)`,
            [fileId, reportId, position],
          ),
        );
        const state = input.outcome === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED';
        const batchUpdate = this.db.run(
          `UPDATE cooking_update_batch
             SET state = ?, active_execution_id = NULL,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'WAITING_EXTERNAL'`,
          [state, now, batchId, input.expectedVersion],
        );
        if (batchUpdate.changes !== 1) throw staleBatch();
        if (input.outcome === 'SUCCEEDED')
          this.projection.completeBatchBugs(batchId, now);
        const revision = this.writes.bumpRevision(batch.submission_id, now);
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
              projectId: this.queries.itemSource(batch.submission_item_id)
                .project_id,
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
    return result;
  }

  resolveInteraction(
    actorUserId: string,
    interactionId: string,
    inputValue: ResolveUpdateInteractionInput,
  ): UpdateMutationResult {
    const input = ResolveUpdateInteractionInputSchema.parse(inputValue);
    const source = this.queries.interactionSource(interactionId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_INTERACTION_RESOLVE',
      resourceType: 'EXECUTION_INTERACTION',
      resultSchema: UpdateMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.queries.batch(source.batch_id).submission_id,
        revision: mutation.revision,
      }),
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
        const update = this.db.run(
          `UPDATE cooking_update_batch
             SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'RUNNING'`,
          [now, batch.id, input.expectedVersion],
        );
        if (update.changes !== 1) throw staleBatch();
        const revision = this.writes.bumpRevision(batch.submission_id, now);
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
              projectId: this.queries.itemSource(batch.submission_item_id)
                .project_id,
              action: 'UPDATE_INTERACTION_RESOLVED',
              targetType: 'EXECUTION_INTERACTION',
              targetId: interactionId,
              details: { batchId: batch.id, executionId: source.execution_id },
            },
          ],
        };
      },
    });
    return result;
  }

  private freezeItem(
    submissionItemId: string,
    now: string,
    requireDue: boolean,
  ): FrozenBatch | undefined {
    const source = this.queries.itemSource(submissionItemId);
    if (
      source.submission_status !== 'ACTIVE' ||
      !environmentOwned(this.db, submissionItemId)
    )
      return undefined;
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
    if (this.queries.activeBatch(submissionItemId)) return undefined;
    const candidates = this.queries.candidates(submissionItemId);
    if (!candidates.length) {
      this.db.run(
        'DELETE FROM cooking_pending_delivery WHERE submission_item_id = ?',
        [submissionItemId],
      );
      return undefined;
    }
    const batchId = this.createId();
    const attemptId = this.createId();
    const executionId = this.createId();
    const workspaceKey = `update-batch:${batchId}`;
    const executionBrief = buildInitialUpdateBrief({
      targetBranch: source.target_branch,
      environmentName: source.environment_name,
      entries: candidates.map((candidate) => ({
        bugTitle: candidate.title,
        commits: parseCommits(candidate.pending_commits_json),
      })),
      deployment:
        deployment.kind === 'LOCAL_SCRIPT'
          ? { mode: 'LOCAL_SCRIPT', command: deployment.command }
          : { mode: 'CI_CD' },
    });
    this.db.run(
      `INSERT INTO cooking_update_batch(
           id, submission_id, submission_item_id, state, version,
           active_execution_id, session_id, deployment_json, frozen_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'READY', 1, NULL, NULL, ?, ?, ?, ?)`,
      [
        batchId,
        source.submission_id,
        submissionItemId,
        source.deployment_json,
        now,
        now,
        now,
      ],
    );
    const insertEntry = this.db.prepare(
      `INSERT INTO cooking_update_batch_entry(
         batch_id, bug_id, position, commits_json, manual_operations_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    candidates.forEach((candidate, position) =>
      insertEntry.run(
        batchId,
        candidate.bug_id,
        position,
        candidate.pending_commits_json,
        candidate.pending_manual_operations_json,
      ),
    );
    const execution = this.executions.enqueue({
      id: executionId,
      owner: { namespace: 'cooking', kind: 'UPDATE_BATCH', id: attemptId },
      attempt: 1,
      previousExecutionId: null,
      runnerId: source.runner_id,
      bindingId: source.binding_id,
      priority: 0,
      approvalPolicy: 'never',
      codexTurn: createInitialCodexTurn({
        requiredSkillName: 'agent-party-time-integrate-update-batch',
        executionBrief,
        outputJsonSchema:
          deployment.kind === 'LOCAL_SCRIPT'
            ? (LocalScriptUpdateOutputJsonSchema as JsonObject)
            : (CiCdUpdateOutputJsonSchema as JsonObject),
      }),
      workspace: {
        key: workspaceKey,
        isolation: 'DETACHED_WORKTREE',
        baseRef: `origin/${source.target_branch}`,
      },
      attachmentIds: [],
    });
    this.db.run(
      `INSERT INTO cooking_update_attempt(
           id, batch_id, execution_id, continuation_report_id, attempt,
           outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, NULL, 1, NULL, ?, NULL)`,
      [attemptId, batchId, execution.id, now],
    );
    this.db.run(
      `UPDATE cooking_update_batch SET active_execution_id = ? WHERE id = ?`,
      [execution.id, batchId],
    );
    const bugUpdate = this.db.run(
      `UPDATE cooking_bug
         SET stage = 'UPDATING', version = version + 1, updated_at = ?
         WHERE submission_item_id = ? AND stage = 'WAITING_FOR_UPDATE'
           AND id IN (
             SELECT bug_id FROM cooking_update_batch_entry WHERE batch_id = ?
           )`,
      [now, submissionItemId, batchId],
    );
    if (bugUpdate.changes !== candidates.length)
      throw new PlatformError('STALE_STATE', '待更新缺陷集合已变化');
    this.db.run(
      'DELETE FROM cooking_pending_delivery WHERE submission_item_id = ?',
      [submissionItemId],
    );
    const revision = this.writes.bumpRevision(source.submission_id, now);
    return { batchId, executionId: execution.id, revision };
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
      this.db.run(
        'DELETE FROM cooking_pending_delivery WHERE submission_item_id = ?',
        [submissionItemId],
      );
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
    this.db.run(
      `INSERT INTO cooking_pending_delivery(
           submission_item_id, last_candidate_at, eligible_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(submission_item_id) DO UPDATE SET
           last_candidate_at = excluded.last_candidate_at,
           eligible_at = excluded.eligible_at`,
      [submissionItemId, candidateAt, eligibleAt],
    );
  }

  private requireResponsible(
    userId: string,
    submissionItemId: string,
  ): ItemSourceRow {
    const source = this.queries.itemSource(submissionItemId);
    requireSubmissionAccess(this.db, userId, source.submission_id);
    if (source.responsible_user_id !== userId)
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有该工程负责人可以操作更新批次',
      );
    if (source.submission_status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能更新');
    requireEnvironment(this.db, submissionItemId);
    return source;
  }

  private requireBatchResponsible(userId: string, batchId: string): BatchRow {
    const batch = this.queries.batch(batchId);
    this.requireResponsible(userId, batch.submission_item_id);
    return batch;
  }

  private requireBatchVersion(batch: BatchRow, expectedVersion: number): void {
    if (batch.version !== expectedVersion) throw staleBatch();
  }
}
