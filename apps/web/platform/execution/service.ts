import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  EnqueueExecutionInputSchema,
  parseExecutionInteractionResolution,
  type ClaimedExecution,
  type CodexTurn,
  type CompleteExecutionRequest,
  type EnqueueExecutionInput,
  type Execution,
  type ExecutionInteraction,
  type ExecutionOutcome,
  type ExecutionStartRequest,
  type JsonValue,
  type OpenInteractionRequest,
  type RunnerActivity,
  type TaskSkillBinding,
  type WaitInteractionResponse,
} from '@agent-party-time/execution-contract';
import { randomBytes, randomUUID } from 'node:crypto';
import { LEASED_STATES, hashSecret, newLeaseExpiry } from './lease';
import type { ExecutionProjector } from './projection';
import { ExecutionQueue } from './queue';
import {
  ExecutionRecords,
  mapInteraction,
  type AttachmentRow,
  type ExecutionRow,
  type FileRow,
} from './records';
const DEFAULT_LEASE_DURATION_MS = 15_000;
const POLL_INTERVAL_MS = 50;

export class ExecutionService {
  private readonly records: ExecutionRecords;
  private readonly queue: ExecutionQueue;
  get(executionId: string): Execution {
    return this.records.get(executionId);
  }
  activityForRunner(runnerId: string): RunnerActivity {
    return this.queue.activityForRunner(runnerId);
  }
  hasActiveExecutions(runnerId: string): boolean {
    return this.queue.hasActiveExecutions(runnerId);
  }
  queueStatus(executionId: string) {
    return this.queue.queueStatus(executionId);
  }

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    createLeaseToken: () => string = () =>
      randomBytes(32).toString('base64url'),
    private readonly leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS,
    private readonly project: ExecutionProjector = () => {},
  ) {
    this.records = new ExecutionRecords(db);
    this.queue = new ExecutionQueue(
      db,
      this.records,
      now,
      createLeaseToken,
      leaseDurationMs,
      project,
    );
  }

  enqueue(inputValue: EnqueueExecutionInput): Execution {
    const input = EnqueueExecutionInputSchema.parse(inputValue);
    const executionId = input.id ?? this.createId();
    const createdAt = this.now().toISOString();
    const attachments = input.attachmentIds.map((fileId) => {
      const row = this.db.get(
        `SELECT id file_id, original_name, media_type, size_bytes, sha256
           FROM platform_file WHERE id = ?`,
        fileId,
      ) as AttachmentRow | undefined;
      if (!row) throw new PlatformError('NOT_FOUND', '处理任务附件不存在');
      return row;
    });

    try {
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO platform_execution(
               id, owner_namespace, owner_kind, owner_id, attempt,
               previous_execution_id, runner_id, binding_id, priority,
               approval_policy, state, codex_turn_json, skill_name,
               skill_bundle_hash, skill_source_revision,
               workspace_json, session_id, lease_token_hash, lease_expires_at,
               outcome_json, reported_outcome_json, cancellation_requested,
               resume_requested_at, created_at, claimed_at, started_at,
               finished_at
             ) VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?,
               ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, NULL, NULL, NULL
             )`,
          [
            executionId,
            input.owner.namespace,
            input.owner.kind,
            input.owner.id,
            input.attempt,
            input.previousExecutionId,
            input.runnerId,
            input.bindingId,
            input.priority,
            input.approvalPolicy,
            input.codexTurn ? JSON.stringify(input.codexTurn) : null,
            input.codexTurn?.kind === 'CONTINUATION'
              ? input.codexTurn.taskSkillBinding.skillName
              : null,
            input.codexTurn?.kind === 'CONTINUATION'
              ? input.codexTurn.taskSkillBinding.bundleHash
              : null,
            input.codexTurn?.kind === 'CONTINUATION'
              ? input.codexTurn.taskSkillBinding.sourceRevision
              : null,
            input.workspace ? JSON.stringify(input.workspace) : null,
            createdAt,
          ],
        );
        const insertAttachment = this.db.prepare(
          `INSERT INTO platform_execution_attachment(
             execution_id, file_id, original_name, media_type, size_bytes,
             sha256, position
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        attachments.forEach((attachment, position) =>
          insertAttachment.run(
            executionId,
            attachment.file_id,
            attachment.original_name,
            attachment.media_type,
            attachment.size_bytes,
            attachment.sha256,
            position,
          ),
        );
      })();
    } catch (error) {
      if (isBindingReservationConstraint(error))
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          '该本机关联已有正在处理的任务',
          { cause: error },
        );
      throw error;
    }
    return this.records.get(executionId);
  }

  async claim(
    runnerId: string,
    availableSlots: number,
    waitMs: number,
  ): Promise<ClaimedExecution[]> {
    const deadline = Date.now() + waitMs;
    do {
      const claimed = this.queue.claimAvailable(runnerId, availableSlots);
      if (claimed.length || availableSlots === 0 || Date.now() >= deadline)
        return claimed;
      await sleep(
        Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
      );
    } while (Date.now() <= deadline);
    return [];
  }

  start(
    runnerId: string,
    executionId: string,
    request: ExecutionStartRequest,
  ): Execution {
    const result = this.db.transaction(() => {
      const row = this.requireLeasedExecution(
        runnerId,
        executionId,
        request.leaseToken,
        ['CLAIMED'],
      );
      const now = this.now().toISOString();
      if (request.kind === 'START_FAILED') {
        const outcome: ExecutionOutcome = {
          kind: 'FAILED',
          failure: request.failure,
        };
        this.db.run(
          `UPDATE platform_execution
             SET state = 'FAILED', outcome_json = ?, finished_at = ?,
                 lease_expires_at = NULL
             WHERE id = ?`,
          [JSON.stringify(outcome), now, executionId],
        );
        this.records.invalidatePendingInteractions(executionId, now);
      } else {
        const turn = row.codex_turn_json
          ? (JSON.parse(row.codex_turn_json) as CodexTurn)
          : null;
        validateStartedSkillBinding(turn, request.taskSkillBinding);
        this.db.run(
          `UPDATE platform_execution
             SET state = CASE
                   WHEN cancellation_requested = 1 THEN 'CANCEL_REQUESTED'
                   ELSE 'RUNNING'
                 END,
                 session_id = ?, skill_name = ?, skill_bundle_hash = ?,
                 skill_source_revision = ?,
                 started_at = COALESCE(started_at, ?)
             WHERE id = ?`,
          [
            request.sessionId,
            request.taskSkillBinding?.skillName ?? null,
            request.taskSkillBinding?.bundleHash ?? null,
            request.taskSkillBinding?.sourceRevision ?? null,
            now,
            executionId,
          ],
        );
      }
      const execution = this.records.get(executionId);
      if (request.kind === 'START_FAILED')
        this.project({
          phase: 'APPLY',
          kind: 'TERMINAL',
          execution: execution,
        });
      else
        this.project({ phase: 'APPLY', kind: 'STARTED', execution: execution });
      return execution;
    })();
    if (request.kind === 'START_FAILED')
      this.project({ phase: 'AFTER', kind: 'TERMINAL', execution: result });
    else this.project({ phase: 'AFTER', kind: 'STARTED', execution: result });
    return result;
  }

  renew(
    runnerId: string,
    executionId: string,
    leaseToken: string,
  ): { expiresAt: string; cancellationRequested: boolean } {
    return this.db.transaction(() => {
      const row = this.requireLeasedExecution(
        runnerId,
        executionId,
        leaseToken,
        [...LEASED_STATES],
      );
      const expiresAt = newLeaseExpiry(this.now(), this.leaseDurationMs);
      this.db.run(
        `UPDATE platform_execution SET lease_expires_at = ? WHERE id = ?`,
        [expiresAt, executionId],
      );
      return {
        expiresAt,
        cancellationRequested: Boolean(row.cancellation_requested),
      };
    })();
  }

  openInteraction(
    runnerId: string,
    executionId: string,
    request: OpenInteractionRequest,
  ): ExecutionInteraction {
    let opened = false;
    const result = this.db.transaction(() => {
      this.requireLeasedExecution(runnerId, executionId, request.leaseToken, [
        'RUNNING',
        'CANCEL_REQUESTED',
      ]);
      const existing = this.records.findPendingInteraction(executionId);
      if (existing) {
        if (
          existing.kind === request.kind &&
          existing.method === request.method &&
          existing.payload_json === JSON.stringify(request.payload)
        )
          return mapInteraction(existing);
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          '该任务已有待处理的操作请求',
        );
      }
      const id = this.createId();
      const createdAt = this.now().toISOString();
      this.db.run(
        `INSERT INTO platform_execution_interaction(
             id, execution_id, kind, method, payload_json, state,
             resolution_json, created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, ?, NULL)`,
        [
          id,
          executionId,
          request.kind,
          request.method,
          JSON.stringify(request.payload),
          createdAt,
        ],
      );
      this.db.run(
        `UPDATE platform_execution
           SET state = 'WAITING_FOR_INTERACTION'
           WHERE id = ?`,
        [executionId],
      );
      const interaction = this.records.getInteraction(id);
      this.project({
        phase: 'APPLY',
        kind: 'INTERACTION_OPENED',
        interaction: interaction,
      });
      opened = true;
      return interaction;
    })();
    if (opened)
      this.project({
        phase: 'AFTER',
        kind: 'INTERACTION_OPENED',
        interaction: result,
      });
    return result;
  }

  async waitInteraction(
    runnerId: string,
    executionId: string,
    interactionId: string,
    leaseToken: string,
    waitMs: number,
  ): Promise<WaitInteractionResponse> {
    const deadline = Date.now() + waitMs;
    do {
      this.requireLeasedExecution(runnerId, executionId, leaseToken, [
        'WAITING_FOR_INTERACTION',
        'WAITING_TO_RESUME',
        'RUNNING',
        'CANCEL_REQUESTED',
      ]);
      const interaction = this.records.latestInteraction(executionId);
      if (!interaction || interaction.id !== interactionId)
        throw new PlatformError('NOT_FOUND', '任务操作请求不存在');
      if (interaction.state === 'RESOLVED') {
        const laneAcquired = this.queue.tryAcquireResumeLane(executionId);
        if (laneAcquired || Date.now() >= deadline)
          return { interaction: mapInteraction(interaction), laneAcquired };
      } else if (interaction.state === 'INVALIDATED')
        return {
          interaction: mapInteraction(interaction),
          laneAcquired: false,
        };
      else if (Date.now() >= deadline)
        return {
          interaction: mapInteraction(interaction),
          laneAcquired: false,
        };
      await sleep(
        Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
      );
    } while (Date.now() <= deadline);
    const interaction = this.records.latestInteraction(executionId);
    if (!interaction || interaction.id !== interactionId)
      throw new PlatformError('NOT_FOUND', '任务操作请求不存在');
    return {
      interaction: mapInteraction(interaction),
      laneAcquired:
        interaction.state === 'RESOLVED' &&
        this.queue.tryAcquireResumeLane(executionId),
    };
  }

  resolveInteraction(
    interactionId: string,
    resolution: JsonValue,
  ): ExecutionInteraction {
    this.queue.expireLeases();
    return this.db.transaction(() => {
      const interaction = this.records.getInteractionRow(interactionId);
      if (interaction.state !== 'PENDING')
        throw new PlatformError('STALE_STATE', '任务操作请求已失效或已处理');
      const execution = this.records.getRow(interaction.execution_id);
      if (
        execution.state !== 'WAITING_FOR_INTERACTION' ||
        execution.cancellation_requested === 1
      )
        throw new PlatformError('STALE_STATE', '任务不再等待该操作请求');
      const parsedResolution = parseExecutionInteractionResolution(
        interaction.method,
        JSON.parse(interaction.payload_json) as JsonValue,
        resolution,
      );
      const resolvedAt = this.now().toISOString();
      this.db.run(
        `UPDATE platform_execution_interaction
           SET state = 'RESOLVED', resolution_json = ?, resolved_at = ?
           WHERE id = ? AND state = 'PENDING'`,
        [JSON.stringify(parsedResolution), resolvedAt, interactionId],
      );
      this.db.run(
        `UPDATE platform_execution
           SET state = 'WAITING_TO_RESUME', resume_requested_at = ?
           WHERE id = ?`,
        [resolvedAt, interaction.execution_id],
      );
      return this.records.getInteraction(interactionId);
    })();
  }

  complete(
    runnerId: string,
    executionId: string,
    request: CompleteExecutionRequest,
  ): Execution {
    let newlyTerminal = false;
    const result = this.db.transaction(() => {
      const row = this.records.getRow(executionId);
      if (row.runner_id !== runnerId)
        throw new PlatformError('NOT_FOUND', '处理任务不存在');
      const tokenHash = hashSecret(request.leaseToken);
      if (isTerminal(row.state)) {
        if (
          row.lease_token_hash === tokenHash &&
          row.session_id === request.sessionId &&
          row.reported_outcome_json === JSON.stringify(request.outcome)
        )
          return this.records.mapExecution(row);
        throw new PlatformError('OUTCOME_CONFLICT', '任务结果与已保存结果冲突');
      }
      this.requireLeasedRow(row, request.leaseToken, [
        'RUNNING',
        'WAITING_FOR_INTERACTION',
        'WAITING_TO_RESUME',
        'CANCEL_REQUESTED',
      ]);
      if (
        (row.state === 'WAITING_FOR_INTERACTION' ||
          row.state === 'WAITING_TO_RESUME') &&
        request.outcome.kind !== 'CANCELLED'
      )
        throw new PlatformError(
          'INVALID_TRANSITION',
          '等待中的任务只能以取消结束',
        );
      if (row.session_id !== request.sessionId)
        throw new PlatformError('STALE_STATE', '任务会话不匹配');
      const finishedAt = this.now().toISOString();
      this.db.run(
        `UPDATE platform_execution
           SET state = ?, outcome_json = ?, reported_outcome_json = ?,
               finished_at = ?, lease_expires_at = NULL
           WHERE id = ?`,
        [
          request.outcome.kind,
          JSON.stringify(request.outcome),
          JSON.stringify(request.outcome),
          finishedAt,
          executionId,
        ],
      );
      this.records.invalidatePendingInteractions(executionId, finishedAt);
      const execution = this.records.get(executionId);
      this.project({ phase: 'APPLY', kind: 'TERMINAL', execution: execution });
      newlyTerminal = true;
      return this.records.get(executionId);
    })();
    if (newlyTerminal)
      this.project({ phase: 'AFTER', kind: 'TERMINAL', execution: result });
    return result;
  }

  cancelQueued(executionId: string, reason: string): Execution {
    const finishedAt = this.now().toISOString();
    const outcome: ExecutionOutcome = { kind: 'CANCELLED', reason };
    const update = this.db.run(
      `UPDATE platform_execution
         SET state = 'CANCELLED', outcome_json = ?, finished_at = ?
         WHERE id = ? AND state = 'QUEUED'`,
      [JSON.stringify(outcome), finishedAt, executionId],
    );
    if (update.changes !== 1)
      throw new PlatformError(
        'INVALID_TRANSITION',
        '只有尚未领取的任务可以取消',
      );
    const execution = this.records.get(executionId);
    this.records.invalidatePendingInteractions(executionId, finishedAt);
    this.project({ phase: 'APPLY', kind: 'TERMINAL', execution: execution });
    this.project({ phase: 'AFTER', kind: 'TERMINAL', execution: execution });
    return execution;
  }

  requestCancellation(executionId: string): Execution {
    let newlyTerminal = false;
    const result = this.db.transaction(() => {
      const row = this.records.getRow(executionId);
      if (isTerminal(row.state)) return this.records.mapExecution(row);
      const cancelledAt = this.now().toISOString();
      if (
        row.state === 'QUEUED' ||
        row.state === 'WAITING_FOR_INTERACTION' ||
        row.state === 'WAITING_TO_RESUME'
      ) {
        const outcome: ExecutionOutcome = {
          kind: 'CANCELLED',
          reason: '服务端已请求取消',
        };
        this.db.run(
          `UPDATE platform_execution
             SET cancellation_requested = 1, state = 'CANCELLED',
                 outcome_json = ?, finished_at = ?,
                 lease_token_hash = NULL, lease_expires_at = NULL
             WHERE id = ?`,
          [JSON.stringify(outcome), cancelledAt, executionId],
        );
        this.records.invalidatePendingInteractions(executionId, cancelledAt);
        const execution = this.records.get(executionId);
        this.project({
          phase: 'APPLY',
          kind: 'TERMINAL',
          execution: execution,
        });
        newlyTerminal = true;
        return execution;
      }
      this.db.run(
        `UPDATE platform_execution
           SET cancellation_requested = 1, state = 'CANCEL_REQUESTED'
           WHERE id = ?`,
        [executionId],
      );
      return this.records.get(executionId);
    })();
    if (newlyTerminal)
      this.project({ phase: 'AFTER', kind: 'TERMINAL', execution: result });
    return result;
  }

  authorizeFile(
    runnerId: string,
    executionId: string,
    leaseToken: string,
    fileId: string,
  ): FileRow {
    this.requireLeasedExecution(runnerId, executionId, leaseToken, [
      ...LEASED_STATES,
    ]);
    const row = this.db.get(
      `SELECT a.file_id, a.original_name, a.media_type, a.size_bytes,
                a.sha256, f.storage_key
         FROM platform_execution_attachment a
         JOIN platform_file f ON f.id = a.file_id
         WHERE a.execution_id = ? AND a.file_id = ?`,
      executionId,
      fileId,
    ) as FileRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '处理任务附件不存在');
    return row;
  }

  private requireLeasedExecution(
    runnerId: string,
    executionId: string,
    leaseToken: string,
    states: Execution['state'][],
  ): ExecutionRow {
    const row = this.records.getRow(executionId);
    if (row.runner_id !== runnerId)
      throw new PlatformError('NOT_FOUND', '处理任务不存在');
    this.requireLeasedRow(row, leaseToken, states);
    return row;
  }

  private requireLeasedRow(
    row: ExecutionRow,
    leaseToken: string,
    states: Execution['state'][],
  ): void {
    if (
      !states.includes(row.state) ||
      !row.lease_token_hash ||
      row.lease_token_hash !== hashSecret(leaseToken) ||
      !row.lease_expires_at
    )
      throw new PlatformError('LEASE_EXPIRED', '任务领取凭据已失效');
    if (Date.parse(row.lease_expires_at) <= this.now().getTime())
      throw new PlatformError('LEASE_EXPIRED', '任务领取凭据已失效');
  }
}

function validateStartedSkillBinding(
  turn: CodexTurn | null,
  actual: TaskSkillBinding | null,
): void {
  if (!turn || turn.kind === 'READ_SESSION') {
    if (actual)
      throw new PlatformError(
        'INVALID_TRANSITION',
        '非 Codex 任务不能关联规则',
      );
    return;
  }
  if (!actual)
    throw new PlatformError('INVALID_TRANSITION', 'Codex 任务缺少规则关联');
  const expectedName =
    turn.kind === 'INITIAL'
      ? turn.requiredSkillName
      : turn.kind === 'CONTINUATION'
        ? turn.taskSkillBinding.skillName
        : null;
  if (
    actual.skillName !== expectedName ||
    (turn.kind === 'CONTINUATION' &&
      (actual.bundleHash !== turn.taskSkillBinding.bundleHash ||
        actual.sourceRevision !== turn.taskSkillBinding.sourceRevision))
  )
    throw new PlatformError('INVALID_TRANSITION', 'Codex 任务的规则关联不匹配');
}

function isTerminal(state: Execution['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

function isBindingReservationConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unique constraint failed:\s*platform_execution[.]binding_id/iu.test(
      `${error.name} ${error.message}`,
    )
  );
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
