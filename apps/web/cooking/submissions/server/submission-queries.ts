import { parseRow, type DatabaseRow } from '@/platform/database/row-mapper';
import {
  environmentBusy,
  environmentConflict,
  environmentOwned,
  environmentReady,
} from './environment-access';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { UserSchema, type User } from '@/platform/auth/contract';
import {
  CookingWorkspaceSnapshotSchema,
  SubmissionItemSchema,
  SubmissionSummarySchema,
  TestSubmissionSchema,
  type CookingWorkspaceSnapshot,
  type SubmissionItem,
  type SubmissionSummary,
  type TestSubmission,
} from '../contract';

export const SUBMISSION_HIDDEN_MESSAGE = '提测单不存在或无权访问';

export function hasActiveSubmissionExecution(
  db: AppDatabase,
  submissionId: string,
): boolean {
  return Boolean(
    db.get(
      `SELECT 1 active
         FROM platform_execution execution
         WHERE execution.state IN (
           'QUEUED', 'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION',
           'WAITING_TO_RESUME', 'CANCEL_REQUESTED'
         ) AND (
           execution.id IN (
             SELECT attempt.execution_id FROM cooking_repair_attempt attempt
             JOIN cooking_bug bug ON bug.id = attempt.bug_id
             WHERE bug.submission_id = ?
           ) OR execution.id IN (
             SELECT attempt.execution_id FROM cooking_update_attempt attempt
             JOIN cooking_update_batch batch ON batch.id = attempt.batch_id
             WHERE batch.submission_id = ?
           )
         ) LIMIT 1`,
      submissionId,
      submissionId,
    ),
  );
}

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

type WorkspaceSubmissionItemRow = SubmissionItemRow & { bug_count: number };

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
                  FROM cooking_submission_item item
                  WHERE item.submission_id = submission.id
                ) item_count
         FROM cooking_test_submission submission
         JOIN cooking_project project ON project.id = submission.project_id
         JOIN cooking_project_membership membership
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

  getWorkspace(userId: string, submissionId: string): CookingWorkspaceSnapshot {
    const row = this.requireSubmissionAccess(userId, submissionId);
    const items = this.db
      .all<WorkspaceSubmissionItemRow>(
        `SELECT item.*,
                (
                  SELECT COUNT(*) FROM cooking_bug bug
                  WHERE bug.submission_item_id = item.id
                ) bug_count
         FROM cooking_submission_item item
         WHERE submission_id = ?
         ORDER BY position, id`,
        submissionId,
      )
      .map((row) => ({ item: mapItem(row), hasBug: row.bug_count > 0 }));
    const canEdit =
      row.status === 'ACTIVE' &&
      (row.created_by_user_id === userId || row.membership_role === 'OWNER');
    const canClose =
      row.status === 'ACTIVE' &&
      row.tester_user_id === userId &&
      this.canCloseSubmission(submissionId);
    return CookingWorkspaceSnapshotSchema.parse({
      revision: row.workspace_revision,
      currentUser: this.getUser(userId),
      submissions: this.listSubmissions(userId),
      submission: {
        submission: mapSubmission(row),
        projectName: row.project_name,
        tester: mapUser('tester', row),
        createdBy: mapUser('creator', row),
        items: items.map(({ item, hasBug }) => ({
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
          environmentAccess: {
            owned: environmentOwned(this.db, item.id),
            deploymentConfirmed: environmentReady(this.db, item.id),
            conflict: environmentOwned(this.db, item.id)
              ? null
              : environmentConflict(this.db, userId, item.environment.id),
            canAcquire:
              row.status === 'ACTIVE' &&
              !environmentOwned(this.db, item.id) &&
              (row.membership_role === 'OWNER' ||
                [
                  row.tester_user_id,
                  row.created_by_user_id,
                  item.responsibleUser.id,
                ].includes(userId)),
            canConfirmDeployment:
              row.status === 'ACTIVE' &&
              item.responsibleUser.id === userId &&
              environmentOwned(this.db, item.id) &&
              !environmentReady(this.db, item.id) &&
              !environmentBusy(this.db, item.id),
          },
          availableActions:
            row.status === 'ACTIVE' &&
            item.responsibleUser.id === userId &&
            !hasBug
              ? (['EDIT_TARGET_BRANCH'] as const)
              : [],
          createdAt: item.createdAt,
        })),
        availableActions: [
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
      if (error instanceof PlatformError && error.code === 'NOT_FOUND')
        return false;
      throw error;
    }
  }

  private canCloseSubmission(submissionId: string): boolean {
    const nonTerminal = this.db.get(
      `SELECT 1 blocked FROM cooking_bug
         WHERE submission_id = ? AND stage NOT IN ('DONE', 'CANCELLED')
         LIMIT 1`,
      submissionId,
    );
    if (nonTerminal) return false;
    const unfinishedBatch = this.db.get(
      `SELECT 1 blocked FROM cooking_update_batch
         WHERE submission_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED')
         LIMIT 1`,
      submissionId,
    );
    if (unfinishedBatch) return false;
    return !hasActiveSubmissionExecution(this.db, submissionId);
  }

  requireSubmissionAccess(
    userId: string,
    submissionId: string,
  ): SubmissionAccessRow {
    const row = this.db.get(
      `SELECT submission.*, project.name project_name,
                membership.role membership_role,
                tester.username tester_username,
                tester.display_name tester_display_name,
                tester.created_at tester_created_at,
                creator.username creator_username,
                creator.display_name creator_display_name,
                creator.created_at creator_created_at
         FROM cooking_test_submission submission
         JOIN cooking_project project ON project.id = submission.project_id
         JOIN cooking_project_membership membership
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
      deployment: JSON.parse(row.deployment_json),
    },
    createdAt: row.created_at,
  });
}

function mapUser(
  prefix: 'creator' | 'tester',
  row: Record<string, unknown>,
): User {
  return UserSchema.parse({
    id: prefix === 'tester' ? row.tester_user_id : row.created_by_user_id,
    username: row[`${prefix}_username`],
    displayName: row[`${prefix}_display_name`],
    createdAt: row[`${prefix}_created_at`],
  });
}
