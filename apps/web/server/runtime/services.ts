import { createProjectService, createBindingService } from './projects';
import { BindingRequestService } from '@/server/platform/projects/engineering/bindingRequestService';
import { BindingService } from '@/server/platform/projects/engineering/bindingService';
import { EngineeringService } from '@/server/platform/projects/engineering/engineeringService';
import { ProjectService } from '@/server/platform/projects/projectService';
import type { SubmissionCreationCatalog } from '@/contracts/submissions/submission';
import { readSubmissionCreationCatalog } from '@/server/submissions/creationCatalog';
import {
  engineeringMemberHasSubmissionResponsibilities,
  submissionReferencesEngineering,
  submissionReferencesEnvironment,
} from '@/server/submissions/references';
import { workspaceEvents } from '@/server/submissions/workspaceEvents';
import { serverPaths } from '@/server/config';
import { database } from '@/server/database/index';
import { LocalFileStore } from '@/server/platform/files/localFileStore';
import { createSubmissionWorkflow } from './createSubmissionWorkflow';

export function projectService(): ProjectService {
  return createProjectService(database());
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
  return createBindingService(database());
}

export function bindingRequestService(): BindingRequestService {
  const appDatabase = database();
  return new BindingRequestService(appDatabase, bindingService());
}

export function applicationFileStore(): LocalFileStore {
  return new LocalFileStore(database(), serverPaths().files);
}

export function submissionCreationCatalog(userId: string): SubmissionCreationCatalog {
  return readSubmissionCreationCatalog(database(), userId);
}

const workflows = new WeakMap<
  ReturnType<typeof database>,
  ReturnType<typeof createSubmissionWorkflow>
>();

function workflow() {
  const db = database();
  let submissionWorkflow = workflows.get(db);
  if (!submissionWorkflow) {
    submissionWorkflow = createSubmissionWorkflow(db, {
      publish: (submissionId, revision) =>
        workspaceEvents().publish({ submissionId, revision }),
    });
    workflows.set(db, submissionWorkflow);
  }
  return submissionWorkflow;
}

export const submissionService = () => workflow().submissions;
export const bugService = () => workflow().bugs;
export const repairService = () => workflow().repairs;
export const updateService = () => workflow().updates;
export const lifecycleService = () => workflow().lifecycle;
export const submissionExecutionService = () => workflow().executions;
export const workspaceService = () => workflow().workspace;
export const prepareDueUpdateExecutions = () => workflow().updates.prepareDueExecutions();
