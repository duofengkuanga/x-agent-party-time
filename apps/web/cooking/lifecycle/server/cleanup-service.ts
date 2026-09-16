import type { CookingExecutionProjectionEvent } from '@/cooking/runtime/execution-projection';
import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ExecutionService } from '@/platform/execution/service';
import { type Execution } from '@agent-party-time/execution-contract';
import {
  CleanupMutationResultSchema,
  LifecycleCommandInputSchema,
  ResolveCleanupInteractionInputSchema,
  type CleanupMutationResult,
  type LifecycleCommandInput,
  type ResolveCleanupInteractionInput,
} from '../contract';
import { LifecycleQueries } from './lifecycle-queries';
import type { CleanupSourceRow } from './records';
import {
  interpretCleanup,
  isCleanupExecution,
  isTerminal,
  parseWorkspaceKeys,
  staleLifecycle,
} from './results';

export class CleanupService {
  private readonly queries: LifecycleQueries;
  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService,
    private readonly writes: TestSubmissionWriteStore,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {
    this.queries = new LifecycleQueries(db);
  }
  retryCleanup(
    actorUserId: string,
    cleanupId: string,
    inputValue: LifecycleCommandInput,
  ): CleanupMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'CLEANUP_RETRY',
      resourceType: 'CLEANUP',
      resultSchema: CleanupMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.queries.cleanupSource(cleanupId).submission_id,
        revision: mutation.revision,
      }),
      perform: () => {
        const cleanup = this.requireCleanupResponsible(actorUserId, cleanupId);
        if (cleanup.version !== input.expectedVersion)
          throw staleLifecycle('清理任务');
        if (cleanup.state !== 'FAILED')
          throw new PlatformError('INVALID_TRANSITION', '只有失败清理可以重试');
        const latest = this.queries.latestCleanupAttempt(cleanupId);
        if (!latest || !isTerminal(latest.state))
          throw new PlatformError('RESOURCE_CONFLICT', '当前清理执行尚未结束');
        const attemptId = this.createId();
        const execution = this.executions.enqueue({
          owner: { namespace: 'cooking', kind: 'CLEANUP', id: attemptId },
          attempt: latest.attempt + 1,
          previousExecutionId: latest.execution_id,
          runnerId: cleanup.runner_id,
          bindingId: cleanup.binding_id,
          priority: 0,
          approvalPolicy: 'never',
          codexTurn: null,
          workspace: {
            key: `cleanup:${cleanup.id}`,
            isolation: 'CLEANUP_WORKTREES',
            workspaceKeys: parseWorkspaceKeys(cleanup.scope_json),
            completionResult: {
              outcome: 'COMPLETED',
              summary: '本机临时工作区已安全清理。',
            },
          },
          attachmentIds: [],
        });
        const now = this.now().toISOString();
        this.db.run(
          `INSERT INTO cooking_cleanup_attempt(
               id, cleanup_id, execution_id, attempt, outcome_json,
               created_at, finished_at
             ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
          [attemptId, cleanupId, execution.id, latest.attempt + 1, now],
        );
        const update = this.db.run(
          `UPDATE cooking_cleanup
             SET state = 'READY', active_execution_id = ?,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND state = 'FAILED' AND version = ?`,
          [execution.id, now, cleanupId, input.expectedVersion],
        );
        if (update.changes !== 1) throw staleLifecycle('清理任务');
        const revision = this.writes.bumpRevision(cleanup.submission_id, now);
        return {
          result: {
            cleanupId,
            cleanupVersion: input.expectedVersion + 1,
            executionId: execution.id,
            revision,
          },
          resourceId: cleanupId,
          audits: [
            {
              projectId: cleanup.project_id,
              action: 'CLEANUP_RETRIED',
              targetType: 'CLEANUP',
              targetId: cleanupId,
              details: {
                executionId: execution.id,
                attempt: latest.attempt + 1,
              },
            },
          ],
        };
      },
    });
    return result;
  }

  resolveCleanupInteraction(
    actorUserId: string,
    interactionId: string,
    inputValue: ResolveCleanupInteractionInput,
  ): CleanupMutationResult {
    const input = ResolveCleanupInteractionInputSchema.parse(inputValue);
    const source = this.queries.cleanupInteractionSource(interactionId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'CLEANUP_INTERACTION_RESOLVE',
      resourceType: 'EXECUTION_INTERACTION',
      resultSchema: CleanupMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: this.queries.cleanupSource(source.cleanup_id)
          .submission_id,
        revision: mutation.revision,
      }),
      perform: () => {
        const cleanup = this.requireCleanupResponsible(
          actorUserId,
          source.cleanup_id,
        );
        if (cleanup.version !== input.expectedVersion)
          throw staleLifecycle('清理任务');
        if (
          cleanup.state !== 'RUNNING' ||
          cleanup.active_execution_id !== source.execution_id
        )
          throw new PlatformError('INVALID_TRANSITION', '清理任务不在运行中');
        this.executions.resolveInteraction(interactionId, input.resolution);
        const now = this.now().toISOString();
        const update = this.db.run(
          `UPDATE cooking_cleanup
             SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'RUNNING'
               AND active_execution_id = ?`,
          [now, cleanup.id, input.expectedVersion, source.execution_id],
        );
        if (update.changes !== 1) throw staleLifecycle('清理任务');
        const revision = this.writes.bumpRevision(cleanup.submission_id, now);
        return {
          result: {
            cleanupId: cleanup.id,
            cleanupVersion: input.expectedVersion + 1,
            executionId: source.execution_id,
            revision,
          },
          resourceId: interactionId,
          audits: [
            {
              projectId: cleanup.project_id,
              action: 'CLEANUP_INTERACTION_RESOLVED',
              targetType: 'EXECUTION_INTERACTION',
              targetId: interactionId,
              details: {
                cleanupId: cleanup.id,
                executionId: source.execution_id,
              },
            },
          ],
        };
      },
    });
    return result;
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
    if (event.phase === 'APPLY') this.applyTerminalExecution(event.execution);
    else this.afterTerminalExecution(event.execution);
  }

  private applyStartedExecution(execution: Execution): void {
    if (!isCleanupExecution(execution)) return;
    const attempt = this.queries.cleanupAttemptForExecution(execution.id);
    if (!attempt) return;
    const cleanup = this.queries.cleanupSource(attempt.cleanup_id);
    if (cleanup.state !== 'READY') return;
    const now = this.now().toISOString();
    this.db.run(
      `UPDATE cooking_cleanup
         SET state = 'RUNNING', version = version + 1, updated_at = ?
         WHERE id = ? AND state = 'READY'`,
      [now, cleanup.id],
    );
    this.writes.bumpRevision(cleanup.submission_id, now);
  }

  private applyResumedExecution(execution: Execution): void {
    if (!isCleanupExecution(execution)) return;
    const attempt = this.queries.cleanupAttemptForExecution(execution.id);
    if (!attempt) return;
    const cleanup = this.queries.cleanupSource(attempt.cleanup_id);
    this.writes.bumpRevision(cleanup.submission_id, this.now().toISOString());
  }

  private applyInteractionOpened(
    executionId: string,
    interactionId: string,
  ): void {
    const attempt = this.queries.cleanupAttemptForExecution(executionId);
    if (!attempt) return;
    const cleanup = this.queries.cleanupSource(attempt.cleanup_id);
    const now = this.now().toISOString();
    this.db.run(
      `INSERT INTO cooking_audit_event(
           id, project_id, actor_user_id, action, target_type, target_id,
           details_json, created_at
         ) VALUES (?, ?, ?, 'CLEANUP_INTERACTION_OPENED',
                   'EXECUTION_INTERACTION', ?, ?, ?)`,
      [
        this.createId(),
        cleanup.project_id,
        cleanup.responsible_user_id,
        interactionId,
        JSON.stringify({
          cleanupId: cleanup.id,
          executionId,
          attempt: attempt.attempt,
        }),
        now,
      ],
    );
    this.writes.bumpRevision(cleanup.submission_id, now);
  }

  private applyTerminalExecution(execution: Execution): void {
    if (!isCleanupExecution(execution)) return;
    const attempt = this.queries.cleanupAttemptForExecution(execution.id);
    if (!attempt || attempt.outcome_json) return;
    const cleanup = this.queries.cleanupSource(attempt.cleanup_id);
    const now = this.now().toISOString();
    const interpreted = interpretCleanup(execution);
    this.db.run(
      `UPDATE cooking_cleanup
         SET state = ?, active_execution_id = NULL,
             session_id = COALESCE(?, session_id),
             version = version + 1, updated_at = ?
         WHERE id = ? AND state IN ('READY', 'RUNNING')`,
      [
        interpreted.kind === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
        execution.sessionId,
        now,
        cleanup.id,
      ],
    );
    this.db.run(
      `UPDATE cooking_cleanup_attempt
         SET outcome_json = ?, finished_at = ? WHERE id = ?`,
      [JSON.stringify(interpreted.outcome), now, attempt.id],
    );
    this.writes.bumpRevision(cleanup.submission_id, now);
  }

  private afterStartedExecution(execution: Execution): void {
    if (isCleanupExecution(execution)) this.publishExecution(execution.id);
  }

  private afterResumedExecution(execution: Execution): void {
    if (isCleanupExecution(execution)) this.publishExecution(execution.id);
  }

  private afterInteractionOpened(executionId: string): void {
    this.publishExecution(executionId);
  }

  private afterTerminalExecution(execution: Execution): void {
    if (isCleanupExecution(execution)) this.publishExecution(execution.id);
  }

  createCleanup(input: {
    reason: 'SUBMISSION_CLOSED';
    subjectId: string;
    submissionId: string;
    submissionItemId: string;
    workspaceKeys: string[];
    now: string;
  }): { cleanupId: string; executionId: string } {
    const source = this.queries.itemCleanupSource(input.submissionItemId);
    const cleanupId = this.createId();
    const attemptId = this.createId();
    this.db.run(
      `INSERT INTO cooking_cleanup(
           id, submission_id, submission_item_id, reason, subject_id,
           state, version, active_execution_id, session_id, scope_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'READY', 1, NULL, NULL, ?, ?, ?)`,
      [
        cleanupId,
        input.submissionId,
        input.submissionItemId,
        input.reason,
        input.subjectId,
        JSON.stringify([...new Set(input.workspaceKeys)]),
        input.now,
        input.now,
      ],
    );
    const execution = this.executions.enqueue({
      owner: { namespace: 'cooking', kind: 'CLEANUP', id: attemptId },
      attempt: 1,
      previousExecutionId: null,
      runnerId: source.runner_id,
      bindingId: source.binding_id,
      priority: 0,
      approvalPolicy: 'never',
      codexTurn: null,
      workspace: {
        key: `cleanup:${cleanupId}`,
        isolation: 'CLEANUP_WORKTREES',
        workspaceKeys: [...new Set(input.workspaceKeys)],
        completionResult: {
          outcome: 'COMPLETED',
          summary: '本机临时工作区已安全清理。',
        },
      },
      attachmentIds: [],
    });
    this.db.run(
      `INSERT INTO cooking_cleanup_attempt(
           id, cleanup_id, execution_id, attempt, outcome_json,
           created_at, finished_at
         ) VALUES (?, ?, ?, 1, NULL, ?, NULL)`,
      [attemptId, cleanupId, execution.id, input.now],
    );
    this.db.run(
      'UPDATE cooking_cleanup SET active_execution_id = ? WHERE id = ?',
      [execution.id, cleanupId],
    );
    return { cleanupId, executionId: execution.id };
  }

  private requireCleanupResponsible(
    userId: string,
    cleanupId: string,
  ): CleanupSourceRow {
    const cleanup = this.queries.cleanupSource(cleanupId);
    requireSubmissionAccess(this.db, userId, cleanup.submission_id);
    if (cleanup.responsible_user_id !== userId)
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有对应工程负责人可以处理清理',
      );
    return cleanup;
  }

  private publishExecution(executionId: string): void {
    const row = this.db
      .prepare(
        `SELECT cleanup.submission_id, submission.workspace_revision
         FROM cooking_cleanup_attempt attempt
         JOIN cooking_cleanup cleanup ON cleanup.id = attempt.cleanup_id
         JOIN cooking_test_submission submission ON submission.id = cleanup.submission_id
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
