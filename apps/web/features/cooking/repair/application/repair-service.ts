import { randomUUID } from 'node:crypto';
import type {
  Execution,
  JsonObject,
  JsonValue,
} from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import { ExecutionService } from '@/server/execution/service';
import {
  createContinuationCodexTurn,
  createInitialCodexTurn,
} from '@/server/execution/codex-turn';
import { BugRepairContextService } from '@/features/cooking/bugs/application/repair-context';
import type { CookingExecutionProjectionEvent } from '@/features/cooking/execution/application/execution-projection';
import {
  projectCookingInteraction,
  type CookingInteractionRow,
} from '@/features/cooking/shared/interaction-projection';
import type {
  CookingInteractionView,
  CookingVisualPresentation,
} from '@/features/cooking/shared/contract';
import { TestSubmissionWriteStore } from '@/features/cooking/submissions/application/test-submission-write-store';
import {
  BugRepairViewSchema,
  ContinueRepairInputSchema,
  ManualOperationsSchema,
  RepairExecutionResultSchema,
  RepairOutputJsonSchema,
  RepairMutationResultSchema,
  RepairWorkspaceProjectionSchema,
  ResolveRepairInteractionInputSchema,
  type BugRepairView,
  type RepairMutationResult,
  type RepairWorkspaceProjection,
  type ResolveRepairInteractionInput,
  type ContinueRepairInput,
  type SynchronizeRepairSessionInput,
} from '../contract';
import {
  buildInitialRepairBrief,
  buildRepairContinuationInput,
} from '../brief';

type RepairSourceRow = {
  bug_id: string;
  submission_id: string;
  submission_item_id: string;
  project_id: string;
  submission_status: 'ACTIVE' | 'CLOSED';
  stage:
    | 'WAITING_FOR_REPAIR'
    | 'REPAIRING'
    | 'WAITING_FOR_UPDATE'
    | 'UPDATING'
    | 'WAITING_FOR_VERIFICATION'
    | 'DONE'
    | 'CANCELLED';
  bug_version: number;
  responsible_user_id: string;
};

type AttemptRow = {
  id: string;
  bug_id: string;
  execution_id: string;
  attempt: number;
  outcome_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  state: Execution['state'];
  session_id: string | null;
  outcome: string | null;
  runner_name: string;
};

