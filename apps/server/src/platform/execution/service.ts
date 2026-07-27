import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ClaimedExecutionSchema,
  EnqueueExecutionInputSchema,
  ExecutionInteractionSchema,
  ExecutionSchema,
  RunnerActivitySchema,
  type ClaimedExecution,
  type CompleteExecutionRequest,
  type EnqueueExecutionInput,
  type Execution,
  type ExecutionInteraction,
  type ExecutionOutcome,
  type ExecutionStartRequest,
  type JsonValue,
  type OpenInteractionRequest,
  type RunnerActivity,
} from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';

type ExecutionRow = {
  id: string;
  owner_namespace: string;
  owner_kind: string;
  owner_id: string;
  attempt: number;
  previous_execution_id: string | null;
  runner_id: string;
  binding_id: string;
  priority: number;
  state: Execution['state'];
  prompt_kind: string;
  prompt_version: number;
  rendered_prompt: string;
  rendered_prompt_hash: string;
  output_json_schema: string;
  resume_session_id: string | null;
  session_id: string | null;
  lease_token_hash: string | null;
  lease_expires_at: string | null;
  outcome_json: string | null;
  reported_outcome_json: string | null;
  cancellation_requested: number;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
};

type AttachmentRow = {
  file_id: string;
  original_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
};

type InteractionRow = {
  id: string;
  execution_id: string;
  kind: ExecutionInteraction['kind'];
  method: string;
  payload_json: string;
  state: ExecutionInteraction['state'];
  resolution_json: string | null;
  created_at: string;
  resolved_at: string | null;
};

type FileRow = AttachmentRow & {
  storage_key: string;
};

const ACTIVE_STATES = [
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'WAITING_FOR_INTERACTION',
  'CANCEL_REQUESTED',
] as const;
const LEASED_STATES = [
  'CLAIMED',
  'RUNNING',
  'WAITING_FOR_INTERACTION',
  'CANCEL_REQUESTED',
] as const;
const DEFAULT_LEASE_DURATION_MS = 15_000;
const POLL_INTERVAL_MS = 50;

export type ExecutionLifecycleHooks = {
  applyStarted: (execution: Execution) => void;
  afterStarted: (execution: Execution) => void;
  applyTerminal: (execution: Execution) => void;
  afterTerminal: (execution: Execution) => void;
  applyInteractionOpened: (interaction: ExecutionInteraction) => void;
  afterInteractionOpened: (interaction: ExecutionInteraction) => void;
};

const NOOP_HOOKS: ExecutionLifecycleHooks = {
  applyStarted: () => {},
  afterStarted: () => {},
  applyTerminal: () => {},
  afterTerminal: () => {},
  applyInteractionOpened: () => {},
  afterInteractionOpened: () => {},
};

