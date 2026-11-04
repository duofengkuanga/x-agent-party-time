import type { AppDatabase } from '@/server/database/index';
import {
  ClaimedExecutionSchema,
  RunnerActivitySchema,
  type ClaimedExecution,
  type CodexTurn,
  type Execution,
  type ExecutionOutcome,
  type ExecutionWorkspaceMember,
  type RunnerActivity,
} from '@agent-party-time/execution-contract';
import {
  executionsConflict,
  hasExecutionCapacity,
  type ExecutionAccess,
} from '@agent-party-time/execution-contract/scheduling';
import { ACTIVE_STATES, LEASED_STATES, hashSecret, newLeaseExpiry } from './lease';
import { projectTransaction, type ExecutionProjector } from './projection';
import { ExecutionRecords, type ExecutionRow } from './records';
export type ExecutionClaimPlan = {
  workspaces: ExecutionWorkspaceMember[];
  codexTurn: CodexTurn | null;
  claimed?(): void;
};
export type ExecutionClaimResolver = (
  execution: Execution,
) => ExecutionClaimPlan | false | undefined;

export class ExecutionQueue {
  constructor(
    private readonly db: AppDatabase,
    private readonly records: ExecutionRecords,
    private readonly now: () => Date,
    private readonly createLeaseToken: () => string,
    private readonly leaseDurationMs: number,
    private readonly project: ExecutionProjector,
    private readonly resolveClaim?: ExecutionClaimResolver,
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
    ) as { active_count: number | null; waiting_count: number | null } | undefined;
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
    const rows = this.schedulingRows(execution.runner_id);
    const candidate = rows.find((row) => row.id === executionId)!;
    const aheadCount = rows.filter(
      (row) =>
        row.id !== candidate.id &&
        executionsConflict(row.access, candidate.access) &&
        (occupiesLane(row) ||
          (isQueued(row) && row.manual_available && compareSchedule(row, candidate) < 0)),
    ).length;
    return { state: execution.state, aheadCount };
  }

  tryAcquireResumeLane(executionId: string): boolean {
    this.expireLeases();
    return projectTransaction(this.db, this.project, (emit) => {
      const execution = this.records.getRow(executionId);
      if (execution.state === 'RUNNING') return true;
      if (
        execution.state !== 'WAITING_TO_RESUME' ||
        !execution.lease_token_hash ||
        !execution.lease_expires_at ||
        execution.lease_expires_at <= this.now().toISOString()
      )
        return false;
      if (this.resolveClaim?.(this.records.get(executionId)) === false) return false;
      const rows = this.schedulingRows(execution.runner_id);
      const candidate = rows.find((row) => row.id === executionId)!;
      const others = rows.filter((row) => row.id !== executionId);
      if (
        !candidate.manual_available ||
        others.some(
          (row) =>
            executionsConflict(row.access, candidate.access) &&
            (occupiesLane(row) ||
              (row.state === 'WAITING_TO_RESUME' &&
                row.manual_available &&
                compareSchedule(row, candidate) < 0)),
        ) ||
        !hasExecutionCapacity(
          candidate.access,
          others.filter(holdsSlot).map((row) => row.access),
        )
      )
        return false;
      this.db.run(
        "UPDATE platform_execution SET state = 'RUNNING', resume_requested_at = NULL WHERE id = ?",
        [executionId],
      );
      emit({ kind: 'RESUMED', execution: this.records.get(executionId) });
      return true;
    });
  }

  claimAvailable(runnerId: string, availableSlots: number): ClaimedExecution[] {
    if (availableSlots === 0) return [];
    this.expireLeases();
    return this.db
      .transaction(() => {
        const plans = new Map<string, ExecutionClaimPlan | false>();
        if (this.resolveClaim) {
          const queued = this.db.all<{ id: string }>(
            "SELECT id FROM platform_execution WHERE runner_id = ? AND state IN ('QUEUED', 'WAITING_TO_RESUME')",
            runnerId,
          );
          for (const { id } of queued) {
            const plan = this.resolveClaim(this.records.get(id));
            if (plan !== undefined) plans.set(id, plan);
          }
        }
        const rows = this.schedulingRows(runnerId, plans);
        const active = rows.filter(occupiesLane);
        const occupied = rows.filter(holdsSlot).map((row) => row.access);
        const queued = rows.filter(
          (row) => isQueued(row) && row.manual_available && plans.get(row.id) !== false,
        );
        const claimed: ClaimedExecution[] = [];
        for (
          let index = 0;
          index < queued.length && claimed.length < availableSlots;
          index++
        ) {
          const row = queued[index]!;
          if (
            (row.state === 'WAITING_TO_RESUME' && row.lease_token_hash) ||
            active.some((entry) => executionsConflict(entry.access, row.access)) ||
            queued
              .slice(0, index)
              .some((entry) => executionsConflict(entry.access, row.access)) ||
            !hasExecutionCapacity(row.access, occupied)
          )
            continue;
          const recoveredInteraction =
            row.state === 'WAITING_TO_RESUME'
              ? this.records.latestInteraction(row.id)
              : undefined;
          const plan = plans.get(row.id);
          if (plan) {
            this.db.run(
              'UPDATE platform_execution SET workspace_json = ?, codex_turn_json = ? WHERE id = ?',
              [
                JSON.stringify(plan.workspaces),
                plan.codexTurn ? JSON.stringify(plan.codexTurn) : null,
                row.id,
              ],
            );
            plan.claimed?.();
          }
          const leaseToken = this.createLeaseToken();
          const expiresAt = newLeaseExpiry(this.now(), this.leaseDurationMs);
          this.db.run(
            `UPDATE platform_execution SET state = 'CLAIMED', lease_token_hash = ?,
             lease_expires_at = ?, claimed_at = COALESCE(claimed_at, ?),
             resume_requested_at = NULL WHERE id = ?`,
            [hashSecret(leaseToken), expiresAt, this.now().toISOString(), row.id],
          );
          const execution = this.records.get(row.id);
          claimed.push(
            ClaimedExecutionSchema.parse({
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
            }),
          );
          active.push(row);
          occupied.push(row.access);
        }
        return claimed;
      })
      .immediate();
  }

  private schedulingRows(
    runnerId: string,
    plans?: ReadonlyMap<string, ExecutionClaimPlan | false>,
  ): ScheduledExecution[] {
    return this.db
      .all<SchedulingRow>(
        `SELECT candidate.id, candidate.state, candidate.priority,
         candidate.workspace_json, candidate.lease_token_hash, candidate.lease_expires_at,
         candidate.cancellation_requested, candidate.resume_requested_at, candidate.created_at,
         COALESCE(candidate.session_id, json_extract(candidate.codex_turn_json, '$.taskId')) session_id,
         candidate.rowid queue_order,
         ${manualWorkspaceAvailable('candidate')} manual_available
       FROM platform_execution candidate
       WHERE candidate.runner_id = ? AND candidate.state IN (
         'QUEUED', 'CLAIMED', 'RUNNING', 'CANCEL_REQUESTED',
         'WAITING_TO_RESUME', 'WAITING_FOR_INTERACTION')`,
        runnerId,
      )
      .map((row) => {
        const plan = plans?.get(row.id);
        const available = plan
          ? this.db.get<{ allowed: number }>(
              `SELECT ${manualWorkspaceAvailable('candidate')} allowed
               FROM (SELECT ? id, ? runner_id, ? workspace_json, ? codex_turn_json) candidate`,
              row.id,
              runnerId,
              JSON.stringify(plan.workspaces),
              plan.codexTurn ? JSON.stringify(plan.codexTurn) : null,
            )?.allowed
          : row.manual_available;
        return {
          ...row,
          manual_available: available ?? 0,
          access: {
            workspaces: plan ? plan.workspaces : JSON.parse(row.workspace_json),
            sessionId: row.session_id,
            codexTurn: null,
          },
        };
      })
      .sort(compareSchedule);
  }

  expireLeases(): void {
    const now = this.now().toISOString();
    projectTransaction(this.db, this.project, (emit) => {
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
      for (const row of expired) {
        if (row.cancellation_requested === 1) {
          const outcome: ExecutionOutcome = {
            kind: 'CANCELLED',
            reason: '取消中的任务因 Agent 失联而终止',
          };
          invalidate.run(now, row.id);
          cancelled.run(JSON.stringify(outcome), now, row.id);
          const execution = this.records.get(row.id);
          emit({ kind: 'TERMINAL', execution });
          continue;
        }
        if (
          this.records.findPendingInteraction(row.id)?.method === 'xapt/manualHandoff'
        ) {
          // Keep the original token solely for the durable release receipt;
          // this state is never automatically claimed or resumed.
          this.db.run(
            'UPDATE platform_execution SET lease_expires_at = NULL WHERE id = ?',
            [row.id],
          );
          continue;
        }
        release.run(row.id);
      }
    });
  }
}
function manualWorkspaceAvailable(candidate: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM platform_execution manual
    WHERE manual.id <> ${candidate}.id
      AND (manual.state = 'HANDED_OFF' OR (
        manual.state = 'WAITING_FOR_INTERACTION' AND EXISTS (
          SELECT 1 FROM platform_execution_interaction interaction
          WHERE interaction.execution_id = manual.id AND interaction.state = 'PENDING'
            AND interaction.method = 'xapt/manualHandoff'
        )
      ))
      AND manual.runner_id = ${candidate}.runner_id
      AND (manual.session_id = json_extract(${candidate}.codex_turn_json, '$.taskId')
        OR EXISTS (
          SELECT 1 FROM json_each(manual.workspace_json) a
          JOIN json_each(${candidate}.workspace_json) b
          WHERE a.value ->> '$.workspace.key' = b.value ->> '$.workspace.key'
            OR EXISTS (SELECT 1 FROM json_each(b.value, '$.workspace.workspaceKeys') cleanup
              WHERE cleanup.value = a.value ->> '$.workspace.key')
            OR (a.value ->> '$.bindingId' = b.value ->> '$.bindingId'
              AND (a.value ->> '$.workspace' IS NULL OR b.value ->> '$.workspace' IS NULL))
        ))
      AND NOT (COALESCE(json_extract(${candidate}.codex_turn_json, '$.kind'), '') = 'READ_SESSION'
        AND json_extract(${candidate}.codex_turn_json, '$.taskId') = manual.session_id)
      AND NOT EXISTS (
        SELECT 1 FROM platform_execution synced
        WHERE synced.previous_execution_id = manual.id AND synced.state = 'SUCCEEDED'
          AND json_extract(synced.codex_turn_json, '$.kind') = 'READ_SESSION'
      )
  )`;
}
function codexTurnForClaim(execution: Execution): CodexTurn | null {
  const turn = execution.codexTurn;
  if (turn?.kind !== 'INITIAL' || !execution.sessionId || !turn.taskSkillBinding)
    return turn;
  return {
    kind: 'CONTINUATION',
    manualHandoff: turn.manualHandoff,
    taskId: execution.sessionId,
    taskSkillBinding: turn.taskSkillBinding,
    input: '继续完成上次未完成的任务。',
    outputJsonSchema: turn.outputJsonSchema,
    resultAssertions: turn.resultAssertions,
  };
}

type SchedulingRow = Pick<
  ExecutionRow,
  | 'id'
  | 'state'
  | 'priority'
  | 'workspace_json'
  | 'lease_token_hash'
  | 'lease_expires_at'
  | 'cancellation_requested'
  | 'resume_requested_at'
  | 'created_at'
  | 'session_id'
> & {
  queue_order: number;
  manual_available: number;
};
type ScheduledExecution = SchedulingRow & {
  access: ExecutionAccess;
};

function occupiesLane(row: ScheduledExecution): boolean {
  return (
    ['CLAIMED', 'RUNNING', 'CANCEL_REQUESTED'].includes(row.state) ||
    (row.state === 'WAITING_FOR_INTERACTION' &&
      row.access.workspaces.some(({ workspace }) => workspace !== null) &&
      Boolean(row.lease_token_hash) &&
      Boolean(row.lease_expires_at))
  );
}
function holdsSlot(row: SchedulingRow): boolean {
  return (
    Boolean(row.lease_token_hash) &&
    Boolean(row.lease_expires_at) &&
    LEASED_STATES.some((state) => state === row.state)
  );
}
function isQueued(row: SchedulingRow): boolean {
  return (
    row.cancellation_requested === 0 &&
    ['QUEUED', 'WAITING_TO_RESUME'].includes(row.state)
  );
}
function compareSchedule(left: ScheduledExecution, right: ScheduledExecution): number {
  return (
    Number(left.state !== 'WAITING_TO_RESUME') -
      Number(right.state !== 'WAITING_TO_RESUME') ||
    right.priority - left.priority ||
    (left.resume_requested_at ?? left.created_at).localeCompare(
      right.resume_requested_at ?? right.created_at,
    ) ||
    left.queue_order - right.queue_order
  );
}
