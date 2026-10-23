import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';

export type ProjectDeletionParticipant = (projectId: string) => readonly string[];

/** Runs inside the project's mutation transaction after owner/version confirmation. */
export function deleteProjectRecords(
  db: AppDatabase,
  projectId: string,
  now: string,
  participants: readonly ProjectDeletionParticipant[],
): void {
  const relatedExecutionIds = participants.flatMap((participate) => [
    ...participate(projectId),
  ]);
  if (
    db.get(
      `SELECT 1 FROM platform_binding_request request
       JOIN platform_engineering engineering ON engineering.id = request.engineering_id
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
     JOIN platform_engineering_binding binding ON binding.id = execution.binding_id
     JOIN platform_engineering engineering ON engineering.id = binding.engineering_id
     WHERE engineering.project_id = ?`,
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
    `SELECT DISTINCT target_id FROM platform_audit_event
     WHERE project_id = ? AND target_type NOT IN ('PROJECT_MEMBERSHIP', 'ENGINEERING_MEMBERSHIP')`,
    projectId,
  );
  for (const { target_id } of resources)
    db.run('DELETE FROM platform_mutation WHERE resource_id = ?', [target_id]);
  db.run('DELETE FROM platform_project WHERE id = ?', [projectId]);
  // Delete successors first. An execution referenced outside this project rolls back
  // the entire mutation rather than silently deleting another project's history.
  const remaining = new Set([...executions.map(({ id }) => id), ...relatedExecutionIds]);
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
