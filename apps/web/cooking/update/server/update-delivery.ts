import { DeploymentMethodSchema } from '@/cooking/engineering/contract';
import {
  isTerminal,
  requireTaskSkillBinding,
} from '@/cooking/shared/server/execution-state';
import { environmentOwned } from '@/cooking/submissions/server/environment-access';
import type { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  createContinuationCodexTurn,
  createInitialCodexTurn,
} from '@/platform/execution/codex-turn';
import type { ExecutionService } from '@/platform/execution/service';
import {
  buildInitialUpdateBrief,
  buildUpdateExternalFailureInput,
  buildUpdateRetryInput,
} from '../brief';
import {
  CiCdUpdateOutputJsonSchema,
  LocalScriptUpdateOutputJsonSchema,
} from '../contract';
import type { BatchRow, FrozenBatch, ItemSourceRow } from './records';
import { parseCommits } from '@/cooking/shared/server/result-data';
import type { UpdateQueries } from './update-queries';
import { staleBatch } from './results';
import { freezeRepairHandoffs } from './repair-handoffs';
import { UPDATE_HANDOFF_TEXT_ASSERTION } from '@/cooking/repair/handoff';

const QUIET_WINDOW_MS = 2 * 60 * 1_000;

export class UpdateDelivery {
  constructor(
    private readonly db: AppDatabase,
    private readonly executions: ExecutionService,
    private readonly queries: UpdateQueries,
    private readonly writes: TestSubmissionWriteStore,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {}

  retryFailedBatch(
    batch: BatchRow & { source: ItemSourceRow },
    expectedVersion: number,
  ): { executionId: string; revision: number } {
    const batchId = batch.id;
    const latest = this.queries.latestAttempt(batchId);
    if (!latest || !isTerminal(latest.state))
      throw new PlatformError('RESOURCE_CONFLICT', '当前更新执行尚未结束');
    const source = batch.source;
    const deployment = DeploymentMethodSchema.parse(JSON.parse(batch.deployment_json));
    const externalReport =
      deployment.kind === 'CI_CD'
        ? this.queries.latestUnconsumedFailedReport(batchId)
        : undefined;
    const attachmentIds = externalReport
      ? this.queries.externalReportAttachmentIds(externalReport.id)
      : [];
    if (!batch.session_id)
      throw new PlatformError('INVALID_TRANSITION', '原更新任务不存在，不能自动重建');
    const previousExecution = this.executions.get(latest.execution_id);
    const continuationInput = externalReport
      ? buildUpdateExternalFailureInput({
          reportRound: externalReport.round,
          summary: externalReport.summary!,
          attachments: this.queries
            .externalReportAttachments(externalReport.id)
            .map(({ id, original_name }) => ({
              fileId: id,
              originalName: original_name,
            })),
        })
      : buildUpdateRetryInput();
    const attemptId = this.createId();
    const execution = this.executions.enqueue({
      owner: { namespace: 'cooking', kind: 'UPDATE_BATCH', id: attemptId },
      attempt: latest.attempt + 1,
      previousExecutionId: latest.execution_id,
      runnerId: source.runner_id,
      bindingId: source.binding_id,
      priority: 0,
      approvalPolicy: 'never',
      codexTurn: createContinuationCodexTurn({
        manualHandoff: 'EXTERNAL_SESSION',
        taskId: batch.session_id,
        taskSkillBinding: requireTaskSkillBinding(previousExecution, '更新'),
        text: continuationInput,
        resultAssertions: [UPDATE_HANDOFF_TEXT_ASSERTION],
        outputJsonSchema:
          deployment.kind === 'LOCAL_SCRIPT'
            ? LocalScriptUpdateOutputJsonSchema
            : CiCdUpdateOutputJsonSchema,
      }),
      workspace: {
        key: `update-batch:${batchId}`,
        isolation: 'DETACHED_WORKTREE',
        baseRef: `origin/${source.target_branch}`,
      },
      attachmentIds,
    });
    const now = this.now().toISOString();
    this.db.run(
      `INSERT INTO cooking_update_attempt(
           id, batch_id, execution_id, continuation_report_id, attempt,
           outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
      [
        attemptId,
        batchId,
        execution.id,
        externalReport?.id ?? null,
        latest.attempt + 1,
        now,
      ],
    );
    const update = this.db.run(
      `UPDATE cooking_update_batch
         SET state = 'READY', active_execution_id = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND state = 'FAILED'`,
      [execution.id, now, batchId, expectedVersion],
    );
    if (update.changes !== 1) throw staleBatch();
    const revision = this.writes.bumpRevision(batch.submission_id, now);
    return { executionId: execution.id, revision };
  }

  recordCandidateAvailable(bugId: string, candidateAt: string): void {
    const row = this.db.get(
      `SELECT submission_item_id FROM cooking_bug
         WHERE id = ? AND stage = 'WAITING_FOR_UPDATE'`,
      bugId,
    ) as { submission_item_id: string | null } | undefined;
    if (!row?.submission_item_id) return;
    this.recordPendingDelivery(row.submission_item_id, candidateAt);
  }

  recalculatePendingDeliveryForBug(bugId: string): void {
    const row = this.db.get(
      'SELECT submission_item_id FROM cooking_bug WHERE id = ?',
      bugId,
    ) as { submission_item_id: string | null } | undefined;
    if (!row?.submission_item_id) return;
    this.recalculatePendingDelivery(row.submission_item_id);
  }

  prepareDueExecutions(nowValue: Date = this.now()): string[] {
    const now = nowValue.toISOString();
    const due = this.db.all<{ submission_item_id: string }>(
      `SELECT pending.submission_item_id
         FROM cooking_pending_delivery pending
         JOIN cooking_submission_item item
           ON item.id = pending.submission_item_id
         JOIN cooking_test_submission submission
           ON submission.id = item.submission_id
         WHERE pending.eligible_at <= ?
           AND submission.status = 'ACTIVE'
         ORDER BY pending.eligible_at, pending.submission_item_id`,
      now,
    );
    const prepared: Array<FrozenBatch & { submissionId: string }> = [];
    for (const { submission_item_id } of due) {
      const frozen = this.db.transaction(() =>
        this.freezeItem(submission_item_id, now, true),
      )();
      if (frozen)
        prepared.push({
          ...frozen,
          submissionId: this.queries.itemSource(submission_item_id).submission_id,
        });
    }
    for (const item of prepared)
      this.writes.publishInvalidation(item.submissionId, item.revision);
    return prepared.map(({ executionId }) => executionId);
  }

  freezeItem(
    submissionItemId: string,
    now: string,
    requireDue: boolean,
  ): FrozenBatch | undefined {
    const source = this.queries.itemSource(submissionItemId);
    if (
      source.submission_status !== 'ACTIVE' ||
      !environmentOwned(this.db, submissionItemId)
    )
      return undefined;
    const pending = this.db.get(
      `SELECT last_candidate_at, eligible_at
         FROM cooking_pending_delivery WHERE submission_item_id = ?`,
      submissionItemId,
    ) as { last_candidate_at: string; eligible_at: string } | undefined;
    if (!pending || (requireDue && pending.eligible_at > now)) return undefined;
    if (this.queries.activeBatch(submissionItemId)) return undefined;
    const available = this.queries.candidates(submissionItemId);
    if (!available.length) {
      this.db.run('DELETE FROM cooking_pending_delivery WHERE submission_item_id = ?', [
        submissionItemId,
      ]);
      return undefined;
    }
    const deployment = DeploymentMethodSchema.parse(
      JSON.parse(available[0]!.deployment_json),
    );
    const deploymentJson = JSON.stringify(deployment);
    const candidates = available.filter(
      (candidate) =>
        JSON.stringify(
          DeploymentMethodSchema.parse(JSON.parse(candidate.deployment_json)),
        ) === deploymentJson,
    );
    const batchId = this.createId();
    const attemptId = this.createId();
    const executionId = this.createId();
    const workspaceKey = `update-batch:${batchId}`;
    const entries = candidates.map((candidate) => {
      const commits = parseCommits(candidate.pending_commits_json);
      return {
        bugTitle: candidate.title,
        commits,
        repairHandoffs: freezeRepairHandoffs(this.db, candidate.bug_id, commits),
      };
    });
    const executionBrief = buildInitialUpdateBrief({
      targetBranch: source.target_branch,
      environmentName: source.environment_name,
      entries,
      deployment:
        deployment.kind === 'LOCAL_SCRIPT'
          ? { mode: 'LOCAL_SCRIPT', command: deployment.command }
          : { mode: 'CI_CD' },
    });
    this.db.run(
      `INSERT INTO cooking_update_batch(
           id, submission_id, submission_item_id, state, version,
           active_execution_id, session_id, deployment_json, frozen_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'READY', 1, NULL, NULL, ?, ?, ?, ?)`,
      [batchId, source.submission_id, submissionItemId, deploymentJson, now, now, now],
    );
    const insertEntry = this.db.prepare(
      `INSERT INTO cooking_update_batch_entry(
         batch_id, bug_id, position, commits_json, manual_operations_json, handoffs_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    candidates.forEach((candidate, position) =>
      insertEntry.run(
        batchId,
        candidate.bug_id,
        position,
        candidate.pending_commits_json,
        candidate.pending_manual_operations_json,
        JSON.stringify(entries[position]!.repairHandoffs),
      ),
    );
    const execution = this.executions.enqueue({
      id: executionId,
      owner: { namespace: 'cooking', kind: 'UPDATE_BATCH', id: attemptId },
      attempt: 1,
      previousExecutionId: null,
      runnerId: source.runner_id,
      bindingId: source.binding_id,
      priority: 0,
      approvalPolicy: 'never',
      codexTurn: createInitialCodexTurn({
        manualHandoff: 'EXTERNAL_SESSION',
        requiredSkillName: 'agent-party-time-integrate-update-batch',
        executionBrief,
        resultAssertions: [UPDATE_HANDOFF_TEXT_ASSERTION],
        outputJsonSchema:
          deployment.kind === 'LOCAL_SCRIPT'
            ? LocalScriptUpdateOutputJsonSchema
            : CiCdUpdateOutputJsonSchema,
      }),
      workspace: {
        key: workspaceKey,
        isolation: 'DETACHED_WORKTREE',
        baseRef: `origin/${source.target_branch}`,
      },
      attachmentIds: [],
    });
    this.db.run(
      `INSERT INTO cooking_update_attempt(
           id, batch_id, execution_id, continuation_report_id, attempt,
           outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, NULL, 1, NULL, ?, NULL)`,
      [attemptId, batchId, execution.id, now],
    );
    this.db.run(`UPDATE cooking_update_batch SET active_execution_id = ? WHERE id = ?`, [
      execution.id,
      batchId,
    ]);
    const bugUpdate = this.db.run(
      `UPDATE cooking_bug
         SET stage = 'UPDATING', version = version + 1, updated_at = ?
         WHERE submission_item_id = ? AND stage = 'WAITING_FOR_UPDATE'
           AND id IN (
             SELECT bug_id FROM cooking_update_batch_entry WHERE batch_id = ?
           )`,
      [now, submissionItemId, batchId],
    );
    if (bugUpdate.changes !== candidates.length)
      throw new PlatformError('STALE_STATE', '待更新缺陷集合已变化');
    this.recalculatePendingDelivery(submissionItemId);
    const revision = this.writes.bumpRevision(source.submission_id, now);
    return { batchId, executionId: execution.id, revision };
  }

  private recalculatePendingDelivery(submissionItemId: string): void {
    const latest = this.db.get(
      `SELECT MAX(context.last_candidate_at) last_candidate_at
         FROM cooking_bug bug
         JOIN cooking_bug_repair_context context ON context.bug_id = bug.id
         WHERE bug.submission_item_id = ?
           AND bug.stage = 'WAITING_FOR_UPDATE'
           AND context.last_candidate_at IS NOT NULL
           AND context.pending_commits_json <> '[]'`,
      submissionItemId,
    ) as { last_candidate_at: string | null };
    if (!latest.last_candidate_at) {
      this.db.run('DELETE FROM cooking_pending_delivery WHERE submission_item_id = ?', [
        submissionItemId,
      ]);
      return;
    }
    this.recordPendingDelivery(submissionItemId, latest.last_candidate_at);
  }

  private recordPendingDelivery(submissionItemId: string, candidateAt: string): void {
    const eligibleAt = new Date(Date.parse(candidateAt) + QUIET_WINDOW_MS).toISOString();
    this.db.run(
      `INSERT INTO cooking_pending_delivery(
           submission_item_id, last_candidate_at, eligible_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(submission_item_id) DO UPDATE SET
           last_candidate_at = excluded.last_candidate_at,
           eligible_at = excluded.eligible_at`,
      [submissionItemId, candidateAt, eligibleAt],
    );
  }
}
