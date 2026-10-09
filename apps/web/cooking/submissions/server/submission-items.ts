import { requireProjectMember } from '@/cooking/shared/server/access';
import { ProjectIdSchema } from '@/cooking/projects/contract';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  CreateSubmissionInputSchema,
  type CreateSubmissionInput,
  type EnvironmentConflict,
} from '../contract';
import { environmentConflict } from './environment-access';
import type { SubmissionItemRow } from './submission-queries';

type ItemSnapshotSource = Omit<
  SubmissionItemRow,
  'id' | 'submission_id' | 'target_branch' | 'created_at'
>;

export function environmentConflictsForSubmission(
  db: AppDatabase,
  actorUserId: string,
  projectId: string,
  input: CreateSubmissionInput,
): EnvironmentConflict[] {
  requireProjectMember(db, actorUserId, ProjectIdSchema.parse(projectId));
  const parsed = CreateSubmissionInputSchema.parse(input);
  return parsed.items.flatMap((item) => {
    snapshotItemSource(db, projectId, item);
    const conflict = environmentConflict(db, actorUserId, item.environmentId);
    return conflict ? [conflict] : [];
  });
}

export function ensureDistinctItems(input: CreateSubmissionInput): void {
  const engineeringIds = new Set<string>();
  const environmentIds = new Set<string>();
  for (const item of input.items) {
    if (engineeringIds.has(item.engineeringId))
      throw new PlatformError(
        'VALIDATION_FAILED',
        '同一工程在一张提测单中只能出现一次',
      );
    if (environmentIds.has(item.environmentId))
      throw new PlatformError(
        'VALIDATION_FAILED',
        '同一环境在一张提测单中只能出现一次',
      );
    engineeringIds.add(item.engineeringId);
    environmentIds.add(item.environmentId);
  }
}

export function snapshotItemSource(
  db: AppDatabase,
  projectId: string,
  item: CreateSubmissionInput['items'][number],
): ItemSnapshotSource {
  const source = db.get(
    `SELECT engineering.id engineering_id,
              engineering.name engineering_name,
              engineering.type engineering_type,
              engineering.identifier engineering_identifier,
              engineering.repository_url,
              responsible.id responsible_user_id,
              responsible.username responsible_username,
              responsible.display_name responsible_display_name,
              responsible.created_at responsible_user_created_at,
              binding.id binding_id,
              environment.id environment_id,
              environment.name environment_name,
              environment.deployment_json
       FROM cooking_engineering engineering
       JOIN cooking_project_membership project_membership
         ON project_membership.project_id = engineering.project_id
        AND project_membership.user_id = ?
       JOIN cooking_engineering_membership engineering_membership
         ON engineering_membership.engineering_id = engineering.id
        AND engineering_membership.user_id = ?
       JOIN platform_user responsible
         ON responsible.id = engineering_membership.user_id
       JOIN cooking_engineering_binding binding
         ON binding.id = ?
        AND binding.engineering_id = engineering.id
        AND binding.user_id = responsible.id
       JOIN platform_runner runner
         ON runner.id = binding.runner_id
        AND runner.owner_user_id = responsible.id
        AND runner.revoked_at IS NULL
       JOIN cooking_environment environment
         ON environment.id = ?
        AND environment.engineering_id = engineering.id
       WHERE engineering.id = ?
         AND engineering.project_id = ?
         AND engineering.repository_state = 'CONFIRMED'
         AND engineering.archived_at IS NULL`,
    item.responsibleUserId,
    item.responsibleUserId,
    item.bindingId,
    item.environmentId,
    item.engineeringId,
    projectId,
  ) as ItemSnapshotSource | undefined;
  if (!source)
    throw new PlatformError(
      'VALIDATION_FAILED',
      '提测项仓库、负责人、绑定、Agent 或环境配置无效',
    );
  return source;
}

export function insertItem(
  db: AppDatabase,
  submissionId: string,
  itemId: string,
  position: number,
  source: ItemSnapshotSource,
  targetBranch: string,
  createdAt: string,
): void {
  db.run(
    `INSERT INTO cooking_submission_item(
         id, submission_id, position, engineering_id, engineering_name,
         engineering_type, engineering_identifier, repository_url,
         responsible_user_id, responsible_username,
         responsible_display_name, responsible_user_created_at,
         binding_id, target_branch, environment_id, environment_name,
         deployment_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      itemId,
      submissionId,
      position,
      source.engineering_id,
      source.engineering_name,
      source.engineering_type,
      source.engineering_identifier,
      source.repository_url,
      source.responsible_user_id,
      source.responsible_username,
      source.responsible_display_name,
      source.responsible_user_created_at,
      source.binding_id,
      targetBranch,
      source.environment_id,
      source.environment_name,
      source.deployment_json,
      createdAt,
    ],
  );
}
