import { DeploymentMethodSchema } from '@/cooking/engineering/contract';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { executionProjector } from '@/platform/execution/projection';
import type {
  Execution,
  JsonValue,
} from '@agent-party-time/execution-contract';
import {
  CiCdUpdateExecutionResultSchema,
  LocalScriptUpdateExecutionResultSchema,
} from '../contract';
import type { BatchRow } from './records';
import {
  asDetails,
  isTerminal,
  isUpdateExecution,
  staleBatch,
} from './results';
import { UpdateQueries } from './update-queries';
export class UpdateProjection {
  constructor(
    private readonly db: AppDatabase,
    private readonly queries: UpdateQueries,
    private readonly writes: TestSubmissionWriteStore,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {}
  readonly projectExecution = executionProjector({
    APPLY: {
      STARTED: this.applyStartedExecution.bind(this),
      RESUMED: this.applyResumedExecution.bind(this),
      TERMINAL: (execution) =>
        execution.owner.kind === 'SESSION_SYNC'
          ? this.applySynchronizedExecution(execution)
          : this.applyTerminalExecution(execution),
      INTERACTION_OPENED: ({ executionId, id }) =>
        this.applyInteractionOpened(executionId, id),
    },
    AFTER: {
      STARTED: this.afterStartedExecution.bind(this),
      RESUMED: this.afterStartedExecution.bind(this),
      TERMINAL: this.afterTerminalExecution.bind(this),
      INTERACTION_OPENED: ({ executionId }) =>
        this.afterInteractionOpened(executionId),
    },
  });

  private applyStartedExecution(execution: Execution): void {
    if (
      execution.owner.namespace !== 'cooking' ||
      !['UPDATE_BATCH', 'SESSION_SYNC'].includes(execution.owner.kind)
    )
      return;
    const attempt = this.queries.attemptForExecution(execution.id);
    if (!attempt) return;
    const batch = this.queries.batch(attempt.batch_id);
    if (batch.state !== 'READY') return;
    const now = this.now().toISOString();
    this.db.run(
      `UPDATE cooking_update_batch
         SET state = 'RUNNING', version = version + 1, updated_at = ?
         WHERE id = ? AND state = 'READY'`,
      [now, batch.id],
    );
    this.auditForBatch(
      batch,
      'UPDATE_ATTEMPT_STARTED',
      { executionId: execution.id, attempt: attempt.attempt },
      now,
    );
    this.writes.bumpRevision(batch.submission_id, now);
  }

  private applyResumedExecution(execution: Execution): void {
    if (!isUpdateExecution(execution)) return;
    const attempt = this.queries.attemptForExecution(execution.id);
    if (!attempt) return;
    const batch = this.queries.batch(attempt.batch_id);
    this.writes.bumpRevision(batch.submission_id, this.now().toISOString());
  }

  private applyTerminalExecution(execution: Execution): void {
    const attempt = this.queries.attemptForExecution(execution.id);
    if (!attempt || attempt.outcome_json) return;
    const batch = this.queries.batch(attempt.batch_id);
    const now = this.now().toISOString();
    const interpreted = this.interpret(execution, batch);
    const nextState = {
      COMPLETED: 'COMPLETED',
      PUSHED: 'WAITING_EXTERNAL',
      FAILED: 'FAILED',
    }[interpreted.kind];
    const batchUpdate = this.db.run(
      `UPDATE cooking_update_batch
       SET state = ?, active_execution_id = ?,
           session_id = COALESCE(?, session_id),
           version = version + 1, updated_at = ?
       WHERE id = ? AND state IN ('READY', 'RUNNING', 'FAILED')`,
      [
        nextState,
        interpreted.kind === 'FAILED' ? batch.active_execution_id : null,
        execution.sessionId,
        now,
        batch.id,
      ],
    );
    if (batchUpdate.changes !== 1) throw staleBatch();
    if (interpreted.kind === 'COMPLETED') this.completeBatchBugs(batch.id, now);
    this.db.run(
      `UPDATE cooking_update_attempt
         SET outcome_json = ?, finished_at = ? WHERE id = ?`,
      [JSON.stringify(interpreted.attemptOutcome), now, attempt.id],
    );
    this.auditForBatch(
      batch,
      `UPDATE_ATTEMPT_${interpreted.kind}`,
      {
        executionId: execution.id,
        attempt: attempt.attempt,
        outcome: interpreted.kind,
      },
      now,
    );
    this.writes.bumpRevision(batch.submission_id, now);
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
        'SELECT batch_id FROM cooking_update_session_sync WHERE execution_id = ?',
      )
      .get(execution.id) as { batch_id: string } | undefined;
    if (!sync) return;
    const batch = this.queries.batch(sync.batch_id);
    const envelope = execution.outcome.result as Record<string, unknown>;
    const turnId = typeof envelope.turnId === 'string' ? envelope.turnId : null;
    const result = envelope.result;
    if (!turnId) return;
    const deployment = DeploymentMethodSchema.parse(
      JSON.parse(batch.deployment_json),
    );
    const parsed =
      deployment.kind === 'LOCAL_SCRIPT'
        ? LocalScriptUpdateExecutionResultSchema.safeParse(result)
        : CiCdUpdateExecutionResultSchema.safeParse(result);
    if (!parsed.success) {
      this.markExecutionResultInvalid(execution.id);
      return;
    }
    const latest = this.queries.latestAttempt(batch.id);
    if (!latest || !isTerminal(latest.state) || batch.state !== 'FAILED')
      return;
    const duplicate = this.db
      .prepare(
        `SELECT 1 FROM cooking_update_session_sync
       WHERE session_id = ? AND turn_id = ? AND execution_id <> ? LIMIT 1`,
      )
      .get(execution.sessionId, turnId, execution.id);
    if (duplicate) return;
    this.db.run(
      'UPDATE cooking_update_session_sync SET turn_id = ? WHERE execution_id = ?',
      [turnId, execution.id],
    );
    const attemptId = this.createId();
    const now = this.now().toISOString();
    this.db.run(
      `INSERT INTO cooking_update_attempt(id, batch_id, execution_id, continuation_report_id, attempt, outcome_json, created_at, finished_at)
       VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL)`,
      [attemptId, batch.id, execution.id, latest.attempt + 1, now],
    );
    this.applyTerminalExecution({
      ...execution,
      outcome: { kind: 'SUCCEEDED', result: result as JsonValue },
    });
  }

