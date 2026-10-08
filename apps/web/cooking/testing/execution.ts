import type { ExecutionService } from '@/platform/execution/service';
import type {
  CompleteExecutionRequest,
  JsonValue,
} from '@agent-party-time/execution-contract';

type ExecutionScenario = {
  executions: Pick<ExecutionService, 'complete'>;
  runner: { id: string };
};

/** Complete a claimed execution without repeating its lease envelope in scenarios. */
export function completeClaimedExecution(
  scenario: ExecutionScenario,
  started: { executionId: string; leaseToken: string; sessionId: string },
  outcome: CompleteExecutionRequest['outcome'],
) {
  return scenario.executions.complete(scenario.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    sessionId: started.sessionId,
    outcome,
  });
}

export function completeSuccessfulExecution(
  scenario: ExecutionScenario,
  started: { executionId: string; leaseToken: string; sessionId: string },
  result: JsonValue,
) {
  return completeClaimedExecution(scenario, started, {
    kind: 'SUCCEEDED',
    result,
  });
}
