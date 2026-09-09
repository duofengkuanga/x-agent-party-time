import { database } from '@/platform/database';
import { ExecutionService } from '@/platform/execution/service';
import { repairService } from '@/cooking/runtime/repair';
import { workspaceEvents } from '@/cooking/submissions/server/workspace-events';
import { updateService } from '@/cooking/runtime/update';
import { LifecycleService } from '../lifecycle/server/lifecycle-service';

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
  );
}
