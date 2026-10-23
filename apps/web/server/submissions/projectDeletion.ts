import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';

/** Submission records participate in the caller's project-deletion transaction. */
export function deleteProjectSubmissionRecords(
  db: AppDatabase,
  projectId: string,
): string[] {
  if (
    db.get(
      `SELECT 1 FROM test_submission
       WHERE project_id = ? AND status = 'ACTIVE' LIMIT 1`,
      projectId,
    )
  )
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '请先关闭项目中的活动提测单，再删除项目',
    );

  if (
    db.get(
      `SELECT 1 FROM submission_cleanup cleanup
       JOIN test_submission submission ON submission.id = cleanup.submission_id
       WHERE submission.project_id = ? AND cleanup.state <> 'COMPLETED' LIMIT 1`,
      projectId,
    )
  )
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '项目仍有未完成的本机善后任务，请完成后再删除',
    );

  const executions = db.all<{ id: string; state: string }>(
    `SELECT id, state FROM platform_execution WHERE binding_id IN (
       SELECT item.binding_id FROM submission_item item
       JOIN test_submission submission ON submission.id = item.submission_id
       WHERE submission.project_id = ?
     )`,
    projectId,
  );
  if (
    executions.some(
      ({ state }) => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'HANDED_OFF'].includes(state),
    )
  )
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '项目仍有进行中的本机任务，请等待任务结束后再删除',
    );

  const relations = db.all<{ id: string }>(
    `SELECT relation.id FROM submission_bug_relation relation
     WHERE relation.source_bug_id IN (
       SELECT bug.id FROM submission_bug bug
       JOIN test_submission submission ON submission.id = bug.submission_id
       WHERE submission.project_id = ?
     ) OR relation.target_bug_id IN (
       SELECT bug.id FROM submission_bug bug
       JOIN test_submission submission ON submission.id = bug.submission_id
       WHERE submission.project_id = ?
     )`,
    projectId,
    projectId,
  );

  // RESTRICT relationships require deleting the delivery records before their items.
  const submissions = 'SELECT id FROM test_submission WHERE project_id = ?';
  db.run(
    `DELETE FROM submission_update_attempt WHERE batch_id IN (
       SELECT id FROM submission_update_batch WHERE submission_id IN (${submissions})
     )`,
    [projectId],
  );
  for (const table of [
    'submission_update_batch',
    'submission_cleanup',
    'submission_bug',
    'test_submission',
  ])
    db.run(
      `DELETE FROM ${table} WHERE ${table === 'test_submission' ? 'id' : 'submission_id'} IN (${submissions})`,
      [projectId],
    );
  for (const { id } of relations)
    db.run(
      `DELETE FROM submission_bug_relation
       WHERE id = ? AND source_bug_id IS NULL AND target_bug_id IS NULL`,
      [id],
    );
  return executions.map(({ id }) => id);
}
