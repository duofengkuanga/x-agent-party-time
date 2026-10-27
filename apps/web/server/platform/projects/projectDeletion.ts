import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';

export type ProjectDeletionParticipant = {
  prepare: (projectId: string) => readonly string[];
  deleteRecords: (projectId: string) => void;
};

/** Runs inside the project's mutation transaction after owner/version confirmation. */
export function deleteProjectRecords(
  db: AppDatabase,
  projectId: string,
  now: string,
  participants: readonly ProjectDeletionParticipant[],
): void {
  const executionIds = planProjectDeletion(db, projectId, now, participants);
  for (const participant of participants) participant.deleteRecords(projectId);
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
  for (const id of executionIds)
    db.run('DELETE FROM platform_execution WHERE id = ?', [id]);
}

/** Read-only preflight shared by the page and the transactional deletion. */
export function planProjectDeletion(
  db: AppDatabase,
  projectId: string,
  now: string,
  participants: readonly ProjectDeletionParticipant[],
): string[] {
  const relatedExecutionIds = participants.flatMap((participant) => [
    ...participant.prepare(projectId),
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

  const ids = [...new Set([...executions.map(({ id }) => id), ...relatedExecutionIds])];
  const successors = new Map(ids.map((id) => [id, 0]));
  const parents = new Map<string, string>();
  // Batch the read so eligibility checks do not query once per historical task.
  for (let start = 0; start < ids.length; start += 500) {
    const batch = ids.slice(start, start + 500);
    const rows = db.all<{ id: string; previous_execution_id: string }>(
      `SELECT id, previous_execution_id FROM platform_execution
       WHERE previous_execution_id IN (${batch.map(() => '?').join(',')})`,
      ...batch,
    );
    for (const row of rows) {
      successors.set(
        row.previous_execution_id,
        successors.get(row.previous_execution_id)! + 1,
      );
      parents.set(row.id, row.previous_execution_id);
    }
  }
  const order = ids.filter((id) => successors.get(id) === 0);
  for (let index = 0; index < order.length; index++) {
    const parent = parents.get(order[index]!);
    if (!parent) continue;
    const remaining = successors.get(parent)! - 1;
    successors.set(parent, remaining);
    if (remaining === 0) order.push(parent);
  }
  // External successors and cycles never become ready for deletion.
  if (order.length !== ids.length)
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '项目任务仍被其他任务引用，删除已撤销，请联系维护者检查',
    );
  return order;
}
