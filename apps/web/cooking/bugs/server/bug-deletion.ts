import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import type { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import {
  BugDeleteRequestSchema,
  type BugDeleteRequest,
  type BugDeleteResponse,
  type Bug,
} from '../contract';

export class BugDeletion {
  constructor(
    private readonly db: AppDatabase,
    private readonly requireBug: (bugId: string) => Bug,
    private readonly writes: TestSubmissionWriteStore,
    private readonly now: () => Date,
  ) {}

  deleteBugs(input: BugDeleteRequest): BugDeleteResponse {
    const parsed = BugDeleteRequestSchema.parse(input);
    const bugIds = parsed.all
      ? (
          this.db
            .prepare('SELECT id FROM cooking_bug ORDER BY id')
            .all() as Array<{ id: string }>
        ).map(({ id }) => id)
      : [...new Set(parsed.bugIds!)];
    if (bugIds.length === 0)
      throw new PlatformError('NOT_FOUND', '没有可删除的缺陷');
    const bugs = bugIds.map((bugId) => this.requireBug(bugId));
    const batchIds = this.updateBatchIds(bugIds);
    const executionIds = this.bugExecutionIds(bugIds, batchIds);
    if (!parsed.force && executionIds.length > 0) {
      const active = this.db
        .prepare(
          `SELECT id FROM platform_execution
           WHERE id IN (${placeholders(executionIds.length)})
             AND state IN (
               'QUEUED', 'CLAIMED', 'RUNNING',
               'WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME', 'CANCEL_REQUESTED'
             )`,
        )
        .all(...executionIds) as Array<{ id: string }>;
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
    return (
      this.db
        .prepare(
          `SELECT DISTINCT batch_id FROM cooking_update_batch_entry
           WHERE bug_id IN (${placeholders(bugIds.length)})`,
        )
        .all(...bugIds) as Array<{ batch_id: string }>
    ).map(({ batch_id }) => batch_id);
  }

  private bugExecutionIds(bugIds: string[], batchIds: string[]): string[] {
    const ids = new Set<string>();
    for (const { execution_id } of this.db
      .prepare(
        `SELECT execution_id FROM cooking_repair_attempt
         WHERE bug_id IN (${placeholders(bugIds.length)})
         UNION SELECT execution_id FROM cooking_repair_session_sync
         WHERE bug_id IN (${placeholders(bugIds.length)})`,
      )
      .all(...bugIds, ...bugIds) as Array<{ execution_id: string }>)
      ids.add(execution_id);
    if (batchIds.length > 0) {
      for (const { execution_id } of this.db
        .prepare(
          `SELECT execution_id FROM cooking_update_attempt
           WHERE batch_id IN (${placeholders(batchIds.length)})
           UNION SELECT execution_id FROM cooking_update_session_sync
           WHERE batch_id IN (${placeholders(batchIds.length)})`,
        )
        .all(...batchIds, ...batchIds) as Array<{ execution_id: string }>)
        ids.add(execution_id);
      for (const { active_execution_id } of this.db
        .prepare(
          `SELECT active_execution_id FROM cooking_update_batch
           WHERE id IN (${placeholders(batchIds.length)})
             AND active_execution_id IS NOT NULL`,
        )
        .all(...batchIds) as Array<{ active_execution_id: string }>)
        ids.add(active_execution_id);
    }
    return [...ids];
  }

  private deleteEmptyUpdateBatches(batchIds: string[]): void {
    if (batchIds.length === 0) return;
    this.db
      .prepare(
        `DELETE FROM cooking_update_batch
         WHERE id IN (${placeholders(batchIds.length)})
           AND NOT EXISTS (
             SELECT 1 FROM cooking_update_batch_entry entry
             WHERE entry.batch_id = cooking_update_batch.id
           )`,
      )
      .run(...batchIds);
  }

  private deleteBugRows(bugIds: string[], executionIds: string[]): void {
    if (executionIds.length > 0) {
      this.db
        .prepare(
          `DELETE FROM cooking_update_session_sync
         WHERE execution_id IN (${placeholders(executionIds.length)})`,
        )
        .run(...executionIds);
      this.db
        .prepare(
          `UPDATE cooking_update_batch SET active_execution_id = NULL
           WHERE active_execution_id IN (${placeholders(executionIds.length)})`,
        )
        .run(...executionIds);
      this.db
        .prepare(
          `UPDATE cooking_cleanup SET active_execution_id = NULL
           WHERE active_execution_id IN (${placeholders(executionIds.length)})`,
        )
        .run(...executionIds);
      this.db
        .prepare(
          `DELETE FROM cooking_update_attempt
           WHERE execution_id IN (${placeholders(executionIds.length)})`,
        )
        .run(...executionIds);
      this.db
        .prepare(
          `DELETE FROM cooking_cleanup_attempt
           WHERE execution_id IN (${placeholders(executionIds.length)})`,
        )
        .run(...executionIds);
    }
    this.db
      .prepare(
        `DELETE FROM cooking_update_batch_entry
         WHERE bug_id IN (${placeholders(bugIds.length)})`,
      )
      .run(...bugIds);
    this.db
      .prepare(
        `DELETE FROM cooking_mutation
         WHERE resource_type = 'BUG'
           AND resource_id IN (${placeholders(bugIds.length)})`,
      )
      .run(...bugIds);
    this.db
      .prepare(
        `DELETE FROM cooking_audit_event
         WHERE target_type = 'BUG'
           AND target_id IN (${placeholders(bugIds.length)})`,
      )
      .run(...bugIds);
    this.db
      .prepare(
        `DELETE FROM cooking_repair_attempt
         WHERE bug_id IN (${placeholders(bugIds.length)})`,
      )
      .run(...bugIds);
    this.db
      .prepare(
        `DELETE FROM cooking_bug
         WHERE id IN (${placeholders(bugIds.length)})`,
      )
      .run(...bugIds);
  }

  private deleteExecutions(executionIds: string[]): string[] {
    if (executionIds.length === 0) return [];
    const outsideSuccessor = this.db
      .prepare(
        `SELECT id FROM platform_execution
       WHERE previous_execution_id IN (${placeholders(executionIds.length)})
         AND id NOT IN (${placeholders(executionIds.length)}) LIMIT 1`,
      )
      .get(...executionIds, ...executionIds);
    if (outsideSuccessor)
      throw new PlatformError(
        'RESOURCE_CONFLICT',
        '删除已撤销：关联任务仍被本次删除范围外的后续任务引用。请联系维护者检查任务归属；重复执行或添加 --force 无法解决。',
      );
    const deleted: string[] = [];
    let remaining = [...executionIds];
    while (remaining.length > 0) {
      const result = this.db
        .prepare(
          `DELETE FROM platform_execution
           WHERE id IN (${placeholders(remaining.length)})
             AND NOT EXISTS (
               SELECT 1 FROM platform_execution successor
               WHERE successor.previous_execution_id = platform_execution.id
                 AND successor.id IN (${placeholders(remaining.length)})
             )`,
        )
        .run(...remaining, ...remaining);
      if (result.changes === 0)
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          '存在无法删除的执行链，请先清理后继执行',
        );
      const stillPresent = this.db
        .prepare(
          `SELECT id FROM platform_execution
           WHERE id IN (${placeholders(remaining.length)})`,
        )
        .all(...remaining) as Array<{ id: string }>;
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
      if (revision !== null)
        this.writes.publishInvalidation(submissionId, revision);
    }
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
