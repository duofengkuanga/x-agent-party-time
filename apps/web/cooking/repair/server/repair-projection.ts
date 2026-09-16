import type { CookingExecutionProjectionEvent } from '@/cooking/runtime/execution-projection';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import type {
  Execution,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { RepairExecutionResultSchema } from '../contract';
import type { AttemptRow, ContextRow } from './records';
import { RepairQueries } from './repair-queries';
import type { RepairDeliveryHooks } from './repair-service';
import {
  asDetails,
  formatRepairContractIssues,
  isFailedAttemptOutcome,
  isRepairExecution,
  parseCommits,
  parseManualOperations,
} from './results';
export class RepairProjection {
  constructor(
    private readonly db: AppDatabase,
    private readonly queries: RepairQueries,
    private readonly writes: TestSubmissionWriteStore,
    private readonly now: () => Date,
    private readonly createId: () => string,
    private readonly deliveryHooks: RepairDeliveryHooks,
  ) {}
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
    const context = this.queries.requireContext(attempt.bug_id);
    const now = this.now().toISOString();
    const interpreted = this.interpret(execution, context);
    const deliveryRequired =
      interpreted.kind === 'COMPLETED' && interpreted.deliveryRequired;
    if (interpreted.kind === 'COMPLETED') {
      this.db.run(
        `UPDATE cooking_bug_repair_context
           SET session_id = ?, pending_commits_json = ?,
               pending_manual_operations_json = ?,
               last_candidate_at = ?, version = version + 1, updated_at = ?
           WHERE bug_id = ?`,
        [
          execution.sessionId,
          JSON.stringify(interpreted.pendingCommits),
          JSON.stringify(interpreted.pendingManualOperations),
          deliveryRequired ? now : null,
          now,
          attempt.bug_id,
        ],
      );
      this.db.run(
        `UPDATE cooking_bug
           SET stage = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND stage = 'REPAIRING'`,
        [
          deliveryRequired ? 'WAITING_FOR_UPDATE' : 'WAITING_FOR_VERIFICATION',
          now,
          attempt.bug_id,
        ],
      );
      if (deliveryRequired)
        this.deliveryHooks.candidateAvailable(attempt.bug_id, now);
    } else {
      this.db.run(
        `UPDATE cooking_bug_repair_context
           SET session_id = COALESCE(?, session_id),
               version = version + 1, updated_at = ?
           WHERE bug_id = ?`,
        [execution.sessionId, now, attempt.bug_id],
      );
      this.db.run(
        `UPDATE cooking_bug
           SET version = version + 1, updated_at = ?
           WHERE id = ? AND stage = 'REPAIRING'`,
        [now, attempt.bug_id],
      );
    }
    this.db.run(
      `UPDATE cooking_repair_attempt
         SET outcome_json = ?, finished_at = ? WHERE id = ?`,
      [JSON.stringify(interpreted.attemptOutcome), now, attempt.id],
    );
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
    const attempt = this.queries.attemptForExecution(execution.id);
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
    const attempt = this.queries.attemptForExecution(execution.id);
    if (!attempt) return;
    this.writes.bumpRevisionForBug(attempt.bug_id, this.now().toISOString());
  }

  private applyInteractionOpened(
    executionId: string,
    interactionId: string,
  ): void {
    const attempt = this.queries.attemptForExecution(executionId);
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

  private applySynchronizedExecution(execution: Execution): void {
    if (
      execution.owner.namespace !== 'cooking' ||
      execution.owner.kind !== 'SESSION_SYNC'
    )
      return;
    if (execution.outcome?.kind !== 'SUCCEEDED') return;
    const sync = this.db
      .prepare(
        'SELECT bug_id FROM cooking_repair_session_sync WHERE execution_id = ?',
      )
      .get(execution.id) as { bug_id: string } | undefined;
    if (!sync) return;
    const envelope = execution.outcome.result as Record<string, unknown>;
    const turnId = typeof envelope.turnId === 'string' ? envelope.turnId : null;
    const result = envelope.result;
    if (!turnId) return;
    const parsed = RepairExecutionResultSchema.safeParse(result);
    if (!parsed.success) {
      this.markExecutionResultInvalid(execution.id);
      return;
    }
    const duplicate = this.db
      .prepare(
        `SELECT 1 FROM cooking_repair_session_sync
         WHERE session_id = ? AND turn_id = ? AND execution_id <> ? LIMIT 1`,
      )
      .get(execution.sessionId, turnId, execution.id);
    if (duplicate) return;
    this.db.run(
      'UPDATE cooking_repair_session_sync SET turn_id = ? WHERE execution_id = ?',
      [turnId, execution.id],
    );
    const latest = this.queries.latestAttempt(sync.bug_id);
    if (
      !latest ||
      !latest.outcome_json ||
      !isFailedAttemptOutcome(latest.outcome_json)
    )
      return;
    const attemptId = this.createId();
    const now = this.now().toISOString();
    this.db.run(
      `INSERT INTO cooking_repair_attempt(id, bug_id, execution_id, attempt, outcome_json, created_at, finished_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      [attemptId, sync.bug_id, execution.id, latest.attempt + 1, now],
    );
    this.applyTerminalExecution({
      ...execution,
      outcome: { kind: 'SUCCEEDED', result: result as JsonValue },
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
      const result = parsed.success ? parsed.data.result : null;
      if (result?.outcome === 'COMPLETED') {
        const current = parseCommits(context.pending_commits_json);
        const currentManualOperations = parseManualOperations(
          context.pending_manual_operations_json,
        );
        if (
          new Set(result.commits).size === result.commits.length &&
          !result.commits.some((commit) => current.includes(commit)) &&
          (result.completionKind === 'CHANGES_COMMITTED' ||
            current.length === 0)
        )
          return {
            kind: 'COMPLETED',
            deliveryRequired: result.completionKind === 'CHANGES_COMMITTED',
            pendingCommits: [...current, ...result.commits],
            pendingManualOperations: [
              ...currentManualOperations,
              ...result.manualOperations,
            ],
            attemptOutcome: result,
          };
      }
      if (result?.outcome === 'FAILED')
        return {
          kind: 'FAILED',
          attemptOutcome: result,
        };
      const invalidReason = parsed.success
        ? 'Codex 返回的候选本地提交记录无效。'
        : `Codex 返回的修复结果格式不符合要求。具体问题：${formatRepairContractIssues(parsed.error.issues)}`;
      this.markExecutionResultInvalid(execution.id);
      return {
        kind: 'FAILED',
        attemptOutcome: {
          outcome: 'FAILED',
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
    return {
      kind: 'FAILED',
      attemptOutcome: {
        outcome: 'FAILED',
        failedStep: '修复执行',
        reason:
          failure?.message ??
          cancelledReason ??
          '修复执行未返回更具体的失败原因',
        completedActions: [],
        pendingActions: ['重新执行修复'],
        technicalFailure: failure?.code ?? (cancelled ? 'CANCELLED' : null),
      },
    };
  }

  private markExecutionResultInvalid(executionId: string): void {
    this.db.run(
      `UPDATE platform_execution
         SET state = 'FAILED', outcome_json = ?
         WHERE id = ?`,
      [
        JSON.stringify({
          kind: 'FAILED',
          failure: {
            code: 'CODEX_EXECUTION_FAILED',
            message: 'Codex 返回的结构化结果无效',
            retryable: true,
          },
        }),
        executionId,
      ],
    );
  }

  private auditForBug(
    bugId: string,
    action: string,
    details: unknown,
    createdAt: string,
  ): void {
    const source = this.queries.source(bugId);
    this.db.run(
      `INSERT INTO cooking_audit_event(
           id, project_id, actor_user_id, action, target_type, target_id,
           details_json, created_at
         ) VALUES (?, ?, ?, ?, 'BUG', ?, ?, ?)`,
      [
        this.createId(),
        source.project_id,
        source.responsible_user_id,
        action,
        bugId,
        JSON.stringify({ source: 'EXECUTION', ...asDetails(details) }),
        createdAt,
      ],
    );
  }
}