  private applyInteractionOpened(
    executionId: string,
    interactionId: string,
  ): void {
    const attempt = this.queries.attemptForExecution(executionId);
    if (!attempt) return;
    const batch = this.queries.batch(attempt.batch_id);
    const now = this.now().toISOString();
    this.auditForBatch(
      batch,
      'UPDATE_INTERACTION_OPENED',
      { executionId, interactionId, attempt: attempt.attempt },
      now,
    );
    this.writes.bumpRevision(batch.submission_id, now);
  }

  private afterStartedExecution(execution: Execution): void {
    if (isUpdateExecution(execution)) this.publishExecution(execution.id);
  }

  private afterTerminalExecution(execution: Execution): void {
    if (isUpdateExecution(execution)) {
      this.publishExecution(execution.id);
      return;
    }
    if (execution.owner.kind !== 'SESSION_SYNC') return;
    const sync = this.db
      .prepare(
        'SELECT batch_id FROM cooking_update_session_sync WHERE execution_id = ?',
      )
      .get(execution.id) as { batch_id: string } | undefined;
    if (sync) {
      const batch = this.queries.batch(sync.batch_id);
      this.writes.bumpRevision(batch.submission_id, this.now().toISOString());
    }
  }

  private afterInteractionOpened(executionId: string): void {
    this.publishExecution(executionId);
  }

