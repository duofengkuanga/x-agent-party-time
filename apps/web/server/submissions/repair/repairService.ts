import { EffectiveEnvironmentDeploymentSchema } from '@/contracts/projects/engineering';
import { requireSubmissionAccess } from '@/server/submissions/shared/access';
import {
  isTerminal,
  requireTaskSkillBinding,
} from '@/server/submissions/shared/executionState';
import { TestSubmissionWriteStore } from '@/server/submissions/testSubmissionWriteStore';
import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import {
  createContinuationCodexTurn,
  createInitialCodexTurn,
} from '@/server/platform/execution/codexTurn';
import { ExecutionService } from '@/server/platform/execution/service';
import type {
  ExecutionResultAssertion,
  JsonObject,
} from '@agent-party-time/execution-contract';
import { randomUUID } from 'node:crypto';
import {
  ContinueRepairInputSchema,
  RepairMutationResultSchema,
  RepairOutputJsonSchema,
  ResolveRepairInteractionInputSchema,
  type ContinueRepairInput,
  type RepairMutationResult,
  type ResolveRepairInteractionInput,
  type SynchronizeRepairSessionInput,
} from '../../../contracts/submissions/repair';
import { type RepairSourceRow, RepairQueries } from './repairQueries';
import { RepairProjection } from './repairProjection';
import {
  parseCommits,
  isFailedAttemptOutcome,
  isSynchronizableAttempt,
  staleRepair,
} from './results';
import { REPAIR_HANDOFF_TEXT_ASSERTION } from '../../../contracts/submissions/handoff';

const REPAIR_RESULT_ASSERTIONS: ExecutionResultAssertion[] = [
  REPAIR_HANDOFF_TEXT_ASSERTION,
  {
    kind: 'GIT_COMMITS_CREATED',
    resultPath: ['result', 'commits'],
  },
];

export type RepairDeliveryHooks = {
  candidateAvailable: (bugId: string, candidateAt: string) => void;
  candidateReconsidered: (bugId: string) => void;
};

const NOOP_DELIVERY_HOOKS: RepairDeliveryHooks = {
  candidateAvailable: () => {},
  candidateReconsidered: () => {},
};

