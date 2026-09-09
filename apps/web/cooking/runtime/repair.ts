import { database } from '@/platform/database';
import { ExecutionService } from '@/platform/execution/service';
import { cookingExecutionProjection } from '@/cooking/runtime/execution-projection';
import { workspaceEvents } from '@/cooking/submissions/server/workspace-events';
import { UpdateService } from '@/cooking/update/server/update-service';
import { LifecycleService } from '@/cooking/lifecycle/server/lifecycle-service';
import { RepairService } from '../repair/server/repair-service';

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
  );
  return new ExecutionService(
    appDatabase,
    undefined,
    undefined,
    undefined,
    undefined,
    cookingExecutionProjection(appDatabase, {
      BUG_REPAIR: repair,
      SESSION_SYNC: {
        projectExecution: (event) => {
          repair.projectExecution(event);
          updates.projectExecution(event);
        },
      },
      UPDATE_BATCH: updates,
      CLEANUP: lifecycle,
    }),
  );
}