  private interpret(
    execution: Execution,
    batch: BatchRow,
  ):
    | { kind: 'COMPLETED'; attemptOutcome: unknown }
    | { kind: 'PUSHED'; attemptOutcome: unknown }
    | { kind: 'FAILED'; attemptOutcome: unknown } {
    if (execution.outcome?.kind === 'SUCCEEDED') {
      const deployment = DeploymentMethodSchema.parse(
        JSON.parse(batch.deployment_json),
      );
      const parsed =
        deployment.kind === 'LOCAL_SCRIPT'
          ? LocalScriptUpdateExecutionResultSchema.safeParse(
              execution.outcome.result,
            )
          : CiCdUpdateExecutionResultSchema.safeParse(execution.outcome.result);
      const result = parsed.success ? parsed.data.result : null;
      if (result?.outcome === 'COMPLETED')
        return { kind: 'COMPLETED', attemptOutcome: result };
      if (result?.outcome === 'PUSHED')
        return { kind: 'PUSHED', attemptOutcome: result };
      if (parsed.success) return { kind: 'FAILED', attemptOutcome: result };
      this.markExecutionResultInvalid(execution.id);
      return {
        kind: 'FAILED',
        attemptOutcome: {
          outcome: 'FAILED',
          failedStep: '解析结构化结果',
          reason: 'Agent 返回内容不符合统一更新结果 Schema',
          completedActions: [],
          validations: [],
          warnings: [],
          pendingActions: ['重新执行统一更新'],
          technicalFailure: 'RESULT_SCHEMA_INVALID',
        },
      };
    }
    const cancelled = execution.outcome?.kind === 'CANCELLED';
    return {
      kind: 'FAILED',
      attemptOutcome: {
        outcome: 'FAILED',
        failedStep: cancelled ? '执行停止' : '执行统一更新',
        reason:
          execution.outcome?.kind === 'FAILED'
            ? execution.outcome.failure.message
            : cancelled
              ? '更新执行已停止'
              : '统一更新未完成',
        completedActions: [],
        validations: [],
        warnings: [],
        pendingActions: ['重新执行统一更新'],
        technicalFailure:
          execution.outcome?.kind === 'FAILED'
            ? execution.outcome.failure.code
            : execution.outcome?.kind,
      },
    };
  }

  private markExecutionResultInvalid(executionId: string): void {
    this.db.run(
      `UPDATE platform_execution
         SET state = 'FAILED', outcome_json = ? WHERE id = ?`,
      [
        JSON.stringify({
          kind: 'FAILED',
          failure: {
            code: 'CODEX_EXECUTION_FAILED',
            message: 'Codex 返回的更新结果无效',
            retryable: true,
          },
        }),
        executionId,
      ],
    );
  }

  completeBatchBugs(batchId: string, now: string): void {
    const entries = this.queries.batchEntries(batchId);
    const bugUpdate = this.db.run(
      `UPDATE cooking_bug
         SET stage = 'WAITING_FOR_VERIFICATION', version = version + 1,
             updated_at = ?
         WHERE id IN (
           SELECT bug_id FROM cooking_update_batch_entry WHERE batch_id = ?
         ) AND stage = 'UPDATING'`,
      [now, batchId],
    );
    if (bugUpdate.changes !== entries.length)
      throw new PlatformError('STALE_STATE', '更新批次中的缺陷状态已变化');
    const contextUpdate = this.db.run(
      `UPDATE cooking_bug_repair_context
         SET pending_commits_json = '[]',
             pending_manual_operations_json = '[]', last_candidate_at = NULL,
             version = version + 1, updated_at = ?
         WHERE bug_id IN (
           SELECT bug_id FROM cooking_update_batch_entry WHERE batch_id = ?
         )`,
      [now, batchId],
    );
    if (contextUpdate.changes !== entries.length)
      throw new PlatformError('INTERNAL_ERROR', '更新批次候选提交上下文不完整');
  }

  private auditForBatch(
    batch: BatchRow,
    action: string,
    details: unknown,
    createdAt: string,
  ): void {
    const source = this.queries.itemSource(batch.submission_item_id);
    this.db.run(
      `INSERT INTO cooking_audit_event(
           id, project_id, actor_user_id, action, target_type, target_id,
           details_json, created_at
         ) VALUES (?, ?, ?, ?, 'UPDATE_BATCH', ?, ?, ?)`,
      [
        this.createId(),
        source.project_id,
        source.responsible_user_id,
        action,
        batch.id,
        JSON.stringify({ source: 'EXECUTION', ...asDetails(details) }),
        createdAt,
      ],
    );
  }

  private publishExecution(executionId: string): void {
    const row = this.db
      .prepare(
        `SELECT batch.submission_id, submission.workspace_revision
         FROM cooking_update_attempt attempt
         JOIN cooking_update_batch batch ON batch.id = attempt.batch_id
         JOIN cooking_test_submission submission ON submission.id = batch.submission_id
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
}
