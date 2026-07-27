import { database } from '@/platform/database';
import { ExecutionService } from '@/platform/execution/service';
import { workspaceEvents } from '@/modules/cooking/submissions/application/workspace-events';
import { RepairService } from './repair-service';

export function repairService(): RepairService {
  return new RepairService(
    database(),
    undefined,
    undefined,
    undefined,
    (submissionId, revision) =>
      workspaceEvents().publish({ submissionId, revision }),
  );
}

export function cookingExecutionService(): ExecutionService {
  const appDatabase = database();
  const repair = new RepairService(
    appDatabase,
    new ExecutionService(appDatabase),
    undefined,
    undefined,
    (submissionId, revision) =>
      workspaceEvents().publish({ submissionId, revision }),
  );
  return new ExecutionService(
    appDatabase,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      applyStarted: (execution) => repair.applyStartedExecution(execution),
      afterStarted: (execution) => repair.afterStartedExecution(execution),
      applyTerminal: (execution) => repair.applyTerminalExecution(execution),
      afterTerminal: (execution) => repair.afterTerminalExecution(execution),
      applyInteractionOpened: (interaction) =>
        repair.applyInteractionOpened(interaction.executionId, interaction.id),
      afterInteractionOpened: (interaction) =>
        repair.afterInteractionOpened(interaction.executionId),
    },
  );
}