export class RepairService {
  private readonly writes: TestSubmissionWriteStore;
  private readonly queries: RepairQueries;
  readonly projectExecution: RepairProjection['projectExecution'];
  readonly workspace: RepairQueries['workspace'];
  readonly repairView: RepairQueries['repairView'];

  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService = new ExecutionService(db),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    onInvalidated: (submissionId: string, revision: number) => void = () => {},
    private readonly deliveryHooks: RepairDeliveryHooks = NOOP_DELIVERY_HOOKS,
  ) {
    this.queries = new RepairQueries(db, executions);
    this.workspace = this.queries.workspace.bind(this.queries);
    this.repairView = this.queries.repairView.bind(this.queries);
    this.writes = new TestSubmissionWriteStore(db, now, createId, onInvalidated);
    this.projectExecution = new RepairProjection(
      db,
      this.queries,
      this.writes,
      now,
      createId,
      deliveryHooks,
    ).projectExecution;
  }

  createInitialExecution(bugId: string): string {
    const repairContext = this.queries.inputForBug(bugId);
    const existingContext = this.queries.context(bugId);
    const latest = existingContext ? this.queries.latestAttempt(bugId) : undefined;
    if (latest && !isTerminal(latest.state))
      throw new PlatformError('RESOURCE_CONFLICT', '该缺陷已有正在进行的修复');
    if (!this.db.get('SELECT 1 FROM submission_bug_deployment WHERE bug_id = ?', bugId)) {
      const environment = this.db.get<{ deployment_json: string }>(
        `SELECT environment.deployment_json FROM submission_bug bug
         JOIN submission_item item ON item.id = bug.submission_item_id
         JOIN platform_environment environment ON environment.id = item.environment_id
         WHERE bug.id = ?`,
        bugId,
      );
      if (!environment) throw new PlatformError('NOT_FOUND', '缺陷对应的测试环境不存在');
      const deployment = EffectiveEnvironmentDeploymentSchema.parse(
        JSON.parse(environment.deployment_json),
      );
      this.db.run(
        'INSERT INTO submission_bug_deployment(bug_id, deployment_json) VALUES (?, ?)',
        [bugId, JSON.stringify(deployment)],
      );
    }
    const now = this.now().toISOString();
    const workspaceKey = `bug-repair:${bugId}`;
    const attemptId = this.createId();
    const executionId = this.createId();
    if (!existingContext)
      this.db.run(
        `INSERT INTO submission_bug_repair_context(
             bug_id, workspace_key, session_id, pending_commits_json,
             pending_manual_operations_json,
             last_candidate_at, version, created_at, updated_at
           ) VALUES (?, ?, NULL, '[]', '[]', NULL, 1, ?, ?)`,
        [bugId, workspaceKey, now, now],
      );
    const attempt = (latest?.attempt ?? 0) + 1;
    const { report, attachmentReferences } = repairContext;
    const pendingCommits = existingContext
      ? parseCommits(existingContext.pending_commits_json)
      : [];
    const executionBrief: JsonObject = {
      targetBranch: repairContext.targetBranch,
      bug: {
        title: report.title,
        ...(report.operationPath ? { operationPath: report.operationPath } : {}),
        ...(report.actualResult ? { actualResult: report.actualResult } : {}),
        ...(report.expectedResult ? { expectedResult: report.expectedResult } : {}),
      },
      ...(attachmentReferences.length ? { attachmentReferences } : {}),
      ...(repairContext.feedback.length ? { feedback: repairContext.feedback } : {}),
      ...(pendingCommits.length ? { pendingCommits } : {}),
    };
    const execution = this.executions.enqueue({
      id: executionId,
      owner: { namespace: 'submissions', kind: 'BUG_REPAIR', id: attemptId },
      attempt,
      previousExecutionId: latest?.execution_id ?? null,
      runnerId: repairContext.runnerId,
      bindingId: repairContext.bindingId,
      priority: 0,
      approvalPolicy: 'never',
      codexTurn: createInitialCodexTurn({
        manualHandoff: 'EXTERNAL_SESSION',
        requiredSkillName: 'agent-party-time-repair-bug',
        executionBrief,
        outputJsonSchema: RepairOutputJsonSchema,
        resultAssertions: REPAIR_RESULT_ASSERTIONS,
      }),
      workspace: {
        key: workspaceKey,
        isolation: 'BRANCH_WORKTREE',
        baseRef: `origin/${repairContext.targetBranch}`,
        branch: `apt/repair/${bugId}`,
      },
      attachmentIds: attachmentReferences.map(({ fileId }) => fileId),
    });
    this.db.run(
      `INSERT INTO submission_repair_attempt(
           id, bug_id, execution_id, attempt, outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      [attemptId, bugId, execution.id, attempt, now],
    );
    return execution.id;
  }

  createContinuationExecution(
    bugId: string,
    lifecycleContext = '',
    attachmentIds: string[] = [],
  ): string {
    const repairContext = this.queries.inputForBug(bugId);
    const context = this.queries.requireContext(bugId);
    const latest = this.queries.latestAttempt(bugId);
    if (!latest || !isTerminal(latest.state))
      throw new PlatformError('RESOURCE_CONFLICT', '当前修复尚未结束');
    const attempt = latest.attempt + 1;
    const attemptId = this.createId();
    const executionId = this.createId();
    if (!context.session_id)
      throw new PlatformError('INVALID_TRANSITION', '原修复任务不存在，不能自动重建');
    const previousExecution = this.executions.get(latest.execution_id);
    const codexTurn = createContinuationCodexTurn({
      manualHandoff: 'EXTERNAL_SESSION',
      taskId: context.session_id,
      taskSkillBinding: requireTaskSkillBinding(previousExecution, '修复'),
      text: lifecycleContext
        ? `继续完成上次未完成的任务。新增事实：${JSON.stringify({ lifecycleContext })}`
        : '继续完成上次未完成的任务。',
      outputJsonSchema: RepairOutputJsonSchema,
      resultAssertions: REPAIR_RESULT_ASSERTIONS,
    });
    const execution = this.executions.enqueue({
      id: executionId,
      owner: { namespace: 'submissions', kind: 'BUG_REPAIR', id: attemptId },
      attempt,
      previousExecutionId: latest.execution_id,
      runnerId: repairContext.runnerId,
      bindingId: repairContext.bindingId,
      priority: 0,
      approvalPolicy: 'never',
      codexTurn,
      workspace: {
        key: context.workspace_key,
        isolation: 'BRANCH_WORKTREE',
        baseRef: `origin/${repairContext.targetBranch}`,
        branch: `apt/repair/${bugId}`,
      },
      attachmentIds,
    });
    const now = this.now().toISOString();
    this.db.run(
      `INSERT INTO submission_repair_attempt(
           id, bug_id, execution_id, attempt, outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      [attemptId, bugId, execution.id, attempt, now],
    );
    return execution.id;
  }

  continueRepair(
    actorUserId: string,
    bugId: string,
    inputValue: ContinueRepairInput,
  ): RepairMutationResult {
    const input = ContinueRepairInputSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'REPAIR_CONTINUE',
      resourceType: 'BUG',
      resultSchema: RepairMutationResultSchema,
      submissionId: () => this.queries.source(bugId).submission_id,
      perform: () => {
        const source = this.requireResponsible(actorUserId, bugId);
        this.requireActiveVersion(source, input.expectedVersion);
        if (source.stage !== 'REPAIRING')
          throw new PlatformError('INVALID_TRANSITION', '仅未完成的修复可以重新执行');
        const latest = this.queries.latestAttempt(bugId);
        if (
          !latest ||
          !isTerminal(latest.state) ||
          !latest.outcome_json ||
          !isFailedAttemptOutcome(latest.outcome_json)
        )
          throw new PlatformError('INVALID_TRANSITION', '当前没有可重新执行的失败修复');
        const now = this.now().toISOString();
        const executionId = this.createContinuationExecution(bugId);
        const update = this.db.run(
          `UPDATE submission_bug
             SET stage = 'REPAIRING', version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?
               AND stage = 'REPAIRING'`,
          [now, bugId, input.expectedVersion],
        );
        if (update.changes !== 1) throw staleRepair();
        this.deliveryHooks.candidateReconsidered(bugId);
        const revision = this.writes.bumpRevisionForBug(bugId, now);
        return {
          result: {
            bugId,
            bugVersion: input.expectedVersion + 1,
            executionId,
            revision,
          },
          resourceId: bugId,
          audit: {
            projectId: source.project_id,
            action: 'REPAIR_CONTINUED',
            details: { executionId },
          },
        };
      },
    });
  }

  synchronizeSession(
    actorUserId: string,
    bugId: string,
    inputValue: SynchronizeRepairSessionInput,
  ): RepairMutationResult {
    const input = ContinueRepairInputSchema.parse(inputValue);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'REPAIR_SESSION_SYNC',
      resourceType: 'BUG',
      resultSchema: RepairMutationResultSchema,
      submissionId: () => this.queries.source(bugId).submission_id,
      perform: () => {
        const source = this.requireResponsible(actorUserId, bugId);
        this.requireActiveVersion(source, input.expectedVersion);
        const latest = this.queries.latestAttempt(bugId);
        const context = this.queries.requireContext(bugId);
        if (
          source.stage !== 'REPAIRING' ||
          !latest ||
          !latest.outcome_json ||
          !isSynchronizableAttempt(latest.outcome_json) ||
          !context.session_id
        )
          throw new PlatformError('INVALID_TRANSITION', '当前没有可同步的人工处理会话');
        if (this.queries.hasActiveSessionSync(bugId))
          throw new PlatformError('RESOURCE_CONFLICT', '修复会话正在同步');
        const previousExecution = this.executions.get(latest.execution_id);
        if (!previousExecution.codexTurn)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '原修复任务缺少结果约束，不能同步',
          );
        const resultAssertions = previousExecution.codexTurn?.resultAssertions;
        const repairContext = this.queries.inputForBug(bugId);
        const syncId = this.createId();
        const executionId = this.createId();
        const execution = this.executions.enqueue({
          id: executionId,
          owner: { namespace: 'submissions', kind: 'SESSION_SYNC', id: syncId },
          attempt: 1,
          previousExecutionId: latest.execution_id,
          runnerId: repairContext.runnerId,
          bindingId: repairContext.bindingId,
          priority: 0,
          approvalPolicy: 'never',
          codexTurn: {
            kind: 'READ_SESSION',
            taskId: context.session_id,
            outputJsonSchema: previousExecution.codexTurn.outputJsonSchema,
            resultAssertions,
          },
          workspace: previousExecution.workspace,
          attachmentIds: [],
        });
        const now = this.now().toISOString();
        this.db.run(
          `INSERT INTO submission_repair_session_sync(id, bug_id, execution_id, session_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          [syncId, bugId, execution.id, context.session_id, now],
        );
        const revision = this.writes.bumpRevisionForBug(bugId, now);
        return {
          result: {
            bugId,
            bugVersion: input.expectedVersion,
            executionId: execution.id,
            revision,
          },
          resourceId: bugId,
          audit: {
            projectId: source.project_id,
            action: 'REPAIR_SESSION_SYNC_REQUESTED',
            details: { executionId: execution.id },
          },
        };
      },
    });
  }

  resolveInteraction(
    actorUserId: string,
    interactionId: string,
    inputValue: ResolveRepairInteractionInput,
  ): RepairMutationResult {
    const input = ResolveRepairInteractionInputSchema.parse(inputValue);
    const row = this.queries.interactionSource(interactionId);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'REPAIR_INTERACTION_RESOLVE',
      resourceType: 'EXECUTION_INTERACTION',
      resultSchema: RepairMutationResultSchema,
      submissionId: () => this.queries.source(row.bug_id).submission_id,
      perform: () => {
        const source = this.requireResponsible(actorUserId, row.bug_id);
        this.requireActiveVersion(source, input.expectedVersion);
        if (source.stage !== 'REPAIRING')
          throw new PlatformError('INVALID_TRANSITION', '当前缺陷不在修复中');
        this.executions.resolveInteraction(interactionId, input.resolution);
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE submission_bug SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'REPAIRING'`,
          [now, row.bug_id, input.expectedVersion],
        );
        if (update.changes !== 1) throw staleRepair();
        const revision = this.writes.bumpRevisionForBug(row.bug_id, now);
        return {
          result: {
            bugId: row.bug_id,
            bugVersion: input.expectedVersion + 1,
            executionId: row.execution_id,
            revision,
          },
          resourceId: interactionId,
          audit: {
            projectId: source.project_id,
            action: 'REPAIR_INTERACTION_RESOLVED',
            details: { executionId: row.execution_id, bugId: row.bug_id },
          },
        };
      },
    });
  }

  private requireResponsible(userId: string, bugId: string): RepairSourceRow {
    const source = this.queries.source(bugId);
    requireSubmissionAccess(this.db, userId, source.submission_id);
    if (source.responsible_user_id !== userId)
      throw new PlatformError('PERMISSION_DENIED', '只有该工程负责人可以处理修复执行');
    return source;
  }

  private requireActiveVersion(source: RepairSourceRow, expectedVersion: number): void {
    if (source.submission_status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能修改');
    if (source.bug_version !== expectedVersion) throw staleRepair();
  }
}
