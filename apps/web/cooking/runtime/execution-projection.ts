import type { AppDatabase } from '@/platform/database';
import type {
  ExecutionProjector,
  ExecutionProjectionEvent,
} from '@/platform/execution/projection';

export type CookingExecutionProjectionEvent = ExecutionProjectionEvent;
export type CookingExecutionProjector = {
  projectExecution: ExecutionProjector;
};
type CookingExecutionKind = 'BUG_REPAIR' | 'UPDATE_BATCH' | 'CLEANUP';

export function cookingExecutionProjection(
  db: AppDatabase,
  projectors: Record<CookingExecutionKind, CookingExecutionProjector>,
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
    if (owner?.namespace !== 'cooking') return;
    let kind = owner.kind;
    if (kind === 'SESSION_SYNC') {
      const executionId =
        event.kind === 'INTERACTION_OPENED'
          ? event.interaction.executionId
          : event.execution.id;
      const sync = db.get(
        `
        SELECT 'BUG_REPAIR' kind FROM cooking_repair_session_sync WHERE execution_id = ?
        UNION ALL
        SELECT 'UPDATE_BATCH' kind FROM cooking_update_session_sync WHERE execution_id = ?
      `,
        executionId,
        executionId,
      ) as { kind: CookingExecutionKind } | null;
      if (!sync) return;
      kind = sync.kind;
    }
    if (Object.hasOwn(projectors, kind))
      projectors[kind as CookingExecutionKind].projectExecution(event);
  };
}
