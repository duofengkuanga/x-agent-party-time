import type { AppDatabase } from '@/platform/database';
import {
  ClaimedExecutionSchema,
  RunnerActivitySchema,
  type ClaimedExecution,
  type CodexTurn,
  type Execution,
  type ExecutionOutcome,
  type RunnerActivity,
} from '@agent-party-time/execution-contract';
import {
  ACTIVE_STATES,
  LEASED_STATES,
  hashSecret,
  newLeaseExpiry,
} from './lease';
import type { ExecutionProjector } from './projection';
import { ExecutionRecords, type ExecutionRow } from './records';
export class ExecutionQueue {
  constructor(
    private readonly db: AppDatabase,
    private readonly records: ExecutionRecords,
    private readonly now: () => Date,
    private readonly createLeaseToken: () => string,
    private readonly leaseDurationMs: number,
    private readonly project: ExecutionProjector,
  ) {}
  activityForRunner(runnerId: string): RunnerActivity {
    this.expireLeases();
    const row = this.db.get(
      `SELECT
           SUM(CASE WHEN state IN (
             'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION', 'CANCEL_REQUESTED'
             , 'WAITING_TO_RESUME'
           ) THEN 1 ELSE 0 END) active_count,
           SUM(CASE WHEN state = 'WAITING_FOR_INTERACTION'
             THEN 1 ELSE 0 END) waiting_count
         FROM platform_execution WHERE runner_id = ?`,
      runnerId,
    ) as
      { active_count: number | null; waiting_count: number | null } | undefined;
    return RunnerActivitySchema.parse({
      activeExecutionCount: row?.active_count ?? 0,
      waitingInteractionCount: row?.waiting_count ?? 0,
    });
  }

  hasActiveExecutions(runnerId: string): boolean {
    const row = this.db.get(
      `SELECT 1 active FROM platform_execution
         WHERE runner_id = ? AND state IN (?, ?, ?, ?, ?, ?)
         LIMIT 1`,
      runnerId,
      ...ACTIVE_STATES,
    ) as { active: number } | undefined;
    return Boolean(row);
  }

  queueStatus(executionId: string): {
    state: Execution['state'];
    aheadCount: number;
  } {
    this.expireLeases();
    const execution = this.records.getRow(executionId);
    if (execution.state !== 'QUEUED' && execution.state !== 'WAITING_TO_RESUME')
      return { state: execution.state, aheadCount: 0 };
    const row = this.db.get(
      `SELECT COUNT(*) count
         FROM platform_execution earlier
         WHERE earlier.binding_id = ?
           AND earlier.id <> ?
           AND (
             earlier.state IN ('CLAIMED', 'RUNNING', 'CANCEL_REQUESTED')
             OR (
               earlier.state = 'WAITING_TO_RESUME'
               AND (
                 ? = 'QUEUED'
                 OR COALESCE(
                   earlier.resume_requested_at, earlier.created_at
                 ) < COALESCE(?, ?)
               )
             )
             OR (
               earlier.state = 'QUEUED'
               AND ? = 'QUEUED'
               AND (
                 earlier.created_at < ?
                 OR (
                   earlier.created_at = ?
                   AND earlier.rowid < (
                     SELECT rowid FROM platform_execution WHERE id = ?
                   )
                 )
               )
             )
           )`,
      execution.binding_id,
      execution.id,
      execution.state,
      execution.resume_requested_at,
      execution.created_at,
      execution.state,
      execution.created_at,
      execution.created_at,
      execution.id,
    ) as { count: number };
    return { state: execution.state, aheadCount: row.count };
  }

  tryAcquireResumeLane(executionId: string): boolean {
    this.expireLeases();
    const result = this.db.transaction(
      (): {
        laneAcquired: boolean;
        resumedExecution: Execution | null;
      } => {
        const execution = this.records.getRow(executionId);
        if (execution.state === 'RUNNING')
          return { laneAcquired: true, resumedExecution: null };
        if (execution.state !== 'WAITING_TO_RESUME')
          return { laneAcquired: false, resumedExecution: null };
        const update = this.db.run(
          `UPDATE platform_execution AS candidate
           SET state = 'RUNNING', resume_requested_at = NULL
           WHERE candidate.id = ?
             AND candidate.state = 'WAITING_TO_RESUME'
             AND candidate.lease_token_hash IS NOT NULL
             AND candidate.lease_expires_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM platform_execution active
               WHERE active.binding_id = candidate.binding_id
                 AND active.id <> candidate.id
                 AND active.state IN ('CLAIMED', 'RUNNING', 'CANCEL_REQUESTED')
             )
             AND NOT EXISTS (
               SELECT 1 FROM platform_execution earlier
               WHERE earlier.binding_id = candidate.binding_id
                 AND earlier.id <> candidate.id
                 AND earlier.state = 'WAITING_TO_RESUME'
                 AND (COALESCE(earlier.resume_requested_at, earlier.created_at), earlier.rowid)
                   < (COALESCE(candidate.resume_requested_at, candidate.created_at), candidate.rowid)
             )`,
          [executionId, this.now().toISOString()],
        );
        if (update.changes !== 1)
          return { laneAcquired: false, resumedExecution: null };
        const resumedExecution = this.records.get(executionId);
        this.project({
          phase: 'APPLY',
          kind: 'RESUMED',
          execution: resumedExecution,
        });
        return { laneAcquired: true, resumedExecution };
      },
    )();
    if (result.resumedExecution)
      this.project({
        phase: 'AFTER',
        kind: 'RESUMED',
        execution: result.resumedExecution,
      });
    return result.laneAcquired;
  }

