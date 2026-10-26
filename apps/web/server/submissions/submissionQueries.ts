import { EffectiveEnvironmentDeploymentSchema } from '@/contracts/projects/engineering';
import { parseRow, type DatabaseRow } from '@/server/database/rowMapper';
import { submissionCloseBlocker } from '@/server/submissions/lifecycle/submissionClosure';
import { environmentAccessForItem } from './environmentAccess';
import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import { UserSchema, type User } from '@/contracts/auth';
import {
  SubmissionWorkspaceSnapshotSchema,
  SubmissionItemSchema,
  SubmissionSummarySchema,
  TestSubmissionSchema,
  type SubmissionWorkspaceSnapshot,
  type SubmissionItem,
  type SubmissionSummary,
  type TestSubmission,
} from '../../contracts/submissions/submission';

export const SUBMISSION_HIDDEN_MESSAGE = '提测单不存在或无权访问';

export type SubmissionRow = DatabaseRow<TestSubmission>;

export type SubmissionAccessRow = SubmissionRow & {
  project_name: string;
  membership_role: 'OWNER' | 'MEMBER';
  tester_username: string;
  tester_display_name: string;
  tester_created_at: string;
  creator_username: string;
  creator_display_name: string;
  creator_created_at: string;
};

export type SubmissionItemRow = {
  id: string;
  submission_id: string;
  engineering_id: string;
  engineering_name: string;
  engineering_type: 'FRONTEND' | 'BACKEND';
  engineering_identifier: string;
  repository_url: string;
  responsible_user_id: string;
  responsible_username: string;
  responsible_display_name: string;
  responsible_user_created_at: string;
  binding_id: string;
  target_branch: string;
  environment_id: string;
  environment_name: string;
  deployment_json: string;
  created_at: string;
};

type WorkspaceSubmissionItemRow = SubmissionItemRow & {
  bug_count: number;
  current_engineering_name: string;
  current_deployment_json: string;
};

export class SubmissionQueries {
  constructor(private readonly db: AppDatabase) {}

  listSubmissions(userId: string): SubmissionSummary[] {
    return this.db
      .all(
        `SELECT submission.*, project.name project_name,
                tester.username tester_username,
                tester.display_name tester_display_name,
                tester.created_at tester_created_at,
                (
                  SELECT COUNT(*)
                  FROM submission_item item
                  WHERE item.submission_id = submission.id
                ) item_count
         FROM test_submission submission
         JOIN platform_project project ON project.id = submission.project_id
         JOIN platform_project_membership membership
           ON membership.project_id = submission.project_id
          AND membership.user_id = ?
         JOIN platform_user tester ON tester.id = submission.tester_user_id
         ORDER BY submission.status = 'ACTIVE' DESC,
                  submission.updated_at DESC, submission.id`,
        userId,
      )
      .map((row) => {
        const value = row as SubmissionRow & {
          project_name: string;
          tester_username: string;
          tester_display_name: string;
          tester_created_at: string;
          item_count: number;
        };
        return SubmissionSummarySchema.parse({
          submission: mapSubmission(value),
          projectName: value.project_name,
          tester: mapUser('tester', value),
          itemCount: value.item_count,
        });
      });
  }

  getWorkspace(userId: string, submissionId: string): SubmissionWorkspaceSnapshot {
    const row = this.requireSubmissionAccess(userId, submissionId);
    const items = this.db
      .all<WorkspaceSubmissionItemRow>(
        `SELECT item.*, engineering.name current_engineering_name,
                CASE WHEN submission.status = 'ACTIVE' THEN environment.deployment_json
                  ELSE item.deployment_json END current_deployment_json,
                (
                  SELECT COUNT(*) FROM submission_bug bug
                  WHERE bug.submission_item_id = item.id
                ) bug_count
         FROM submission_item item
         JOIN platform_engineering engineering ON engineering.id = item.engineering_id
         JOIN test_submission submission ON submission.id = item.submission_id
         LEFT JOIN platform_environment environment ON environment.id = item.environment_id
         WHERE item.submission_id = ?
         ORDER BY item.position, item.id`,
        submissionId,
      )
      .map((item) => ({
        item: mapItem({
          ...item,
          engineering_name: item.current_engineering_name,
          deployment_json: item.current_deployment_json,
        }),
        hasBug: item.bug_count > 0,
        environmentAccess: environmentAccessForItem(this.db, userId, row, item).view,
      }));
    const canEdit =
      row.status === 'ACTIVE' &&
      (row.created_by_user_id === userId || row.membership_role === 'OWNER');
    const canClose =
      row.status === 'ACTIVE' &&
      row.tester_user_id === userId &&
      !submissionCloseBlocker(this.db, submissionId);
    return SubmissionWorkspaceSnapshotSchema.parse({
      revision: row.workspace_revision,
      currentUser: this.getUser(userId),
      submissions: this.listSubmissions(userId),
      submission: {
        submission: mapSubmission(row),
        projectName: row.project_name,
        tester: mapUser('tester', row),
        createdBy: mapUser('creator', row),
        items: items.map(({ item, hasBug, environmentAccess }) => ({
          id: item.id,
          submissionId: item.submissionId,
          engineering: {
            id: item.engineering.id,
            name: item.engineering.name,
            type: item.engineering.type,
            identifier: item.engineering.identifier,
          },
          responsibleUser: item.responsibleUser,
          targetBranch: item.targetBranch,
          environment: {
            id: item.environment.id,
            name: item.environment.name,
          },
          technical:
            item.responsibleUser.id === userId
              ? {
                  bindingId: item.bindingId,
                  repositoryUrl: item.engineering.repositoryUrl,
                  deployment: item.environment.deployment,
                }
              : null,
          environmentAccess,
          availableActions:
            row.status === 'ACTIVE' && item.responsibleUser.id === userId && !hasBug
              ? (['EDIT_TARGET_BRANCH'] as const)
              : [],
          createdAt: item.createdAt,
        })),
        availableActions: [
          ...(row.status === 'ACTIVE' &&
          items.length < 20 &&
          (canEdit ||
            row.tester_user_id === userId ||
            items.some(({ item }) => item.responsibleUser.id === userId)) &&
          this.hasAvailableEngineering(row)
            ? (['ADD_ITEMS'] as const)
            : []),
          ...(canEdit ? (['EDIT_DETAILS'] as const) : []),
          ...(canClose ? (['CLOSE'] as const) : []),
        ],
      },
    });
  }

