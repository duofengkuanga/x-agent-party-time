import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  EnqueueExecutionInputSchema,
  type ClaimedExecution,
  type CodexTurn,
  type CompleteExecutionRequest,
  type EnqueueExecutionInput,
  type Execution,
  type ExecutionOutcome,
  type ExecutionStartRequest,
  type RunnerActivity,
  type TaskSkillBinding,
} from '@agent-party-time/execution-contract';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  LEASED_STATES,
  hashSecret,
  newLeaseExpiry,
  requireLeasedExecution,
  requireLeasedRow,
} from './lease';
import { ExecutionInteractions } from './interactions';
import { sleepUntilNextPoll } from './polling';
import { projectTransaction, type ExecutionProjector } from './projection';
import { ExecutionQueue } from './queue';
import { ExecutionRecords, type AttachmentRow, type FileRow } from './records';
const DEFAULT_LEASE_DURATION_MS = 15_000;

export class ExecutionService {
  private readonly records: ExecutionRecords;
  private readonly queue: ExecutionQueue;
  private readonly interactions: ExecutionInteractions;
  readonly openInteraction: ExecutionInteractions['openInteraction'] = (
    ...args
  ) => this.interactions.openInteraction(...args);
  readonly waitInteraction: ExecutionInteractions['waitInteraction'] = (
    ...args
  ) => this.interactions.waitInteraction(...args);
  readonly resolveInteraction: ExecutionInteractions['resolveInteraction'] = (
    ...args
  ) => this.interactions.resolveInteraction(...args);
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
    this.interactions = new ExecutionInteractions(
      db,
      this.records,
      this.queue,
      now,
      createId,
      project,
    );
  }

  enqueue(inputValue: EnqueueExecutionInput): Execution {
    const input = EnqueueExecutionInputSchema.parse(inputValue);
    const executionId = input.id ?? this.createId();
    const createdAt = this.now().toISOString();
    const taskSkillBinding =
      input.codexTurn?.kind === 'CONTINUATION'
        ? input.codexTurn.taskSkillBinding
        : null;
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
            taskSkillBinding?.skillName ?? null,
            taskSkillBinding?.bundleHash ?? null,
            taskSkillBinding?.sourceRevision ?? null,
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
      await sleepUntilNextPoll(deadline);
    } while (Date.now() <= deadline);
    return [];
  }

  start(
    runnerId: string,
    executionId: string,
    request: ExecutionStartRequest,
  ): Execution {
    const kind = request.kind === 'START_FAILED' ? 'TERMINAL' : 'STARTED';
    return projectTransaction(this.db, this.project, (emit) => {
      const row = requireLeasedExecution(
        this.records,
        this.now,
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
      emit({ kind, execution });
      return execution;
    });
  }

  renew(
    runnerId: string,
    executionId: string,
    leaseToken: string,
  ): { expiresAt: string; cancellationRequested: boolean } {
    return this.db.transaction(() => {
      const row = requireLeasedExecution(
        this.records,
        this.now,
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
      requireLeasedRow(this.now, row, request.leaseToken, [
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
    return projectTransaction(this.db, this.project, (emit) => {
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
        emit({ kind: 'TERMINAL', execution });
        return execution;
      }
      this.db.run(
        `UPDATE platform_execution
           SET cancellation_requested = 1, state = 'CANCEL_REQUESTED'
           WHERE id = ?`,
        [executionId],
      );
      return this.records.get(executionId);
    });
  }

  authorizeFile(
    runnerId: string,
    executionId: string,
    leaseToken: string,
    fileId: string,
  ): FileRow {
    requireLeasedExecution(
      this.records,
      this.now,
      runnerId,
      executionId,
      leaseToken,
      [...LEASED_STATES],
    );
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
      : turn.taskSkillBinding.skillName;
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
