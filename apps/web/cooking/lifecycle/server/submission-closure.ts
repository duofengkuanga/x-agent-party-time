import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import { environmentObservers } from '@/cooking/submissions/server/environment-access';
import { hasActiveSubmissionExecution } from '@/cooking/submissions/server/submission-queries';
import type { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  CloseSubmissionMutationResultSchema,
  LifecycleCommandInputSchema,
  type CloseSubmissionMutationResult,
  type LifecycleCommandInput,
} from '../contract';
import type { CleanupService } from './cleanup-service';
import type { LifecycleQueries } from './lifecycle-queries';
import { staleLifecycle } from './results';

export class SubmissionClosure {
  constructor(
    private readonly db: AppDatabase,
    private readonly queries: LifecycleQueries,
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
        if (hasActiveSubmissionExecution(this.db, submissionId))
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
}