  claimAvailable(runnerId: string, availableSlots: number): ClaimedExecution[] {
    if (availableSlots === 0) return [];
    this.expireLeases();
    return this.db.transaction(() => {
      const rows = this.db.all<ExecutionRow>(
        `WITH ranked AS (
             SELECT *, rowid queue_order,
               ROW_NUMBER() OVER (
                 PARTITION BY binding_id
                 ORDER BY state = 'QUEUED',
                   COALESCE(resume_requested_at, created_at), rowid
               ) queue_rank
             FROM platform_execution
             WHERE cancellation_requested = 0
               AND state IN ('QUEUED', 'WAITING_TO_RESUME')
           )
           SELECT candidate.* FROM ranked candidate
           WHERE candidate.runner_id = ? AND candidate.queue_rank = 1
             AND (candidate.state = 'QUEUED' OR candidate.lease_token_hash IS NULL)
             AND NOT EXISTS (
               SELECT 1 FROM platform_execution active
               WHERE active.binding_id = candidate.binding_id
                 AND active.state IN ('CLAIMED', 'RUNNING', 'CANCEL_REQUESTED')
             )
           ORDER BY candidate.state = 'QUEUED',
             COALESCE(candidate.resume_requested_at, candidate.created_at),
             candidate.queue_order
           LIMIT ?`,
        runnerId,
        availableSlots,
      );
      return rows.map((row) => {
        const recoveredInteraction =
          row.state === 'WAITING_TO_RESUME'
            ? this.records.latestInteraction(row.id)
            : undefined;
        const leaseToken = this.createLeaseToken();
        const expiresAt = newLeaseExpiry(this.now(), this.leaseDurationMs);
        const claimedAt = this.now().toISOString();
        this.db.run(
          `UPDATE platform_execution
             SET state = 'CLAIMED', lease_token_hash = ?,
                 lease_expires_at = ?, claimed_at = COALESCE(claimed_at, ?),
                 resume_requested_at = NULL
             WHERE id = ?
               AND cancellation_requested = 0
               AND state IN ('QUEUED', 'WAITING_TO_RESUME')`,
          [hashSecret(leaseToken), expiresAt, claimedAt, row.id],
        );
        const execution = this.records.get(row.id);
        return ClaimedExecutionSchema.parse({
          ...execution,
          codexTurn: codexTurnForClaim(execution),
          lease: { token: leaseToken, expiresAt },
          outcome: null,
          recoveredInteraction:
            recoveredInteraction?.state === 'RESOLVED' &&
            recoveredInteraction.resolution_json
              ? {
                  method: recoveredInteraction.method,
                  payload: JSON.parse(recoveredInteraction.payload_json),
                  resolution: JSON.parse(recoveredInteraction.resolution_json),
                }
              : null,
        });
      });
    })();
  }

  expireLeases(): void {
    const now = this.now().toISOString();
    const terminal = this.db.transaction(() => {
      const expired = this.db.all<{
        id: string;
        state: Execution['state'];
        cancellation_requested: number;
      }>(
        `SELECT id, state, cancellation_requested
           FROM platform_execution
           WHERE state IN (?, ?, ?, ?, ?)
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?`,
        ...LEASED_STATES,
        now,
      );
      const invalidate = this.db.prepare(
        `UPDATE platform_execution_interaction
         SET state = 'INVALIDATED', resolved_at = ?
         WHERE execution_id = ? AND state = 'PENDING'`,
      );
      const release = this.db.prepare(
        `UPDATE platform_execution
         SET state = CASE
               WHEN state IN (
                 'WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME'
               ) THEN state
               ELSE 'QUEUED'
             END,
             lease_token_hash = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      );
      const cancelled = this.db.prepare(
        `UPDATE platform_execution
         SET state = 'CANCELLED', outcome_json = ?, finished_at = ?,
             lease_token_hash = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      );
      const completed: Execution[] = [];
      for (const row of expired) {
        if (row.cancellation_requested === 1) {
          const outcome: ExecutionOutcome = {
            kind: 'CANCELLED',
            reason: '取消中的任务因 Agent 失联而终止',
          };
          invalidate.run(now, row.id);
          cancelled.run(JSON.stringify(outcome), now, row.id);
          const execution = this.records.get(row.id);
          this.project({
            phase: 'APPLY',
            kind: 'TERMINAL',
            execution: execution,
          });
          completed.push(execution);
          continue;
        }
        release.run(row.id);
      }
      return completed;
    })();
    for (const execution of terminal)
      this.project({ phase: 'AFTER', kind: 'TERMINAL', execution: execution });
  }
}
function codexTurnForClaim(execution: Execution): CodexTurn | null {
  const turn = execution.codexTurn;
  if (
    turn?.kind !== 'INITIAL' ||
    !execution.sessionId ||
    !turn.taskSkillBinding
  )
    return turn;
  return {
    kind: 'CONTINUATION',
    taskId: execution.sessionId,
    taskSkillBinding: turn.taskSkillBinding,
    input: '继续完成上次未完成的任务。',
    outputJsonSchema: turn.outputJsonSchema,
    resultAssertions: turn.resultAssertions,
  };
}
