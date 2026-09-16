import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import {
  projectCookingInteraction,
  type CookingInteractionRow,
} from '@/cooking/shared/server/interaction-projection';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ExecutionService } from '@/platform/execution/service';
import {
  BugRepairViewSchema,
  RepairWorkspaceProjectionSchema,
  type BugRepairView,
  type RepairWorkspaceProjection,
} from '../contract';
import type { AttemptRow, ContextRow, RepairSourceRow } from './records';
import {
  isFailedAttemptOutcome,
  parseCommits,
  projectAttemptResult,
  repairStateLabel,
  repairVisual,
} from './results';
export class RepairQueries {
  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService,
  ) {}
  workspace(userId: string, submissionId: string): RepairWorkspaceProjection {
    requireSubmissionAccess(this.db, userId, submissionId);
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

  repairView(userId: string, bugId: string): BugRepairView | null {
    const source = this.source(bugId);
    requireSubmissionAccess(this.db, userId, source.submission_id);
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
      synchronizationCorrection: technical
        ? this.sessionSynchronizationCorrection(bugId)
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

  interactionsForBug(
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

  source(bugId: string): RepairSourceRow {
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

  context(bugId: string): ContextRow | undefined {
    return this.db
      .prepare('SELECT * FROM cooking_bug_repair_context WHERE bug_id = ?')
      .get(bugId) as ContextRow | undefined;
  }

  requireContext(bugId: string): ContextRow {
    const row = this.context(bugId);
    if (!row) throw new PlatformError('NOT_FOUND', '修复上下文不存在');
    return row;
  }

  latestAttempt(bugId: string): AttemptRow | undefined {
    return this.attempts(bugId).at(-1);
  }

  hasActiveSessionSync(bugId: string): boolean {
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

  sessionSynchronizationError(bugId: string): string | null {
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

  sessionSynchronizationCorrection(bugId: string): {
    instruction: string;
    schema: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT execution.outcome_json, previous.codex_turn_json
         FROM cooking_repair_session_sync sync
         JOIN platform_execution execution ON execution.id = sync.execution_id
         LEFT JOIN platform_execution previous
           ON previous.id = execution.previous_execution_id
         WHERE sync.bug_id = ? AND execution.state = 'FAILED'
         ORDER BY sync.created_at DESC LIMIT 1`,
      )
      .get(bugId) as
      | {
          outcome_json: string | null;
          codex_turn_json: string | null;
        }
      | undefined;
    const failure = row?.outcome_json
      ? (JSON.parse(row.outcome_json) as { failure?: { message?: unknown } })
      : null;
    const message = failure?.failure?.message;
    if (typeof message !== 'string') return null;
    const turn = row?.codex_turn_json
      ? (JSON.parse(row.codex_turn_json) as {
          outputJsonSchema?: unknown;
        })
      : null;
    const schema =
      turn?.outputJsonSchema && typeof turn.outputJsonSchema === 'object'
        ? JSON.stringify(turn.outputJsonSchema, null, 2)
        : null;
    if (
      schema &&
      /未返回结果|未返回可识别的结果|不符合原任务结果约束/u.test(message)
    )
      return {
        instruction:
          '回到原 Codex 会话，完成实际修复与验证后，依据下方结果约束据实输出本次终态结果，再点击“同步状态”。',
        schema,
      };
    if (/Commit|工作区|关联|执行前基线/u.test(message))
      return {
        instruction:
          '回到原 Codex 会话，核对实际修复、提交和验证证据；不要编造提交或结果。完成后再次点击“同步状态”。',
        schema: null,
      };
    return null;
  }

  attemptForExecution(executionId: string): AttemptRow | undefined {
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

  attempts(bugId: string): AttemptRow[] {
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

  bugRegisteredAt(bugId: string): string {
    const row = this.db
      .prepare('SELECT created_at FROM cooking_bug WHERE id = ?')
      .get(bugId) as { created_at: string } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '修复缺陷不存在');
    return row.created_at;
  }

  interactionSource(interactionId: string): {
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
}
