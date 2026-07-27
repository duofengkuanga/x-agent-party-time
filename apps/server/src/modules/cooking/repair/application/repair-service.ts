import { randomUUID } from 'node:crypto';
import {
  sanitizeExecutionInteractionPayload,
  type Execution,
} from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ExecutionService } from '@/platform/execution/service';
import { CookingWriteStore } from '@/modules/cooking/shared/write-store';
import {
  BugRepairViewSchema,
  ContinueRepairInputSchema,
  RepairExecutionResultSchema,
  RepairInteractionViewSchema,
  RepairMutationResultSchema,
  RepairWorkspaceProjectionSchema,
  ResolveRepairInteractionInputSchema,
  StopRepairInputSchema,
  type BugRepairView,
  type RepairInteractionView,
  type RepairMutationResult,
  type RepairWorkspaceProjection,
  type ResolveRepairInteractionInput,
  type StopRepairInput,
  type ContinueRepairInput,
} from '../contract';
import {
  buildContinuationRepairPrompt,
  buildInitialRepairPrompt,
} from '../prompt';

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
  title: string;
  operation_path: string | null;
  actual_result: string | null;
  expected_result: string | null;
  notes: string | null;
  submission_title: string;
  requirement_description: string;
  engineering_name: string;
  repository_url: string;
  target_branch: string;
  binding_id: string;
  runner_id: string;
  responsible_user_id: string;
};

type AttemptRow = {
  id: string;
  bug_id: string;
  execution_id: string;
  attempt: number;
  outcome_json: string | null;
  created_at: string;
  finished_at: string | null;
  state: Execution['state'];
  session_id: string | null;
  outcome: string | null;
};

type ContextRow = {
  bug_id: string;
  workspace_key: string;
  session_id: string | null;
  pending_commits_json: string;
  version: number;
};

