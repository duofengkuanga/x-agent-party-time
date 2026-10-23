import type { AppDatabase } from '@/server/database/index';
import type { ExecutionProjector } from '@/server/platform/execution/projection';
type SubmissionExecutionKind = 'BUG_REPAIR' | 'UPDATE_BATCH' | 'CLEANUP';

export function submissionExecutionProjection(
  db: AppDatabase,
  projectors: Record<SubmissionExecutionKind, ExecutionProjector>,
): ExecutionProjector {
  return (event) => {
    const owner =
      event.kind === 'INTERACTION_OPENED'
        ? (db.get(
            `
          SELECT owner_namespace namespace, owner_kind kind
          FROM platform_execution WHERE id = ?
        `,
            event.interaction.executionId,
          ) as {
            namespace: string;
            kind: string;
          } | null)
        : event.execution.owner;
    if (owner?.namespace !== 'submissions') return;
    let kind = owner.kind;
    if (kind === 'SESSION_SYNC') {
      const executionId =
        event.kind === 'INTERACTION_OPENED'
          ? event.interaction.executionId
          : event.execution.id;
      const sync = db.get(
        `
        SELECT 'BUG_REPAIR' kind FROM submission_repair_session_sync WHERE execution_id = ?
        UNION ALL
        SELECT 'UPDATE_BATCH' kind FROM submission_update_session_sync WHERE execution_id = ?
      `,
        executionId,
        executionId,
      ) as { kind: SubmissionExecutionKind } | null;
      if (!sync) return;
      kind = sync.kind;
    }
    if (Object.hasOwn(projectors, kind))
      projectors[kind as SubmissionExecutionKind](event);
  };
}
