import { DeploymentMethodSchema } from '@/cooking/engineering/contract';
import type { CookingExecutionProjectionEvent } from '@/cooking/runtime/execution-projection';
import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import {
  isTerminal,
  requireTaskSkillBinding,
} from '@/cooking/shared/server/execution-state';
import { requireBindableFiles } from '@/cooking/shared/server/attachments';
import { requireEnvironment } from '@/cooking/submissions/server/environment-access';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { createContinuationCodexTurn } from '@/platform/execution/codex-turn';
import { ExecutionService } from '@/platform/execution/service';
import { randomUUID } from 'node:crypto';
import {
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
import type { BatchRow, ItemSourceRow } from './records';
import { UpdateProjection } from './update-projection';
import { UpdateQueries } from './update-queries';
import { UpdateDelivery } from './update-delivery';

import { staleBatch } from './results';

export class UpdateService {
  private readonly writes: TestSubmissionWriteStore;
  private readonly queries: UpdateQueries;
  private readonly projection: UpdateProjection;
  private readonly delivery: UpdateDelivery;
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
    this.delivery = new UpdateDelivery(
      db,
      executions,
      this.queries,
      this.writes,
      now,
      createId,
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
    this.delivery.recordCandidateAvailable(bugId, candidateAt);
  }

  recalculatePendingDeliveryForBug(bugId: string): void {
    this.delivery.recalculatePendingDeliveryForBug(bugId);
  }

  prepareDueExecutions(nowValue: Date = this.now()): string[] {
    return this.delivery.prepareDueExecutions(nowValue);
  }

  freezeNow(
    actorUserId: string,
    submissionItemId: string,
    inputValue: { mutationId: string },
  ): UpdateMutationResult {
    const input = FreezeUpdateInputSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_FREEZE',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      submissionId: () =>
        this.queries.itemSource(submissionItemId).submission_id,
      perform: () => {
        const source = this.requireResponsible(actorUserId, submissionItemId);
        DeploymentMethodSchema.parse(JSON.parse(source.deployment_json));
        const now = this.now().toISOString();
        const frozen = this.delivery.freezeItem(submissionItemId, now, false);
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
          audit: {
            projectId: source.project_id,
            action: 'UPDATE_BATCH_FROZEN',
            details: { submissionItemId, mode: 'IMMEDIATE' },
          },
        };
      },
    });
  }

  retryUpdate(
    actorUserId: string,
    batchId: string,
    inputValue: RetryUpdateInput,
  ): UpdateMutationResult {
    const input = RetryUpdateInputSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_RETRY',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      submissionId: () => this.queries.batch(batchId).submission_id,
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
            taskSkillBinding: requireTaskSkillBinding(
              previousExecution,
              '更新',
            ),
            text: continuationInput,
            outputJsonSchema:
              deployment.kind === 'LOCAL_SCRIPT'
                ? LocalScriptUpdateOutputJsonSchema
                : CiCdUpdateOutputJsonSchema,
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
          audit: {
            projectId: this.queries.itemSource(batch.submission_item_id)
              .project_id,
            action: 'UPDATE_BATCH_RETRIED',
            details: { executionId: execution.id },
          },
        };
      },
    });
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
      submissionId: () => this.queries.batch(batchId).submission_id,
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
          audit: {
            projectId: source.project_id,
            action: 'UPDATE_SESSION_SYNC_REQUESTED',
            details: { executionId: execution.id },
          },
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
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_BATCH_REPORT_EXTERNAL',
      resourceType: 'UPDATE_BATCH',
      resultSchema: UpdateMutationResultSchema,
      submissionId: () => this.queries.batch(batchId).submission_id,
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
          audit: {
            projectId: this.queries.itemSource(batch.submission_item_id)
              .project_id,
            action:
              input.outcome === 'SUCCEEDED'
                ? 'EXTERNAL_DEPLOYMENT_SUCCEEDED'
                : 'EXTERNAL_DEPLOYMENT_FAILED',
            details: {
              reportId,
              round: reportRound,
              attachmentCount: input.attachmentIds.length,
            },
          },
        };
      },
    });
  }

  resolveInteraction(
    actorUserId: string,
    interactionId: string,
    inputValue: ResolveUpdateInteractionInput,
  ): UpdateMutationResult {
    const input = ResolveUpdateInteractionInputSchema.parse(inputValue);
    const source = this.queries.interactionSource(interactionId);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'UPDATE_INTERACTION_RESOLVE',
      resourceType: 'EXECUTION_INTERACTION',
      resultSchema: UpdateMutationResultSchema,
      submissionId: () => this.queries.batch(source.batch_id).submission_id,
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
          audit: {
            projectId: this.queries.itemSource(batch.submission_item_id)
              .project_id,
            action: 'UPDATE_INTERACTION_RESOLVED',
            details: { batchId: batch.id, executionId: source.execution_id },
          },
        };
      },
    });
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
