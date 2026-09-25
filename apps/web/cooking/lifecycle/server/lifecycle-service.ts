import type { RepairService } from '@/cooking/repair/server/repair-service';
import type { CookingExecutionProjectionEvent } from '@/cooking/runtime/execution-projection';
import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import { requireBindableFiles } from '@/cooking/shared/server/attachments';
import {
  environmentObservers,
  requireEnvironment,
} from '@/cooking/submissions/server/environment-access';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ExecutionService } from '@/platform/execution/service';
import { type Execution } from '@agent-party-time/execution-contract';
import { randomUUID } from 'node:crypto';
import {
  BugLifecycleMutationResultSchema,
  CloseSubmissionMutationResultSchema,
  LifecycleCommandInputSchema,
  ReopenBugInputSchema,
  VerifyBugInputSchema,
  type BugLifecycleMutationResult,
  type CleanupInteractionView,
  type CleanupMutationResult,
  type CloseSubmissionMutationResult,
  type LifecycleCommandInput,
  type LifecycleWorkspaceProjection,
  type ReopenBugInput,
  type ResolveCleanupInteractionInput,
  type VerifyBugInput,
} from '../contract';
import { CleanupService } from './cleanup-service';
import { LifecycleQueries } from './lifecycle-queries';
import type { BugSourceRow } from './records';
import { isTerminal, staleLifecycle } from './results';

export class LifecycleService {
  private readonly writes: TestSubmissionWriteStore;
  private readonly queries: LifecycleQueries;
  private readonly cleanup: CleanupService;

  constructor(
    private readonly db: AppDatabase,
    private readonly repairs: RepairService,
    private readonly executions: ExecutionService = new ExecutionService(db),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    onInvalidated: (submissionId: string, revision: number) => void = () => {},
  ) {
    this.queries = new LifecycleQueries(db);
    this.writes = new TestSubmissionWriteStore(
      db,
      now,
      createId,
      onInvalidated,
    );
    this.cleanup = new CleanupService(
      db,
      executions,
      this.writes,
      now,
      createId,
    );
  }

  retryCleanup(
    actorUserId: string,
    cleanupId: string,
    input: LifecycleCommandInput,
  ): CleanupMutationResult {
    return this.cleanup.retryCleanup(actorUserId, cleanupId, input);
  }

  resolveCleanupInteraction(
    actorUserId: string,
    interactionId: string,
    input: ResolveCleanupInteractionInput,
  ): CleanupMutationResult {
    return this.cleanup.resolveCleanupInteraction(
      actorUserId,
      interactionId,
      input,
    );
  }

  projectExecution(event: CookingExecutionProjectionEvent): void {
    this.cleanup.projectExecution(event);
  }

  workspace(
    userId: string,
    submissionId: string,
  ): LifecycleWorkspaceProjection {
    return this.queries.workspace(userId, submissionId);
  }

  cleanupInteractions(
    userId: string,
    submissionId: string,
  ): CleanupInteractionView[] {
    return this.queries.cleanupInteractions(userId, submissionId);
  }

