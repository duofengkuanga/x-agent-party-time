import { randomUUID } from 'node:crypto';
import {
  sanitizeExecutionInteractionPayload,
  type Execution,
} from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import { ExecutionService } from '@/server/execution/service';
import type { RepairService } from '@/features/cooking/repair/application/repair-service';
import { CookingWriteStore } from '@/features/cooking/shared/write-store';
import {
  BugLifecycleMutationResultSchema,
  CleanupExecutionResultSchema,
  CleanupInteractionViewSchema,
  CleanupMutationResultSchema,
  CloseSubmissionMutationResultSchema,
  LifecycleCommandInputSchema,
  LifecycleWorkspaceProjectionSchema,
  ReopenBugInputSchema,
  ResolveCleanupInteractionInputSchema,
  VerifyBugInputSchema,
  type BugLifecycleMutationResult,
  type CleanupMutationResult,
  type CleanupInteractionView,
  type CloseSubmissionMutationResult,
  type LifecycleCommandInput,
  type LifecycleWorkspaceProjection,
  type ReopenBugInput,
  type ResolveCleanupInteractionInput,
  type VerifyBugInput,
} from '../contract';
import {
  buildContinuationCleanupPrompt,
  buildInitialCleanupPrompt,
} from '../prompt';

type BugSourceRow = {
  id: string;
  submission_id: string;
  submission_item_id: string | null;
  stage: string;
  version: number;
  short_id: number;
  title: string;
  project_id: string;
  submission_status: 'ACTIVE' | 'CLOSED';
  submission_title: string;
  tester_user_id: string;
  responsible_user_id: string | null;
  binding_id: string | null;
  runner_id: string | null;
  engineering_name: string | null;
  target_branch: string | null;
};

type CleanupSourceRow = {
  id: string;
  submission_id: string;
  submission_item_id: string;
  reason: 'BUG_CANCELLED' | 'SUBMISSION_CLOSED';
  subject_id: string;
  state: 'READY' | 'RUNNING' | 'FAILED' | 'COMPLETED';
  version: number;
  active_execution_id: string | null;
  session_id: string | null;
  scope_json: string;
  created_at: string;
  updated_at: string;
  responsible_user_id: string;
  binding_id: string;
  runner_id: string;
  engineering_name: string;
  target_branch: string;
  submission_title: string;
  project_id: string;
};

type CleanupAttemptRow = {
  id: string;
  cleanup_id: string;
  execution_id: string;
  attempt: number;
  outcome_json: string | null;
  created_at: string;
  finished_at: string | null;
  state: Execution['state'];
  session_id: string | null;
};

type LifecycleHooks = {
  bugCancelled: (bugId: string) => void;
};

const NOOP_HOOKS: LifecycleHooks = { bugCancelled: () => {} };

