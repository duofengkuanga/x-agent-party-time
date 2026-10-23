import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import type { TestSubmissionWriteStore } from '@/server/submissions/testSubmissionWriteStore';
import type { BugQueries } from './bugQueries';
import { canDeleteUnassignedBug } from './bugQueries';
import {
  DeleteUnassignedBugInputSchema,
  DeleteUnassignedBugResultSchema,
  type DeleteUnassignedBugInput,
  type DeleteUnassignedBugResult,
  BugDeleteRequestSchema,
  type BugDeleteRequest,
  type BugDeleteResponse,
  type Bug,
} from '../../../contracts/submissions/bug';

export class BugDeletion {
  constructor(
    private readonly db: AppDatabase,
    private readonly queries: BugQueries,
    private readonly writes: TestSubmissionWriteStore,
    private readonly now: () => Date,
  ) {}

  deleteUnassignedBug(
    actorUserId: string,
    bugId: string,
    input: DeleteUnassignedBugInput,
  ): DeleteUnassignedBugResult {
    const parsed = DeleteUnassignedBugInputSchema.parse(input);
    return this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: `BUG_DELETE_UNASSIGNED:${bugId}`,
      resourceType: 'BUG',
      resultSchema: DeleteUnassignedBugResultSchema,
      submissionId: (result) => result.submissionId,
      perform: () => {
        const bug = this.queries.requireBug(bugId);
        const access = this.queries.requireAccess(actorUserId, bug.submissionId);
        const anyResponsible = this.queries.isAnyResponsible(
          actorUserId,
          bug.submissionId,
        );
        if (actorUserId !== access.tester_user_id && !anyResponsible)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有测试负责人或提测项的开发负责人可以删除待分配缺陷',
          );
        if (bug.version !== parsed.expectedVersion)
          throw new PlatformError('RESOURCE_CONFLICT', '缺陷已发生变化，请刷新后重试');
        if (!canDeleteUnassignedBug(actorUserId, access, bug, anyResponsible))
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只能删除活动提测单中尚未分配且未开始修复的缺陷',
          );
        this.deleteBugRows([bug.id], []);
        return {
          result: {
            deletedBugId: bug.id,
            submissionId: bug.submissionId,
            revision: this.writes.bumpRevision(
              bug.submissionId,
              this.now().toISOString(),
            ),
            unboundAttachmentIds: [
              ...bug.report.actualResultAttachmentIds,
              ...bug.report.expectedResultAttachmentIds,
            ],
          },
          resourceId: bug.id,
          audit: {
            projectId: access.project_id,
            action: 'BUG_DELETED',
            details: { shortId: bug.shortId, title: bug.report.title },
          },
        };
      },
    });
  }

  deleteBugs(input: BugDeleteRequest): BugDeleteResponse {
    const parsed = BugDeleteRequestSchema.parse(input);
    const bugIds = parsed.all
      ? this.db
          .all<{
            id: string;
          }>('SELECT id FROM submission_bug ORDER BY id')
          .map(({ id }) => id)
      : [...new Set(parsed.bugIds!)];
    if (bugIds.length === 0) throw new PlatformError('NOT_FOUND', '没有可删除的缺陷');
    const bugs = bugIds.map((bugId) => this.queries.requireBug(bugId));
    const batchIds = this.updateBatchIds(bugIds);
    const executionIds = this.bugExecutionIds(bugIds, batchIds);
    if (!parsed.force && executionIds.length > 0) {
      const active = this.db.all<{ id: string }>(
        `SELECT id FROM platform_execution
           WHERE id IN (${placeholders(executionIds.length)})
             AND state IN (
               'QUEUED', 'CLAIMED', 'RUNNING',
               'WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME', 'CANCEL_REQUESTED'
             )`,
        ...executionIds,
      );
      if (active.length > 0)
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          '删除未执行：缺陷仍有进行中的修复、更新或会话同步任务。请等待任务结束，或使用 --force 强制删除。',
        );
    }
    return this.db.transaction(() => {
      this.deleteBugRows(bugIds, executionIds);
      this.deleteEmptyUpdateBatches(batchIds);
      const deletedExecutionIds = this.deleteExecutions(executionIds);
      this.bumpDeletedSubmissions(bugs);
      return {
        deletedBugIds: bugIds,
        deletedExecutionIds,
      };
    })();
  }

  private updateBatchIds(bugIds: string[]): string[] {
    return this.db
      .all<{ batch_id: string }>(
        `SELECT DISTINCT batch_id FROM submission_update_batch_entry
           WHERE bug_id IN (${placeholders(bugIds.length)})`,
        ...bugIds,
      )
      .map(({ batch_id }) => batch_id);
  }

  private bugExecutionIds(bugIds: string[], batchIds: string[]): string[] {
    const ids = new Set<string>();
    for (const { execution_id } of this.db.all<{ execution_id: string }>(
      `SELECT execution_id FROM submission_repair_attempt
         WHERE bug_id IN (${placeholders(bugIds.length)})
         UNION SELECT execution_id FROM submission_repair_session_sync
         WHERE bug_id IN (${placeholders(bugIds.length)})`,
      ...bugIds,
      ...bugIds,
    ))
      ids.add(execution_id);
    if (batchIds.length > 0) {
      for (const { execution_id } of this.db.all<{ execution_id: string }>(
        `SELECT execution_id FROM submission_update_attempt
           WHERE batch_id IN (${placeholders(batchIds.length)})
           UNION SELECT execution_id FROM submission_update_session_sync
           WHERE batch_id IN (${placeholders(batchIds.length)})`,
        ...batchIds,
        ...batchIds,
      ))
        ids.add(execution_id);
      for (const { active_execution_id } of this.db.all<{
        active_execution_id: string;
      }>(
        `SELECT active_execution_id FROM submission_update_batch
           WHERE id IN (${placeholders(batchIds.length)})
             AND active_execution_id IS NOT NULL`,
        ...batchIds,
      ))
        ids.add(active_execution_id);
    }
    return [...ids];
  }

  private deleteEmptyUpdateBatches(batchIds: string[]): void {
    if (batchIds.length === 0) return;
    this.db.run(
      `DELETE FROM submission_update_batch
         WHERE id IN (${placeholders(batchIds.length)})
           AND NOT EXISTS (
             SELECT 1 FROM submission_update_batch_entry entry
             WHERE entry.batch_id = submission_update_batch.id
           )`,
      batchIds,
    );
  }

  private deleteBugRows(bugIds: string[], executionIds: string[]): void {
    if (executionIds.length > 0) {
      const ids = placeholders(executionIds.length);
      for (const sql of [
        `DELETE FROM submission_update_session_sync WHERE execution_id IN (${ids})`,
        `UPDATE submission_update_batch SET active_execution_id = NULL WHERE active_execution_id IN (${ids})`,
        `UPDATE submission_cleanup SET active_execution_id = NULL WHERE active_execution_id IN (${ids})`,
        `DELETE FROM submission_update_attempt WHERE execution_id IN (${ids})`,
        `DELETE FROM submission_cleanup_attempt WHERE execution_id IN (${ids})`,
      ])
        this.db.run(sql, executionIds);
    }
    const ids = placeholders(bugIds.length);
    for (const sql of [
      `DELETE FROM submission_update_batch_entry WHERE bug_id IN (${ids})`,
      `DELETE FROM platform_mutation WHERE resource_type = 'BUG' AND resource_id IN (${ids})`,
      `DELETE FROM platform_audit_event WHERE target_type = 'BUG' AND target_id IN (${ids})`,
      `DELETE FROM submission_repair_attempt WHERE bug_id IN (${ids})`,
      `DELETE FROM submission_bug WHERE id IN (${ids})`,
    ])
      this.db.run(sql, bugIds);
    this.db.run(
      'DELETE FROM submission_bug_relation WHERE source_bug_id IS NULL AND target_bug_id IS NULL',
    );
  }

  private deleteExecutions(executionIds: string[]): string[] {
    if (executionIds.length === 0) return [];
    const outsideSuccessor = this.db.get(
      `SELECT id FROM platform_execution
       WHERE previous_execution_id IN (${placeholders(executionIds.length)})
         AND id NOT IN (${placeholders(executionIds.length)}) LIMIT 1`,
      ...executionIds,
      ...executionIds,
    );
    if (outsideSuccessor)
      throw new PlatformError(
        'RESOURCE_CONFLICT',
        '删除已撤销：关联任务仍被本次删除范围外的后续任务引用。请联系维护者检查任务归属；重复执行或添加 --force 无法解决。',
      );
    const deleted: string[] = [];
    let remaining = [...executionIds];
    while (remaining.length > 0) {
      const result = this.db.run(
        `DELETE FROM platform_execution
           WHERE id IN (${placeholders(remaining.length)})
             AND NOT EXISTS (
               SELECT 1 FROM platform_execution successor
               WHERE successor.previous_execution_id = platform_execution.id
                 AND successor.id IN (${placeholders(remaining.length)})
             )`,
        [...remaining, ...remaining],
      );
      if (result.changes === 0)
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          '存在无法删除的执行链，请先清理后继执行',
        );
      const stillPresent = this.db.all<{ id: string }>(
        `SELECT id FROM platform_execution
           WHERE id IN (${placeholders(remaining.length)})`,
        ...remaining,
      );
      const present = new Set(stillPresent.map(({ id }) => id));
      deleted.push(...remaining.filter((id) => !present.has(id)));
      remaining = stillPresent.map(({ id }) => id);
    }
    return deleted;
  }

  private bumpDeletedSubmissions(bugs: Bug[]): void {
    const now = this.now().toISOString();
    const submissionIds = [...new Set(bugs.map((bug) => bug.submissionId))];
    for (const submissionId of submissionIds) {
      const revision = this.writes.bumpActiveRevision(submissionId, now);
      if (revision !== null) this.writes.publishInvalidation(submissionId, revision);
    }
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
