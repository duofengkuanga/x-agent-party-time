import { requireSubmissionAccess } from '@/server/submissions/shared/access';
import { environmentObservers } from '@/server/submissions/environmentAccess';
import type { TestSubmissionWriteStore } from '@/server/submissions/testSubmissionWriteStore';
import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import {
  CloseSubmissionMutationResultSchema,
  LifecycleCommandInputSchema,
  type CloseSubmissionMutationResult,
  type LifecycleCommandInput,
} from '../../../contracts/submissions/lifecycle';
import type { CleanupService } from './cleanupService';

export class SubmissionClosure {
  constructor(
    private readonly db: AppDatabase,
    private readonly cleanup: CleanupService,
    private readonly writes: TestSubmissionWriteStore,
    private readonly now: () => Date,
  ) {}

  closeSubmission(
    actorUserId: string,
    submissionId: string,
    inputValue: LifecycleCommandInput,
  ): CloseSubmissionMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'SUBMISSION_CLOSE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: CloseSubmissionMutationResultSchema,
      submissionId: (mutation) => mutation.submissionId,
      perform: () => {
        const submission = this.requireSubmissionTester(actorUserId, submissionId);
        if (submission.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '提测单已变化，请刷新后重试');
        const blocker = submissionCloseBlocker(this.db, submissionId);
        if (blocker) throw new PlatformError(blocker.code, blocker.message);
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE test_submission
             SET status = 'CLOSED', version = version + 1,
                 updated_at = ?, closed_at = ?
             WHERE id = ? AND status = 'ACTIVE' AND version = ?
            `,
          [now, now, submissionId, input.expectedVersion],
        );
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', '提测单已变化，请刷新后重试');
        const revision = this.writes.bumpRevision(submissionId, now);
        const heldEnvironments = this.db.all<{ environment_id: string }>(
          'SELECT environment_id FROM submission_environment_lock WHERE submission_id = ?',
          submissionId,
        );
        const affectedSubmissionIds = heldEnvironments.flatMap(({ environment_id }) =>
          environmentObservers(this.db, environment_id, submissionId),
        );
        this.db.run('DELETE FROM submission_environment_lock WHERE submission_id = ?', [
          submissionId,
        ]);
        const cleanupExecutionIds = this.cleanup.createForClosedSubmission(
          submissionId,
          now,
        );
        return {
          result: {
            submissionId,
            submissionVersion: input.expectedVersion + 1,
            cleanupExecutionIds,
            revision,
          },
          resourceId: submissionId,
          affectedSubmissions: { ids: affectedSubmissionIds, updatedAt: now },
          audit: {
            projectId: submission.project_id,
            action: 'SUBMISSION_CLOSED',
            details: { cleanupCount: cleanupExecutionIds.length },
          },
        };
      },
    });
  }

  private requireSubmissionTester(userId: string, submissionId: string) {
    const row = this.db.get(
      `SELECT project_id, tester_user_id, status, version
         FROM test_submission WHERE id = ?`,
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
      throw new PlatformError('PERMISSION_DENIED', '只有测试负责人可以关闭提测单');
    return row;
  }
}

/** Read-only readiness rule; callers check access, tester identity and active status. */
export function submissionCloseBlocker(
  db: AppDatabase,
  submissionId: string,
): Pick<PlatformError, 'code' | 'message'> | null {
  if (
    db.get(
      `SELECT 1 FROM submission_bug
       WHERE submission_id = ? AND stage NOT IN ('DONE', 'CANCELLED') LIMIT 1`,
      submissionId,
    )
  )
    return {
      code: 'INVALID_TRANSITION',
      message: '仍有未完成缺陷，不能关闭提测单',
    };
  if (
    db.get(
      `SELECT 1 FROM platform_execution execution
       WHERE execution.state IN (
         'QUEUED', 'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION',
         'WAITING_TO_RESUME', 'CANCEL_REQUESTED'
       ) AND (
         execution.id IN (
           SELECT attempt.execution_id FROM submission_repair_attempt attempt
           JOIN submission_bug bug ON bug.id = attempt.bug_id
           WHERE bug.submission_id = ?
         ) OR execution.id IN (
           SELECT attempt.execution_id FROM submission_update_attempt attempt
           JOIN submission_update_batch batch ON batch.id = attempt.batch_id
           WHERE batch.submission_id = ?
         )
       ) LIMIT 1`,
      submissionId,
      submissionId,
    )
  )
    return {
      code: 'RESOURCE_CONFLICT',
      message: '仍有修复或更新执行未结束，不能关闭提测单',
    };
  if (
    db.get(
      `SELECT 1 FROM submission_update_batch
       WHERE submission_id = ? AND state != 'COMPLETED' LIMIT 1`,
      submissionId,
    )
  )
    return {
      code: 'INVALID_TRANSITION',
      message: '仍有未完成更新批次，不能关闭提测单',
    };
  return null;
}
