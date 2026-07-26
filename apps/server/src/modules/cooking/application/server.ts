import { database } from '@/platform/database';
import { EngineeringService } from '@/modules/cooking/engineering/application/engineering-service';
import { projectMemberHasEngineeringResponsibilities } from '@/modules/cooking/engineering/application/responsibilities';
import { ProjectService } from '@/modules/cooking/projects/application/project-service';

export function projectService(): ProjectService {
  const appDatabase = database();
  return new ProjectService(
    appDatabase,
    undefined,
    undefined,
    (projectId, userId) =>
      projectMemberHasEngineeringResponsibilities(
        appDatabase,
        projectId,
        userId,
      ),
  );
}

export function engineeringService(): EngineeringService {
  return new EngineeringService(database());
}