export class ExecutionService {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly createLeaseToken: () => string = () =>
      randomBytes(32).toString('base64url'),
    private readonly leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS,
    private readonly hooks: ExecutionLifecycleHooks = NOOP_HOOKS,
  ) {}

  enqueue(inputValue: EnqueueExecutionInput): Execution {
    const input = EnqueueExecutionInputSchema.parse(inputValue);
    const executionId = input.id ?? this.createId();
    const createdAt = this.now().toISOString();
    const attachments = input.attachmentIds.map((fileId) => {
      const row = this.db
        .prepare(
          `SELECT id file_id, original_name, media_type, size_bytes, sha256
           FROM platform_file WHERE id = ?`,
        )
        .get(fileId) as AttachmentRow | undefined;
      if (!row) throw new PlatformError('NOT_FOUND', 'Execution 附件不存在');
      return row;
    });

    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO platform_execution(
               id, owner_namespace, owner_kind, owner_id, attempt,
               previous_execution_id, runner_id, binding_id, priority, state,
               prompt_kind, prompt_version, rendered_prompt,
               rendered_prompt_hash, output_json_schema, resume_session_id,
               session_id, lease_token_hash, lease_expires_at, outcome_json,
               reported_outcome_json, cancellation_requested, created_at,
               claimed_at, started_at, finished_at
             ) VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?,
               NULL, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, NULL
             )`,
          )
          .run(
            executionId,
            input.owner.namespace,
            input.owner.kind,
            input.owner.id,
            input.attempt,
            input.previousExecutionId,
            input.runnerId,
            input.bindingId,
            input.priority,
            input.promptKind,
            input.promptVersion,
            input.renderedPrompt,
            input.renderedPromptHash,
            JSON.stringify(input.outputJsonSchema),
            input.resumeSessionId,
            createdAt,
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
          '该 Binding 已有活动 Execution',
          { cause: error },
        );
      throw error;
    }
    return this.get(executionId);
  }

  async claim(
    runnerId: string,
    availableSlots: number,
    waitMs: number,
  ): Promise<ClaimedExecution[]> {
    const deadline = Date.now() + waitMs;
    do {
      const claimed = this.claimAvailable(runnerId, availableSlots);
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
        this.db
          .prepare(
            `UPDATE platform_execution
             SET state = 'FAILED', outcome_json = ?, finished_at = ?,
                 lease_expires_at = NULL
             WHERE id = ?`,
          )
          .run(JSON.stringify(outcome), now, executionId);
        this.invalidatePendingInteractions(executionId, now);
      } else {
        this.db
          .prepare(
            `UPDATE platform_execution
             SET state = CASE
                   WHEN cancellation_requested = 1 THEN 'CANCEL_REQUESTED'
                   ELSE 'RUNNING'
                 END,
                 session_id = ?, started_at = COALESCE(started_at, ?)
             WHERE id = ?`,
          )
          .run(request.sessionId, now, executionId);
      }
      const execution = this.mapExecution({ ...row, id: executionId });
      if (request.kind === 'START_FAILED') this.hooks.applyTerminal(execution);
      else this.hooks.applyStarted(execution);
      return this.get(executionId);
    })();
    if (request.kind === 'START_FAILED') this.hooks.afterTerminal(result);
    else this.hooks.afterStarted(result);
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
      const expiresAt = this.newLeaseExpiry();
      this.db
        .prepare(
          `UPDATE platform_execution SET lease_expires_at = ? WHERE id = ?`,
        )
        .run(expiresAt, executionId);
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
      const existing = this.findPendingInteraction(executionId);
      if (existing) {
        if (
          existing.kind === request.kind &&
          existing.method === request.method &&
          existing.payload_json === JSON.stringify(request.payload)
        )
          return mapInteraction(existing);
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          'Execution 已有待处理 Interaction',
        );
      }
      const id = this.createId();
      const createdAt = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO platform_execution_interaction(
             id, execution_id, kind, method, payload_json, state,
             resolution_json, created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, ?, NULL)`,
        )
        .run(
          id,
          executionId,
          request.kind,
          request.method,
          JSON.stringify(request.payload),
          createdAt,
        );
      this.db
        .prepare(
          `UPDATE platform_execution
           SET state = 'WAITING_FOR_INTERACTION'
           WHERE id = ?`,
        )
        .run(executionId);
      const interaction = this.getInteraction(id);
      this.hooks.applyInteractionOpened(interaction);
      opened = true;
      return interaction;
    })();
    if (opened) this.hooks.afterInteractionOpened(result);
    return result;
  }

  async waitInteraction(
    runnerId: string,
    executionId: string,
    interactionId: string,
    leaseToken: string,
    waitMs: number,
  ): Promise<ExecutionInteraction> {
    const deadline = Date.now() + waitMs;
    do {
      this.requireLeasedExecution(runnerId, executionId, leaseToken, [
        'WAITING_FOR_INTERACTION',
        'RUNNING',
        'CANCEL_REQUESTED',
      ]);
      const interaction = this.latestInteraction(executionId);
      if (!interaction || interaction.id !== interactionId)
        throw new PlatformError('NOT_FOUND', 'Execution Interaction 不存在');
      if (interaction.state !== 'PENDING' || Date.now() >= deadline)
        return mapInteraction(interaction);
      await sleep(
        Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
      );
    } while (Date.now() <= deadline);
    const interaction = this.latestInteraction(executionId);
    if (!interaction || interaction.id !== interactionId)
      throw new PlatformError('NOT_FOUND', 'Execution Interaction 不存在');
    return mapInteraction(interaction);
  }

  resolveInteraction(
    interactionId: string,
    resolution: JsonValue,
  ): ExecutionInteraction {
    return this.db.transaction(() => {
      const interaction = this.getInteractionRow(interactionId);
      if (interaction.state !== 'PENDING')
        throw new PlatformError(
          'STALE_STATE',
          'Execution Interaction 已失效或已处理',
        );
      const execution = this.getRow(interaction.execution_id);
      if (
        !LEASED_STATES.includes(
          execution.state as (typeof LEASED_STATES)[number],
        ) ||
        !execution.lease_expires_at ||
        Date.parse(execution.lease_expires_at) <= this.now().getTime()
      ) {
        this.expireLeases();
        throw new PlatformError('LEASE_EXPIRED', 'Execution Lease 已失效');
      }
      const resolvedAt = this.now().toISOString();
      this.db
        .prepare(
          `UPDATE platform_execution_interaction
           SET state = 'RESOLVED', resolution_json = ?, resolved_at = ?
           WHERE id = ? AND state = 'PENDING'`,
        )
        .run(JSON.stringify(resolution), resolvedAt, interactionId);
      this.db
        .prepare(
          `UPDATE platform_execution
           SET state = CASE
                 WHEN cancellation_requested = 1 THEN 'CANCEL_REQUESTED'
                 ELSE 'RUNNING'
               END
           WHERE id = ?`,
        )
        .run(interaction.execution_id);
      return this.getInteraction(interactionId);
    })();
  }

  complete(
    runnerId: string,
    executionId: string,
    request: CompleteExecutionRequest,
  ): Execution {
    let newlyTerminal = false;
    const result = this.db.transaction(() => {
      const row = this.getRow(executionId);
      if (row.runner_id !== runnerId)
        throw new PlatformError('NOT_FOUND', 'Execution 不存在');
      const tokenHash = hashSecret(request.leaseToken);
      if (isTerminal(row.state)) {
        if (
          row.lease_token_hash === tokenHash &&
          row.session_id === request.sessionId &&
          row.reported_outcome_json === JSON.stringify(request.outcome)
        )
          return this.mapExecution(row);
        throw new PlatformError(
          'OUTCOME_CONFLICT',
          'Execution Outcome 与已保存结果冲突',
        );
      }
      this.requireLeasedRow(row, request.leaseToken, [
        'RUNNING',
        'CANCEL_REQUESTED',
      ]);
      if (row.session_id !== request.sessionId)
        throw new PlatformError('STALE_STATE', 'Execution Session 不匹配');
      const finishedAt = this.now().toISOString();
      this.db
        .prepare(
          `UPDATE platform_execution
           SET state = ?, outcome_json = ?, reported_outcome_json = ?,
               finished_at = ?, lease_expires_at = NULL
           WHERE id = ?`,
        )
        .run(
          request.outcome.kind,
          JSON.stringify(request.outcome),
          JSON.stringify(request.outcome),
          finishedAt,
          executionId,
        );
      this.invalidatePendingInteractions(executionId, finishedAt);
      const execution = this.get(executionId);
      this.hooks.applyTerminal(execution);
      newlyTerminal = true;
      return this.get(executionId);
    })();
    if (newlyTerminal) this.hooks.afterTerminal(result);
    return result;
  }

  setQueuedPriority(executionId: string, priority: number): Execution {
    const update = this.db
      .prepare(
        `UPDATE platform_execution SET priority = ?
         WHERE id = ? AND state = 'QUEUED'`,
      )
      .run(priority, executionId);
    if (update.changes !== 1)
      throw new PlatformError(
        'INVALID_TRANSITION',
        '只有排队中的 Execution 可以调整优先级',
      );
    return this.get(executionId);
  }

  cancelQueued(executionId: string, reason: string): Execution {
    const finishedAt = this.now().toISOString();
    const outcome: ExecutionOutcome = { kind: 'CANCELLED', reason };
    const update = this.db
      .prepare(
        `UPDATE platform_execution
         SET state = 'CANCELLED', outcome_json = ?, finished_at = ?
         WHERE id = ? AND state = 'QUEUED'`,
      )
      .run(JSON.stringify(outcome), finishedAt, executionId);
    if (update.changes !== 1)
      throw new PlatformError(
        'INVALID_TRANSITION',
        '只有尚未领取的 Execution 可以取消',
      );
    const execution = this.get(executionId);
    this.invalidatePendingInteractions(executionId, finishedAt);
    this.hooks.applyTerminal(execution);
    this.hooks.afterTerminal(execution);
    return execution;
  }

  requestCancellation(executionId: string): Execution {
    return this.db.transaction(() => {
      const row = this.getRow(executionId);
      if (isTerminal(row.state)) return this.mapExecution(row);
      this.db
        .prepare(
          `UPDATE platform_execution
           SET cancellation_requested = 1,
               state = CASE
                 WHEN state IN ('CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION')
                   THEN 'CANCEL_REQUESTED'
                 ELSE state
               END
           WHERE id = ?`,
        )
        .run(executionId);
      return this.get(executionId);
    })();
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
    const row = this.db
      .prepare(
        `SELECT a.file_id, a.original_name, a.media_type, a.size_bytes,
                a.sha256, f.storage_key
         FROM platform_execution_attachment a
         JOIN platform_file f ON f.id = a.file_id
         WHERE a.execution_id = ? AND a.file_id = ?`,
      )
      .get(executionId, fileId) as FileRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Execution 附件不存在');
    return row;
  }

  get(executionId: string): Execution {
    return this.mapExecution(this.getRow(executionId));
  }

  activityForRunner(runnerId: string): RunnerActivity {
    this.expireLeases();
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN state IN (
             'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION', 'CANCEL_REQUESTED'
           ) THEN 1 ELSE 0 END) active_count,
           SUM(CASE WHEN state = 'WAITING_FOR_INTERACTION'
             THEN 1 ELSE 0 END) waiting_count
         FROM platform_execution WHERE runner_id = ?`,
      )
      .get(runnerId) as
      { active_count: number | null; waiting_count: number | null } | undefined;
    return RunnerActivitySchema.parse({
      activeExecutionCount: row?.active_count ?? 0,
      waitingInteractionCount: row?.waiting_count ?? 0,
    });
  }

  hasActiveExecutions(runnerId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 active FROM platform_execution
         WHERE runner_id = ? AND state IN (?, ?, ?, ?, ?)
         LIMIT 1`,
      )
      .get(runnerId, ...ACTIVE_STATES) as { active: number } | undefined;
    return Boolean(row);
  }

  private claimAvailable(
    runnerId: string,
    availableSlots: number,
  ): ClaimedExecution[] {
    if (availableSlots === 0) return [];
    return this.db.transaction(() => {
      this.expireLeases();
      const rows = this.db
        .prepare(
          `SELECT candidate.* FROM platform_execution candidate
           WHERE candidate.runner_id = ?
             AND candidate.state = 'QUEUED'
             AND NOT EXISTS (
               SELECT 1 FROM platform_execution active
               WHERE active.binding_id = candidate.binding_id
                 AND active.state IN (
                   'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION',
                   'CANCEL_REQUESTED'
                 )
             )
             AND NOT EXISTS (
               SELECT 1 FROM platform_execution earlier
               WHERE earlier.binding_id = candidate.binding_id
                 AND earlier.state = 'QUEUED'
                 AND (
                   earlier.priority < candidate.priority
                   OR (
                     earlier.priority = candidate.priority
                     AND earlier.created_at < candidate.created_at
                   )
                   OR (
                     earlier.priority = candidate.priority
                     AND earlier.created_at = candidate.created_at
                     AND earlier.rowid < candidate.rowid
                   )
                 )
             )
           ORDER BY candidate.priority, candidate.created_at, candidate.rowid
           LIMIT ?`,
        )
        .all(runnerId, availableSlots) as ExecutionRow[];
      return rows.map((row) => {
        const leaseToken = this.createLeaseToken();
        const expiresAt = this.newLeaseExpiry();
        const claimedAt = this.now().toISOString();
        this.db
          .prepare(
            `UPDATE platform_execution
             SET state = 'CLAIMED', lease_token_hash = ?,
                 lease_expires_at = ?, claimed_at = COALESCE(claimed_at, ?)
             WHERE id = ? AND state = 'QUEUED'`,
          )
          .run(hashSecret(leaseToken), expiresAt, claimedAt, row.id);
        return ClaimedExecutionSchema.parse({
          ...this.get(row.id),
          lease: { token: leaseToken, expiresAt },
          outcome: null,
        });
      });
    })();
  }

  private expireLeases(): void {
    const now = this.now().toISOString();
    const expired = this.db
      .prepare(
        `SELECT id FROM platform_execution
         WHERE state IN (?, ?, ?, ?)
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?`,
      )
      .all(...LEASED_STATES, now) as Array<{ id: string }>;
    const invalidate = this.db.prepare(
      `UPDATE platform_execution_interaction
       SET state = 'INVALIDATED', resolved_at = ?
       WHERE execution_id = ? AND state = 'PENDING'`,
    );
    const requeue = this.db.prepare(
      `UPDATE platform_execution
       SET state = 'QUEUED', resume_session_id = COALESCE(session_id, resume_session_id),
           lease_token_hash = NULL, lease_expires_at = NULL
       WHERE id = ?`,
    );
    for (const { id } of expired) {
      invalidate.run(now, id);
      requeue.run(id);
    }
  }

  private requireLeasedExecution(
    runnerId: string,
    executionId: string,
    leaseToken: string,
    states: Execution['state'][],
  ): ExecutionRow {
    const row = this.getRow(executionId);
    if (row.runner_id !== runnerId)
      throw new PlatformError('NOT_FOUND', 'Execution 不存在');
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
      throw new PlatformError('LEASE_EXPIRED', 'Execution Lease 已失效');
    if (Date.parse(row.lease_expires_at) <= this.now().getTime()) {
      this.expireLeases();
      throw new PlatformError('LEASE_EXPIRED', 'Execution Lease 已失效');
    }
  }

  private getRow(executionId: string): ExecutionRow {
    const row = this.db
      .prepare('SELECT * FROM platform_execution WHERE id = ?')
      .get(executionId) as ExecutionRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Execution 不存在');
    return row;
  }

  private mapExecution(row: ExecutionRow): Execution {
    const current = this.getRow(row.id);
    const attachments = this.db
      .prepare(
        `SELECT file_id, original_name, media_type, size_bytes, sha256
         FROM platform_execution_attachment
         WHERE execution_id = ? ORDER BY position`,
      )
      .all(current.id)
      .map((attachment) => {
        const value = attachment as AttachmentRow;
        return {
          id: value.file_id,
          originalName: value.original_name,
          mediaType: value.media_type,
          sizeBytes: value.size_bytes,
          sha256: value.sha256,
        };
      });
    return ExecutionSchema.parse({
      id: current.id,
      owner: {
        namespace: current.owner_namespace,
        kind: current.owner_kind,
        id: current.owner_id,
      },
      attempt: current.attempt,
      previousExecutionId: current.previous_execution_id,
      runnerId: current.runner_id,
      bindingId: current.binding_id,
      priority: current.priority,
      state: current.state,
      promptKind: current.prompt_kind,
      promptVersion: current.prompt_version,
      renderedPrompt: current.rendered_prompt,
      renderedPromptHash: current.rendered_prompt_hash,
      outputJsonSchema: JSON.parse(current.output_json_schema),
      attachments,
      resumeSessionId: current.resume_session_id,
      sessionId: current.session_id,
      lease: current.lease_expires_at
        ? { expiresAt: current.lease_expires_at }
        : null,
      outcome: current.outcome_json ? JSON.parse(current.outcome_json) : null,
      cancellationRequested: Boolean(current.cancellation_requested),
      createdAt: current.created_at,
      claimedAt: current.claimed_at,
      startedAt: current.started_at,
      finishedAt: current.finished_at,
    });
  }

  private findPendingInteraction(
    executionId: string,
  ): InteractionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM platform_execution_interaction
         WHERE execution_id = ? AND state = 'PENDING'`,
      )
      .get(executionId) as InteractionRow | undefined;
  }

  private latestInteraction(executionId: string): InteractionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM platform_execution_interaction
         WHERE execution_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(executionId) as InteractionRow | undefined;
  }

  private getInteractionRow(interactionId: string): InteractionRow {
    const row = this.db
      .prepare('SELECT * FROM platform_execution_interaction WHERE id = ?')
      .get(interactionId) as InteractionRow | undefined;
    if (!row)
      throw new PlatformError('NOT_FOUND', 'Execution Interaction 不存在');
    return row;
  }

  private getInteraction(interactionId: string): ExecutionInteraction {
    return mapInteraction(this.getInteractionRow(interactionId));
  }

  private invalidatePendingInteractions(
    executionId: string,
    resolvedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE platform_execution_interaction
         SET state = 'INVALIDATED', resolved_at = ?
         WHERE execution_id = ? AND state = 'PENDING'`,
      )
      .run(resolvedAt, executionId);
  }

  private newLeaseExpiry(): string {
    return new Date(this.now().getTime() + this.leaseDurationMs).toISOString();
  }
}

function mapInteraction(row: InteractionRow): ExecutionInteraction {
  return ExecutionInteractionSchema.parse({
    id: row.id,
    executionId: row.execution_id,
    kind: row.kind,
    method: row.method,
    payload: JSON.parse(row.payload_json),
    state: row.state,
    resolution: row.resolution_json ? JSON.parse(row.resolution_json) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  });
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
