import { database } from '@/platform/database';
import { workspaceEvents } from '@/modules/cooking/submissions/application/workspace-events';
import { UpdateService } from './update-service';

export function updateService(): UpdateService {
  return new UpdateService(
    database(),
    undefined,
    undefined,
    undefined,
    (submissionId, revision) =>
      workspaceEvents().publish({ submissionId, revision }),
  );
}

export function prepareDueUpdateExecutions(): string[] {
  return updateService().prepareDueExecutions();
}
