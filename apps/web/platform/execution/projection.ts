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
