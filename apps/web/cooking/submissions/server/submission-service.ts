import { requireProjectMember } from '@/cooking/shared/server/access';
import {
  environmentObservers,
  environmentOwned,
  environmentBusy,
  requireEnvironment,
  releaseEnvironmentForTakeover,
} from './environment-access';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ProjectIdSchema } from '@/cooking/projects/contract';
import { TestSubmissionWriteStore } from './test-submission-write-store';
import {
  ensureDistinctItems,
  environmentConflictsForSubmission,
  insertItem,
  snapshotItemSource,
} from './submission-items';
import {
  CreateSubmissionInputSchema,
  TestSubmissionSchema,
  UpdateSubmissionInputSchema,
  EnvironmentCommandSchema,
  type EnvironmentCommand,
  type EnvironmentConflict,
  type CreateSubmissionInput,
  type TestSubmission,
  type UpdateSubmissionInput,
} from '../contract';

import {
  SubmissionQueries,
  mapSubmission,
  SUBMISSION_HIDDEN_MESSAGE,
  type SubmissionItemRow,
  type SubmissionRow,
} from './submission-queries';

export class SubmissionService {
  private readonly queries: SubmissionQueries;
  readonly listSubmissions: SubmissionQueries['listSubmissions'];
  readonly getWorkspace: SubmissionQueries['getWorkspace'];
  readonly canAccessSubmission: SubmissionQueries['canAccessSubmission'];
  private readonly requireSubmissionAccess: SubmissionQueries['requireSubmissionAccess'];
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
    this.queries = new SubmissionQueries(db);
    this.listSubmissions = this.queries.listSubmissions.bind(this.queries);
    this.getWorkspace = this.queries.getWorkspace.bind(this.queries);
    this.canAccessSubmission = this.queries.canAccessSubmission.bind(
      this.queries,
    );
    this.requireSubmissionAccess = this.queries.requireSubmissionAccess.bind(
      this.queries,
    );
  }

  createSubmission(
    actorUserId: string,
    projectIdInput: string,
    input: CreateSubmissionInput,
  ): TestSubmission {
    const projectId = ProjectIdSchema.parse(projectIdInput);
    const parsed = CreateSubmissionInputSchema.parse(input);
    ensureDistinctItems(parsed);
    const takeovers = parsed.environmentTakeovers ?? [];
    if (
      new Set(takeovers.map((value) => value.environmentId)).size !==
        takeovers.length ||
      takeovers.some(
        (value) =>
          !parsed.items.some(
            (item) => item.environmentId === value.environmentId,
          ),
      )
    )
      throw new PlatformError(
        'VALIDATION_FAILED',
        '环境切换确认与当前提测项不匹配',
      );
    const invalidations = new Map<string, number>();
    const result = this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'SUBMISSION_CREATE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: TestSubmissionSchema,
      submissionId: (submission) => submission.id,
      perform: () => {
        requireProjectMember(this.db, actorUserId, projectId);
        requireProjectMember(this.db, parsed.testerUserId, projectId);
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
            source: snapshotItemSource(this.db, projectId, item),
            targetBranch: item.targetBranch,
          };
        });
        const stored = this.db.get<SubmissionRow>(
          `INSERT INTO cooking_test_submission(
               id, project_id, title, requirement_description,
               tester_user_id, status, version, workspace_revision,
               created_by_user_id, created_at, updated_at, closed_at
             ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, 1, ?, ?, ?, NULL) RETURNING *`,
          submissionId,
          projectId,
          parsed.title,
          parsed.requirementDescription,
          parsed.testerUserId,
          actorUserId,
          createdAt,
          createdAt,
        )!;
        for (const item of itemSnapshots) {
          insertItem(
            this.db,
            submissionId,
            item.id,
            item.position,
            item.source,
            item.targetBranch,
            createdAt,
          );
          const previous = releaseEnvironmentForTakeover(
            this.db,
            actorUserId,
            item.source.environment_id,
            takeovers.find(
              (value) => value.environmentId === item.source.environment_id,
            ),
          );
          this.db.run(
            `INSERT INTO cooking_submission_environment_lock(
            environment_id, engineering_id, submission_id, submission_item_id, created_at, deployment_confirmed
          ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              item.source.environment_id,
              item.source.engineering_id,
              submissionId,
              item.id,
              createdAt,
              previous ? 0 : 1,
            ],
          );
          for (const observer of environmentObservers(
            this.db,
            item.source.environment_id,
            submissionId,
          ))
            invalidations.set(observer, 0);
        }
        for (const previousId of invalidations.keys())
          invalidations.set(
            previousId,
            this.writes.bumpRevision(previousId, createdAt),
          );
        const submission = mapSubmission(stored);
        return {
          result: submission,
          resourceId: submissionId,
          audit: {
            projectId,
            action: 'SUBMISSION_CREATED',
            details: {
              testerUserId: parsed.testerUserId,
              itemIds: itemSnapshots.map(({ id }) => id),
              environmentTakeovers: takeovers,
            },
          },
        };
      },
    });
    for (const [id, revision] of invalidations)
      this.writes.publishInvalidation(id, revision);
    return result;
  }

  environmentConflicts(
    actorUserId: string,
    projectId: string,
    input: CreateSubmissionInput,
  ): EnvironmentConflict[] {
    return environmentConflictsForSubmission(
      this.db,
      actorUserId,
      projectId,
      input,
    );
  }

  changeEnvironment(
    actorUserId: string,
    itemId: string,
    inputValue: EnvironmentCommand,
  ): TestSubmission {
    const input = EnvironmentCommandSchema.parse(inputValue);
    const invalidations = new Map<string, number>();
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'SUBMISSION_ENVIRONMENT_CHANGE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: TestSubmissionSchema,
      submissionId: (result) => result.id,
      perform: () => {
        const item = this.db.get(
          'SELECT * FROM cooking_submission_item WHERE id = ?',
          itemId,
        ) as SubmissionItemRow | undefined;
        if (!item)
          throw new PlatformError('NOT_FOUND', SUBMISSION_HIDDEN_MESSAGE);
        const submission = this.requireSubmissionAccess(
          actorUserId,
          item.submission_id,
        );
        if (submission.status !== 'ACTIVE')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已关闭提测单不能切换环境',
          );
        if (submission.workspace_revision !== input.expectedRevision)
          throw new PlatformError('STALE_STATE', '提测单已更新，请刷新后重试');
        const now = this.now().toISOString();
        if (input.action === 'CONFIRM_DEPLOYMENT') {
          if (actorUserId !== item.responsible_user_id)
            throw new PlatformError(
              'PERMISSION_DENIED',
              '只有对应工程负责人可以确认部署',
            );
          requireEnvironment(this.db, itemId);
          if (environmentBusy(this.db, itemId))
            throw new PlatformError(
              'RESOURCE_CONFLICT',
              '更新或部署尚未结束，暂时不能确认',
            );
          this.db.run(
            'UPDATE cooking_submission_environment_lock SET deployment_confirmed = 1 WHERE submission_item_id = ?',
            [itemId],
          );
        } else {
          if (
            ![
              submission.tester_user_id,
              submission.created_by_user_id,
              item.responsible_user_id,
            ].includes(actorUserId) &&
            submission.membership_role !== 'OWNER'
          )
            throw new PlatformError(
              'PERMISSION_DENIED',
              '只有提测参与者或项目所有者可以取得环境使用权',
            );
          if (environmentOwned(this.db, itemId))
            throw new PlatformError(
              'STALE_STATE',
              '当前提测项已取得环境，请刷新后重试',
            );
          if (
            input.takeover &&
            input.takeover.environmentId !== item.environment_id
          )
            throw new PlatformError(
              'VALIDATION_FAILED',
              '环境切换确认与当前提测项不匹配',
            );
          releaseEnvironmentForTakeover(
            this.db,
            actorUserId,
            item.environment_id,
            input.takeover,
          );
          this.db.run(
            `INSERT INTO cooking_submission_environment_lock(environment_id, engineering_id, submission_id, submission_item_id, created_at, deployment_confirmed)
            VALUES (?, ?, ?, ?, ?, 0)`,
            [
              item.environment_id,
              item.engineering_id,
              item.submission_id,
              item.id,
              now,
            ],
          );
          for (const observer of environmentObservers(
            this.db,
            item.environment_id,
            submission.id,
          ))
            invalidations.set(
              observer,
              this.writes.bumpRevision(observer, now),
            );
        }
        const revision = this.writes.bumpRevision(submission.id, now);
        return {
          result: {
            ...mapSubmission(submission),
            workspaceRevision: revision,
            updatedAt: now,
          },
          resourceId: submission.id,
          audit: {
            projectId: submission.project_id,
            action:
              input.action === 'ACQUIRE'
                ? 'SUBMISSION_ENVIRONMENT_ACQUIRED'
                : 'SUBMISSION_DEPLOYMENT_CONFIRMED',
            details: {
              submissionItemId: itemId,
              takeover: input.takeover ?? null,
            },
          },
        };
      },
    });
    for (const [id, revision] of invalidations)
      this.writes.publishInvalidation(id, revision);
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
    return this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'SUBMISSION_UPDATE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: TestSubmissionSchema,
      submissionId: (submission) => submission.id,
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
          const item = this.db.get(
            `SELECT item.responsible_user_id, item.target_branch,
                    EXISTS(SELECT 1 FROM cooking_bug bug
                           WHERE bug.submission_item_id = item.id) has_bug
               FROM cooking_submission_item item
               WHERE item.id = ? AND item.submission_id = ?`,
            target.submissionItemId,
            submissionId,
          ) as
            | {
                responsible_user_id: string;
                target_branch: string;
                has_bug: number;
              }
            | undefined;
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
          if (item.has_bug)
            throw new PlatformError(
              'INVALID_TRANSITION',
              '该工程已有缺陷，不能再修改目标分支',
            );
          if (item.target_branch === target.targetBranch) continue;
          const updateItem = this.db.run(
            `UPDATE cooking_submission_item
               SET target_branch = ?
               WHERE id = ? AND submission_id = ?
                 AND responsible_user_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM cooking_bug
                   WHERE submission_item_id = cooking_submission_item.id
                 )`,
            [
              target.targetBranch,
              target.submissionItemId,
              submissionId,
              actorUserId,
            ],
          );
          if (updateItem.changes !== 1)
            throw new PlatformError(
              'STALE_STATE',
              '提测工程状态已更新，请刷新后重试',
            );
          changedTargetBranches.push(target);
        }
        const updated = this.db.get<SubmissionRow>(
          `UPDATE cooking_test_submission
             SET title = ?, requirement_description = ?,
                 version = version + 1,
                 workspace_revision = workspace_revision + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND status = 'ACTIVE'
             RETURNING *`,
          parsed.title,
          parsed.requirementDescription,
          updatedAt,
          submissionId,
          parsed.expectedVersion,
        );
        if (!updated)
          throw new PlatformError('STALE_STATE', '提测单已更新，请刷新后重试');
        const result = mapSubmission(updated);
        return {
          result,
          resourceId: submissionId,
          audit: {
            projectId: current.project_id,
            action: 'SUBMISSION_DETAILS_UPDATED',
            details: {
              title: parsed.title,
              requirementDescription: parsed.requirementDescription,
              targetBranches: changedTargetBranches,
            },
          },
        };
      },
    });
  }
}