  verifyBug(
    actorUserId: string,
    bugId: string,
    inputValue: VerifyBugInput,
  ): BugLifecycleMutationResult {
    const input = VerifyBugInputSchema.parse(inputValue);
    return this.writeBugTransition(
      actorUserId,
      bugId,
      input,
      'BUG_VERIFY',
      (source) => {
        if (source.submission_item_id)
          requireEnvironment(this.db, source.submission_item_id, true);
        this.requireBugVersion(source, input.expectedVersion);
        if (source.stage !== 'WAITING_FOR_VERIFICATION')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前缺陷不在待验证阶段',
          );
        const now = this.now().toISOString();
        const round = this.nextVerificationRound(bugId);
        if (input.result === 'PASSED') {
          requireBindableFiles(this.db, actorUserId, input.attachmentIds);
          if (input.attachmentIds.length)
            throw new PlatformError(
              'VALIDATION_FAILED',
              '验证通过不需要上传失败证据',
            );
          this.db.run(
            `INSERT INTO cooking_verification_record(
                 id, bug_id, round, result, comment, repair_attempt,
                 verified_by_user_id, created_at
               ) VALUES (?, ?, ?, 'PASSED', ?, NULL, ?, ?)`,
            [
              this.createId(),
              bugId,
              round,
              input.comment?.trim() || null,
              actorUserId,
              now,
            ],
          );
          this.updateBugStage(bugId, 'WAITING_FOR_VERIFICATION', 'DONE', now);
          const revision = this.writes.bumpRevision(source.submission_id, now);
          return {
            revision: revision,

            action: 'BUG_VERIFICATION_PASSED',
            details: {
              round,
              comment: Boolean(input.comment),
            },
          };
        }
        const failure = this.recordVerificationFailureAndContinue(
          actorUserId,
          source,
          round,
          input.feedback,
          input.attachmentIds,
          now,
        );
        return {
          revision: failure.revision,
          executionId: failure.executionId,
          action: 'BUG_VERIFICATION_FAILED',
          details: {
            round,
            attachmentCount: input.attachmentIds.length,
            executionId: failure.executionId,
          },
        };
      },
    );
  }

  reopenBug(
    actorUserId: string,
    bugId: string,
    inputValue: ReopenBugInput,
  ): BugLifecycleMutationResult {
    const input = ReopenBugInputSchema.parse(inputValue);
    return this.writeBugTransition(
      actorUserId,
      bugId,
      input,
      'BUG_REOPEN',
      (source) => {
        this.requireBugVersion(source, input.expectedVersion);
        if (source.stage !== 'DONE')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有已完成缺陷可以重开',
          );
        const now = this.now().toISOString();
        const round = this.nextReopenRound(bugId);
        const repairAttempt = this.nextRepairAttempt(bugId);
        const reopenId = this.createId();
        requireBindableFiles(this.db, actorUserId, input.attachmentIds);
        this.db.run(
          `INSERT INTO cooking_reopen_record(
               id, bug_id, round, feedback, repair_attempt,
               reopened_by_user_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            reopenId,
            bugId,
            round,
            input.feedback.trim(),
            repairAttempt,
            actorUserId,
            now,
          ],
        );
        this.bindLifecycleAttachments(
          'cooking_reopen_attachment',
          'reopen_id',
          reopenId,
          input.attachmentIds,
          now,
        );
        const update = this.db.run(
          `UPDATE cooking_bug
             SET stage = 'REPAIRING', version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'DONE'`,
          [now, source.id, source.version],
        );
        if (update.changes !== 1) throw staleLifecycle('缺陷');
        const executionId = this.repairs.createContinuationExecution(
          source.id,
          `第 ${round} 次重新打开：${input.feedback.trim()}`,
          input.attachmentIds,
        );
        const revision = this.writes.bumpRevision(source.submission_id, now);
        return {
          revision: revision,
          executionId: executionId,
          action: 'BUG_REOPENED',
          details: {
            round,
            repairAttempt,
            attachmentCount: input.attachmentIds.length,
            executionId,
          },
        };
      },
    );
  }

  cancelBug(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
  ): BugLifecycleMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    return this.writeBugTransition(
      actorUserId,
      bugId,
      input,
      'BUG_CANCEL',
      (source) => {
        this.requireBugVersion(source, input.expectedVersion);
        if (source.stage !== 'WAITING_FOR_REPAIR')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有待修复缺陷可以取消',
          );
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE cooking_bug
             SET stage = 'CANCELLED', version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = ?`,
          [now, bugId, input.expectedVersion, 'WAITING_FOR_REPAIR'],
        );
        if (update.changes !== 1) throw staleLifecycle('缺陷');
        this.recordBugTransition(bugId, 'CANCELLED', actorUserId, now);
        const revision = this.writes.bumpRevision(source.submission_id, now);
        return {
          revision: revision,

          action: 'BUG_CANCELLED',
          details: {},
        };
      },
    );
  }

  restoreBug(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
  ): BugLifecycleMutationResult {
    return this.changeStoredBugState(
      actorUserId,
      bugId,
      inputValue,
      'BUG_RESTORE',
      'CANCELLED',
      'WAITING_FOR_REPAIR',
      'RESTORED',
      'BUG_RESTORED',
    );
  }

  archiveBug(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
  ): BugLifecycleMutationResult {
    return this.changeArchiveState(actorUserId, bugId, inputValue, true);
  }

  unarchiveBug(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
  ): BugLifecycleMutationResult {
    return this.changeArchiveState(actorUserId, bugId, inputValue, false);
  }

  closeSubmission(
    actorUserId: string,
    submissionId: string,
    inputValue: LifecycleCommandInput,
  ): CloseSubmissionMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    const environmentInvalidations = new Map<string, number>();
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'SUBMISSION_CLOSE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: CloseSubmissionMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: mutation.submissionId,
        revision: mutation.revision,
      }),
      perform: () => {
        const submission = this.requireSubmissionTester(
          actorUserId,
          submissionId,
        );
        if (submission.version !== input.expectedVersion)
          throw staleLifecycle('提测单');
        const nonTerminal = this.db.get(
          `SELECT COUNT(*) count FROM cooking_bug
             WHERE submission_id = ? AND stage NOT IN ('DONE', 'CANCELLED')`,
          submissionId,
        ) as { count: number };
        if (nonTerminal.count > 0)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '仍有未完成缺陷，不能关闭提测单',
          );
        if (this.hasActiveSubmissionExecution(submissionId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '仍有修复或更新执行未结束，不能关闭提测单',
          );
        const unfinishedBatch = this.db.get(
          `SELECT 1 blocked FROM cooking_update_batch
             WHERE submission_id = ? AND state != 'COMPLETED'
             LIMIT 1`,
          submissionId,
        );
        if (unfinishedBatch)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '仍有未完成更新批次，不能关闭提测单',
          );
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE cooking_test_submission
             SET status = 'CLOSED', version = version + 1,
                 updated_at = ?, closed_at = ?
             WHERE id = ? AND status = 'ACTIVE' AND version = ?
            `,
          [now, now, submissionId, input.expectedVersion],
        );
        if (update.changes !== 1) throw staleLifecycle('提测单');
        const revision = this.writes.bumpRevision(submissionId, now);
        const heldEnvironments = this.db.all<{ environment_id: string }>(
          'SELECT environment_id FROM cooking_submission_environment_lock WHERE submission_id = ?',
          submissionId,
        );
        for (const { environment_id } of heldEnvironments)
          for (const observer of environmentObservers(
            this.db,
            environment_id,
            submissionId,
          ))
            environmentInvalidations.set(observer, 0);
        for (const observer of environmentInvalidations.keys())
          environmentInvalidations.set(
            observer,
            this.writes.bumpRevision(observer, now),
          );
        this.db.run(
          'DELETE FROM cooking_submission_environment_lock WHERE submission_id = ?',
          [submissionId],
        );
        const items = this.db.all<{ id: string }>(
          `SELECT id FROM cooking_submission_item
             WHERE submission_id = ? ORDER BY position`,
          submissionId,
        );
        const cleanupExecutionIds: string[] = [];
        for (const item of items) {
          const workspaceKeys = this.queries.cleanupScopeForItem(item.id);
          if (!workspaceKeys.length) continue;
          const cleanup = this.cleanup.createCleanup({
            reason: 'SUBMISSION_CLOSED',
            subjectId: submissionId,
            submissionId,
            submissionItemId: item.id,
            workspaceKeys,
            now,
          });
          cleanupExecutionIds.push(cleanup.executionId);
        }
        return {
          result: {
            submissionId,
            submissionVersion: input.expectedVersion + 1,
            cleanupExecutionIds,
            revision,
          },
          resourceId: submissionId,
          audits: [
            {
              projectId: submission.project_id,
              action: 'SUBMISSION_CLOSED',
              targetType: 'TEST_SUBMISSION',
              targetId: submissionId,
              details: { cleanupCount: cleanupExecutionIds.length },
            },
          ],
        };
      },
    });
    for (const [id, revision] of environmentInvalidations)
      this.writes.publishInvalidation(id, revision);
    return result;
  }

  private changeStoredBugState(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
    operation: string,
    from: 'CANCELLED',
    to: 'WAITING_FOR_REPAIR',
    transition: 'RESTORED',
    auditAction: string,
  ): BugLifecycleMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    return this.writeBugTransition(
      actorUserId,
      bugId,
      input,
      operation,
      (source) => {
        this.requireBugVersion(source, input.expectedVersion);
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE cooking_bug
             SET stage = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = ?`,
          [to, now, bugId, input.expectedVersion, from],
        );
        if (update.changes !== 1)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前缺陷不能恢复到待修复',
          );
        this.recordBugTransition(bugId, transition, actorUserId, now);
        const revision = this.writes.bumpRevision(source.submission_id, now);
        return {
          revision: revision,

          action: auditAction,
          details: {},
        };
      },
    );
  }

  private changeArchiveState(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
    archived: boolean,
  ): BugLifecycleMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    return this.writeBugTransition(
      actorUserId,
      bugId,
      input,
      archived ? 'BUG_ARCHIVE' : 'BUG_UNARCHIVE',
      (source) => {
        this.requireBugVersion(source, input.expectedVersion);
        if (source.stage !== 'DONE')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有已完成缺陷可以整理归档',
          );
        if (archived === Boolean(source.archived_at))
          throw new PlatformError(
            'INVALID_TRANSITION',
            archived ? '缺陷已经归档' : '缺陷尚未归档',
          );
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE cooking_bug
             SET archived_at = ?, archived_by_user_id = ?,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'DONE'
               AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}`,
          [
            archived ? now : null,
            archived ? actorUserId : null,
            now,
            bugId,
            input.expectedVersion,
          ],
        );
        if (update.changes !== 1) throw staleLifecycle('缺陷');
        const revision = this.writes.bumpRevision(source.submission_id, now);
        return {
          revision: revision,

          action: archived ? 'BUG_ARCHIVED' : 'BUG_UNARCHIVED',
          details: {},
        };
      },
    );
  }

  private writeBugTransition(
    actorUserId: string,
    bugId: string,
    input: LifecycleCommandInput,
    operation: string,
    perform: (source: BugSourceRow) => {
      revision: number;
      executionId?: string;
      action: string;
      details: unknown;
    },
  ): BugLifecycleMutationResult {
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation,
      resourceType: 'BUG',
      resultSchema: BugLifecycleMutationResultSchema,
      invalidation: (result) => ({
        submissionId: this.queries.bugSource(bugId).submission_id,
        revision: result.revision,
      }),
      perform: () => {
        const source = this.requireTester(actorUserId, bugId);
        const outcome = perform(source);
        return {
          resourceId: bugId,
          result: {
            bugId,
            bugVersion: input.expectedVersion + 1,
            executionId: outcome.executionId ?? null,
            cleanupId: null,
            revision: outcome.revision,
          },
          audits: [this.audit(source, outcome.action, outcome.details)],
        };
      },
    });
  }

  private recordBugTransition(
    bugId: string,
    kind: 'CANCELLED' | 'RESTORED',
    actorUserId: string,
    now: string,
  ): void {
    this.db.run(
      `INSERT INTO cooking_bug_lifecycle_event(
           id, bug_id, kind, actor_user_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      [this.createId(), bugId, kind, actorUserId, now],
    );
  }

  private recordVerificationFailureAndContinue(
    actorUserId: string,
    source: BugSourceRow,
    round: number,
    feedback: string,
    attachmentIds: string[],
    now: string,
  ): { executionId: string; revision: number } {
    requireBindableFiles(this.db, actorUserId, attachmentIds);
    const verificationId = this.createId();
    const repairAttempt = this.nextRepairAttempt(source.id);
    this.db.run(
      `INSERT INTO cooking_verification_record(
           id, bug_id, round, result, comment, repair_attempt,
           verified_by_user_id, created_at
         ) VALUES (?, ?, ?, 'FAILED', ?, ?, ?, ?)`,
      [
        verificationId,
        source.id,
        round,
        feedback.trim(),
        repairAttempt,
        actorUserId,
        now,
      ],
    );
    this.bindLifecycleAttachments(
      'cooking_verification_attachment',
      'verification_id',
      verificationId,
      attachmentIds,
      now,
    );
    const update = this.db.run(
      `UPDATE cooking_bug
         SET stage = 'REPAIRING', version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND stage = 'WAITING_FOR_VERIFICATION'`,
      [now, source.id, source.version],
    );
    if (update.changes !== 1) throw staleLifecycle('缺陷');
    const executionId = this.repairs.createContinuationExecution(
      source.id,
      `测试负责人第 ${round} 轮验证未通过：${feedback.trim()}`,
      attachmentIds,
    );
    return {
      executionId,
      revision: this.writes.bumpRevision(source.submission_id, now),
    };
  }

  private bindLifecycleAttachments(
    table: 'cooking_verification_attachment' | 'cooking_reopen_attachment',
    ownerColumn: 'verification_id' | 'reopen_id',
    ownerId: string,
    fileIds: string[],
    now: string,
  ): void {
    const statement = this.db.prepare(
      `INSERT INTO ${table}(${ownerColumn}, file_id, position, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    fileIds.forEach((fileId, position) =>
      statement.run(ownerId, fileId, position, now),
    );
  }

  private requireTester(userId: string, bugId: string): BugSourceRow {
    const source = this.queries.bugSource(bugId);
    requireSubmissionAccess(this.db, userId, source.submission_id);
    if (source.submission_status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能修改');
    if (source.tester_user_id !== userId)
      throw new PlatformError('PERMISSION_DENIED', '只有测试负责人可以操作');
    return source;
  }

  private requireSubmissionTester(userId: string, submissionId: string) {
    const row = this.db.get(
      `SELECT project_id, tester_user_id, status, version
         FROM cooking_test_submission WHERE id = ?`,
      submissionId,
    ) as
      | {
          project_id: string;
          tester_user_id: string;
          status: 'ACTIVE' | 'CLOSED';
          version: number;
        }
      | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '提测单不存在');
    requireSubmissionAccess(this.db, userId, submissionId);
    if (row.status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '提测单已经关闭');
    if (row.tester_user_id !== userId)
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有测试负责人可以关闭提测单',
      );
    return row;
  }

  private requireBugVersion(
    source: BugSourceRow,
    expectedVersion: number,
  ): void {
    if (source.version !== expectedVersion) throw staleLifecycle('缺陷');
  }

  private updateBugStage(
    bugId: string,
    from: string,
    to: string,
    now: string,
  ): void {
    const update = this.db.run(
      `UPDATE cooking_bug
         SET stage = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND stage = ?`,
      [to, now, bugId, from],
    );
    if (update.changes !== 1) throw staleLifecycle('缺陷');
  }

  private nextVerificationRound(bugId: string): number {
    return (
      this.db.get(
        `SELECT COALESCE(MAX(round), 0) + 1 round
           FROM cooking_verification_record WHERE bug_id = ?`,
        bugId,
      ) as { round: number }
    ).round;
  }

  private nextReopenRound(bugId: string): number {
    return (
      this.db.get(
        `SELECT COALESCE(MAX(round), 0) + 1 round
           FROM cooking_reopen_record WHERE bug_id = ?`,
        bugId,
      ) as { round: number }
    ).round;
  }

  private nextRepairAttempt(bugId: string): number {
    return (
      this.db.get(
        `SELECT COALESCE(MAX(attempt), 0) + 1 attempt
           FROM cooking_repair_attempt WHERE bug_id = ?`,
        bugId,
      ) as { attempt: number }
    ).attempt;
  }

  private hasActiveRepair(bugId: string): boolean {
    const row = this.db.get(
      `SELECT execution.state
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.bug_id = ? ORDER BY attempt.attempt DESC LIMIT 1`,
      bugId,
    ) as { state: Execution['state'] } | undefined;
    return Boolean(row && !isTerminal(row.state));
  }

  private hasActiveSubmissionExecution(submissionId: string): boolean {
    const row = this.db.get(
      `SELECT 1 active
         FROM platform_execution execution
         WHERE execution.state IN (
           'QUEUED', 'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION',
           'WAITING_TO_RESUME', 'CANCEL_REQUESTED'
         ) AND (
           execution.id IN (
             SELECT attempt.execution_id FROM cooking_repair_attempt attempt
             JOIN cooking_bug bug ON bug.id = attempt.bug_id
             WHERE bug.submission_id = ?
           ) OR execution.id IN (
             SELECT attempt.execution_id FROM cooking_update_attempt attempt
             JOIN cooking_update_batch batch ON batch.id = attempt.batch_id
             WHERE batch.submission_id = ?
           )
         ) LIMIT 1`,
      submissionId,
      submissionId,
    );
    return Boolean(row);
  }

  private audit(source: BugSourceRow, action: string, details: unknown) {
    return {
      projectId: source.project_id,
      action,
      targetType: 'BUG',
      targetId: source.id,
      details,
    };
  }
}
