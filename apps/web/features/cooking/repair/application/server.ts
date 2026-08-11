import { database } from '@/server/database';
import { ExecutionService } from '@/server/execution/service';
import { cookingExecutionProjection } from '@/features/cooking/execution/application/execution-projection';
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
  );
  return new ExecutionService(
    appDatabase,
    undefined,
    undefined,
    undefined,
    undefined,
    cookingExecutionProjection(appDatabase, {
      BUG_REPAIR: repair,
      UPDATE_BATCH: updates,
      CLEANUP: lifecycle,
    }),
  );
}
