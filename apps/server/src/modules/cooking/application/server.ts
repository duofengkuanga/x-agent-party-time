import { database } from '@/platform/database';
import { serverPaths } from '@/platform/config';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { BindingService } from '@/modules/cooking/bindings/application/binding-service';
import { BugService } from '@/modules/cooking/bugs/application/bug-service';
import { EngineeringService } from '@/modules/cooking/engineering/application/engineering-service';
import { projectMemberHasEngineeringResponsibilities } from '@/modules/cooking/engineering/application/responsibilities';
import { ProjectService } from '@/modules/cooking/projects/application/project-service';
import {
  engineeringMemberHasSubmissionResponsibilities,
  projectMemberHasSubmissionResponsibilities,
  submissionReferencesEngineering,
  submissionReferencesEnvironment,
} from '@/modules/cooking/submissions/application/references';
import { SubmissionService } from '@/modules/cooking/submissions/application/submission-service';
import { workspaceEvents } from '@/modules/cooking/submissions/application/workspace-events';
import {
  SubmissionCreationCatalogSchema,
  type SubmissionCreationCatalog,
} from '@/modules/cooking/submissions/contract';
import { CookingWorkspaceService } from '@/modules/cooking/workspace/application/workspace-service';
import { repairService } from '@/modules/cooking/repair/application/server';
import { updateService } from '@/modules/cooking/update/application/server';

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
      ) ||
      projectMemberHasSubmissionResponsibilities(
        appDatabase,
        projectId,
        userId,
      ),
  );
}

export function engineeringService(): EngineeringService {
  const appDatabase = database();
  return new EngineeringService(appDatabase, {
    engineeringReferenced: (engineeringId) =>
      submissionReferencesEngineering(appDatabase, engineeringId),
    environmentReferenced: (environmentId) =>
      submissionReferencesEnvironment(appDatabase, environmentId),
    memberHasActiveResponsibilities: (engineeringId, userId) =>
      engineeringMemberHasSubmissionResponsibilities(
        appDatabase,
        engineeringId,
        userId,
      ),
  });
}

export function bindingService(): BindingService {
  return new BindingService(database());
}

export function submissionService(): SubmissionService {
  return new SubmissionService(
    database(),
    undefined,
    undefined,
    (submissionId, revision) =>
      workspaceEvents().publish({ submissionId, revision }),
  );
}

export function bugService(): BugService {
  const repairs = repairService();
  return new BugService(
    database(),
    undefined,
    undefined,
    (submissionId, revision) =>
      workspaceEvents().publish({ submissionId, revision }),
    {
      requested: (bugId, priority) =>
        repairs.createInitialExecution(bugId, priority),
      withdrawn: (bugId) => repairs.withdrawQueuedExecution(bugId),
      reordered: (submissionId) =>
        repairs.synchronizeQueuePriorities(submissionId),
    },
  );
}

export function workspaceService(): CookingWorkspaceService {
  return new CookingWorkspaceService(
    submissionService(),
    bugService(),
    repairService(),
    updateService(),
  );
}

export function cookingFileStore(): LocalFileStore {
  return new LocalFileStore(database(), serverPaths().files);
}

export function submissionCreationCatalog(
  userId: string,
): SubmissionCreationCatalog {
  const projects = projectService();
  const engineering = engineeringService();
  const bindings = bindingService();
  return SubmissionCreationCatalogSchema.parse(
    projects.listProjects(userId).map(({ project }) => ({
      projectId: project.id,
      projectName: project.name,
      members: projects.listMembers(userId, project.id).map(({ user }) => user),
      engineerings: engineering
        .listEngineering(userId, project.id)
        .filter(({ archivedAt }) => !archivedAt)
        .map((item) => {
          const workspace = engineering.getWorkspace(userId, item.id);
          return {
            id: item.id,
            name: item.name,
            members: workspace.members.map(({ user }) => user),
            environments: workspace.environments.map(({ id, name }) => ({
              id,
              name,
            })),
            bindings: bindings
              .listBindings(userId, item.id)
              .filter(({ runner }) => !runner.revokedAt)
              .map(({ binding, runner }) => ({
                id: binding.id,
                userId: binding.userId,
                runnerName: runner.name,
              })),
          };
        }),
    })),
  );
}