  canAccessSubmission(userId: string, submissionId: string): boolean {
    try {
      this.requireSubmissionAccess(userId, submissionId);
      return true;
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  requireSubmissionAccess(userId: string, submissionId: string): SubmissionAccessRow {
    const row = this.db.get(
      `SELECT submission.*, project.name project_name,
                membership.role membership_role,
                tester.username tester_username,
                tester.display_name tester_display_name,
                tester.created_at tester_created_at,
                creator.username creator_username,
                creator.display_name creator_display_name,
                creator.created_at creator_created_at
         FROM test_submission submission
         JOIN platform_project project ON project.id = submission.project_id
         JOIN platform_project_membership membership
           ON membership.project_id = submission.project_id
          AND membership.user_id = ?
         JOIN platform_user tester ON tester.id = submission.tester_user_id
         JOIN platform_user creator ON creator.id = submission.created_by_user_id
         WHERE submission.id = ?`,
      userId,
      submissionId,
    ) as SubmissionAccessRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', SUBMISSION_HIDDEN_MESSAGE);
    return row;
  }

  private hasAvailableEngineering(submission: SubmissionAccessRow): boolean {
    return Boolean(
      this.db.get(
        `SELECT 1 FROM platform_engineering engineering
       WHERE engineering.project_id = ? AND engineering.archived_at IS NULL
         AND engineering.repository_state = 'CONFIRMED'
         AND NOT EXISTS (SELECT 1 FROM submission_item item
           WHERE item.submission_id = ? AND item.engineering_id = engineering.id)
         AND EXISTS (SELECT 1 FROM platform_environment environment
           WHERE environment.engineering_id = engineering.id)
         AND EXISTS (
           SELECT 1 FROM platform_engineering_binding binding
           JOIN platform_engineering_membership member
             ON member.engineering_id = binding.engineering_id AND member.user_id = binding.user_id
           JOIN platform_project_membership project_member
             ON project_member.project_id = engineering.project_id AND project_member.user_id = binding.user_id
           JOIN platform_runner runner ON runner.id = binding.runner_id
             AND runner.owner_user_id = binding.user_id AND runner.revoked_at IS NULL
           WHERE binding.engineering_id = engineering.id AND binding.user_id != ?
         ) LIMIT 1`,
        submission.project_id,
        submission.id,
        submission.tester_user_id,
      ),
    );
  }

  private getUser(userId: string): User {
    const row = this.db.get<DatabaseRow<User>>(
      `SELECT id, username, display_name, created_at
         FROM platform_user WHERE id = ?`,
      userId,
    );
    if (!row) throw new PlatformError('NOT_AUTHENTICATED', '当前用户不存在');
    return parseRow(UserSchema, row);
  }
}

export function mapSubmission(row: SubmissionRow): TestSubmission {
  return parseRow(TestSubmissionSchema, row);
}

function mapItem(row: SubmissionItemRow): SubmissionItem {
  return SubmissionItemSchema.parse({
    id: row.id,
    submissionId: row.submission_id,
    engineering: {
      id: row.engineering_id,
      name: row.engineering_name,
      type: row.engineering_type,
      identifier: row.engineering_identifier,
      repositoryUrl: row.repository_url,
    },
    responsibleUser: {
      id: row.responsible_user_id,
      username: row.responsible_username,
      displayName: row.responsible_display_name,
      createdAt: row.responsible_user_created_at,
    },
    bindingId: row.binding_id,
    targetBranch: row.target_branch,
    environment: {
      id: row.environment_id,
      name: row.environment_name,
      deployment: EffectiveEnvironmentDeploymentSchema.parse(
        JSON.parse(row.deployment_json),
      ),
    },
    createdAt: row.created_at,
  });
}

function mapUser(prefix: 'creator' | 'tester', row: Record<string, unknown>): User {
  return UserSchema.parse({
    id: prefix === 'tester' ? row.tester_user_id : row.created_by_user_id,
    username: row[`${prefix}_username`],
    displayName: row[`${prefix}_display_name`],
    createdAt: row[`${prefix}_created_at`],
  });
}
