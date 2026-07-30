import { database } from '@/server/database';
import { serverPaths } from '@/server/config';
import { LocalFileStore } from '@/server/files/local-file-store';
import { BindingService } from '@/features/cooking/bindings/application/binding-service';
import { BindingRequestService } from '@/features/cooking/bindings/application/binding-request-service';
import { BugService } from '@/features/cooking/bugs/application/bug-service';
import { EngineeringService } from '@/features/cooking/engineering/application/engineering-service';
import { projectMemberHasEngineeringResponsibilities } from '@/features/cooking/engineering/application/responsibilities';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import {
  engineeringMemberHasSubmissionResponsibilities,
  projectMemberHasSubmissionResponsibilities,
  submissionReferencesEngineering,
  submissionReferencesEnvironment,
} from '@/features/cooking/submissions/application/references';
import { SubmissionService } from '@/features/cooking/submissions/application/submission-service';
import { workspaceEvents } from '@/features/cooking/submissions/application/workspace-events';
import {
  SubmissionCreationCatalogSchema,
  type SubmissionCreationCatalog,
} from '@/features/cooking/submissions/contract';
import { CookingWorkspaceService } from '@/features/cooking/workspace/application/workspace-service';
import { repairService } from '@/features/cooking/repair/application/server';
import { updateService } from '@/features/cooking/update/application/server';
import { lifecycleService } from '@/features/cooking/lifecycle/application/server';

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

export function bindingRequestService(): BindingRequestService {
  const appDatabase = database();
  return new BindingRequestService(
    appDatabase,
    new BindingService(appDatabase),
  );
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
      requested: (bugId) => repairs.createInitialExecution(bugId),
    },
  );
}

export function workspaceService(): CookingWorkspaceService {
  return new CookingWorkspaceService(
    submissionService(),
    bugService(),
    repairService(),
    updateService(),
    lifecycleService(),
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
        .filter(
          (item) => !item.archivedAt && item.repositoryState === 'CONFIRMED',
        )
        .map((item) => {
          const workspace = engineering.getWorkspace(userId, item.id);
          return {
            id: item.id,
            name: item.name,
            type: item.type,
            identifier: item.identifier,
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
