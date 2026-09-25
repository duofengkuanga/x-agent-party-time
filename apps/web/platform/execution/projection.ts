import type {
  Execution,
  ExecutionInteraction,
} from '@agent-party-time/execution-contract';

/** APPLY runs within the state transaction; AFTER runs after a successful commit. */
export type ExecutionProjectionEvent =
  | {
      phase: 'APPLY' | 'AFTER';
      kind: 'STARTED' | 'RESUMED' | 'TERMINAL';
      execution: Execution;
    }
  | {
      phase: 'APPLY' | 'AFTER';
      kind: 'INTERACTION_OPENED';
      interaction: ExecutionInteraction;
    };

export type ExecutionProjector = (event: ExecutionProjectionEvent) => void;

type ProjectionHandlers = Record<
  ExecutionProjectionEvent['phase'],
  {
    STARTED: (execution: Execution) => void;
    RESUMED: (execution: Execution) => void;
    TERMINAL: (execution: Execution) => void;
    INTERACTION_OPENED: (interaction: ExecutionInteraction) => void;
  }
>;

/** Keep phase dispatch exhaustive without duplicating it in each domain. */
export function executionProjector(
  handlers: ProjectionHandlers,
): ExecutionProjector {
  return (event) => {
    const phase = handlers[event.phase];
    if (event.kind === 'INTERACTION_OPENED')
      phase.INTERACTION_OPENED(event.interaction);
    else phase[event.kind](event.execution);
  };
}
