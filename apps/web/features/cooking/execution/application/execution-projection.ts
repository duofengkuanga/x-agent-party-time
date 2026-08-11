import type {
  Execution,
  ExecutionInteraction,
} from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/server/database';
import type { ExecutionLifecycleHooks } from '@/server/execution/service';

export type CookingExecutionProjectionEvent =
  | {
      phase: 'APPLY' | 'AFTER';
      kind: 'STARTED' | 'TERMINAL';
      execution: Execution;
    }
  | {
      phase: 'APPLY' | 'AFTER';
      kind: 'INTERACTION_OPENED';
      interaction: ExecutionInteraction;
    };

export type CookingExecutionProjector = {
  projectExecution: (event: CookingExecutionProjectionEvent) => void;
};

type CookingExecutionKind = 'BUG_REPAIR' | 'UPDATE_BATCH' | 'CLEANUP';

export function cookingExecutionProjection(
  db: AppDatabase,
  projectors: Record<CookingExecutionKind, CookingExecutionProjector>,
): ExecutionLifecycleHooks {
  const projectExecution = (
    owner: Execution['owner'] | undefined,
    event: CookingExecutionProjectionEvent,
  ): void => {
    if (owner?.namespace !== 'cooking' || !isCookingExecutionKind(owner.kind))
      return;
    projectors[owner.kind].projectExecution(event);
  };
  const interactionOwner = (
    interaction: ExecutionInteraction,
  ): Execution['owner'] | undefined => {
    const row = db
      .prepare(
        `SELECT owner_namespace, owner_kind, owner_id
           FROM platform_execution WHERE id = ?`,
      )
      .get(interaction.executionId) as
      | {
          owner_namespace: string;
          owner_kind: string;
          owner_id: string;
        }
      | undefined;
    return row
      ? {
          namespace: row.owner_namespace,
          kind: row.owner_kind,
          id: row.owner_id,
        }
      : undefined;
  };

  return {
    applyStarted: (execution) =>
      projectExecution(execution.owner, {
        phase: 'APPLY',
        kind: 'STARTED',
        execution,
      }),
    afterStarted: (execution) =>
      projectExecution(execution.owner, {
        phase: 'AFTER',
        kind: 'STARTED',
        execution,
      }),
    applyTerminal: (execution) =>
      projectExecution(execution.owner, {
        phase: 'APPLY',
        kind: 'TERMINAL',
        execution,
      }),
    afterTerminal: (execution) =>
      projectExecution(execution.owner, {
        phase: 'AFTER',
        kind: 'TERMINAL',
        execution,
      }),
    applyInteractionOpened: (interaction) =>
      projectExecution(interactionOwner(interaction), {
        phase: 'APPLY',
        kind: 'INTERACTION_OPENED',
        interaction,
      }),
    afterInteractionOpened: (interaction) =>
      projectExecution(interactionOwner(interaction), {
        phase: 'AFTER',
        kind: 'INTERACTION_OPENED',
        interaction,
      }),
  };
}

function isCookingExecutionKind(
  value: string | undefined,
): value is CookingExecutionKind {
  return (
    value === 'BUG_REPAIR' || value === 'UPDATE_BATCH' || value === 'CLEANUP'
  );
}
