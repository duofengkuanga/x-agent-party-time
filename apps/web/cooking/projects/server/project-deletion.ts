import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';

/** Runs inside the project's mutation transaction, after owner/version confirmation. */
export function deleteProjectRecords(
  db: AppDatabase,
  projectId: string,
  now: string,
): void {
  if (
    db.get(
      `SELECT 1 FROM cooking_test_submission
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
      `SELECT 1 FROM cooking_cleanup cleanup
       JOIN cooking_test_submission submission ON submission.id = cleanup.submission_id
       WHERE submission.project_id = ? AND cleanup.state <> 'COMPLETED' LIMIT 1`,
      projectId,
    )
  )
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '项目仍有未完成的本机善后任务，请完成后再删除',
    );

  if (
    db.get(
      `SELECT 1 FROM cooking_binding_request request
       JOIN cooking_engineering engineering ON engineering.id = request.engineering_id
       WHERE engineering.project_id = ? AND request.state IN ('PENDING', 'PROCESSING')
         AND request.expires_at > ? LIMIT 1`,
      projectId,
      now,
    )
  )
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '项目正在建立本机绑定，请等待绑定结束后再删除',
    );

  const executions = db.all<{ id: string; state: string }>(
    `SELECT execution.id, execution.state FROM platform_execution execution
     WHERE execution.binding_id IN (
       SELECT binding.id FROM cooking_engineering_binding binding
       JOIN cooking_engineering engineering ON engineering.id = binding.engineering_id
       WHERE engineering.project_id = ?
       UNION SELECT item.binding_id FROM cooking_submission_item item
       JOIN cooking_test_submission submission ON submission.id = item.submission_id
       WHERE submission.project_id = ?
     )`,
    projectId,
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

  // Mutation receipts have no project foreign key. Remove receipts for deleted
  // entities so old creation requests cannot return records that no longer exist.
  const resources = db.all<{ target_id: string }>(
    `SELECT DISTINCT target_id FROM cooking_audit_event
     WHERE project_id = ? AND target_type NOT IN ('PROJECT_MEMBERSHIP', 'ENGINEERING_MEMBERSHIP')`,
    projectId,
  );
  for (const { target_id } of resources)
    db.run('DELETE FROM cooking_mutation WHERE resource_id = ?', [target_id]);
  const relations = db.all<{ id: string }>(
    `SELECT relation.id FROM cooking_bug_relation relation
     WHERE relation.source_bug_id IN (
       SELECT bug.id FROM cooking_bug bug
       JOIN cooking_test_submission submission ON submission.id = bug.submission_id
       WHERE submission.project_id = ?
     ) OR relation.target_bug_id IN (
       SELECT bug.id FROM cooking_bug bug
       JOIN cooking_test_submission submission ON submission.id = bug.submission_id
       WHERE submission.project_id = ?
     )`,
    projectId,
    projectId,
  );

  // RESTRICT relationships require deleting the delivery records before their items.
  const submissions = 'SELECT id FROM cooking_test_submission WHERE project_id = ?';
  db.run(
    `DELETE FROM cooking_update_attempt WHERE batch_id IN (
       SELECT id FROM cooking_update_batch WHERE submission_id IN (${submissions})
     )`,
    [projectId],
  );
  for (const table of [
    'cooking_update_batch',
    'cooking_cleanup',
    'cooking_bug',
    'cooking_test_submission',
  ])
    db.run(
      `DELETE FROM ${table} WHERE ${table === 'cooking_test_submission' ? 'id' : 'submission_id'} IN (${submissions})`,
      [projectId],
    );
  for (const { id } of relations)
    db.run(
      `DELETE FROM cooking_bug_relation
       WHERE id = ? AND source_bug_id IS NULL AND target_bug_id IS NULL`,
      [id],
    );
  db.run('DELETE FROM cooking_project WHERE id = ?', [projectId]);

  // Delete successors first. An execution referenced outside this project rolls back
  // the entire mutation rather than silently deleting another project's history.
  const remaining = new Set(executions.map(({ id }) => id));
  while (remaining.size > 0) {
    let deleted = 0;
    for (const id of remaining) {
      if (db.get('SELECT 1 FROM platform_execution WHERE previous_execution_id = ?', id))
        continue;
      db.run('DELETE FROM platform_execution WHERE id = ?', [id]);
      remaining.delete(id);
      deleted++;
    }
    if (deleted === 0)
      throw new PlatformError(
        'RESOURCE_CONFLICT',
        '项目任务仍被其他任务引用，删除已撤销，请联系维护者检查',
      );
  }
}
