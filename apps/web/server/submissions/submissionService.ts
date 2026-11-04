import { normalizeRepositoryUrl } from '@agent-party-time/runner-contract';
import { requireProjectMember } from '@/server/platform/projects/access';
import { acquireEnvironment, environmentAccessForItem } from './environmentAccess';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import { ProjectIdSchema } from '@/contracts/projects/project';
import { TestSubmissionWriteStore } from './testSubmissionWriteStore';
import {
  ensureDistinctItems,
  environmentConflictsForSubmission,
  insertItem,
  snapshotItemSource,
} from './submissionItems';
import {
  CreateSubmissionInputSchema,
  AddSubmissionItemsInputSchema,
  type AddSubmissionItemsInput,
  TestSubmissionSchema,
  UpdateSubmissionInputSchema,
  EnvironmentCommandSchema,
  type EnvironmentCommand,
  type EnvironmentConflict,
  type CreateSubmissionInput,
  type TestSubmission,
  type PersonAgentAssignment,
  type UpdateSubmissionInput,
} from '../../contracts/submissions/submission';

import {
  SubmissionQueries,
  mapSubmission,
  SUBMISSION_HIDDEN_MESSAGE,
  type SubmissionItemRow,
  type SubmissionRow,
} from './submissionQueries';

export class SubmissionService {
  private readonly queries: SubmissionQueries;
  readonly listSubmissions: SubmissionQueries['listSubmissions'];
  readonly getWorkspace: SubmissionQueries['getWorkspace'];
  readonly canAccessSubmission: SubmissionQueries['canAccessSubmission'];
  private readonly writes: TestSubmissionWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    onInvalidated: (submissionId: string, revision: number) => void = () => {},
  ) {
    this.writes = new TestSubmissionWriteStore(db, now, createId, onInvalidated);
    this.queries = new SubmissionQueries(db);
    this.listSubmissions = this.queries.listSubmissions.bind(this.queries);
    this.getWorkspace = this.queries.getWorkspace.bind(this.queries);
    this.canAccessSubmission = this.queries.canAccessSubmission.bind(this.queries);
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
      new Set(takeovers.map((value) => value.environmentId)).size !== takeovers.length ||
      takeovers.some(
        (value) =>
          !parsed.items.some((item) => item.environmentId === value.environmentId),
      )
    )
      throw new PlatformError('VALIDATION_FAILED', '环境切换确认与当前提测项不匹配');
    return this.writes.run({
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
          const source = snapshotItemSource(this.db, projectId, item);
          if (parsed.personAgent) requirePersonAgentBinding(parsed.personAgent, source);
          return {
            id: this.createId(),
            position,
            source,
            targetBranch: item.targetBranch,
          };
        });
        if (parsed.personAgent)
          requireDistinctPersonAgentTargets(
            itemSnapshots.map(({ source, targetBranch }) => ({
              repository_url: source.repository_url,
              target_branch: targetBranch,
            })),
          );
        const stored = this.db.get<SubmissionRow>(
          `INSERT INTO test_submission(
               id, project_id, title, requirement_description,
               tester_user_id, mode, person_agent_developer_id, person_agent_runner_id,
               status, version, workspace_revision, created_by_user_id, created_at, updated_at, closed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, 1, ?, ?, ?, NULL) RETURNING *`,
          submissionId,
          projectId,
          parsed.title,
          parsed.requirementDescription,
          parsed.testerUserId,
          parsed.mode,
          parsed.personAgent?.responsibleUserId ?? null,
          parsed.personAgent?.runnerId ?? null,
          actorUserId,
          createdAt,
          createdAt,
        )!;
        const affectedSubmissionIds: string[] = [];
        for (const item of itemSnapshots) {
          const observers = insertItem(this.db, {
            actorUserId,
            submissionId,
            itemId: item.id,
            position: item.position,
            source: item.source,
            targetBranch: item.targetBranch,
            createdAt,
            takeover: takeovers.find(
              (value) => value.environmentId === item.source.environment_id,
            ),
          });
          affectedSubmissionIds.push(...observers);
        }
        const submission = mapSubmission(stored);
        return {
          result: submission,
          resourceId: submissionId,
          affectedSubmissions: { ids: affectedSubmissionIds, updatedAt: createdAt },
          audit: {
            projectId,
            action: 'SUBMISSION_CREATED',
            details: {
              testerUserId: parsed.testerUserId,
              mode: parsed.mode,
              itemIds: itemSnapshots.map(({ id }) => id),
              environmentTakeovers: takeovers,
            },
          },
        };
      },
    });
  }

  environmentConflicts(
    actorUserId: string,
    projectId: string,
    input: CreateSubmissionInput,
  ): EnvironmentConflict[] {
    requireProjectMember(this.db, actorUserId, ProjectIdSchema.parse(projectId));
    const parsed = CreateSubmissionInputSchema.parse(input);
    return environmentConflictsForSubmission(
      this.db,
      actorUserId,
      projectId,
      parsed.items,
    );
  }

  addItems(
    actorUserId: string,
    submissionId: string,
    input: AddSubmissionItemsInput,
  ): TestSubmission {
    const parsed = AddSubmissionItemsInputSchema.parse(input);
    const takeovers = parsed.environmentTakeovers ?? [];
    if (
      new Set(takeovers.map((value) => value.environmentId)).size !== takeovers.length ||
      takeovers.some(
        (value) =>
          !parsed.items.some((item) => item.environmentId === value.environmentId),
      )
    )
      throw new PlatformError('VALIDATION_FAILED', '环境切换确认与追加工程不匹配');
    return this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'SUBMISSION_ADD_ITEMS',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: TestSubmissionSchema,
      submissionId: (result) => result.id,
      perform: () => {
        const current = this.queries.requireSubmissionAccess(actorUserId, submissionId);
        const existing = this.db.all<SubmissionItemRow & { position: number }>(
          'SELECT * FROM submission_item WHERE submission_id = ? ORDER BY position',
          submissionId,
        );
        if (
          current.membership_role !== 'OWNER' &&
          current.created_by_user_id !== actorUserId &&
          current.tester_user_id !== actorUserId &&
          !existing.some((item) => item.responsible_user_id === actorUserId)
        )
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有提测负责人、创建人或项目所有者可以追加工程',
          );
        if (current.status !== 'ACTIVE')
          throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能追加工程');
        if (current.version !== parsed.expectedVersion)
          throw new PlatformError('STALE_STATE', '提测单已更新，请刷新后重试');
        if (existing.length + parsed.items.length > 20)
          throw new PlatformError('VALIDATION_FAILED', '一张提测单最多包含二十个工程');
        const engineeringIds = new Set(existing.map((item) => item.engineering_id));
        const environmentIds = new Set(existing.map((item) => item.environment_id));
        const now = this.now().toISOString();
        const itemIds: string[] = [];
        const affectedSubmissionIds: string[] = [];
        for (const [index, item] of parsed.items.entries()) {
          if (
            engineeringIds.has(item.engineeringId) ||
            environmentIds.has(item.environmentId)
          )
            throw new PlatformError(
              'VALIDATION_FAILED',
              '同一工程或环境在一张提测单中只能出现一次',
            );
          engineeringIds.add(item.engineeringId);
          environmentIds.add(item.environmentId);
          if (item.responsibleUserId === current.tester_user_id)
            throw new PlatformError(
              'VALIDATION_FAILED',
              '测试负责人不能同时担任提测项负责人',
            );
          const source = snapshotItemSource(this.db, current.project_id, item);
          if (current.mode === 'PERSON_AGENT')
            requirePersonAgentBinding(
              {
                responsibleUserId: current.person_agent_developer_id!,
                runnerId: current.person_agent_runner_id!,
              },
              source,
            );
          const itemId = this.createId();
          const observers = insertItem(this.db, {
            actorUserId,
            submissionId,
            itemId,
            position: (existing.at(-1)?.position ?? -1) + index + 1,
            source,
            targetBranch: item.targetBranch,
            createdAt: now,
            takeover: takeovers.find(
              (value) => value.environmentId === item.environmentId,
            ),
          });
          affectedSubmissionIds.push(...observers);
          itemIds.push(itemId);
        }
        if (current.mode === 'PERSON_AGENT')
          requireDistinctPersonAgentTargets(
            this.db.all(
              'SELECT repository_url, target_branch FROM submission_item WHERE submission_id = ?',
              submissionId,
            ),
          );
        const stored = this.db.get<SubmissionRow>(
          `UPDATE test_submission
          SET version = version + 1, workspace_revision = workspace_revision + 1, updated_at = ?
          WHERE id = ? AND version = ? RETURNING *`,
          now,
          submissionId,
          parsed.expectedVersion,
        );
        if (!stored) throw new PlatformError('STALE_STATE', '提测单已更新，请刷新后重试');
        return {
          result: mapSubmission(stored),
          resourceId: submissionId,
          affectedSubmissions: { ids: affectedSubmissionIds, updatedAt: now },
          audit: {
            projectId: current.project_id,
            action: 'SUBMISSION_ITEMS_ADDED',
            details: { itemIds, environmentTakeovers: takeovers },
          },
        };
      },
    });
  }

  addedItemConflicts(
    actorUserId: string,
    submissionId: string,
    input: AddSubmissionItemsInput,
  ): EnvironmentConflict[] {
    const current = this.queries.requireSubmissionAccess(actorUserId, submissionId);
    const parsed = AddSubmissionItemsInputSchema.parse(input);
    return environmentConflictsForSubmission(
      this.db,
      actorUserId,
      current.project_id,
      parsed.items,
    );
  }

  changeEnvironment(
    actorUserId: string,
    itemId: string,
    inputValue: EnvironmentCommand,
  ): TestSubmission {
    const input = EnvironmentCommandSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'SUBMISSION_ENVIRONMENT_CHANGE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: TestSubmissionSchema,
      submissionId: (result) => result.id,
      perform: () => {
        const item = this.db.get('SELECT * FROM submission_item WHERE id = ?', itemId) as
          SubmissionItemRow | undefined;
        if (!item) throw new PlatformError('NOT_FOUND', SUBMISSION_HIDDEN_MESSAGE);
        const submission = this.queries.requireSubmissionAccess(
          actorUserId,
          item.submission_id,
        );
        if (submission.workspace_revision !== input.expectedRevision)
          throw new PlatformError('STALE_STATE', '提测单已更新，请刷新后重试');
        const blocker = environmentAccessForItem(this.db, actorUserId, submission, item)
          .blockers[input.action];
        if (blocker) throw blocker;
        const now = this.now().toISOString();
        let affectedSubmissionIds: string[] = [];
        if (input.action === 'CONFIRM_DEPLOYMENT') {
          this.db.run(
            'UPDATE submission_environment_lock SET deployment_confirmed = 1 WHERE submission_item_id = ?',
            [itemId],
          );
        } else {
          affectedSubmissionIds = acquireEnvironment(
            this.db,
            actorUserId,
            item,
            now,
            'REACQUIRE',
            input.takeover,
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
          affectedSubmissions: { ids: affectedSubmissionIds, updatedAt: now },
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
  }

  updateSubmission(
    actorUserId: string,
    submissionId: string,
    input: UpdateSubmissionInput,
  ): TestSubmission {
    const parsed = UpdateSubmissionInputSchema.parse(input);
    const targetBranches = parsed.targetBranches ?? [];
    if (
      new Set(targetBranches.map(({ submissionItemId }) => submissionItemId)).size !==
      targetBranches.length
    )
      throw new PlatformError('VALIDATION_FAILED', '同一提测工程不能重复提交目标分支');
    return this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'SUBMISSION_UPDATE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: TestSubmissionSchema,
      submissionId: (submission) => submission.id,
      perform: () => {
        const current = this.queries.requireSubmissionAccess(actorUserId, submissionId);
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
          throw new PlatformError('PERMISSION_DENIED', '当前用户没有可修改的提测信息');
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
            `SELECT item.responsible_user_id, item.target_branch, item.target_branch_locked_at,
                    EXISTS(SELECT 1 FROM submission_bug bug
                           WHERE bug.submission_item_id = item.id) has_bug
               FROM submission_item item
               WHERE item.id = ? AND item.submission_id = ?`,
            target.submissionItemId,
            submissionId,
          ) as
            | {
                responsible_user_id: string;
                target_branch: string;
                target_branch_locked_at: string | null;
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
          if (
            current.mode === 'PERSON_AGENT' ? item.target_branch_locked_at : item.has_bug
          )
            throw new PlatformError(
              'INVALID_TRANSITION',
              current.mode === 'PERSON_AGENT'
                ? '该工程已进入修复范围，目标分支已锁定'
                : '该工程已有缺陷，不能再修改目标分支',
            );
          if (item.target_branch === target.targetBranch) continue;
          const updateItem = this.db.run(
            `UPDATE submission_item
               SET target_branch = ?
               WHERE id = ? AND submission_id = ?
                 AND responsible_user_id = ?
                 AND CASE WHEN ? = 'PERSON_AGENT' THEN target_branch_locked_at IS NULL
                   ELSE NOT EXISTS (SELECT 1 FROM submission_bug WHERE submission_item_id = submission_item.id) END`,
            [
              target.targetBranch,
              target.submissionItemId,
              submissionId,
              actorUserId,
              current.mode,
            ],
          );
          if (updateItem.changes !== 1)
            throw new PlatformError('STALE_STATE', '提测工程状态已更新，请刷新后重试');
          changedTargetBranches.push(target);
        }
        if (current.mode === 'PERSON_AGENT' && changedTargetBranches.length)
          requireDistinctPersonAgentTargets(
            this.db.all(
              'SELECT repository_url, target_branch FROM submission_item WHERE submission_id = ?',
              submissionId,
            ),
          );
        const updated = this.db.get<SubmissionRow>(
          `UPDATE test_submission
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

function requirePersonAgentBinding(
  assignment: PersonAgentAssignment,
  source: { responsible_user_id: string; runner_id: string },
): void {
  if (
    assignment.responsibleUserId !== source.responsible_user_id ||
    assignment.runnerId !== source.runner_id
  )
    throw new PlatformError(
      'VALIDATION_FAILED',
      'PersonAgent 的全部工程必须绑定同一个开发负责人和 Agent',
    );
}

function requireDistinctPersonAgentTargets(
  items: Array<{ repository_url: string; target_branch: string }>,
): void {
  const keys = items.map(({ repository_url, target_branch }) =>
    JSON.stringify([normalizeRepositoryUrl(repository_url), target_branch]),
  );
  if (new Set(keys).size !== keys.length)
    throw new PlatformError(
      'VALIDATION_FAILED',
      'PersonAgent 不能重复选择同一仓库和目标分支',
    );
}
