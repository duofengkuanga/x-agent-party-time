import type { ExecutionService } from '@/server/platform/execution/service';
import { testRepairHandoff } from './handoff';
import { testTestingScope } from './testingScope';
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

export function testSkillBinding(skillName: string) {
  return {
    skillName,
    bundleHash: 'a'.repeat(64),
    sourceRevision: 'b'.repeat(40),
  };
}

export function completeRepairExecution(
  scenario: ExecutionScenario & {
    executions: Pick<ExecutionService, 'start' | 'complete'>;
  },
  executionId: string,
  leaseToken: string,
  sessionId: string,
  commits: string[],
  manualOperations: Array<{ kind: 'DATABASE_SQL'; paths: string[] }> = [],
  testingScope = testTestingScope(commits.at(-1)),
) {
  scenario.executions.start(scenario.runner.id, executionId, {
    kind: 'STARTED',
    leaseToken,
    sessionId,
    taskSkillBinding: testSkillBinding('XBugRepaire'),
  });
  return completeSuccessfulExecution(
    scenario,
    { executionId, leaseToken, sessionId },
    {
      result: {
        outcome: 'COMPLETED',
        completionKind: 'CHANGES_COMMITTED',
        handoff: testRepairHandoff(),
        testingScope,
        changes: ['完成缺陷修复'],
        validations: [{ name: '定向测试', status: 'PASSED', detail: '' }],
        warnings: [],
        commits,
        manualOperations,
      },
    },
  );
}

export function testDeploymentReceipt(commit = 'a'.repeat(40), environmentKey = 'test') {
  return {
    source: 'CODEX_COMMAND' as const,
    commit,
    environmentKey,
    artifactSha256: 'b'.repeat(64),
    conventionPath: 'docs/delivery.md',
    conventionSha256: 'c'.repeat(64),
    commandSha256: 'd'.repeat(64),
  };
}
