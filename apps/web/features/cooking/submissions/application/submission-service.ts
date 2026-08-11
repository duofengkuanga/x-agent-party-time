import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import { UserSchema, type User } from '@/server/auth/contract';
import { ProjectIdSchema } from '@/features/cooking/projects/contract';
import { TestSubmissionWriteStore } from './test-submission-write-store';
import {
  CookingWorkspaceSnapshotSchema,
  CreateSubmissionInputSchema,
  SubmissionItemSchema,
  SubmissionSummarySchema,
  TestSubmissionSchema,
  UpdateSubmissionInputSchema,
  type CookingWorkspaceSnapshot,
  type CreateSubmissionInput,
  type SubmissionItem,
  type SubmissionSummary,
  type TestSubmission,
  type UpdateSubmissionInput,
} from '../contract';

const SUBMISSION_HIDDEN_MESSAGE = '提测单不存在或无权访问';

type SubmissionRow = {
  id: string;
  project_id: string;
  title: string;
  requirement_description: string;
  tester_user_id: string;
  status: 'ACTIVE' | 'CLOSED';
  version: number;
  workspace_revision: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

type SubmissionAccessRow = SubmissionRow & {
  project_name: string;
  membership_role: 'OWNER' | 'MEMBER';
  tester_username: string;
  tester_display_name: string;
  tester_created_at: string;
  creator_username: string;
  creator_display_name: string;
  creator_created_at: string;
};

type SubmissionItemRow = {
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

type ItemSnapshotSource = {
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
  environment_id: string;
  environment_name: string;
  deployment_json: string;
};

export class SubmissionService {
  private readonly writes: TestSubmissionWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    onInvalidated: (submissionId: string, revision: number) => void = () => {},
  ) {
    this.writes = new TestSubmissionWriteStore(
      db,
      now,
      createId,
      onInvalidated,
    );
  }

  createSubmission(
    actorUserId: string,
    projectIdInput: string,
    input: CreateSubmissionInput,
  ): TestSubmission {
    const projectId = ProjectIdSchema.parse(projectIdInput);
    const parsed = CreateSubmissionInputSchema.parse(input);
    this.ensureDistinctItems(parsed);
    const result = this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'SUBMISSION_CREATE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: TestSubmissionSchema,
      invalidation: (submission) => ({
        submissionId: submission.id,
        revision: submission.workspaceRevision,
      }),
      perform: () => {
        this.requireProjectMember(actorUserId, projectId);
        this.requireProjectMember(parsed.testerUserId, projectId);
        const createdAt = this.now().toISOString();
        const submissionId = this.createId();
        const itemSnapshots = parsed.items.map((item, position) => {
          if (item.responsibleUserId === parsed.testerUserId)
            throw new PlatformError(
              'VALIDATION_FAILED',
              '测试负责人不能同时担任提测项负责人',
            );
          return {
            id: this.createId(),
            position,
            source: this.snapshotItemSource(projectId, item),
            targetBranch: item.targetBranch,
          };
        });
        this.db
          .prepare(
            `INSERT INTO cooking_test_submission(
               id, project_id, title, requirement_description,
               tester_user_id, status, version, workspace_revision,
               created_by_user_id, created_at, updated_at, closed_at
             ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, 1, ?, ?, ?, NULL)`,
          )
          .run(
            submissionId,
            projectId,
            parsed.title,
            parsed.requirementDescription,
            parsed.testerUserId,
            actorUserId,
            createdAt,
            createdAt,
          );
        for (const item of itemSnapshots) {
          this.insertItem(
            submissionId,
            item.id,
            item.position,
            item.source,
            item.targetBranch,
            createdAt,
          );
          const lock = this.db
            .prepare(
              `INSERT INTO cooking_submission_environment_lock(
                 environment_id, engineering_id, submission_id,
                 submission_item_id, created_at
               )
               SELECT ?, ?, ?, ?, ?
               WHERE NOT EXISTS (
                 SELECT 1 FROM cooking_submission_environment_lock
                 WHERE environment_id = ?
               )`,
            )
            .run(
              item.source.environment_id,
              item.source.engineering_id,
              submissionId,
              item.id,
              createdAt,
              item.source.environment_id,
            );
          if (lock.changes !== 1)
            throw new PlatformError(
              'RESOURCE_CONFLICT',
              '所选环境已被其他活动提测单占用',
            );
        }
        const submission = TestSubmissionSchema.parse({
          id: submissionId,
          projectId,
          title: parsed.title,
          requirementDescription: parsed.requirementDescription,
          testerUserId: parsed.testerUserId,
          status: 'ACTIVE',
          version: 1,
          workspaceRevision: 1,
          createdByUserId: actorUserId,
          createdAt,
          updatedAt: createdAt,
          closedAt: null,
        });
        return {
          result: submission,
          resourceId: submissionId,
          audits: [
            {
              projectId,
              action: 'SUBMISSION_CREATED',
              targetType: 'TEST_SUBMISSION',
              targetId: submissionId,
              details: {
                testerUserId: parsed.testerUserId,
                itemIds: itemSnapshots.map(({ id }) => id),
              },
            },
          ],
        };
      },
    });
    return result;
  }

  updateSubmission(
    actorUserId: string,
    submissionId: string,
    input: UpdateSubmissionInput,
  ): TestSubmission {
    const parsed = UpdateSubmissionInputSchema.parse(input);
    const targetBranches = parsed.targetBranches ?? [];
    if (
      new Set(targetBranches.map(({ submissionItemId }) => submissionItemId))
        .size !== targetBranches.length
    )
      throw new PlatformError(
        'VALIDATION_FAILED',
        '同一提测工程不能重复提交目标分支',
      );
    const result = this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'SUBMISSION_UPDATE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: TestSubmissionSchema,
      invalidation: (submission) => ({
        submissionId: submission.id,
        revision: submission.workspaceRevision,
      }),
      perform: () => {
        const current = this.requireSubmissionAccess(actorUserId, submissionId);
        const canEditDetails =
          current.created_by_user_id === actorUserId ||
          current.membership_role === 'OWNER';
        const detailsChanged =
          parsed.title !== current.title ||
          parsed.requirementDescription !== current.requirement_description;
        if (detailsChanged && !canEditDetails)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有创建人或项目所有者可以修改提测信息',
          );
        if (!canEditDetails && targetBranches.length === 0)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '当前用户没有可修改的提测信息',
          );
        if (current.status !== 'ACTIVE')
          throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能修改');
        if (current.version !== parsed.expectedVersion)
          throw new PlatformError('STALE_STATE', '提测单已更新，请刷新后重试');
        const updatedAt = this.now().toISOString();
        const changedTargetBranches: Array<{
          submissionItemId: string;
          targetBranch: string;
        }> = [];
        for (const target of targetBranches) {
          const item = this.db
            .prepare(
              `SELECT responsible_user_id, target_branch
               FROM cooking_submission_item
               WHERE id = ? AND submission_id = ?`,
            )
            .get(target.submissionItemId, submissionId) as
            { responsible_user_id: string; target_branch: string } | undefined;
          if (!item)
            throw new PlatformError(
              'VALIDATION_FAILED',
              '提测工程不存在或不属于当前提测单',
            );
          if (item.responsible_user_id !== actorUserId)
            throw new PlatformError(
              'PERMISSION_DENIED',
              '只有对应开发负责人可以修改目标分支',
            );
          if (
            this.db
              .prepare(
                `SELECT 1 FROM cooking_bug
                 WHERE submission_item_id = ? LIMIT 1`,
              )
              .get(target.submissionItemId)
          )
            throw new PlatformError(
              'INVALID_TRANSITION',
              '该工程已有缺陷，不能再修改目标分支',
            );
          if (item.target_branch === target.targetBranch) continue;
          const updateItem = this.db
            .prepare(
              `UPDATE cooking_submission_item
               SET target_branch = ?
               WHERE id = ? AND submission_id = ?
                 AND responsible_user_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM cooking_bug
                   WHERE submission_item_id = cooking_submission_item.id
                 )`,
            )
            .run(
              target.targetBranch,
              target.submissionItemId,
              submissionId,
              actorUserId,
            );
          if (updateItem.changes !== 1)
            throw new PlatformError(
              'STALE_STATE',
              '提测工程状态已更新，请刷新后重试',
            );
          changedTargetBranches.push(target);
        }
        const update = this.db
          .prepare(
            `UPDATE cooking_test_submission
             SET title = ?, requirement_description = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND status = 'ACTIVE'`,
          )
          .run(
            parsed.title,
            parsed.requirementDescription,
            updatedAt,
            submissionId,
            parsed.expectedVersion,
          );
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', '提测单已更新，请刷新后重试');
        const workspaceRevision = this.writes.bumpRevision(
          submissionId,
          updatedAt,
        );
        const result = TestSubmissionSchema.parse({
          ...mapSubmission(current),
          title: parsed.title,
          requirementDescription: parsed.requirementDescription,
          version: current.version + 1,
          workspaceRevision,
          updatedAt,
        });
        return {
          result,
          resourceId: submissionId,
          audits: [
            {
              projectId: current.project_id,
              action: 'SUBMISSION_DETAILS_UPDATED',
              targetType: 'TEST_SUBMISSION',
              targetId: submissionId,
              details: {
                title: parsed.title,
                requirementDescription: parsed.requirementDescription,
                targetBranches: changedTargetBranches,
              },
            },
          ],
        };
      },
    });
    return result;
  }

  listSubmissions(userId: string): SubmissionSummary[] {
    return this.db
      .prepare(
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
      )
      .all(userId)
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
      .prepare(
        `SELECT item.*,
                (
                  SELECT COUNT(*) FROM cooking_bug bug
                  WHERE bug.submission_item_id = item.id
                ) bug_count
         FROM cooking_submission_item item
         WHERE submission_id = ?
         ORDER BY position, id`,
      )
      .all(submissionId)
      .map((row) => {
        const itemRow = row as WorkspaceSubmissionItemRow;
        return { item: mapItem(itemRow), hasBug: itemRow.bug_count > 0 };
      });
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
    const nonTerminal = this.db
      .prepare(
        `SELECT 1 blocked FROM cooking_bug
         WHERE submission_id = ? AND stage NOT IN ('DONE', 'CANCELLED')
         LIMIT 1`,
      )
      .get(submissionId);
    if (nonTerminal) return false;
    const unfinishedBatch = this.db
      .prepare(
        `SELECT 1 blocked FROM cooking_update_batch
         WHERE submission_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED')
         LIMIT 1`,
      )
      .get(submissionId);
    if (unfinishedBatch) return false;
    return !this.db
      .prepare(
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
      )
      .get(submissionId, submissionId);
  }

  private ensureDistinctItems(input: CreateSubmissionInput): void {
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

  private snapshotItemSource(
    projectId: string,
    item: CreateSubmissionInput['items'][number],
  ): ItemSnapshotSource {
    const source = this.db
      .prepare(
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
      )
      .get(
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

  private insertItem(
    submissionId: string,
    itemId: string,
    position: number,
    source: ItemSnapshotSource,
    targetBranch: string,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO cooking_submission_item(
           id, submission_id, position, engineering_id, engineering_name,
           engineering_type, engineering_identifier, repository_url,
           responsible_user_id, responsible_username,
           responsible_display_name, responsible_user_created_at,
           binding_id, target_branch, environment_id, environment_name,
           deployment_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }

  private requireProjectMember(userId: string, projectId: string): void {
    const membership = this.db
      .prepare(
        `SELECT 1 present FROM cooking_project_membership
         WHERE project_id = ? AND user_id = ?`,
      )
      .get(projectId, userId);
    if (!membership)
      throw new PlatformError('NOT_FOUND', '项目不存在或无权访问');
  }

  private requireSubmissionAccess(
    userId: string,
    submissionId: string,
  ): SubmissionAccessRow {
    const row = this.db
      .prepare(
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
      )
      .get(userId, submissionId) as SubmissionAccessRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', SUBMISSION_HIDDEN_MESSAGE);
    return row;
  }

  private getUser(userId: string): User {
    const row = this.db
      .prepare(
        `SELECT id, username, display_name, created_at
         FROM platform_user WHERE id = ?`,
      )
      .get(userId) as
      | {
          id: string;
          username: string;
          display_name: string;
          created_at: string;
        }
      | undefined;
    if (!row) throw new PlatformError('NOT_AUTHENTICATED', '当前用户不存在');
    return UserSchema.parse({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
    });
  }
}

function mapSubmission(row: SubmissionRow): TestSubmission {
  return TestSubmissionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    requirementDescription: row.requirement_description,
    testerUserId: row.tester_user_id,
    status: row.status,
    version: row.version,
    workspaceRevision: row.workspace_revision,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  });
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
