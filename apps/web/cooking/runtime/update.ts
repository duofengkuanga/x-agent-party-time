import { database } from '@/platform/database';
import { workspaceEvents } from '@/cooking/submissions/server/workspace-events';
import { UpdateService } from '../update/server/update-service';

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