type ContextRow = {
  bug_id: string;
  workspace_key: string;
  session_id: string | null;
  pending_commits_json: string;
  pending_manual_operations_json: string;
  last_candidate_at: string | null;
  version: number;
};

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

  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService = new ExecutionService(db),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    onInvalidated: (submissionId: string, revision: number) => void = () => {},
    private readonly deliveryHooks: RepairDeliveryHooks = NOOP_DELIVERY_HOOKS,
    private readonly bugContexts: BugRepairContextService = new BugRepairContextService(
      db,
    ),
  ) {
    this.writes = new TestSubmissionWriteStore(
      db,
      now,
      createId,
      onInvalidated,
    );
  }

  createInitialExecution(bugId: string): string {
    const repairContext = this.bugContexts.get(bugId);
    const existingContext = this.context(bugId);
    const latest = existingContext ? this.latestAttempt(bugId) : undefined;
    if (latest && !isTerminal(latest.state))
      throw new PlatformError('RESOURCE_CONFLICT', '该缺陷已有正在进行的修复');
    const now = this.now().toISOString();
    const workspaceKey = `bug-repair:${bugId}`;
    const attemptId = this.createId();
    const executionId = this.createId();
    if (!existingContext)
      this.db
        .prepare(
          `INSERT INTO cooking_bug_repair_context(
             bug_id, workspace_key, session_id, pending_commits_json,
             pending_manual_operations_json,
             last_candidate_at, version, created_at, updated_at
           ) VALUES (?, ?, NULL, '[]', '[]', NULL, 1, ?, ?)`,
        )
        .run(bugId, workspaceKey, now, now);
    const attempt = (latest?.attempt ?? 0) + 1;
    const executionBrief = buildInitialRepairBrief({
      executionId,
      workspaceKey,
      submissionId: repairContext.submissionId,
      submissionTitle: repairContext.submissionTitle,
      requirementDescription: repairContext.requirementDescription,
      engineeringName: repairContext.engineeringName,
      repositoryUrl: repairContext.repositoryUrl,
      targetBranch: repairContext.targetBranch,
      bugTitle: repairContext.report.title,
      bugId,
      operationPath: repairContext.report.operationPath,
      actualResult: repairContext.report.actualResult,
      expectedResult: repairContext.report.expectedResult,
      actualResultAttachments:
        repairContext.report.attachments.actualResult.map(
          ({ id, originalName }) => ({ fileId: id, originalName }),
        ),
      expectedResultAttachments:
        repairContext.report.attachments.expectedResult.map(
          ({ id, originalName }) => ({ fileId: id, originalName }),
        ),
      feedback: repairContext.feedback,
      pendingCommits: existingContext
        ? parseCommits(existingContext.pending_commits_json)
        : [],
    });
    const execution = this.executions.enqueue({
      id: executionId,
      owner: { namespace: 'cooking', kind: 'BUG_REPAIR', id: attemptId },
      attempt,
      previousExecutionId: latest?.execution_id ?? null,
      runnerId: repairContext.runnerId,
      bindingId: repairContext.bindingId,
      priority: 0,
      approvalPolicy: 'never',
      codexTurn: createInitialCodexTurn({
        requiredSkillName: 'agent-party-time-repair-bug',
        executionBrief,
        outputJsonSchema: RepairOutputJsonSchema as JsonObject,
      }),
      workspace: {
        key: workspaceKey,
        isolation: 'BRANCH_WORKTREE',
        baseRef: `origin/${repairContext.targetBranch}`,
        branch: `apt/repair/${bugId}`,
      },
      attachmentIds: [
        ...repairContext.report.attachments.actualResult,
        ...repairContext.report.attachments.expectedResult,
      ].map(({ id }) => id),
    });
    this.db
      .prepare(
        `INSERT INTO cooking_repair_attempt(
           id, bug_id, execution_id, attempt, outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(attemptId, bugId, execution.id, attempt, now);
    return execution.id;
  }

  createContinuationExecution(
    bugId: string,
    lifecycleContext = '',
    attachmentIds: string[] = [],
  ): string {
    const repairContext = this.bugContexts.get(bugId);
    const context = this.requireContext(bugId);
    const latest = this.latestAttempt(bugId);
    if (!latest || !isTerminal(latest.state))
      throw new PlatformError('RESOURCE_CONFLICT', '当前修复尚未结束');
    const attempt = latest.attempt + 1;
    const attemptId = this.createId();
    const executionId = this.createId();
    if (!context.session_id)
      throw new PlatformError(
        'INVALID_TRANSITION',
        '原修复任务不存在，不能自动重建',
      );
    const previousExecution = this.executions.get(latest.execution_id);
    const codexTurn = createContinuationCodexTurn({
      taskId: context.session_id,
      taskSkillBinding: requireTaskSkillBinding(previousExecution),
      text: buildRepairContinuationInput({
        lifecycleContext: lifecycleContext || undefined,
      }),
      outputJsonSchema: RepairOutputJsonSchema as JsonObject,
    });
    const execution = this.executions.enqueue({
      id: executionId,
      owner: { namespace: 'cooking', kind: 'BUG_REPAIR', id: attemptId },
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
    this.db
      .prepare(
        `INSERT INTO cooking_repair_attempt(
           id, bug_id, execution_id, attempt, outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(attemptId, bugId, execution.id, attempt, now);
    return execution.id;
  }

  projectExecution(event: CookingExecutionProjectionEvent): void {
    if (event.kind === 'INTERACTION_OPENED') {
      if (event.phase === 'APPLY')
        this.applyInteractionOpened(
          event.interaction.executionId,
          event.interaction.id,
        );
      else this.afterInteractionOpened(event.interaction.executionId);
      return;
    }
    if (event.kind === 'STARTED') {
      if (event.phase === 'APPLY') this.applyStartedExecution(event.execution);
      else this.afterStartedExecution(event.execution);
      return;
    }
    if (event.kind === 'RESUMED') {
      if (event.phase === 'APPLY') this.applyResumedExecution(event.execution);
      else this.afterResumedExecution(event.execution);
      return;
    }
    if (event.phase === 'APPLY') {
      if (event.execution.owner.kind === 'SESSION_SYNC')
        this.applySynchronizedExecution(event.execution);
      else this.applyTerminalExecution(event.execution);
    } else this.afterTerminalExecution(event.execution);
  }

  private applyTerminalExecution(execution: Execution): void {
    if (
      execution.owner.namespace !== 'cooking' ||
      !['BUG_REPAIR', 'SESSION_SYNC'].includes(execution.owner.kind)
    )
      return;
    const attempt = this.db
      .prepare(
        `SELECT attempt.id, attempt.bug_id, attempt.execution_id,
                attempt.attempt, attempt.outcome_json, attempt.created_at,
                execution.started_at, attempt.finished_at, execution.state,
                execution.session_id, execution.outcome_json outcome,
                runner.name runner_name
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         JOIN platform_runner runner ON runner.id = execution.runner_id
         WHERE attempt.execution_id = ?`,
      )
      .get(execution.id) as AttemptRow | undefined;
    if (!attempt || attempt.outcome_json) return;
    const context = this.requireContext(attempt.bug_id);
    const now = this.now().toISOString();
    const interpreted = this.interpret(execution, context);
    const deliveryRequired =
      interpreted.kind === 'COMPLETED' && interpreted.deliveryRequired;
    if (interpreted.kind === 'COMPLETED') {
      this.db
        .prepare(
          `UPDATE cooking_bug_repair_context
           SET session_id = ?, pending_commits_json = ?,
               pending_manual_operations_json = ?,
               last_candidate_at = ?, version = version + 1, updated_at = ?
           WHERE bug_id = ?`,
        )
        .run(
          execution.sessionId,
          JSON.stringify(interpreted.pendingCommits),
          JSON.stringify(interpreted.pendingManualOperations),
          deliveryRequired ? now : null,
          now,
          attempt.bug_id,
        );
      this.db
        .prepare(
          `UPDATE cooking_bug
           SET stage = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND stage = 'REPAIRING'`,
        )
        .run(
          deliveryRequired ? 'WAITING_FOR_UPDATE' : 'WAITING_FOR_VERIFICATION',
          now,
          attempt.bug_id,
        );
      if (deliveryRequired)
        this.deliveryHooks.candidateAvailable(attempt.bug_id, now);
    } else {
      this.db
        .prepare(
          `UPDATE cooking_bug_repair_context
           SET session_id = COALESCE(?, session_id),
               version = version + 1, updated_at = ?
           WHERE bug_id = ?`,
        )
        .run(execution.sessionId, now, attempt.bug_id);
      this.db
        .prepare(
          `UPDATE cooking_bug
           SET version = version + 1, updated_at = ?
           WHERE id = ? AND stage = 'REPAIRING'`,
        )
        .run(now, attempt.bug_id);
    }
    this.db
      .prepare(
        `UPDATE cooking_repair_attempt
         SET outcome_json = ?, finished_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(interpreted.attemptOutcome), now, attempt.id);
    this.auditForBug(
      attempt.bug_id,
      interpreted.kind === 'COMPLETED'
        ? 'REPAIR_ATTEMPT_COMPLETED'
        : 'REPAIR_ATTEMPT_FAILED',
      {
        executionId: execution.id,
        attempt: attempt.attempt,
        outcome: interpreted.kind,
        deliveryRequired:
          interpreted.kind === 'COMPLETED' ? deliveryRequired : undefined,
      },
      now,
    );
    this.writes.bumpRevisionForBug(attempt.bug_id, now);
  }

  private applyStartedExecution(execution: Execution): void {
    if (!isRepairExecution(execution)) return;
    const now = this.now().toISOString();
    const attempt = this.attemptForExecution(execution.id);
    if (!attempt) return;
    this.auditForBug(
      attempt.bug_id,
      'REPAIR_ATTEMPT_STARTED',
      { executionId: execution.id, attempt: attempt.attempt },
      now,
    );
    this.writes.bumpRevisionForBug(attempt.bug_id, now);
  }

  private applyResumedExecution(execution: Execution): void {
    if (!isRepairExecution(execution)) return;
    const attempt = this.attemptForExecution(execution.id);
    if (!attempt) return;
    this.writes.bumpRevisionForBug(attempt.bug_id, this.now().toISOString());
  }

  private applyInteractionOpened(
    executionId: string,
    interactionId: string,
  ): void {
    const attempt = this.attemptForExecution(executionId);
    if (!attempt) return;
    const now = this.now().toISOString();
    this.auditForBug(
      attempt.bug_id,
      'REPAIR_INTERACTION_OPENED',
      { executionId, interactionId, attempt: attempt.attempt },
      now,
    );
    this.writes.bumpRevisionForBug(attempt.bug_id, now);
  }

  private afterTerminalExecution(execution: Execution): void {
    if (isRepairExecution(execution)) {
      this.publishExecutionInvalidation(execution.id);
      return;
    }
    if (execution.owner.kind !== 'SESSION_SYNC') return;
    const sync = this.db
      .prepare(
        'SELECT bug_id FROM cooking_repair_session_sync WHERE execution_id = ?',
      )
      .get(execution.id) as { bug_id: string } | undefined;
    if (sync)
      this.writes.bumpRevisionForBug(sync.bug_id, this.now().toISOString());
  }

  private afterStartedExecution(execution: Execution): void {
    if (!isRepairExecution(execution)) return;
    this.publishExecutionInvalidation(execution.id);
  }

  private afterResumedExecution(execution: Execution): void {
    if (!isRepairExecution(execution)) return;
    this.publishExecutionInvalidation(execution.id);
  }

  private afterInteractionOpened(executionId: string): void {
    this.publishExecutionInvalidation(executionId);
  }

  continueRepair(
    actorUserId: string,
    bugId: string,
    inputValue: ContinueRepairInput,
  ): RepairMutationResult {
    const input = ContinueRepairInputSchema.parse(inputValue);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'REPAIR_CONTINUE',
      resourceType: 'BUG',
      resultSchema: RepairMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.source(bugId).submission_id,
        revision: mutation.revision,
      }),
      perform: () => {
        const source = this.requireResponsible(actorUserId, bugId);
        this.requireActiveVersion(source, input.expectedVersion);
        if (source.stage !== 'REPAIRING')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '仅未完成的修复可以重新执行',
          );
        const latest = this.latestAttempt(bugId);
        if (
          !latest ||
          !isTerminal(latest.state) ||
          !latest.outcome_json ||
          !isFailedAttemptOutcome(latest.outcome_json)
        )
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前没有可重新执行的失败修复',
          );
        const now = this.now().toISOString();
        const executionId = this.createContinuationExecution(bugId);
        const update = this.db
          .prepare(
            `UPDATE cooking_bug
             SET stage = 'REPAIRING', version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?
               AND stage = 'REPAIRING'`,
          )
          .run(now, bugId, input.expectedVersion);
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
          audits: [
            {
              projectId: source.project_id,
              action: 'REPAIR_CONTINUED',
              targetType: 'BUG',
              targetId: bugId,
              details: { executionId },
            },
          ],
        };
      },
    });
    return result;
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
      invalidation: (mutation) => ({
        submissionId: this.source(bugId).submission_id,
        revision: mutation.revision,
      }),
      perform: () => {
        const source = this.requireResponsible(actorUserId, bugId);
        this.requireActiveVersion(source, input.expectedVersion);
        const latest = this.latestAttempt(bugId);
        const context = this.requireContext(bugId);
        if (
          source.stage !== 'REPAIRING' ||
          !latest ||
          !latest.outcome_json ||
          !isFailedAttemptOutcome(latest.outcome_json) ||
          !context.session_id
        )
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前没有可同步的失败修复会话',
          );
        if (this.hasActiveSessionSync(bugId))
          throw new PlatformError('RESOURCE_CONFLICT', '修复会话正在同步');
        const syncId = this.createId();
        const executionId = this.createId();
        const execution = this.executions.enqueue({
          id: executionId,
          owner: { namespace: 'cooking', kind: 'SESSION_SYNC', id: syncId },
          attempt: 1,
          previousExecutionId: latest.execution_id,
          runnerId: this.bugContexts.get(bugId).runnerId,
          bindingId: this.bugContexts.get(bugId).bindingId,
          priority: 0,
          approvalPolicy: 'never',
          codexTurn: { kind: 'READ_SESSION', taskId: context.session_id },
          workspace: null,
          attachmentIds: [],
        });
        const now = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_repair_session_sync(id, bug_id, execution_id, session_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(syncId, bugId, execution.id, context.session_id, now);
        const revision = this.writes.bumpRevisionForBug(bugId, now);
        return {
          result: {
            bugId,
            bugVersion: input.expectedVersion,
            executionId: execution.id,
            revision,
          },
          resourceId: bugId,
          audits: [
            {
              projectId: source.project_id,
              action: 'REPAIR_SESSION_SYNC_REQUESTED',
              targetType: 'BUG',
              targetId: bugId,
              details: { executionId: execution.id },
            },
          ],
        };
      },
    });
  }

  private applySynchronizedExecution(execution: Execution): void {
    if (
      execution.owner.namespace !== 'cooking' ||
      execution.owner.kind !== 'SESSION_SYNC'
    )
      return;
    if (execution.outcome?.kind !== 'SUCCEEDED') return;
    const envelope = execution.outcome.result as Record<string, unknown>;
    const turnId = typeof envelope.turnId === 'string' ? envelope.turnId : null;
    const result = envelope.result;
    if (!turnId) return;
    const parsed = RepairExecutionResultSchema.safeParse(result);
    if (!parsed.success) {
      this.markExecutionResultInvalid(execution.id);
      return;
    }
    const sync = this.db
      .prepare(
        'SELECT bug_id FROM cooking_repair_session_sync WHERE execution_id = ?',
      )
      .get(execution.id) as { bug_id: string } | undefined;
    if (!sync) return;
    const duplicate = this.db
      .prepare(
        `SELECT 1 FROM cooking_repair_session_sync
         WHERE session_id = ? AND turn_id = ? AND execution_id <> ? LIMIT 1`,
      )
      .get(execution.sessionId, turnId, execution.id);
    if (duplicate) return;
    this.db
      .prepare(
        'UPDATE cooking_repair_session_sync SET turn_id = ? WHERE execution_id = ?',
      )
      .run(turnId, execution.id);
    const latest = this.latestAttempt(sync.bug_id);
    if (
      !latest ||
      !latest.outcome_json ||
      !isFailedAttemptOutcome(latest.outcome_json)
    )
      return;
    const attemptId = this.createId();
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO cooking_repair_attempt(id, bug_id, execution_id, attempt, outcome_json, created_at, finished_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(attemptId, sync.bug_id, execution.id, latest.attempt + 1, now);
    this.applyTerminalExecution({
      ...execution,
      outcome: { kind: 'SUCCEEDED', result: result as JsonValue },
    });
  }

  resolveInteraction(
    actorUserId: string,
    interactionId: string,
    inputValue: ResolveRepairInteractionInput,
  ): RepairMutationResult {
    const input = ResolveRepairInteractionInputSchema.parse(inputValue);
    const row = this.interactionSource(interactionId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'REPAIR_INTERACTION_RESOLVE',
      resourceType: 'EXECUTION_INTERACTION',
      resultSchema: RepairMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.source(row.bug_id).submission_id,
        revision: mutation.revision,
      }),
      perform: () => {
        const source = this.requireResponsible(actorUserId, row.bug_id);
        this.requireActiveVersion(source, input.expectedVersion);
        if (source.stage !== 'REPAIRING')
          throw new PlatformError('INVALID_TRANSITION', '当前缺陷不在修复中');
        this.executions.resolveInteraction(interactionId, input.resolution);
        const now = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_bug SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'REPAIRING'`,
          )
          .run(now, row.bug_id, input.expectedVersion);
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
          audits: [
            {
              projectId: source.project_id,
              action: 'REPAIR_INTERACTION_RESOLVED',
              targetType: 'EXECUTION_INTERACTION',
              targetId: interactionId,
              details: { executionId: row.execution_id, bugId: row.bug_id },
            },
          ],
        };
      },
    });
    return result;
  }

  workspace(userId: string, submissionId: string): RepairWorkspaceProjection {
    this.requireSubmissionAccess(userId, submissionId);
    const bugIds = (
      this.db
        .prepare(
          `SELECT id bug_id FROM cooking_bug
           WHERE submission_id = ? AND submission_item_id IS NOT NULL
           ORDER BY short_id`,
        )
        .all(submissionId) as Array<{ bug_id: string }>
    ).map(({ bug_id }) => bug_id);
    return RepairWorkspaceProjectionSchema.parse({
      repairByBug: Object.fromEntries(
        bugIds.map((bugId) => [bugId, this.repairView(userId, bugId)]),
      ),
    });
  }

  private publishExecutionInvalidation(executionId: string): void {
    const row = this.db
      .prepare(
        `SELECT bug.submission_id, submission.workspace_revision
         FROM cooking_repair_attempt attempt
         JOIN cooking_bug bug ON bug.id = attempt.bug_id
         JOIN cooking_test_submission submission ON submission.id = bug.submission_id
         WHERE attempt.execution_id = ?`,
      )
      .get(executionId) as
      { submission_id: string; workspace_revision: number } | undefined;
    if (row)
      this.writes.publishInvalidation(
        row.submission_id,
        row.workspace_revision,
      );
  }

  repairView(userId: string, bugId: string): BugRepairView | null {
    const source = this.source(bugId);
    this.requireSubmissionAccess(userId, source.submission_id);
    const context = this.context(bugId);
    const technical = userId === source.responsible_user_id;
    const attempts = this.attempts(bugId);
    const latest = attempts.at(-1);
    const interactions = this.interactionsForBug(bugId).map((row) => ({
      executionId: row.execution_id,
      interaction: projectCookingInteraction(row, technical),
    }));
    const statusLabel = latest ? repairStateLabel(latest.state) : '等待修复';
    const attemptNodes = attempts.map((attempt) => ({
      id: attempt.id,
      kind: 'REPAIR_ATTEMPT' as const,
      executionId: attempt.execution_id,
      sessionId: technical ? attempt.session_id : null,
      attempt: attempt.attempt,
      executionState: attempt.state,
      agentName: attempt.runner_name,
      queuedAt: attempt.created_at,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
      interactions: interactions
        .filter(({ executionId }) => executionId === attempt.execution_id)
        .map(({ interaction }) => interaction),
      result: attempt.outcome_json
        ? projectAttemptResult(attempt.outcome_json, technical)
        : null,
    }));
    return BugRepairViewSchema.parse({
      pendingCommits:
        technical && context
          ? parseCommits(context.pending_commits_json)
          : null,
      sessionAvailable: Boolean(context?.session_id),
      synchronizationError: technical
        ? this.sessionSynchronizationError(bugId)
        : null,
      timeline: [
        {
          id: `registered:${bugId}`,
          kind: 'BUG_REGISTERED' as const,
          occurredAt: this.bugRegisteredAt(bugId),
        },
        ...attemptNodes,
      ],
      availableActions:
        technical &&
        source.submission_status === 'ACTIVE' &&
        source.stage === 'REPAIRING' &&
        latest &&
        latest.outcome_json &&
        isFailedAttemptOutcome(latest.outcome_json)
          ? context?.session_id && !this.hasActiveSessionSync(bugId)
            ? ['SYNC_SESSION']
            : []
          : [],
      presentation: {
        statusLabel,
        visual: repairVisual(
          latest,
          interactions.map(({ interaction }) => interaction),
          technical,
          statusLabel,
          latest ? this.executions.queueStatus(latest.execution_id) : undefined,
        ),
      },
    });
  }

  private interactionsForBug(
    bugId: string,
  ): Array<CookingInteractionRow & { attempt: number }> {
    return this.db
      .prepare(
        `SELECT interaction.*, attempt.attempt
         FROM platform_execution_interaction interaction
         JOIN cooking_repair_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         WHERE attempt.bug_id = ?
           AND interaction.state IN ('PENDING', 'RESOLVED')
         ORDER BY interaction.created_at, interaction.id`,
      )
      .all(bugId) as Array<CookingInteractionRow & { attempt: number }>;
  }

  private interpret(
    execution: Execution,
    context: ContextRow,
  ):
    | {
        kind: 'COMPLETED';
        deliveryRequired: boolean;
        pendingCommits: string[];
        pendingManualOperations: Array<{
          kind: 'DATABASE_SQL';
          paths: string[];
        }>;
        attemptOutcome: unknown;
      }
    | {
        kind: 'FAILED';
        attemptOutcome: unknown;
      } {
    if (execution.outcome?.kind === 'SUCCEEDED') {
      const parsed = RepairExecutionResultSchema.safeParse(
        execution.outcome.result,
      );
      if (parsed.success && parsed.data.outcome === 'COMPLETED') {
        const current = parseCommits(context.pending_commits_json);
        const currentManualOperations = parseManualOperations(
          context.pending_manual_operations_json,
        );
        if (
          new Set(parsed.data.commits).size === parsed.data.commits.length &&
          !parsed.data.commits.some((commit) => current.includes(commit)) &&
          (parsed.data.completionKind === 'CHANGES_COMMITTED' ||
            current.length === 0)
        )
          return {
            kind: 'COMPLETED',
            deliveryRequired:
              parsed.data.completionKind === 'CHANGES_COMMITTED',
            pendingCommits: [...current, ...parsed.data.commits],
            pendingManualOperations: [
              ...currentManualOperations,
              ...parsed.data.manualOperations,
            ],
            attemptOutcome: parsed.data,
          };
      }
      if (parsed.success && parsed.data.outcome === 'FAILED')
        return {
          kind: 'FAILED',
          attemptOutcome: parsed.data,
        };
      const invalidReason = parsed.success
        ? 'Codex 返回的候选本地提交记录无效。'
        : `Codex 返回的修复结果格式不符合要求。具体问题：${formatRepairContractIssues(parsed.error.issues)}`;
      this.markExecutionResultInvalid(execution.id);
      return {
        kind: 'FAILED',
        attemptOutcome: {
          outcome: 'FAILED',
          summary: '修复结果格式或候选本地提交记录无效。',
          failedStep: '结构化结果校验',
          reason: invalidReason,
          completedActions: [],
          pendingActions: ['修复缺陷并返回有效的结构化结果'],
          technicalFailure: 'RESULT_SCHEMA_INVALID',
        },
      };
    }
    const failure =
      execution.outcome?.kind === 'FAILED' ? execution.outcome.failure : null;
    const cancelled = execution.outcome?.kind === 'CANCELLED';
    const cancelledReason =
      execution.outcome?.kind === 'CANCELLED' ? execution.outcome.reason : null;
    const summary = cancelled
      ? '修复执行已停止。'
      : (failure?.message ?? '修复执行未完成。');
    return {
      kind: 'FAILED',
      attemptOutcome: {
        outcome: 'FAILED',
        summary,
        failedStep: '修复执行',
        reason: failure?.message ?? cancelledReason ?? '未返回更具体的失败原因',
        completedActions: [],
        pendingActions: ['重新执行修复'],
        technicalFailure: failure?.code ?? (cancelled ? 'CANCELLED' : null),
      },
    };
  }

  private markExecutionResultInvalid(executionId: string): void {
    this.db
      .prepare(
        `UPDATE platform_execution
         SET state = 'FAILED', outcome_json = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          kind: 'FAILED',
          failure: {
            code: 'CODEX_EXECUTION_FAILED',
            message: 'Codex 返回的结构化结果无效',
            retryable: true,
          },
        }),
        executionId,
      );
  }

  private source(bugId: string): RepairSourceRow {
    const row = this.db
      .prepare(
        `SELECT bug.id bug_id, bug.submission_id, bug.submission_item_id,
                submission.project_id, submission.status submission_status,
                bug.stage, bug.version bug_version,
                item.responsible_user_id
         FROM cooking_bug bug
         JOIN cooking_test_submission submission ON submission.id = bug.submission_id
         JOIN cooking_submission_item item ON item.id = bug.submission_item_id
         WHERE bug.id = ?`,
      )
      .get(bugId) as RepairSourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '修复缺陷不存在');
    return row;
  }

  private context(bugId: string): ContextRow | undefined {
    return this.db
      .prepare('SELECT * FROM cooking_bug_repair_context WHERE bug_id = ?')
      .get(bugId) as ContextRow | undefined;
  }

  private requireContext(bugId: string): ContextRow {
    const row = this.context(bugId);
    if (!row) throw new PlatformError('NOT_FOUND', '修复上下文不存在');
    return row;
  }

  private latestAttempt(bugId: string): AttemptRow | undefined {
    return this.attempts(bugId).at(-1);
  }

  private hasActiveSessionSync(bugId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM cooking_repair_session_sync sync
         JOIN platform_execution execution ON execution.id = sync.execution_id
         WHERE sync.bug_id = ?
           AND execution.state IN ('QUEUED', 'CLAIMED', 'RUNNING')
         LIMIT 1`,
      )
      .get(bugId);
    return Boolean(row);
  }

  private sessionSynchronizationError(bugId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT execution.outcome_json
         FROM cooking_repair_session_sync sync
         JOIN platform_execution execution ON execution.id = sync.execution_id
         WHERE sync.bug_id = ? AND execution.state = 'FAILED'
         ORDER BY sync.created_at DESC LIMIT 1`,
      )
      .get(bugId) as { outcome_json: string | null } | undefined;
    const failure = row?.outcome_json
      ? (JSON.parse(row.outcome_json) as { failure?: { message?: unknown } })
      : null;
    return typeof failure?.failure?.message === 'string'
      ? failure.failure.message
      : null;
  }

  private attemptForExecution(executionId: string): AttemptRow | undefined {
    return this.db
      .prepare(
        `SELECT attempt.id, attempt.bug_id, attempt.execution_id,
                attempt.attempt, attempt.outcome_json, attempt.created_at,
                execution.started_at, attempt.finished_at, execution.state,
                execution.session_id, execution.outcome_json outcome,
                runner.name runner_name
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         JOIN platform_runner runner ON runner.id = execution.runner_id
         WHERE attempt.execution_id = ?`,
      )
      .get(executionId) as AttemptRow | undefined;
  }

  private attempts(bugId: string): AttemptRow[] {
    return this.db
      .prepare(
        `SELECT attempt.id, attempt.bug_id, attempt.execution_id,
                attempt.attempt, attempt.outcome_json, attempt.created_at,
                execution.started_at, attempt.finished_at, execution.state,
                execution.session_id, execution.outcome_json outcome,
                runner.name runner_name
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         JOIN platform_runner runner ON runner.id = execution.runner_id
         WHERE attempt.bug_id = ? ORDER BY attempt.attempt`,
      )
      .all(bugId) as AttemptRow[];
  }

  private bugRegisteredAt(bugId: string): string {
    const row = this.db
      .prepare('SELECT created_at FROM cooking_bug WHERE id = ?')
      .get(bugId) as { created_at: string } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '修复缺陷不存在');
    return row.created_at;
  }

  private requireSubmissionAccess(userId: string, submissionId: string): void {
    const row = this.db
      .prepare(
        `SELECT 1 allowed
         FROM cooking_test_submission submission
         JOIN cooking_project_membership membership
           ON membership.project_id = submission.project_id
         WHERE submission.id = ? AND membership.user_id = ?`,
      )
      .get(submissionId, userId) as { allowed: number } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '提测单不存在');
  }

  private requireResponsible(userId: string, bugId: string): RepairSourceRow {
    const source = this.source(bugId);
    this.requireSubmissionAccess(userId, source.submission_id);
    if (source.responsible_user_id !== userId)
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有该工程负责人可以处理修复执行',
      );
    return source;
  }

  private requireActiveVersion(
    source: RepairSourceRow,
    expectedVersion: number,
  ): void {
    if (source.submission_status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能修改');
    if (source.bug_version !== expectedVersion) throw staleRepair();
  }

  private interactionSource(interactionId: string): {
    bug_id: string;
    execution_id: string;
  } {
    const row = this.db
      .prepare(
        `SELECT attempt.bug_id, interaction.execution_id
         FROM platform_execution_interaction interaction
         JOIN cooking_repair_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         WHERE interaction.id = ?`,
      )
      .get(interactionId) as
      { bug_id: string; execution_id: string } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '修复操作请求不存在');
    return row;
  }

  private auditForBug(
    bugId: string,
    action: string,
    details: unknown,
    createdAt: string,
  ): void {
    const source = this.source(bugId);
    this.db
      .prepare(
        `INSERT INTO cooking_audit_event(
           id, project_id, actor_user_id, action, target_type, target_id,
           details_json, created_at
         ) VALUES (?, ?, ?, ?, 'BUG', ?, ?, ?)`,
      )
      .run(
        this.createId(),
        source.project_id,
        source.responsible_user_id,
        action,
        bugId,
        JSON.stringify({ source: 'EXECUTION', ...asDetails(details) }),
        createdAt,
      );
  }
}

function formatRepairContractIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>,
): string {
  return issues
    .map(
      ({ path, message }) =>
        `${path.length ? path.map(String).join('.') : '$'}: ${message}`,
    )
    .join('; ')
    .slice(0, 3_500);
}

function projectAttemptResult(outcomeJson: string, technical: boolean) {
  const raw = JSON.parse(outcomeJson) as Record<string, unknown>;
  const { technicalFailure: _technicalFailure, ...contractResult } = raw;
  const parsed = RepairExecutionResultSchema.safeParse(
    raw.outcome === 'COMPLETED' && raw.manualOperations === undefined
      ? { ...contractResult, manualOperations: [] }
      : contractResult,
  );
  if (!parsed.success)
    throw new PlatformError('INTERNAL_ERROR', '已保存的修复记录结果格式无效');
  if (parsed.data.outcome === 'COMPLETED')
    return {
      outcome: parsed.data.outcome,
      changes: parsed.data.changes,
      validations: parsed.data.validations,
      warnings: parsed.data.warnings,
      commitCount: parsed.data.commits.length,
      commits: technical ? parsed.data.commits : null,
      rawSummary: technical ? parsed.data.summary : null,
    };
  return {
    outcome: parsed.data.outcome,
    failedStep: parsed.data.failedStep,
    reason:
      !technical &&
      typeof raw.technicalFailure === 'string' &&
      raw.technicalFailure !== 'CANCELLED'
        ? '自动修复执行未完成，工程负责人可查看详细原因。'
        : parsed.data.reason,
    completedActions: parsed.data.completedActions,
    pendingActions: parsed.data.pendingActions,
    failureCode:
      technical && typeof raw.technicalFailure === 'string'
        ? raw.technicalFailure
        : null,
    rawSummary: technical ? parsed.data.summary : null,
  };
}

function repairVisual(
  latest: AttemptRow | undefined,
  interactions: CookingInteractionView[],
  responsible: boolean,
  idleLabel: string,
  queue: { state: Execution['state']; aheadCount: number } | undefined,
): CookingVisualPresentation {
  const pending = interactions.filter(
    (interaction) => interaction.state === 'PENDING',
  );
  if (pending.length > 1)
    throw new PlatformError(
      'INTERNAL_ERROR',
      '同一修复记录存在多个待处理操作请求',
    );
  const interaction = pending[0];
  if (interaction) {
    if (!latest || latest.state !== 'WAITING_FOR_INTERACTION')
      throw new PlatformError('INTERNAL_ERROR', '修复操作请求与任务状态不一致');
    return interaction.kind === 'APPROVAL'
      ? {
          state: 'NEEDS_APPROVAL',
          label: responsible ? '需要你审批' : '等待工程负责人审批',
          symbol: '!',
        }
      : {
          state: 'NEEDS_INPUT',
          label: responsible ? '需要你回答' : '等待工程负责人回答',
          symbol: '?',
        };
  }
  if (latest?.state === 'WAITING_FOR_INTERACTION')
    throw new PlatformError(
      'INTERNAL_ERROR',
      '等待操作请求的修复任务缺少待处理记录',
    );
  if (
    latest?.state === 'FAILED' ||
    (latest?.outcome_json && isFailedAttemptOutcome(latest.outcome_json))
  )
    return { state: 'FAILED', label: '自动修复未完成', symbol: '×' };
  if (latest?.state === 'QUEUED')
    return {
      state: 'QUEUED_FOR_ENGINEERING',
      label: `等待工程执行通道（前方 ${queue?.aheadCount ?? 0} 项）`,
      symbol: '…',
      aheadCount: queue?.aheadCount ?? 0,
    };
  if (latest?.state === 'WAITING_TO_RESUME')
    return { state: 'WAITING_TO_RESUME', label: '等待继续', symbol: 'Ⅱ' };
  if (latest && ['CLAIMED', 'RUNNING'].includes(latest.state))
    return { state: 'RUNNING', label: '正在自动处理', symbol: '●' };
  if (latest && ['CANCEL_REQUESTED', 'CANCELLED'].includes(latest.state))
    return {
      state: 'WAITING_TO_RESUME',
      label: '等待重新处理',
      symbol: 'Ⅱ',
    };
  return { state: 'IDLE', label: idleLabel, symbol: '·' };
}

function isFailedAttemptOutcome(outcomeJson: string): boolean {
  const raw = JSON.parse(outcomeJson) as Record<string, unknown>;
  return raw.outcome === 'FAILED';
}

function requireTaskSkillBinding(execution: Execution) {
  const binding =
    execution.codexTurn?.kind === 'CONTINUATION' ||
    execution.codexTurn?.kind === 'INITIAL'
      ? execution.codexTurn.taskSkillBinding
      : null;
  if (!binding)
    throw new PlatformError(
      'INVALID_TRANSITION',
      '原修复任务缺少规则关联，不能继续',
    );
  return binding;
}

function parseCommits(value: string): string[] {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new PlatformError('INTERNAL_ERROR', '待提交记录无效');
  return parsed;
}

function parseManualOperations(value: string): Array<{
  kind: 'DATABASE_SQL';
  paths: string[];
}> {
  try {
    return ManualOperationsSchema.parse(JSON.parse(value));
  } catch {
    throw new PlatformError('INTERNAL_ERROR', '待执行的人工操作记录无效');
  }
}

function isTerminal(state: Execution['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

function isRepairExecution(execution: Execution): boolean {
  return (
    execution.owner.namespace === 'cooking' &&
    execution.owner.kind === 'BUG_REPAIR'
  );
}

function repairStateLabel(state: Execution['state']): string {
  return {
    QUEUED: '等待 Agent',
    CLAIMED: '正在准备修复',
    RUNNING: '正在修复',
    WAITING_FOR_INTERACTION: '等待工程负责人处理',
    WAITING_TO_RESUME: '等待继续',
    CANCEL_REQUESTED: '正在停止',
    SUCCEEDED: '修复已完成',
    FAILED: '修复未完成',
    CANCELLED: '修复已停止',
  }[state];
}

function staleRepair(): PlatformError {
  return new PlatformError('STALE_STATE', '缺陷已更新，请刷新后重试');
}

function asDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
