import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database';
import { ProjectService } from '@/server/platform/projects/projectService';
import { BindingService } from '@/server/platform/projects/engineering/bindingService';
import { projectMemberHasEngineeringResponsibilities } from '@/server/platform/projects/engineering/responsibilities';
import {
  deleteProjectSubmissionRecords,
  prepareProjectSubmissionDeletion,
} from '@/server/submissions/projectDeletion';
import {
  projectMemberHasSubmissionResponsibilities,
  submissionReferencesBinding,
} from '@/server/submissions/references';

export function createProjectService(
  db: AppDatabase,
  now: () => Date = () => new Date(),
  createId: () => string = randomUUID,
): ProjectService {
  return new ProjectService(
    db,
    now,
    createId,
    (projectId, userId) =>
      projectMemberHasEngineeringResponsibilities(db, projectId, userId) ||
      projectMemberHasSubmissionResponsibilities(db, projectId, userId),
    [
      {
        prepare: (projectId) => prepareProjectSubmissionDeletion(db, projectId),
        deleteRecords: (projectId) => deleteProjectSubmissionRecords(db, projectId),
      },
    ],
  );
}

export function createBindingService(
  db: AppDatabase,
  now: () => Date = () => new Date(),
): BindingService {
  return new BindingService(db, now, randomUUID, [
    (id) => submissionReferencesBinding(db, id),
  ]);
}