export class RepairService {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService = new ExecutionService(db),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly onInvalidated: (
      submissionId: string,
      revision: number,
    ) => void = () => {},
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  createInitialExecution(bugId: string, priority: number): string {
    const source = this.source(bugId);
    const existingContext = this.context(bugId);
    const latest = existingContext ? this.latestAttempt(bugId) : undefined;
    if (latest && !isTerminal(latest.state))
      throw new PlatformError(
        'RESOURCE_CONFLICT',
        '缺陷已有活动 Repair Attempt',
      );
    const now = this.now().toISOString();
    const workspaceKey = `bug-repair:${bugId}`;
    const attemptId = this.createId();
    if (!existingContext)
      this.db
        .prepare(
          `INSERT INTO cooking_bug_repair_context(
             bug_id, workspace_key, session_id, pending_commits_json,
             version, created_at, updated_at
           ) VALUES (?, ?, NULL, '[]', 1, ?, ?)`,
        )
        .run(bugId, workspaceKey, now, now);
    const attempt = (latest?.attempt ?? 0) + 1;
    const prompt = buildInitialRepairPrompt({
      workspaceKey,
      submissionTitle: source.submission_title,
      requirementDescription: source.requirement_description,
      engineeringName: source.engineering_name,
      repositoryUrl: source.repository_url,
      targetBranch: source.target_branch,
      bugTitle: source.title,
      operationPath: source.operation_path ?? undefined,
      actualResult: source.actual_result ?? undefined,
      expectedResult: source.expected_result ?? undefined,
      notes: source.notes ?? undefined,
      feedback: this.feedbackContents(bugId),
      pendingCommits: existingContext
        ? parseCommits(existingContext.pending_commits_json)
        : [],
    });
    const execution = this.executions.enqueue({
      owner: { namespace: 'cooking', kind: 'BUG_REPAIR', id: attemptId },
      attempt,
      previousExecutionId: latest?.execution_id ?? null,
      runnerId: source.runner_id,
      bindingId: source.binding_id,
      priority,
      promptKind: prompt.kind,
      promptVersion: prompt.version,
      renderedPrompt: prompt.renderedPrompt,
      renderedPromptHash: prompt.renderedPromptHash,
      outputJsonSchema: prompt.outputJsonSchema,
      attachmentIds: this.attachmentIds(bugId),
      resumeSessionId: null,
    });
    this.db
      .prepare(
        `INSERT INTO cooking_repair_attempt(
           id, bug_id, execution_id, attempt, outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(attemptId, bugId, execution.id, attempt, now);
    this.synchronizeQueuePriorities(source.submission_id);
    return execution.id;
  }

  createContinuationExecution(
    bugId: string,
    content: string,
    priority = -1_000_000,
  ): string {
    const source = this.source(bugId);
    const context = this.requireContext(bugId);
    const latest = this.latestAttempt(bugId);
    if (!latest || !isTerminal(latest.state))
      throw new PlatformError('RESOURCE_CONFLICT', '当前修复 Attempt 尚未结束');
    const attempt = latest.attempt + 1;
    const attemptId = this.createId();
    const prompt = buildContinuationRepairPrompt({
      content,
      pendingCommits: parseCommits(context.pending_commits_json),
    });
    const execution = this.executions.enqueue({
      owner: { namespace: 'cooking', kind: 'BUG_REPAIR', id: attemptId },
      attempt,
      previousExecutionId: latest.execution_id,
      runnerId: source.runner_id,
      bindingId: source.binding_id,
      priority,
      promptKind: prompt.kind,
      promptVersion: prompt.version,
      renderedPrompt: prompt.renderedPrompt,
      renderedPromptHash: prompt.renderedPromptHash,
      outputJsonSchema: prompt.outputJsonSchema,
      attachmentIds: [],
      resumeSessionId: context.session_id,
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

  withdrawQueuedExecution(bugId: string): void {
    const latest = this.latestAttempt(bugId);
    if (!latest || latest.state !== 'QUEUED')
      throw new PlatformError('INVALID_TRANSITION', '修复已开始，不能直接撤回');
    const execution = this.executions.cancelQueued(
      latest.execution_id,
      '修复请求已撤回',
    );
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE cooking_repair_attempt
         SET outcome_json = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          outcome: 'FAILED',
          summary: '修复请求在 Runner 领取前撤回。',
          technicalFailure: execution.outcome?.kind,
        }),
        now,
        latest.id,
      );
  }

  synchronizeQueuePriorities(submissionId: string): void {
    const rows = this.db
      .prepare(
        `SELECT entry.position, attempt.execution_id, execution.state
         FROM cooking_repair_queue_entry entry
         JOIN cooking_repair_attempt attempt ON attempt.bug_id = entry.bug_id
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE entry.submission_id = ?
           AND attempt.attempt = (
             SELECT MAX(latest.attempt) FROM cooking_repair_attempt latest
             WHERE latest.bug_id = entry.bug_id
           )
         ORDER BY entry.position`,
      )
      .all(submissionId) as Array<{
      position: number;
      execution_id: string;
      state: Execution['state'];
    }>;
    for (const row of rows)
      if (row.state === 'QUEUED')
        this.executions.setQueuedPriority(row.execution_id, row.position);
  }

  applyTerminalExecution(execution: Execution): void {
    if (
      execution.owner.namespace !== 'cooking' ||
      execution.owner.kind !== 'BUG_REPAIR'
    )
      return;
    const attempt = this.db
      .prepare(
        `SELECT attempt.id, attempt.bug_id, attempt.execution_id,
                attempt.attempt, attempt.outcome_json, attempt.created_at,
                attempt.finished_at, execution.state, execution.session_id,
                execution.outcome_json outcome
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.execution_id = ?`,
      )
      .get(execution.id) as AttemptRow | undefined;
    if (!attempt || attempt.outcome_json) return;
    const context = this.requireContext(attempt.bug_id);
    const now = this.now().toISOString();
    const interpreted = this.interpret(execution, context);
    this.removeQueueEntry(attempt.bug_id, now);
    if (interpreted.kind === 'COMPLETED') {
      this.db
        .prepare(
          `UPDATE cooking_bug_repair_context
           SET session_id = ?, pending_commits_json = ?,
               version = version + 1, updated_at = ?
           WHERE bug_id = ?`,
        )
        .run(
          execution.sessionId,
          JSON.stringify(interpreted.pendingCommits),
          now,
          attempt.bug_id,
        );
      this.db
        .prepare(
          `UPDATE cooking_bug
           SET stage = 'WAITING_FOR_UPDATE', version = version + 1, updated_at = ?
           WHERE id = ? AND stage = 'REPAIRING'`,
        )
        .run(now, attempt.bug_id);
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
          `INSERT INTO cooking_bug_feedback(
             id, bug_id, kind, author_user_id, content, created_at
           ) VALUES (?, ?, 'EXECUTION_FAILURE', NULL, ?, ?)`,
        )
        .run(
          this.createId(),
          attempt.bug_id,
          '修复执行未完成，可由工程负责人补充信息后继续。',
          now,
        );
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
      },
      now,
    );
    this.bumpRevision(attempt.bug_id, now);
  }

  applyStartedExecution(execution: Execution): void {
    if (!isRepairExecution(execution)) return;
    const now = this.now().toISOString();
    const attempt = this.attemptForExecution(execution.id);
    if (!attempt || !this.removeQueueEntry(attempt.bug_id, now)) return;
    this.auditForBug(
      attempt.bug_id,
      'REPAIR_ATTEMPT_STARTED',
      { executionId: execution.id, attempt: attempt.attempt },
      now,
    );
    this.bumpRevision(attempt.bug_id, now);
  }

  applyInteractionOpened(executionId: string, interactionId: string): void {
    const attempt = this.attemptForExecution(executionId);
    if (!attempt) return;
    const now = this.now().toISOString();
    this.auditForBug(
      attempt.bug_id,
      'REPAIR_INTERACTION_OPENED',
      { executionId, interactionId, attempt: attempt.attempt },
      now,
    );
    this.bumpRevision(attempt.bug_id, now);
  }

  afterTerminalExecution(execution: Execution): void {
    if (!isRepairExecution(execution)) return;
    this.publishExecutionInvalidation(execution.id);
  }

  afterStartedExecution(execution: Execution): void {
    if (!isRepairExecution(execution)) return;
    this.publishExecutionInvalidation(execution.id);
  }

  afterInteractionOpened(executionId: string): void {
    this.publishExecutionInvalidation(executionId);
  }

  continueRepair(
    actorUserId: string,
    bugId: string,
    inputValue: ContinueRepairInput,
  ): RepairMutationResult {
    const input = ContinueRepairInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'REPAIR_CONTINUE',
      resourceType: 'BUG',
      resultSchema: RepairMutationResultSchema,
      perform: () => {
        const source = this.requireResponsible(actorUserId, bugId);
        this.requireActiveVersion(source, input.expectedVersion);
        if (!['REPAIRING', 'WAITING_FOR_UPDATE'].includes(source.stage))
          throw new PlatformError('INVALID_TRANSITION', '当前缺陷不能继续修复');
        const latest = this.latestAttempt(bugId);
        if (!latest || !isTerminal(latest.state))
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前修复尚未结束，不能继续创建新 Attempt',
          );
        const now = this.now().toISOString();
        const feedbackId = this.createId();
        this.db
          .prepare(
            `INSERT INTO cooking_bug_feedback(
               id, bug_id, kind, author_user_id, content, created_at
             ) VALUES (?, ?, 'DEVELOPER_NOTE', ?, ?, ?)`,
          )
          .run(feedbackId, bugId, actorUserId, input.content, now);
        const executionId = this.createContinuationExecution(
          bugId,
          input.content,
        );
        const update = this.db
          .prepare(
            `UPDATE cooking_bug
             SET stage = 'REPAIRING', version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?
               AND stage IN ('REPAIRING', 'WAITING_FOR_UPDATE')`,
          )
          .run(now, bugId, input.expectedVersion);
        if (update.changes !== 1) throw staleRepair();
        const revision = this.bumpRevision(bugId, now);
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
              details: { executionId, feedbackId },
            },
          ],
        };
      },
    });
    if (!replay)
      this.onInvalidated(this.source(bugId).submission_id, result.revision);
    return result;
  }

  stopExecution(
    actorUserId: string,
    bugId: string,
    inputValue: StopRepairInput,
  ): RepairMutationResult {
    const input = StopRepairInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'REPAIR_STOP',
      resourceType: 'BUG',
      resultSchema: RepairMutationResultSchema,
      perform: () => {
        const source = this.requireResponsible(actorUserId, bugId);
        this.requireActiveVersion(source, input.expectedVersion);
        if (source.stage !== 'REPAIRING')
          throw new PlatformError('INVALID_TRANSITION', '当前缺陷不在修复中');
        const latest = this.latestAttempt(bugId);
        if (
          !latest ||
          !['CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION'].includes(
            latest.state,
          )
        )
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前没有可以停止的修复执行',
          );
        this.executions.requestCancellation(latest.execution_id);
        const now = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_bug SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'REPAIRING'`,
          )
          .run(now, bugId, input.expectedVersion);
        if (update.changes !== 1) throw staleRepair();
        const revision = this.bumpRevision(bugId, now);
        return {
          result: {
            bugId,
            bugVersion: input.expectedVersion + 1,
            executionId: latest.execution_id,
            revision,
          },
          resourceId: bugId,
          audits: [
            {
              projectId: source.project_id,
              action: 'REPAIR_EXECUTION_STOP_REQUESTED',
              targetType: 'BUG',
              targetId: bugId,
              details: { executionId: latest.execution_id },
            },
          ],
        };
      },
    });
    if (!replay)
      this.onInvalidated(this.source(bugId).submission_id, result.revision);
    return result;
  }

  resolveInteraction(
    actorUserId: string,
    interactionId: string,
    inputValue: ResolveRepairInteractionInput,
  ): RepairMutationResult {
    const input = ResolveRepairInteractionInputSchema.parse(inputValue);
    const row = this.interactionSource(interactionId);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'REPAIR_INTERACTION_RESOLVE',
      resourceType: 'EXECUTION_INTERACTION',
      resultSchema: RepairMutationResultSchema,
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
        const revision = this.bumpRevision(row.bug_id, now);
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
    if (!replay)
      this.onInvalidated(
        this.source(row.bug_id).submission_id,
        result.revision,
      );
    return result;
  }

  workspace(userId: string, submissionId: string): RepairWorkspaceProjection {
    this.requireSubmissionAccess(userId, submissionId);
    const bugIds = (
      this.db
        .prepare(
          `SELECT context.bug_id
           FROM cooking_bug_repair_context context
           JOIN cooking_bug bug ON bug.id = context.bug_id
           WHERE bug.submission_id = ? ORDER BY bug.short_id`,
        )
        .all(submissionId) as Array<{ bug_id: string }>
    ).map(({ bug_id }) => bug_id);
    return RepairWorkspaceProjectionSchema.parse({
      repairByBug: Object.fromEntries(
        bugIds.map((bugId) => [bugId, this.repairView(userId, bugId)]),
      ),
      pendingInteractions: this.interactions(userId, submissionId),
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
    if (row) this.onInvalidated(row.submission_id, row.workspace_revision);
  }

  repairView(userId: string, bugId: string): BugRepairView | null {
    const source = this.source(bugId);
    this.requireSubmissionAccess(userId, source.submission_id);
    const context = this.context(bugId);
    if (!context) return null;
    const technical = userId === source.responsible_user_id;
    const attempts = this.attempts(bugId);
    const latest = attempts.at(-1);
    return BugRepairViewSchema.parse({
      pendingCommits: technical
        ? parseCommits(context.pending_commits_json)
        : null,
      sessionAvailable: Boolean(context.session_id),
      attempts: attempts.map((attempt) => {
        const outcome = attempt.outcome_json
          ? (JSON.parse(attempt.outcome_json) as {
              outcome?: string;
              summary?: string;
              technicalFailure?: string;
            })
          : null;
        const failed = outcome?.outcome === 'FAILED';
        return {
          id: attempt.id,
          executionId: attempt.execution_id,
          attempt: attempt.attempt,
          executionState: attempt.state,
          summary:
            failed && !technical
              ? '修复执行未完成，可由工程负责人继续处理。'
              : (outcome?.summary ?? null),
          technicalFailure: technical
            ? (outcome?.technicalFailure ?? (failed ? outcome?.summary : null))
            : null,
          createdAt: attempt.created_at,
          finishedAt: attempt.finished_at,
        };
      }),
      availableActions:
        technical && source.submission_status === 'ACTIVE'
          ? [
              ...(['REPAIRING', 'WAITING_FOR_UPDATE'].includes(source.stage) &&
              latest &&
              isTerminal(latest.state)
                ? (['CONTINUE_REPAIR'] as const)
                : []),
              ...(source.stage === 'REPAIRING' &&
              latest &&
              ['CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION'].includes(
                latest.state,
              )
                ? (['STOP_EXECUTION'] as const)
                : []),
            ]
          : [],
      presentation: {
        statusLabel: latest ? repairStateLabel(latest.state) : '等待修复',
      },
    });
  }

  interactions(userId: string, submissionId: string): RepairInteractionView[] {
    this.requireSubmissionAccess(userId, submissionId);
    const rows = this.db
      .prepare(
        `SELECT interaction.*, bug.id bug_id, bug.short_id,
                item.responsible_user_id
         FROM platform_execution_interaction interaction
         JOIN cooking_repair_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         JOIN cooking_bug bug ON bug.id = attempt.bug_id
         JOIN cooking_submission_item item ON item.id = bug.submission_item_id
         WHERE bug.submission_id = ? AND interaction.state = 'PENDING'
         ORDER BY interaction.created_at, interaction.id`,
      )
      .all(submissionId) as Array<{
      id: string;
      execution_id: string;
      bug_id: string;
      short_id: number;
      responsible_user_id: string;
      kind: 'APPROVAL' | 'USER_INPUT';
      state: 'PENDING';
      method: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => {
      const responsible = row.responsible_user_id === userId;
      return RepairInteractionViewSchema.parse({
        id: row.id,
        executionId: row.execution_id,
        bugId: row.bug_id,
        bugShortId: row.short_id,
        kind: row.kind,
        state: row.state,
        method: responsible ? row.method : null,
        payload: responsible
          ? sanitizeExecutionInteractionPayload(
              row.method,
              JSON.parse(row.payload_json),
            )
          : null,
        canResolve: responsible,
        createdAt: row.created_at,
      });
    });
  }

  private interpret(
    execution: Execution,
    context: ContextRow,
  ):
    | {
        kind: 'COMPLETED';
        pendingCommits: string[];
        attemptOutcome: unknown;
      }
    | {
        kind: 'FAILED';
        summary: string;
        attemptOutcome: unknown;
      } {
    if (execution.outcome?.kind === 'SUCCEEDED') {
      const parsed = RepairExecutionResultSchema.safeParse(
        execution.outcome.result,
      );
      if (parsed.success && parsed.data.outcome === 'COMPLETED') {
        const current = parseCommits(context.pending_commits_json);
        if (
          new Set(parsed.data.commits).size === parsed.data.commits.length &&
          !parsed.data.commits.some((commit) => current.includes(commit))
        )
          return {
            kind: 'COMPLETED',
            pendingCommits: [...current, ...parsed.data.commits],
            attemptOutcome: parsed.data,
          };
      }
      if (parsed.success && parsed.data.outcome === 'FAILED')
        return {
          kind: 'FAILED',
          summary: parsed.data.summary,
          attemptOutcome: parsed.data,
        };
      this.markExecutionResultInvalid(execution.id);
      return {
        kind: 'FAILED',
        summary: '修复执行未返回有效的候选 Commit。',
        attemptOutcome: {
          outcome: 'FAILED',
          summary: '修复结果格式或候选 Commit 链无效',
          technicalFailure: 'RESULT_SCHEMA_INVALID',
        },
      };
    }
    const summary =
      execution.outcome?.kind === 'CANCELLED'
        ? '修复执行已停止，可由工程负责人继续。'
        : '修复执行未完成，可由工程负责人补充信息后继续。';
    return {
      kind: 'FAILED',
      summary,
      attemptOutcome: {
        outcome: 'FAILED',
        summary,
        technicalFailure:
          execution.outcome?.kind === 'FAILED'
            ? execution.outcome.failure.code
            : execution.outcome?.kind,
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
                bug.title, bug.operation_path, bug.actual_result,
                bug.expected_result, bug.notes,
                submission.title submission_title,
                submission.requirement_description,
                item.engineering_name, item.repository_url, item.target_branch,
                item.binding_id, binding.runner_id, item.responsible_user_id
         FROM cooking_bug bug
         JOIN cooking_test_submission submission ON submission.id = bug.submission_id
         JOIN cooking_submission_item item ON item.id = bug.submission_item_id
         JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         WHERE bug.id = ?`,
      )
      .get(bugId) as RepairSourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Repair Bug 不存在');
    return row;
  }

  private context(bugId: string): ContextRow | undefined {
    return this.db
      .prepare('SELECT * FROM cooking_bug_repair_context WHERE bug_id = ?')
      .get(bugId) as ContextRow | undefined;
  }

  private requireContext(bugId: string): ContextRow {
    const row = this.context(bugId);
    if (!row) throw new PlatformError('NOT_FOUND', 'Repair Context 不存在');
    return row;
  }

  private latestAttempt(bugId: string): AttemptRow | undefined {
    return this.attempts(bugId).at(-1);
  }

  private attemptForExecution(executionId: string): AttemptRow | undefined {
    return this.db
      .prepare(
        `SELECT attempt.id, attempt.bug_id, attempt.execution_id,
                attempt.attempt, attempt.outcome_json, attempt.created_at,
                attempt.finished_at, execution.state, execution.session_id,
                execution.outcome_json outcome
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.execution_id = ?`,
      )
      .get(executionId) as AttemptRow | undefined;
  }

  private attempts(bugId: string): AttemptRow[] {
    return this.db
      .prepare(
        `SELECT attempt.id, attempt.bug_id, attempt.execution_id,
                attempt.attempt, attempt.outcome_json, attempt.created_at,
                attempt.finished_at, execution.state, execution.session_id,
                execution.outcome_json outcome
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.bug_id = ? ORDER BY attempt.attempt`,
      )
      .all(bugId) as AttemptRow[];
  }

  private feedbackContents(bugId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT content FROM cooking_bug_feedback
           WHERE bug_id = ? ORDER BY created_at, id`,
        )
        .all(bugId) as Array<{ content: string }>
    ).map(({ content }) => content);
  }

  private attachmentIds(bugId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT file_id FROM cooking_bug_attachment
           WHERE bug_id = ? ORDER BY feedback_id IS NOT NULL, position`,
        )
        .all(bugId) as Array<{ file_id: string }>
    ).map(({ file_id }) => file_id);
  }

  private removeQueueEntry(bugId: string, now: string): boolean {
    const entry = this.db
      .prepare(
        `SELECT submission_id, position FROM cooking_repair_queue_entry
         WHERE bug_id = ?`,
      )
      .get(bugId) as { submission_id: string; position: number } | undefined;
    if (!entry) return false;
    this.db
      .prepare('DELETE FROM cooking_repair_queue_entry WHERE bug_id = ?')
      .run(bugId);
    this.db
      .prepare(
        `UPDATE cooking_repair_queue_entry SET position = position - 1
         WHERE submission_id = ? AND position > ?`,
      )
      .run(entry.submission_id, entry.position);
    this.db
      .prepare(
        `UPDATE cooking_repair_queue
         SET version = version + 1, updated_at = ? WHERE submission_id = ?`,
      )
      .run(now, entry.submission_id);
    return true;
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
    if (!row) throw new PlatformError('NOT_FOUND', 'Repair Interaction 不存在');
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

  private hasRecordedMutation(mutationId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 recorded FROM cooking_mutation WHERE id = ?')
        .get(mutationId),
    );
  }

  private bumpRevision(bugId: string, now: string): number {
    const row = this.db
      .prepare(
        `UPDATE cooking_test_submission
         SET workspace_revision = workspace_revision + 1, updated_at = ?
         WHERE id = (SELECT submission_id FROM cooking_bug WHERE id = ?)
         RETURNING workspace_revision`,
      )
      .get(now, bugId) as { workspace_revision: number };
    return row.workspace_revision;
  }
}

function parseCommits(value: string): string[] {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new PlatformError('INTERNAL_ERROR', 'Pending Commit Chain 无效');
  return parsed;
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
    QUEUED: '等待 Runner',
    CLAIMED: '正在准备修复',
    RUNNING: '正在修复',
    WAITING_FOR_INTERACTION: '等待工程负责人处理',
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
