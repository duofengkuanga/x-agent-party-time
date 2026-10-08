import { requireProjectMember } from '@/cooking/shared/server/access';
import {
  environmentConflict,
  environmentObservers,
  environmentOwned,
  environmentReady,
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
  type SubmissionAccessRow,
  type SubmissionItemRow,
  type SubmissionRow,
} from './submission-queries';

type ItemSnapshotSource = Omit<
  SubmissionItemRow,
  'id' | 'submission_id' | 'target_branch' | 'created_at'
>;

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
    this.ensureDistinctItems(parsed);
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
      invalidation: (submission) => ({
        submissionId: submission.id,
        revision: submission.workspaceRevision,
      }),
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
            source: this.snapshotItemSource(projectId, item),
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
          this.insertItem(
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
          audits: [
            {
              projectId,
              action: 'SUBMISSION_CREATED',
              details: {
                testerUserId: parsed.testerUserId,
                itemIds: itemSnapshots.map(({ id }) => id),
                environmentTakeovers: takeovers,
              },
            },
          ],
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
    requireProjectMember(
      this.db,
      actorUserId,
      ProjectIdSchema.parse(projectId),
    );
    const parsed = CreateSubmissionInputSchema.parse(input);
    return parsed.items.flatMap((item) => {
      this.snapshotItemSource(projectId, item);
      const conflict = environmentConflict(
        this.db,
        actorUserId,
        item.environmentId,
      );
      return conflict ? [conflict] : [];
    });
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
      invalidation: (result) => ({
        submissionId: result.id,
        revision: result.workspaceRevision,
      }),
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
          audits: [
            {
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
          ],
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
          const item = this.db.get(
            `SELECT responsible_user_id, target_branch
               FROM cooking_submission_item
               WHERE id = ? AND submission_id = ?`,
            target.submissionItemId,
            submissionId,
          ) as
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
            this.db.get(
              `SELECT 1 FROM cooking_bug
                 WHERE submission_item_id = ? LIMIT 1`,
              target.submissionItemId,
            )
          )
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
        const update = this.db.run(
          `UPDATE cooking_test_submission
             SET title = ?, requirement_description = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND status = 'ACTIVE'`,
          [
            parsed.title,
            parsed.requirementDescription,
            updatedAt,
            submissionId,
            parsed.expectedVersion,
          ],
        );
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', '提测单已更新，请刷新后重试');
        const workspaceRevision = this.writes.bumpRevision(
          submissionId,
          updatedAt,
        );
        const result = {
          ...mapSubmission(current),
          title: parsed.title,
          requirementDescription: parsed.requirementDescription,
          version: current.version + 1,
          workspaceRevision,
          updatedAt,
        } satisfies TestSubmission;
        return {
          result,
          resourceId: submissionId,
          audits: [
            {
              projectId: current.project_id,
              action: 'SUBMISSION_DETAILS_UPDATED',
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
    const source = this.db.get(
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

  private insertItem(
    submissionId: string,
    itemId: string,
    position: number,
    source: ItemSnapshotSource,
    targetBranch: string,
    createdAt: string,
  ): void {
    this.db.run(
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
}