export class LifecycleService {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly repairs: RepairService,
    private readonly executions: ExecutionService = new ExecutionService(db),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly onInvalidated: (
      submissionId: string,
      revision: number,
    ) => void = () => {},
    private readonly hooks: LifecycleHooks = NOOP_HOOKS,
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  verifyBug(
    actorUserId: string,
    bugId: string,
    inputValue: VerifyBugInput,
  ): BugLifecycleMutationResult {
    const input = VerifyBugInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'BUG_VERIFY',
      resourceType: 'BUG',
      resultSchema: BugLifecycleMutationResultSchema,
      perform: () => {
        const source = this.requireTester(actorUserId, bugId);
        this.requireBugVersion(source, input.expectedVersion);
        if (source.stage !== 'WAITING_FOR_VERIFICATION')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '当前缺陷不在待验证阶段',
          );
        const now = this.now().toISOString();
        const round = this.nextVerificationRound(bugId);
        if (input.result === 'PASSED') {
          this.requireBindableFiles(actorUserId, input.attachmentIds);
          if (input.attachmentIds.length)
            throw new PlatformError(
              'VALIDATION_FAILED',
              '验证通过不需要上传失败证据',
            );
          this.db
            .prepare(
              `INSERT INTO cooking_verification_record(
                 id, bug_id, round, result, comment, feedback_id,
                 verified_by_user_id, created_at
               ) VALUES (?, ?, ?, 'PASSED', ?, NULL, ?, ?)`,
            )
            .run(
              this.createId(),
              bugId,
              round,
              input.comment?.trim() || null,
              actorUserId,
              now,
            );
          this.updateBugStage(bugId, 'WAITING_FOR_VERIFICATION', 'DONE', now);
          const revision = this.bumpRevision(source.submission_id, now);
          return {
            result: {
              bugId,
              bugVersion: input.expectedVersion + 1,
              executionId: null,
              cleanupId: null,
              revision,
            },
            resourceId: bugId,
            audits: [
              this.audit(source, 'BUG_VERIFICATION_PASSED', {
                round,
                comment: Boolean(input.comment),
              }),
            ],
          };
        }
        const failure = this.recordFailureAndContinue(
          actorUserId,
          source,
          round,
          input.feedback,
          input.attachmentIds,
          now,
        );
        return {
          result: {
            bugId,
            bugVersion: input.expectedVersion + 1,
            executionId: failure.executionId,
            cleanupId: null,
            revision: failure.revision,
          },
          resourceId: bugId,
          audits: [
            this.audit(source, 'BUG_VERIFICATION_FAILED', {
              round,
              attachmentCount: input.attachmentIds.length,
              executionId: failure.executionId,
            }),
          ],
        };
      },
    });
    if (!replay) {
      const source = this.bugSource(bugId);
      this.onInvalidated(source.submission_id, result.revision);
    }
    return result;
  }

  reopenBug(
    actorUserId: string,
    bugId: string,
    inputValue: ReopenBugInput,
  ): BugLifecycleMutationResult {
    const input = ReopenBugInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'BUG_REOPEN',
      resourceType: 'BUG',
      resultSchema: BugLifecycleMutationResultSchema,
      perform: () => {
        const source = this.requireTester(actorUserId, bugId);
        this.requireBugVersion(source, input.expectedVersion);
        if (source.stage !== 'DONE')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有已完成缺陷可以重开',
          );
        const now = this.now().toISOString();
        const round = this.nextVerificationRound(bugId);
        const failure = this.recordFailureAndContinue(
          actorUserId,
          source,
          round,
          input.feedback,
          input.attachmentIds,
          now,
        );
        return {
          result: {
            bugId,
            bugVersion: input.expectedVersion + 1,
            executionId: failure.executionId,
            cleanupId: null,
            revision: failure.revision,
          },
          resourceId: bugId,
          audits: [
            this.audit(source, 'BUG_REOPENED', {
              round,
              attachmentCount: input.attachmentIds.length,
              executionId: failure.executionId,
            }),
          ],
        };
      },
    });
    if (!replay) {
      const source = this.bugSource(bugId);
      this.onInvalidated(source.submission_id, result.revision);
    }
    return result;
  }

  cancelBug(
    actorUserId: string,
    bugId: string,
    inputValue: LifecycleCommandInput,
  ): BugLifecycleMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'BUG_CANCEL',
      resourceType: 'BUG',
      resultSchema: BugLifecycleMutationResultSchema,
      perform: () => {
        const source = this.requireTester(actorUserId, bugId);
        this.requireBugVersion(source, input.expectedVersion);
        if (
          !['WAITING_FOR_REPAIR', 'WAITING_FOR_UPDATE', 'REPAIRING'].includes(
            source.stage,
          )
        )
          throw new PlatformError('INVALID_TRANSITION', '当前缺陷不能取消');
        if (source.stage === 'REPAIRING' && this.hasActiveRepair(bugId))
          throw new PlatformError(
            'INVALID_TRANSITION',
            '请先停止当前修复执行，再确认取消缺陷',
          );
        const now = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_bug
             SET stage = 'CANCELLED', version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = ?`,
          )
          .run(now, bugId, input.expectedVersion, source.stage);
        if (update.changes !== 1) throw staleLifecycle('缺陷');
        this.hooks.bugCancelled(bugId);
        const revision = this.bumpRevision(source.submission_id, now);
        return {
          result: {
            bugId,
            bugVersion: input.expectedVersion + 1,
            executionId: null,
            cleanupId: null,
            revision,
          },
          resourceId: bugId,
          audits: [this.audit(source, 'BUG_CANCELLED', { cleanupId: null })],
        };
      },
    });
    if (!replay) {
      const source = this.bugSource(bugId);
      this.onInvalidated(source.submission_id, result.revision);
    }
    return result;
  }

  closeSubmission(
    actorUserId: string,
    submissionId: string,
    inputValue: LifecycleCommandInput,
  ): CloseSubmissionMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'SUBMISSION_CLOSE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: CloseSubmissionMutationResultSchema,
      perform: () => {
        const submission = this.requireSubmissionTester(
          actorUserId,
          submissionId,
        );
        if (submission.version !== input.expectedVersion)
          throw staleLifecycle('提测单');
        const nonTerminal = this.db
          .prepare(
            `SELECT COUNT(*) count FROM cooking_bug
             WHERE submission_id = ? AND stage NOT IN ('DONE', 'CANCELLED')`,
          )
          .get(submissionId) as { count: number };
        if (nonTerminal.count > 0)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '仍有未完成缺陷，不能关闭提测单',
          );
        if (this.hasActiveSubmissionExecution(submissionId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '仍有修复或更新执行未结束，不能关闭提测单',
          );
        const unfinishedBatch = this.db
          .prepare(
            `SELECT 1 blocked FROM cooking_update_batch
             WHERE submission_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED')
             LIMIT 1`,
          )
          .get(submissionId);
        if (unfinishedBatch)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '仍有未完成更新批次，不能关闭提测单',
          );
        const now = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_test_submission
             SET status = 'CLOSED', version = version + 1,
                 workspace_revision = workspace_revision + 1,
                 updated_at = ?, closed_at = ?
             WHERE id = ? AND status = 'ACTIVE' AND version = ?
             RETURNING workspace_revision`,
          )
          .get(now, now, submissionId, input.expectedVersion) as
          { workspace_revision: number } | undefined;
        if (!update) throw staleLifecycle('提测单');
        this.db
          .prepare(
            'DELETE FROM cooking_submission_environment_lock WHERE submission_id = ?',
          )
          .run(submissionId);
        const items = this.db
          .prepare(
            `SELECT id FROM cooking_submission_item
             WHERE submission_id = ? ORDER BY position`,
          )
          .all(submissionId) as Array<{ id: string }>;
        const cleanupExecutionIds: string[] = [];
        for (const item of items) {
          const workspaceKeys = this.cleanupScopeForItem(item.id);
          if (!workspaceKeys.length) continue;
          const cleanup = this.createCleanup({
            reason: 'SUBMISSION_CLOSED',
            subjectId: submissionId,
            submissionId,
            submissionItemId: item.id,
            workspaceKeys,
            now,
          });
          cleanupExecutionIds.push(cleanup.executionId);
        }
        return {
          result: {
            submissionId,
            submissionVersion: input.expectedVersion + 1,
            cleanupExecutionIds,
            revision: update.workspace_revision,
          },
          resourceId: submissionId,
          audits: [
            {
              projectId: submission.project_id,
              action: 'SUBMISSION_CLOSED',
              targetType: 'TEST_SUBMISSION',
              targetId: submissionId,
              details: { cleanupCount: cleanupExecutionIds.length },
            },
          ],
        };
      },
    });
    if (!replay) this.onInvalidated(submissionId, result.revision);
    return result;
  }

  retryCleanup(
    actorUserId: string,
    cleanupId: string,
    inputValue: LifecycleCommandInput,
  ): CleanupMutationResult {
    const input = LifecycleCommandInputSchema.parse(inputValue);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'CLEANUP_RETRY',
      resourceType: 'CLEANUP',
      resultSchema: CleanupMutationResultSchema,
      perform: () => {
        const cleanup = this.requireCleanupResponsible(actorUserId, cleanupId);
        if (cleanup.version !== input.expectedVersion)
          throw staleLifecycle('清理任务');
        if (cleanup.state !== 'FAILED')
          throw new PlatformError('INVALID_TRANSITION', '只有失败清理可以重试');
        const latest = this.latestCleanupAttempt(cleanupId);
        if (!latest || !isTerminal(latest.state))
          throw new PlatformError('RESOURCE_CONFLICT', '当前清理执行尚未结束');
        const prompt = buildContinuationCleanupPrompt();
        const attemptId = this.createId();
        const execution = this.executions.enqueue({
          owner: { namespace: 'cooking', kind: 'CLEANUP', id: attemptId },
          attempt: latest.attempt + 1,
          previousExecutionId: latest.execution_id,
          runnerId: cleanup.runner_id,
          bindingId: cleanup.binding_id,
          priority: 0,
          promptKind: prompt.kind,
          promptVersion: prompt.version,
          renderedPrompt: prompt.renderedPrompt,
          renderedPromptHash: prompt.renderedPromptHash,
          outputJsonSchema: prompt.outputJsonSchema,
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
          resumeSessionId: cleanup.session_id,
        });
        const now = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_cleanup_attempt(
               id, cleanup_id, execution_id, attempt, outcome_json,
               created_at, finished_at
             ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
          )
          .run(attemptId, cleanupId, execution.id, latest.attempt + 1, now);
        const update = this.db
          .prepare(
            `UPDATE cooking_cleanup
             SET state = 'READY', active_execution_id = ?,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND state = 'FAILED' AND version = ?`,
          )
          .run(execution.id, now, cleanupId, input.expectedVersion);
        if (update.changes !== 1) throw staleLifecycle('清理任务');
        const revision = this.bumpRevision(cleanup.submission_id, now);
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
    if (!replay) {
      const cleanup = this.cleanupSource(cleanupId);
      this.onInvalidated(cleanup.submission_id, result.revision);
    }
    return result;
  }

  resolveCleanupInteraction(
    actorUserId: string,
    interactionId: string,
    inputValue: ResolveCleanupInteractionInput,
  ): CleanupMutationResult {
    const input = ResolveCleanupInteractionInputSchema.parse(inputValue);
    const source = this.cleanupInteractionSource(interactionId);
    const replay = this.hasRecordedMutation(input.mutationId);
    const result = this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'CLEANUP_INTERACTION_RESOLVE',
      resourceType: 'EXECUTION_INTERACTION',
      resultSchema: CleanupMutationResultSchema,
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
        const update = this.db
          .prepare(
            `UPDATE cooking_cleanup
             SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'RUNNING'
               AND active_execution_id = ?`,
          )
          .run(now, cleanup.id, input.expectedVersion, source.execution_id);
        if (update.changes !== 1) throw staleLifecycle('清理任务');
        const revision = this.bumpRevision(cleanup.submission_id, now);
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
    if (!replay) {
      const cleanup = this.cleanupSource(source.cleanup_id);
      this.onInvalidated(cleanup.submission_id, result.revision);
    }
    return result;
  }

  applyStartedExecution(execution: Execution): void {
    if (!isCleanupExecution(execution)) return;
    const attempt = this.cleanupAttemptForExecution(execution.id);
    if (!attempt) return;
    const cleanup = this.cleanupSource(attempt.cleanup_id);
    if (cleanup.state !== 'READY') return;
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE cooking_cleanup
         SET state = 'RUNNING', version = version + 1, updated_at = ?
         WHERE id = ? AND state = 'READY'`,
      )
      .run(now, cleanup.id);
    this.bumpRevision(cleanup.submission_id, now);
  }

  applyInteractionOpened(executionId: string, interactionId: string): void {
    const attempt = this.cleanupAttemptForExecution(executionId);
    if (!attempt) return;
    const cleanup = this.cleanupSource(attempt.cleanup_id);
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO cooking_audit_event(
           id, project_id, actor_user_id, action, target_type, target_id,
           details_json, created_at
         ) VALUES (?, ?, ?, 'CLEANUP_INTERACTION_OPENED',
                   'EXECUTION_INTERACTION', ?, ?, ?)`,
      )
      .run(
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
      );
    this.bumpRevision(cleanup.submission_id, now);
  }

  applyTerminalExecution(execution: Execution): void {
    if (!isCleanupExecution(execution)) return;
    const attempt = this.cleanupAttemptForExecution(execution.id);
    if (!attempt || attempt.outcome_json) return;
    const cleanup = this.cleanupSource(attempt.cleanup_id);
    const now = this.now().toISOString();
    const interpreted = interpretCleanup(execution);
    this.db
      .prepare(
        `UPDATE cooking_cleanup
         SET state = ?, active_execution_id = NULL,
             session_id = COALESCE(?, session_id),
             version = version + 1, updated_at = ?
         WHERE id = ? AND state IN ('READY', 'RUNNING')`,
      )
      .run(
        interpreted.kind === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
        execution.sessionId,
        now,
        cleanup.id,
      );
    this.db
      .prepare(
        `UPDATE cooking_cleanup_attempt
         SET outcome_json = ?, finished_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(interpreted.outcome), now, attempt.id);
    this.bumpRevision(cleanup.submission_id, now);
  }

  afterStartedExecution(execution: Execution): void {
    if (isCleanupExecution(execution)) this.publishExecution(execution.id);
  }

  afterInteractionOpened(executionId: string): void {
    this.publishExecution(executionId);
  }

  afterTerminalExecution(execution: Execution): void {
    if (isCleanupExecution(execution)) this.publishExecution(execution.id);
  }

  workspace(
    userId: string,
    submissionId: string,
  ): LifecycleWorkspaceProjection {
    this.requireSubmissionAccess(userId, submissionId);
    const bugIds = (
      this.db
        .prepare('SELECT id FROM cooking_bug WHERE submission_id = ?')
        .all(submissionId) as Array<{ id: string }>
    ).map(({ id }) => id);
    const verificationsByBug = Object.fromEntries(
      bugIds.map((bugId) => [bugId, this.verificationViews(bugId)]),
    );
    const cleanupIds = (
      this.db
        .prepare(
          `SELECT id FROM cooking_cleanup
           WHERE submission_id = ? ORDER BY created_at, id`,
        )
        .all(submissionId) as Array<{ id: string }>
    ).map(({ id }) => id);
    return LifecycleWorkspaceProjectionSchema.parse({
      verificationsByBug,
      cleanups: cleanupIds.map((id) => this.cleanupView(userId, id)),
      cleanupInteractions: this.cleanupInteractions(userId, submissionId),
      timeline: this.timeline(submissionId),
    });
  }

  cleanupInteractions(
    userId: string,
    submissionId: string,
  ): CleanupInteractionView[] {
    this.requireSubmissionAccess(userId, submissionId);
    const rows = this.db
      .prepare(
        `SELECT interaction.*, cleanup.id cleanup_id,
                cleanup.submission_item_id, item.responsible_user_id
         FROM platform_execution_interaction interaction
         JOIN cooking_cleanup_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         JOIN cooking_cleanup cleanup ON cleanup.id = attempt.cleanup_id
         JOIN cooking_submission_item item
           ON item.id = cleanup.submission_item_id
         WHERE cleanup.submission_id = ? AND interaction.state = 'PENDING'
         ORDER BY interaction.created_at, interaction.id`,
      )
      .all(submissionId) as Array<{
      id: string;
      execution_id: string;
      cleanup_id: string;
      submission_item_id: string;
      responsible_user_id: string;
      kind: 'APPROVAL' | 'USER_INPUT';
      state: 'PENDING';
      method: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => {
      const responsible = row.responsible_user_id === userId;
      return CleanupInteractionViewSchema.parse({
        id: row.id,
        executionId: row.execution_id,
        cleanupId: row.cleanup_id,
        submissionItemId: row.submission_item_id,
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

  private recordFailureAndContinue(
    actorUserId: string,
    source: BugSourceRow,
    round: number,
    feedback: string,
    attachmentIds: string[],
    now: string,
  ): { executionId: string; revision: number } {
    this.requireBindableFiles(actorUserId, attachmentIds);
    const feedbackId = this.createId();
    this.db
      .prepare(
        `INSERT INTO cooking_bug_feedback(
           id, bug_id, kind, author_user_id, content, created_at
         ) VALUES (?, ?, 'TESTER_FEEDBACK', ?, ?, ?)`,
      )
      .run(feedbackId, source.id, actorUserId, feedback.trim(), now);
    attachmentIds.forEach((fileId, position) =>
      this.db
        .prepare(
          `INSERT INTO cooking_bug_attachment(
             file_id, bug_id, feedback_id, position, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(fileId, source.id, feedbackId, position, now),
    );
    this.db
      .prepare(
        `INSERT INTO cooking_verification_record(
           id, bug_id, round, result, comment, feedback_id,
           verified_by_user_id, created_at
         ) VALUES (?, ?, ?, 'FAILED', ?, ?, ?, ?)`,
      )
      .run(
        this.createId(),
        source.id,
        round,
        feedback.trim(),
        feedbackId,
        actorUserId,
        now,
      );
    const update = this.db
      .prepare(
        `UPDATE cooking_bug
         SET stage = 'REPAIRING', version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND stage IN ('WAITING_FOR_VERIFICATION', 'DONE')`,
      )
      .run(now, source.id, source.version);
    if (update.changes !== 1) throw staleLifecycle('缺陷');
    const executionId = this.repairs.createContinuationExecution(
      source.id,
      `测试负责人第 ${round} 轮验证失败：${feedback.trim()}`,
      attachmentIds,
    );
    return {
      executionId,
      revision: this.bumpRevision(source.submission_id, now),
    };
  }

  private createCleanup(input: {
    reason: 'BUG_CANCELLED' | 'SUBMISSION_CLOSED';
    subjectId: string;
    submissionId: string;
    submissionItemId: string;
    workspaceKeys: string[];
    now: string;
  }): { cleanupId: string; executionId: string } {
    const source = this.itemCleanupSource(input.submissionItemId);
    const cleanupId = this.createId();
    const attemptId = this.createId();
    const prompt = buildInitialCleanupPrompt({
      reason: input.reason,
      submissionTitle: source.submission_title,
      engineeringName: source.engineering_name,
      targetBranch: source.target_branch,
      workspaceKeys: [...new Set(input.workspaceKeys)],
    });
    this.db
      .prepare(
        `INSERT INTO cooking_cleanup(
           id, submission_id, submission_item_id, reason, subject_id,
           state, version, active_execution_id, session_id, scope_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'READY', 1, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        cleanupId,
        input.submissionId,
        input.submissionItemId,
        input.reason,
        input.subjectId,
        JSON.stringify([...new Set(input.workspaceKeys)]),
        input.now,
        input.now,
      );
    const execution = this.executions.enqueue({
      owner: { namespace: 'cooking', kind: 'CLEANUP', id: attemptId },
      attempt: 1,
      previousExecutionId: null,
      runnerId: source.runner_id,
      bindingId: source.binding_id,
      priority: 0,
      promptKind: prompt.kind,
      promptVersion: prompt.version,
      renderedPrompt: prompt.renderedPrompt,
      renderedPromptHash: prompt.renderedPromptHash,
      outputJsonSchema: prompt.outputJsonSchema,
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
      resumeSessionId: null,
    });
    this.db
      .prepare(
        `INSERT INTO cooking_cleanup_attempt(
           id, cleanup_id, execution_id, attempt, outcome_json,
           created_at, finished_at
         ) VALUES (?, ?, ?, 1, NULL, ?, NULL)`,
      )
      .run(attemptId, cleanupId, execution.id, input.now);
    this.db
      .prepare(
        'UPDATE cooking_cleanup SET active_execution_id = ? WHERE id = ?',
      )
      .run(execution.id, cleanupId);
    return { cleanupId, executionId: execution.id };
  }

  private cleanupScopeForItem(submissionItemId: string): string[] {
    const repairs = this.db
      .prepare(
        `SELECT context.workspace_key key
         FROM cooking_bug bug
         JOIN cooking_bug_repair_context context ON context.bug_id = bug.id
         WHERE bug.submission_item_id = ?`,
      )
      .all(submissionItemId) as Array<{ key: string }>;
    const updates = this.db
      .prepare(
        `SELECT 'update-batch:' || id key FROM cooking_update_batch
         WHERE submission_item_id = ?`,
      )
      .all(submissionItemId) as Array<{ key: string }>;
    return [...new Set([...repairs, ...updates].map(({ key }) => key))];
  }

  private verificationViews(bugId: string) {
    const records = this.db
      .prepare(
        `SELECT id, round, result, comment, feedback_id, created_at
         FROM cooking_verification_record
         WHERE bug_id = ? ORDER BY round`,
      )
      .all(bugId) as Array<{
      id: string;
      round: number;
      result: 'PASSED' | 'FAILED';
      comment: string | null;
      feedback_id: string | null;
      created_at: string;
    }>;
    return records.map((record) => ({
      id: record.id,
      bugId,
      round: record.round,
      result: record.result,
      comment: record.comment,
      attachments: record.feedback_id
        ? this.feedbackAttachments(record.feedback_id)
        : [],
      createdAt: record.created_at,
    }));
  }

  private feedbackAttachments(feedbackId: string) {
    return (
      this.db
        .prepare(
          `SELECT file.id, file.original_name, file.media_type,
                  file.size_bytes, file.created_at
           FROM cooking_bug_attachment attachment
           JOIN platform_file file ON file.id = attachment.file_id
           WHERE attachment.feedback_id = ? ORDER BY attachment.position`,
        )
        .all(feedbackId) as Array<{
        id: string;
        original_name: string;
        media_type: string;
        size_bytes: number;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      originalName: row.original_name,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    }));
  }

  private cleanupView(userId: string, cleanupId: string) {
    const cleanup = this.cleanupSource(cleanupId);
    const technical = cleanup.responsible_user_id === userId;
    return {
      id: cleanup.id,
      submissionId: cleanup.submission_id,
      submissionItemId: cleanup.submission_item_id,
      reason: cleanup.reason,
      subjectId: cleanup.subject_id,
      state: cleanup.state,
      version: cleanup.version,
      attempts: technical
        ? this.cleanupAttempts(cleanupId).map((attempt) => {
            const outcome = attempt.outcome_json
              ? (JSON.parse(attempt.outcome_json) as {
                  outcome?: string;
                  summary?: string;
                  technicalFailure?: string;
                })
              : null;
            return {
              id: attempt.id,
              attempt: attempt.attempt,
              executionState: attempt.state,
              summary: outcome?.summary ?? null,
              technicalFailure: outcome?.technicalFailure ?? null,
              createdAt: attempt.created_at,
              finishedAt: attempt.finished_at,
            };
          })
        : [],
      availableActions:
        technical && cleanup.state === 'FAILED' ? ['RETRY_CLEANUP'] : [],
      presentation: { statusLabel: cleanupStateLabel(cleanup.state) },
      createdAt: cleanup.created_at,
    };
  }

  private timeline(submissionId: string) {
    const entries: Array<{
      id: string;
      kind:
        | 'VERIFICATION'
        | 'FEEDBACK'
        | 'REPAIR'
        | 'UPDATE'
        | 'EXTERNAL_DEPLOYMENT'
        | 'CLEANUP'
        | 'SUBMISSION';
      bugId: string | null;
      title: string;
      summary: string;
      createdAt: string;
    }> = [];
    const verifications = this.db
      .prepare(
        `SELECT verification.id, verification.bug_id, verification.round,
                verification.result, verification.comment,
                verification.created_at, bug.short_id
         FROM cooking_verification_record verification
         JOIN cooking_bug bug ON bug.id = verification.bug_id
         WHERE bug.submission_id = ?`,
      )
      .all(submissionId) as Array<{
      id: string;
      bug_id: string;
      round: number;
      result: 'PASSED' | 'FAILED';
      comment: string | null;
      created_at: string;
      short_id: number;
    }>;
    for (const row of verifications)
      entries.push({
        id: `verification:${row.id}`,
        kind: 'VERIFICATION',
        bugId: row.bug_id,
        title: `缺陷-${String(row.short_id).padStart(3, '0')} 第 ${row.round} 轮验证`,
        summary:
          row.result === 'PASSED'
            ? row.comment || '测试负责人已确认验证通过。'
            : row.comment || '验证失败，已自动继续修复。',
        createdAt: row.created_at,
      });
    const reports = this.db
      .prepare(
        `SELECT report.id, report.round, report.outcome, report.created_at,
                batch.id batch_id
         FROM cooking_external_deployment_report report
         JOIN cooking_update_batch batch ON batch.id = report.batch_id
         WHERE batch.submission_id = ?`,
      )
      .all(submissionId) as Array<{
      id: string;
      round: number;
      outcome: 'SUCCEEDED' | 'FAILED';
      created_at: string;
      batch_id: string;
    }>;
    for (const row of reports)
      entries.push({
        id: `external:${row.id}`,
        kind: 'EXTERNAL_DEPLOYMENT',
        bugId: null,
        title: `第 ${row.round} 轮外部部署结果`,
        summary:
          row.outcome === 'SUCCEEDED'
            ? '工程负责人已确认外部部署成功。'
            : '外部部署失败，等待工程负责人继续原批次。',
        createdAt: row.created_at,
      });
    const cleanups = this.db
      .prepare(
        `SELECT id, reason, state, created_at FROM cooking_cleanup
         WHERE submission_id = ?`,
      )
      .all(submissionId) as Array<{
      id: string;
      reason: 'BUG_CANCELLED' | 'SUBMISSION_CLOSED';
      state: 'READY' | 'RUNNING' | 'FAILED' | 'COMPLETED';
      created_at: string;
    }>;
    for (const row of cleanups)
      entries.push({
        id: `cleanup:${row.id}`,
        kind: 'CLEANUP',
        bugId: null,
        title:
          row.reason === 'SUBMISSION_CLOSED'
            ? '关闭后资源清理'
            : '取消后资源清理',
        summary: cleanupStateLabel(row.state),
        createdAt: row.created_at,
      });
    const submission = this.db
      .prepare(
        `SELECT status, closed_at FROM cooking_test_submission WHERE id = ?`,
      )
      .get(submissionId) as {
      status: 'ACTIVE' | 'CLOSED';
      closed_at: string | null;
    };
    if (submission.status === 'CLOSED' && submission.closed_at)
      entries.push({
        id: `submission:${submissionId}:closed`,
        kind: 'SUBMISSION',
        bugId: null,
        title: '提测单已关闭',
        summary: '全部缺陷已终结，测试环境占用已释放。',
        createdAt: submission.closed_at,
      });
    return entries.sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }

  private requireTester(userId: string, bugId: string): BugSourceRow {
    const source = this.bugSource(bugId);
    this.requireSubmissionAccess(userId, source.submission_id);
    if (source.submission_status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能修改');
    if (source.tester_user_id !== userId)
      throw new PlatformError('PERMISSION_DENIED', '只有测试负责人可以操作');
    return source;
  }

  private requireSubmissionTester(userId: string, submissionId: string) {
    const row = this.db
      .prepare(
        `SELECT project_id, tester_user_id, status, version
         FROM cooking_test_submission WHERE id = ?`,
      )
      .get(submissionId) as
      | {
          project_id: string;
          tester_user_id: string;
          status: 'ACTIVE' | 'CLOSED';
          version: number;
        }
      | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '提测单不存在');
    this.requireSubmissionAccess(userId, submissionId);
    if (row.status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '提测单已经关闭');
    if (row.tester_user_id !== userId)
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有测试负责人可以关闭提测单',
      );
    return row;
  }

  private requireBugVersion(
    source: BugSourceRow,
    expectedVersion: number,
  ): void {
    if (source.version !== expectedVersion) throw staleLifecycle('缺陷');
  }

  private bugSource(bugId: string): BugSourceRow {
    const row = this.db
      .prepare(
        `SELECT bug.id, bug.submission_id, bug.submission_item_id, bug.stage,
                bug.version, bug.short_id, bug.title, submission.project_id,
                submission.status submission_status,
                submission.title submission_title,
                submission.tester_user_id, item.responsible_user_id,
                item.binding_id, binding.runner_id, item.engineering_name,
                item.target_branch
         FROM cooking_bug bug
         JOIN cooking_test_submission submission ON submission.id = bug.submission_id
         LEFT JOIN cooking_submission_item item ON item.id = bug.submission_item_id
         LEFT JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         WHERE bug.id = ?`,
      )
      .get(bugId) as BugSourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '缺陷不存在');
    return row;
  }

  private updateBugStage(
    bugId: string,
    from: string,
    to: string,
    now: string,
  ): void {
    const update = this.db
      .prepare(
        `UPDATE cooking_bug
         SET stage = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND stage = ?`,
      )
      .run(to, now, bugId, from);
    if (update.changes !== 1) throw staleLifecycle('缺陷');
  }

  private nextVerificationRound(bugId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(round), 0) + 1 round
           FROM cooking_verification_record WHERE bug_id = ?`,
        )
        .get(bugId) as { round: number }
    ).round;
  }

  private requireBindableFiles(userId: string, fileIds: string[]): void {
    for (const fileId of fileIds) {
      const row = this.db
        .prepare(
          `SELECT file.uploaded_by_user_id,
                  bug_attachment.file_id bug_file_id,
                  report_attachment.file_id report_file_id
           FROM platform_file file
           LEFT JOIN cooking_bug_attachment bug_attachment
             ON bug_attachment.file_id = file.id
           LEFT JOIN cooking_external_deployment_report_attachment report_attachment
             ON report_attachment.file_id = file.id
           WHERE file.id = ?`,
        )
        .get(fileId) as
        | {
            uploaded_by_user_id: string;
            bug_file_id: string | null;
            report_file_id: string | null;
          }
        | undefined;
      if (
        !row ||
        row.uploaded_by_user_id !== userId ||
        row.bug_file_id ||
        row.report_file_id
      )
        throw new PlatformError(
          'VALIDATION_FAILED',
          '附件不存在、已被使用或不属于当前用户',
        );
    }
  }

  private hasActiveRepair(bugId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT execution.state
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.bug_id = ? ORDER BY attempt.attempt DESC LIMIT 1`,
      )
      .get(bugId) as { state: Execution['state'] } | undefined;
    return Boolean(row && !isTerminal(row.state));
  }

  private hasActiveSubmissionExecution(submissionId: string): boolean {
    const row = this.db
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
    return Boolean(row);
  }

  private itemCleanupSource(submissionItemId: string) {
    const row = this.db
      .prepare(
        `SELECT item.binding_id, binding.runner_id, item.engineering_name,
                item.target_branch, submission.title submission_title
         FROM cooking_submission_item item
         JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         JOIN cooking_test_submission submission ON submission.id = item.submission_id
         WHERE item.id = ?`,
      )
      .get(submissionItemId) as
      | {
          binding_id: string;
          runner_id: string;
          engineering_name: string;
          target_branch: string;
          submission_title: string;
        }
      | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Submission Item 不存在');
    return row;
  }

  private cleanupSource(cleanupId: string): CleanupSourceRow {
    const row = this.db
      .prepare(
        `SELECT cleanup.*, item.responsible_user_id, item.binding_id,
                binding.runner_id, item.engineering_name, item.target_branch,
                submission.title submission_title, submission.project_id
         FROM cooking_cleanup cleanup
         JOIN cooking_submission_item item ON item.id = cleanup.submission_item_id
         JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         JOIN cooking_test_submission submission ON submission.id = cleanup.submission_id
         WHERE cleanup.id = ?`,
      )
      .get(cleanupId) as CleanupSourceRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '清理任务不存在');
    return row;
  }

  private requireCleanupResponsible(
    userId: string,
    cleanupId: string,
  ): CleanupSourceRow {
    const cleanup = this.cleanupSource(cleanupId);
    this.requireSubmissionAccess(userId, cleanup.submission_id);
    if (cleanup.responsible_user_id !== userId)
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有对应工程负责人可以处理清理',
      );
    return cleanup;
  }

  private cleanupAttempts(cleanupId: string): CleanupAttemptRow[] {
    return this.db
      .prepare(
        `SELECT attempt.*, execution.state, execution.session_id
         FROM cooking_cleanup_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.cleanup_id = ? ORDER BY attempt.attempt`,
      )
      .all(cleanupId) as CleanupAttemptRow[];
  }

  private latestCleanupAttempt(
    cleanupId: string,
  ): CleanupAttemptRow | undefined {
    return this.cleanupAttempts(cleanupId).at(-1);
  }

  private cleanupInteractionSource(interactionId: string): {
    cleanup_id: string;
    execution_id: string;
  } {
    const row = this.db
      .prepare(
        `SELECT attempt.cleanup_id, interaction.execution_id
         FROM platform_execution_interaction interaction
         JOIN cooking_cleanup_attempt attempt
           ON attempt.execution_id = interaction.execution_id
         WHERE interaction.id = ?`,
      )
      .get(interactionId) as
      { cleanup_id: string; execution_id: string } | undefined;
    if (!row)
      throw new PlatformError('NOT_FOUND', 'Cleanup Interaction 不存在');
    return row;
  }

  private cleanupAttemptForExecution(
    executionId: string,
  ): CleanupAttemptRow | undefined {
    return this.db
      .prepare(
        `SELECT attempt.*, execution.state, execution.session_id
         FROM cooking_cleanup_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.execution_id = ?`,
      )
      .get(executionId) as CleanupAttemptRow | undefined;
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
      .get(submissionId, userId);
    if (!row) throw new PlatformError('NOT_FOUND', '提测单不存在');
  }

  private audit(source: BugSourceRow, action: string, details: unknown) {
    return {
      projectId: source.project_id,
      action,
      targetType: 'BUG',
      targetId: source.id,
      details,
    };
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
    if (row) this.onInvalidated(row.submission_id, row.workspace_revision);
  }

  private hasRecordedMutation(mutationId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM cooking_mutation WHERE id = ?')
        .get(mutationId),
    );
  }

  private bumpRevision(submissionId: string, now: string): number {
    return (
      this.db
        .prepare(
          `UPDATE cooking_test_submission
           SET workspace_revision = workspace_revision + 1, updated_at = ?
           WHERE id = ? RETURNING workspace_revision revision`,
        )
        .get(now, submissionId) as { revision: number }
    ).revision;
  }
}

function isCleanupExecution(execution: Execution): boolean {
  return (
    execution.owner.namespace === 'cooking' &&
    execution.owner.kind === 'CLEANUP'
  );
}

function isTerminal(state: Execution['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

function parseWorkspaceKeys(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== 'string' || !item.trim())
  )
    throw new PlatformError(
      'INVALID_TRANSITION',
      '清理任务缺少有效的逻辑工作区范围',
    );
  return [...new Set(parsed)];
}

function interpretCleanup(execution: Execution): {
  kind: 'COMPLETED' | 'FAILED';
  outcome: unknown;
} {
  if (execution.outcome?.kind === 'SUCCEEDED') {
    const parsed = CleanupExecutionResultSchema.safeParse(
      execution.outcome.result,
    );
    if (parsed.success)
      return {
        kind: parsed.data.outcome,
        outcome: parsed.data,
      };
    return {
      kind: 'FAILED',
      outcome: {
        outcome: 'FAILED',
        summary: '清理结果格式无效',
        technicalFailure: 'RESULT_SCHEMA_INVALID',
      },
    };
  }
  return {
    kind: 'FAILED',
    outcome: {
      outcome: 'FAILED',
      summary:
        execution.outcome?.kind === 'CANCELLED'
          ? '清理执行已停止，可由工程负责人重试。'
          : '清理执行未完成，可由工程负责人重试。',
      technicalFailure:
        execution.outcome?.kind === 'FAILED'
          ? execution.outcome.failure.code
          : execution.outcome?.kind,
    },
  };
}

function cleanupStateLabel(state: CleanupSourceRow['state']): string {
  return {
    READY: '等待 Agent 清理',
    RUNNING: '正在清理本机临时资源',
    FAILED: '资源清理未完成，不影响业务终态',
    COMPLETED: '本机临时资源已清理',
  }[state];
}

function staleLifecycle(target: string): PlatformError {
  return new PlatformError('STALE_STATE', `${target}已变化，请刷新后重试`);
}
