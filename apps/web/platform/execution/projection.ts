import type {
  Execution,
  ExecutionInteraction,
} from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/platform/database';

type ProjectionFact =
  | { kind: 'STARTED' | 'RESUMED' | 'TERMINAL'; execution: Execution }
  | { kind: 'INTERACTION_OPENED'; interaction: ExecutionInteraction };

/** APPLY runs within the state transaction; AFTER runs after a successful commit. */
export type ExecutionProjectionEvent = ProjectionFact & {
  phase: 'APPLY' | 'AFTER';
};

export type ExecutionProjector = (event: ExecutionProjectionEvent) => void;

/** APPLY is transactional; AFTER only runs after the transaction commits. */
export function projectTransaction<T>(
  db: AppDatabase,
  project: ExecutionProjector,
  write: (emit: (fact: ProjectionFact) => void) => T,
): T {
  const facts: ProjectionFact[] = [];
  const result = db.transaction(() =>
    write((fact) => {
      project({ phase: 'APPLY', ...fact });
      facts.push(fact);
    }),
  )();
  for (const fact of facts) project({ phase: 'AFTER', ...fact });
  return result;
}

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
