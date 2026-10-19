import { BindingRequestService } from '@/cooking/bindings/server/binding-request-service';
import { BindingService } from '@/cooking/bindings/server/binding-service';
import { EngineeringService } from '@/cooking/engineering/server/engineering-service';
import { projectMemberHasEngineeringResponsibilities } from '@/cooking/engineering/server/responsibilities';
import { ProjectService } from '@/cooking/projects/server/project-service';
import type { SubmissionCreationCatalog } from '@/cooking/submissions/contract';
import { readSubmissionCreationCatalog } from '@/cooking/submissions/server/creation-catalog';
import {
  engineeringMemberHasSubmissionResponsibilities,
  projectMemberHasSubmissionResponsibilities,
  submissionReferencesEngineering,
  submissionReferencesEnvironment,
} from '@/cooking/submissions/server/references';
import { workspaceEvents } from '@/cooking/submissions/server/workspace-events';
import { serverPaths } from '@/platform/config';
import { database } from '@/platform/database';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { createCooking } from './create-cooking';

export function projectService(): ProjectService {
  const appDatabase = database();
  return new ProjectService(
    appDatabase,
    undefined,
    undefined,
    (projectId, userId) =>
      projectMemberHasEngineeringResponsibilities(appDatabase, projectId, userId) ||
      projectMemberHasSubmissionResponsibilities(appDatabase, projectId, userId),
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
      engineeringMemberHasSubmissionResponsibilities(appDatabase, engineeringId, userId),
  });
}

export function bindingService(): BindingService {
  return new BindingService(database());
}

export function bindingRequestService(): BindingRequestService {
  const appDatabase = database();
  return new BindingRequestService(appDatabase, new BindingService(appDatabase));
}

export function cookingFileStore(): LocalFileStore {
  return new LocalFileStore(database(), serverPaths().files);
}

export function submissionCreationCatalog(userId: string): SubmissionCreationCatalog {
  return readSubmissionCreationCatalog(database(), userId);
}

const workflows = new WeakMap<
  ReturnType<typeof database>,
  ReturnType<typeof createCooking>
>();

function workflow() {
  const db = database();
  let cooking = workflows.get(db);
  if (!cooking) {
    cooking = createCooking(db, {
      publish: (submissionId, revision) =>
        workspaceEvents().publish({ submissionId, revision }),
    });
    workflows.set(db, cooking);
  }
  return cooking;
}

export const submissionService = () => workflow().submissions;
export const bugService = () => workflow().bugs;
export const repairService = () => workflow().repairs;
export const updateService = () => workflow().updates;
export const lifecycleService = () => workflow().lifecycle;
export const cookingExecutionService = () => workflow().executions;
export const workspaceService = () => workflow().workspace;
export const prepareDueUpdateExecutions = () => workflow().updates.prepareDueExecutions();
