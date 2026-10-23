import type { RepairService } from '@/cooking/repair/server/repairService';
import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import { requireBindableFiles } from '@/cooking/shared/server/attachments';
import { requireEnvironment } from '@/cooking/submissions/server/environmentAccess';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/testSubmissionWriteStore';
import { insertAuditEvent } from '@/cooking/shared/server/auditEvent';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  BugLifecycleMutationResultSchema,
  LinkedBugArchiveInputSchema,
  LinkedBugArchiveResultSchema,
  LinkedBugReviewInputSchema,
  LinkedBugReviewResultSchema,
  LifecycleCommandInputSchema,
  ReopenBugInputSchema,
  VerifyBugInputSchema,
  type BugLifecycleMutationResult,
  type LifecycleCommandInput,
  type LinkedBugArchiveInput,
  type LinkedBugArchiveResult,
  type LinkedBugReviewInput,
  type LinkedBugReviewResult,
  type ReopenBugInput,
  type VerifyBugInput,
} from '../contract';
import { LifecycleQueries } from './lifecycleQueries';
import type { BugSourceRow } from './lifecycleQueries';

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

type TransitionOutcome = {
  revision: number;
  executionId?: string;
  action: string;
  details: Record<string, unknown>;
};

export class BugLifecycleCommands {
  constructor(
    private readonly db: AppDatabase,
    private readonly repairs: RepairService,
    private readonly queries: LifecycleQueries,
    private readonly writes: TestSubmissionWriteStore,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {}

  verifyBug(
    actorUserId: string,
    bugId: string,
    inputValue: VerifyBugInput,
  ): BugLifecycleMutationResult {
    const input = VerifyBugInputSchema.parse(inputValue);
    return this.writeBugTransition(actorUserId, bugId, input, 'BUG_VERIFY', (source) => {
      this.requireBugVersion(source, input.expectedVersion);
      this.requireLinkedReady(actorUserId, bugId);
      return this.performVerification(
        source,
        actorUserId,
        input,
        this.now().toISOString(),
      );
    });
  }

  reopenBug(
    actorUserId: string,
    bugId: string,
    inputValue: ReopenBugInput,
  ): BugLifecycleMutationResult {
    const input = ReopenBugInputSchema.parse(inputValue);
    return this.writeBugTransition(actorUserId, bugId, input, 'BUG_REOPEN', (source) => {
      this.requireBugVersion(source, input.expectedVersion);
      this.requireLinkedReady(actorUserId, bugId);
      return this.performReopen(source, actorUserId, input, this.now().toISOString());
    });
  }

  reviewLinkedBugs(
    actorUserId: string,
    bugId: string,
    inputValue: LinkedBugReviewInput,
  ): LinkedBugReviewResult {
    const input = LinkedBugReviewInputSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'LINKED_BUG_REVIEW',
      resourceType: 'BUG',
      resultSchema: LinkedBugReviewResultSchema,
      submissionId: () => this.queries.bugSource(bugId).submission_id,
      perform: () => {
        const source = this.requireTester(actorUserId, bugId);
        const related = this.requireLinkedReady(actorUserId, bugId);
        if (!related)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前缺陷没有可共同验收的关联缺陷',
          );
        const peer = this.requireTester(actorUserId, related.relatedBugId);
        this.requireBugVersion(source, input.expectedVersion);
        this.requireBugVersion(peer, input.relatedExpectedVersion);
        const pairs = [source, peer];
        if (input.decision === 'PASSED' && pairs.every(({ stage }) => stage === 'DONE'))
          throw new PlatformError('INVALID_TRANSITION', '关联缺陷均已完成，无需再次通过');
        const now = this.now().toISOString();
        const changedBugIds: string[] = [];
        const executionIds: string[] = [];
        let revision = 0;
        for (const bug of pairs) {
          const engineering = this.engineeringType(bug);
          const selected =
            input.decision === 'PASSED' ||
            input.ownership === 'BOTH' ||
            input.ownership === engineering;
          if (!selected || (input.decision === 'PASSED' && bug.stage === 'DONE'))
            continue;
          const outcome =
            input.decision === 'PASSED'
              ? this.performVerification(
                  bug,
                  actorUserId,
                  { result: 'PASSED', attachmentIds: [] },
                  now,
                )
              : bug.stage === 'DONE'
                ? this.performReopen(bug, actorUserId, input, now)
                : this.performVerification(
                    bug,
                    actorUserId,
                    {
                      result: 'FAILED',
                      feedback: input.feedback,
                      attachmentIds: input.attachmentIds,
                    },
                    now,
                  );
          changedBugIds.push(bug.id);
          if (outcome.executionId) executionIds.push(outcome.executionId);
          revision = outcome.revision;
          insertAuditEvent(this.db, {
            id: this.createId(),
            projectId: bug.project_id,
            actorUserId,
            action: outcome.action,
            targetType: 'BUG',
            targetId: bug.id,
            details: { ...outcome.details, linkedBugIds: pairs.map(({ id }) => id) },
            createdAt: now,
          });
        }
        return {
          resourceId: bugId,
          result: {
            bugIds: pairs.map(({ id }) => id),
            changedBugIds,
            executionIds,
            revision,
          },
        };
      },
    });
  }

  archiveLinkedBugs(
    actorUserId: string,
    bugId: string,
    inputValue: LinkedBugArchiveInput,
  ): LinkedBugArchiveResult {
    return this.changeLinkedArchive(actorUserId, bugId, inputValue, true);
  }

  unarchiveLinkedBugs(
    actorUserId: string,
    bugId: string,
    inputValue: LinkedBugArchiveInput,
  ): LinkedBugArchiveResult {
    return this.changeLinkedArchive(actorUserId, bugId, inputValue, false);
  }

  private changeLinkedArchive(
    actorUserId: string,
    bugId: string,
    inputValue: LinkedBugArchiveInput,
    archived: boolean,
  ): LinkedBugArchiveResult {
    const input = LinkedBugArchiveInputSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: archived ? 'LINKED_BUG_ARCHIVE' : 'LINKED_BUG_UNARCHIVE',
      resourceType: 'BUG',
      resultSchema: LinkedBugArchiveResultSchema,
      submissionId: () => this.queries.bugSource(bugId).submission_id,
      perform: () => {
        const source = this.requireTester(actorUserId, bugId);
        const related = this.queries.linkedReview(actorUserId, bugId);
        if (!related)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前缺陷没有可共同归档的关联缺陷',
          );
        const peer = this.requireTester(actorUserId, related.relatedBugId);
        this.requireBugVersion(source, input.expectedVersion);
        this.requireBugVersion(peer, input.relatedExpectedVersion);
        const pair = [source, peer];
        if (
          source.submission_id !== peer.submission_id ||
          pair.some(
            ({ stage, archived_at }) =>
              stage !== 'DONE' || Boolean(archived_at) !== !archived,
          )
        )
          throw new PlatformError(
            'INVALID_TRANSITION',
            archived
              ? '只有两张均已完成且未归档的关联缺陷可以一同归档'
              : '只有两张均已归档的关联缺陷可以一同撤销归档',
          );
        const now = this.now().toISOString();
        for (const bug of pair) {
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
              bug.id,
              bug.version,
            ],
          );
          if (update.changes !== 1)
            throw new PlatformError('STALE_STATE', '缺陷已变化，请刷新后重试');
          insertAuditEvent(this.db, {
            id: this.createId(),
            projectId: bug.project_id,
            actorUserId,
            action: archived ? 'BUG_ARCHIVED' : 'BUG_UNARCHIVED',
            targetType: 'BUG',
            targetId: bug.id,
            details: { linkedBugIds: pair.map(({ id }) => id) },
            createdAt: now,
          });
        }
        return {
          resourceId: bugId,
          result: {
            bugIds: pair.map(({ id }) => id),
            bugVersions: pair.map(({ version }) => version + 1),
            revision: this.writes.bumpRevision(source.submission_id, now),
          },
        };
      },
    });
  }

  private performVerification(
    source: BugSourceRow,
    actorUserId: string,
    input:
      | { result: 'PASSED'; attachmentIds: string[]; comment?: string }
      | { result: 'FAILED'; attachmentIds: string[]; feedback: string },
    now: string,
  ): TransitionOutcome {
    if (source.submission_item_id)
      requireEnvironment(this.db, source.submission_item_id, true);
    if (source.stage !== 'WAITING_FOR_VERIFICATION')
      throw new PlatformError('INVALID_TRANSITION', '当前缺陷不在待验证阶段');
    const round = this.nextVerificationRound(source.id);
    requireBindableFiles(this.db, actorUserId, input.attachmentIds);
    if (input.result === 'PASSED' && input.attachmentIds.length)
      throw new PlatformError('VALIDATION_FAILED', '验证通过不需要上传失败证据');
    const verificationId = this.createId();
    const repairAttempt =
      input.result === 'FAILED' ? this.nextRepairAttempt(source.id) : null;
    this.db.run(
      `INSERT INTO cooking_verification_record(
             id, bug_id, round, result, comment, repair_attempt,
             verified_by_user_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        verificationId,
        source.id,
        round,
        input.result,
        input.result === 'PASSED' ? input.comment?.trim() || null : input.feedback.trim(),
        repairAttempt,
        actorUserId,
        now,
      ],
    );
    if (input.result === 'PASSED') {
      this.updateBugStage(source.id, 'WAITING_FOR_VERIFICATION', 'DONE', now);
      return {
        revision: this.writes.bumpRevision(source.submission_id, now),
        action: 'BUG_VERIFICATION_PASSED',
        details: { round, comment: Boolean(input.comment) },
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
  }

  private performReopen(
    source: BugSourceRow,
    actorUserId: string,
    input: { feedback: string; attachmentIds: string[] },
    now: string,
  ): TransitionOutcome {
    if (source.stage !== 'DONE' || source.archived_at)
      throw new PlatformError('INVALID_TRANSITION', '只有未归档的已完成缺陷可以重开');
    const round = this.nextReopenRound(source.id);
    const repairAttempt = this.nextRepairAttempt(source.id);
    const reopenId = this.createId();
    requireBindableFiles(this.db, actorUserId, input.attachmentIds);
    this.db.run(
      `INSERT INTO cooking_reopen_record(
             id, bug_id, round, feedback, repair_attempt,
             reopened_by_user_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        reopenId,
        source.id,
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
  }

  private requireLinkedReady(actorUserId: string, bugId: string) {
    const review = this.queries.linkedReview(actorUserId, bugId);
    if (review?.blockedReason)
      throw new PlatformError(review.blockedCode, review.blockedReason);
    return review;
  }

  private engineeringType(source: BugSourceRow): 'FRONTEND' | 'BACKEND' {
    const item = this.db.get<{ engineering_type: 'FRONTEND' | 'BACKEND' }>(
      'SELECT engineering_type FROM cooking_submission_item WHERE id = ?',
      source.submission_item_id,
    );
    if (!item) throw new PlatformError('RESOURCE_CONFLICT', '关联缺陷缺少工程归属');
    return item.engineering_type;
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
        if (
          this.db.get(
            'SELECT 1 FROM cooking_bug WHERE id = ? AND transferred_at IS NOT NULL',
            bugId,
          )
        )
          throw new PlatformError('INVALID_TRANSITION', '因转交关闭的缺陷不能恢复或取消');
        if (kind === 'cancel' && source.stage !== transition.from)
          throw new PlatformError('INVALID_TRANSITION', '只有待修复缺陷可以取消');
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE cooking_bug
             SET stage = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = ?`,
          [transition.to, now, bugId, input.expectedVersion, transition.from],
        );
        if (update.changes !== 1) {
          if (kind === 'cancel')
            throw new PlatformError('STALE_STATE', '缺陷已变化，请刷新后重试');
          throw new PlatformError('INVALID_TRANSITION', '当前缺陷不能恢复到待修复');
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
          throw new PlatformError('INVALID_TRANSITION', '只有已完成缺陷可以整理归档');
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
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', '缺陷已变化，请刷新后重试');
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
    if (update.changes !== 1)
      throw new PlatformError('STALE_STATE', '缺陷已变化，请刷新后重试');
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
    fileIds.forEach((fileId, position) => statement.run(ownerId, fileId, position, now));
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

  private requireBugVersion(source: BugSourceRow, expectedVersion: number): void {
    if (source.version !== expectedVersion)
      throw new PlatformError('STALE_STATE', '缺陷已变化，请刷新后重试');
  }

  private updateBugStage(bugId: string, from: string, to: string, now: string): void {
    const update = this.db.run(
      `UPDATE cooking_bug
         SET stage = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND stage = ?`,
      [to, now, bugId, from],
    );
    if (update.changes !== 1)
      throw new PlatformError('STALE_STATE', '缺陷已变化，请刷新后重试');
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
