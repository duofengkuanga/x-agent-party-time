import { database } from '@/platform/database';
import { ExecutionService } from '@/platform/execution/service';
import { repairService } from '@/modules/cooking/repair/application/server';
import { workspaceEvents } from '@/modules/cooking/submissions/application/workspace-events';
import { updateService } from '@/modules/cooking/update/application/server';
import { LifecycleService } from './lifecycle-service';

export function lifecycleService(): LifecycleService {
  const appDatabase = database();
  const updates = updateService();
  return new LifecycleService(
    appDatabase,
    repairService(),
    new ExecutionService(appDatabase),
    undefined,
    undefined,
    (submissionId, revision) =>
      workspaceEvents().publish({ submissionId, revision }),
    {
      bugCancelled: (bugId) => updates.recalculatePendingDeliveryForBug(bugId),
    },
  );
}
