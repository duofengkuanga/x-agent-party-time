import { database } from '@/server/database';
import { ExecutionService } from '@/server/execution/service';
import { workspaceEvents } from '@/features/cooking/submissions/application/workspace-events';
import { UpdateService } from '@/features/cooking/update/application/update-service';
import { LifecycleService } from '@/features/cooking/lifecycle/application/lifecycle-service';
import { RepairService } from './repair-service';

function publish(submissionId: string, revision: number): void {
  workspaceEvents().publish({ submissionId, revision });
}

export function repairService(): RepairService {
  const appDatabase = database();
  const updates = new UpdateService(appDatabase);
  return new RepairService(
    appDatabase,
    undefined,
    undefined,
    undefined,
    publish,
    {
      candidateAvailable: (bugId, candidateAt) =>
        updates.recordCandidateAvailable(bugId, candidateAt),
      candidateReconsidered: (bugId) =>
        updates.recalculatePendingDeliveryForBug(bugId),
    },
  );
}

export function cookingExecutionService(): ExecutionService {
  const appDatabase = database();
  const updates = new UpdateService(
    appDatabase,
    new ExecutionService(appDatabase),
    undefined,
    undefined,
    publish,
  );
  const repair = new RepairService(
    appDatabase,
    new ExecutionService(appDatabase),
    undefined,
    undefined,
    publish,
    {
      candidateAvailable: (bugId, candidateAt) =>
        updates.recordCandidateAvailable(bugId, candidateAt),
      candidateReconsidered: (bugId) =>
        updates.recalculatePendingDeliveryForBug(bugId),
    },
  );
  const lifecycle = new LifecycleService(
    appDatabase,
    repair,
    new ExecutionService(appDatabase),
    undefined,
    undefined,
    publish,
    {
      bugCancelled: (bugId) => updates.recalculatePendingDeliveryForBug(bugId),
    },
  );
  return new ExecutionService(
    appDatabase,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      applyStarted: (execution) => {
        repair.applyStartedExecution(execution);
        updates.applyStartedExecution(execution);
        lifecycle.applyStartedExecution(execution);
      },
      afterStarted: (execution) => {
        repair.afterStartedExecution(execution);
        updates.afterStartedExecution(execution);
        lifecycle.afterStartedExecution(execution);
      },
      applyTerminal: (execution) => {
        repair.applyTerminalExecution(execution);
        updates.applyTerminalExecution(execution);
        lifecycle.applyTerminalExecution(execution);
      },
      afterTerminal: (execution) => {
        repair.afterTerminalExecution(execution);
        updates.afterTerminalExecution(execution);
        lifecycle.afterTerminalExecution(execution);
      },
      applyInteractionOpened: (interaction) => {
        repair.applyInteractionOpened(interaction.executionId, interaction.id);
        updates.applyInteractionOpened(interaction.executionId, interaction.id);
        lifecycle.applyInteractionOpened(
          interaction.executionId,
          interaction.id,
        );
      },
      afterInteractionOpened: (interaction) => {
        repair.afterInteractionOpened(interaction.executionId);
        updates.afterInteractionOpened(interaction.executionId);
        lifecycle.afterInteractionOpened(interaction.executionId);
      },
    },
  );
}
