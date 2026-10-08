import type { RepairService } from '@/cooking/repair/server/repair-service';
import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import { requireBindableFiles } from '@/cooking/shared/server/attachments';
import { requireEnvironment } from '@/cooking/submissions/server/environment-access';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ExecutionService } from '@/platform/execution/service';
import { randomUUID } from 'node:crypto';
import {
  BugLifecycleMutationResultSchema,
  LifecycleCommandInputSchema,
  ReopenBugInputSchema,
  VerifyBugInputSchema,
  type BugLifecycleMutationResult,
  type LifecycleCommandInput,
  type ReopenBugInput,
  type VerifyBugInput,
} from '../contract';
import { CleanupService } from './cleanup-service';
import { SubmissionClosure } from './submission-closure';
import { LifecycleQueries } from './lifecycle-queries';
import type { BugSourceRow } from './records';
import { staleLifecycle } from './results';

const STORED_BUG_TRANSITIONS = {
  cancel: {
    operation: 'BUG_CANCEL',
    from: 'WAITING_FOR_REPAIR',
    to: 'CANCELLED',
    event: 'CANCELLED',
    audit: 'BUG_CANCELLED',
  },
  restore: {
    operation: 'BUG_RESTORE',
    from: 'CANCELLED',
    to: 'WAITING_FOR_REPAIR',
    event: 'RESTORED',
    audit: 'BUG_RESTORED',
  },
} as const;

export class LifecycleService {
  private readonly writes: TestSubmissionWriteStore;
  private readonly queries: LifecycleQueries;
  private readonly cleanup: CleanupService;
  private readonly closure: SubmissionClosure;
  readonly retryCleanup: CleanupService['retryCleanup'] = (...args) =>
    this.cleanup.retryCleanup(...args);
  readonly resolveCleanupInteraction: CleanupService['resolveCleanupInteraction'] =
    (...args) => this.cleanup.resolveCleanupInteraction(...args);
  readonly projectExecution: CleanupService['projectExecution'] = (...args) =>
    this.cleanup.projectExecution(...args);
  readonly workspace: LifecycleQueries['workspace'] = (...args) =>
    this.queries.workspace(...args);
  readonly cleanupInteractions: LifecycleQueries['cleanupInteractions'] = (
    ...args
  ) => this.queries.cleanupInteractions(...args);
  readonly closeSubmission: SubmissionClosure['closeSubmission'] = (...args) =>
    this.closure.closeSubmission(...args);

  constructor(
    private readonly db: AppDatabase,
    private readonly repairs: RepairService,
    executions: ExecutionService = new ExecutionService(db),
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
    this.closure = new SubmissionClosure(
      db,
      this.queries,
      this.cleanup,
      this.writes,
      now,
    );
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
        requireBindableFiles(this.db, actorUserId, input.attachmentIds);
        if (input.result === 'PASSED' && input.attachmentIds.length)
          throw new PlatformError(
            'VALIDATION_FAILED',
            '验证通过不需要上传失败证据',
          );
        const verificationId = this.createId();
        const repairAttempt =
          input.result === 'FAILED' ? this.nextRepairAttempt(bugId) : null;
        this.db.run(
          `INSERT INTO cooking_verification_record(
               id, bug_id, round, result, comment, repair_attempt,
               verified_by_user_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            verificationId,
            bugId,
            round,
            input.result,
            input.result === 'PASSED'
              ? input.comment?.trim() || null
              : input.feedback.trim(),
            repairAttempt,
            actorUserId,
            now,
          ],
        );
        if (input.result === 'PASSED') {
          this.updateBugStage(bugId, 'WAITING_FOR_VERIFICATION', 'DONE', now);
          const revision = this.writes.bumpRevision(source.submission_id, now);
          return {
            revision,
            action: 'BUG_VERIFICATION_PASSED',
            details: {
              round,
              comment: Boolean(input.comment),
            },
          };
        }
        this.bindLifecycleAttachments(
          'cooking_verification_attachment',
          'verification_id',
          verificationId,
          input.attachmentIds,
          now,
        );
        const failure = this.continueRepair(
          source,
          'WAITING_FOR_VERIFICATION',
          `测试负责人第 ${round} 轮验证未通过：${input.feedback.trim()}`,
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
        const continuation = this.continueRepair(
          source,
          'DONE',
          `第 ${round} 次重新打开：${input.feedback.trim()}`,
          input.attachmentIds,
          now,
        );
        return {
          revision: continuation.revision,
          executionId: continuation.executionId,
          action: 'BUG_REOPENED',
          details: {
            round,
            repairAttempt,
            attachmentCount: input.attachmentIds.length,
            executionId: continuation.executionId,
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
    return this.changeStoredBugState(actorUserId, bugId, inputValue, 'cancel');
  }

  restoreBug(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
  ): BugLifecycleMutationResult {
    return this.changeStoredBugState(actorUserId, bugId, inputValue, 'restore');
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

  private changeStoredBugState(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
    kind: keyof typeof STORED_BUG_TRANSITIONS,
  ): BugLifecycleMutationResult {
    const transition = STORED_BUG_TRANSITIONS[kind];
    const input = LifecycleCommandInputSchema.parse(inputValue);
    return this.writeBugTransition(
      actorUserId,
      bugId,
      input,
      transition.operation,
      (source) => {
        this.requireBugVersion(source, input.expectedVersion);
        if (kind === 'cancel' && source.stage !== transition.from)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有待修复缺陷可以取消',
          );
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE cooking_bug
             SET stage = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = ?`,
          [transition.to, now, bugId, input.expectedVersion, transition.from],
        );
        if (update.changes !== 1) {
          if (kind === 'cancel') throw staleLifecycle('缺陷');
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前缺陷不能恢复到待修复',
          );
        }
        this.recordBugTransition(bugId, transition.event, actorUserId, now);
        const revision = this.writes.bumpRevision(source.submission_id, now);
        return { revision, action: transition.audit, details: {} };
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
      submissionId: () => this.queries.bugSource(bugId).submission_id,
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
          audit: this.audit(source, outcome.action, outcome.details),
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

  private continueRepair(
    source: BugSourceRow,
    fromStage: 'WAITING_FOR_VERIFICATION' | 'DONE',
    context: string,
    attachmentIds: string[],
    now: string,
  ): { executionId: string; revision: number } {
    const update = this.db.run(
      `UPDATE cooking_bug
         SET stage = 'REPAIRING', version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND stage = ?`,
      [now, source.id, source.version, fromStage],
    );
    if (update.changes !== 1) throw staleLifecycle('缺陷');
    const executionId = this.repairs.createContinuationExecution(
      source.id,
      context,
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

  private audit(source: BugSourceRow, action: string, details: unknown) {
    return {
      projectId: source.project_id,
      action,
      details,
    };
  }
}
