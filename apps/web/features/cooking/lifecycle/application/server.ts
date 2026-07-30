import { database } from '@/server/database';
import { ExecutionService } from '@/server/execution/service';
import { repairService } from '@/features/cooking/repair/application/server';
import { workspaceEvents } from '@/features/cooking/submissions/application/workspace-events';
import { updateService } from '@/features/cooking/update/application/server';
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
  );
}
