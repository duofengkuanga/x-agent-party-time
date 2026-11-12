import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import {
  parseExecutionInteractionResolution,
  type ExecutionInteraction,
  type JsonValue,
  type OpenInteractionRequest,
  type WaitInteractionResponse,
  type YieldInteractionRequest,
  type ExecutionOutcome,
} from '@agent-party-time/execution-contract';
import { hashSecret, requireLeasedExecution } from './lease';
import { sleepUntilNextPoll } from './polling';
import { projectTransaction, type ExecutionProjector } from './projection';
import type { ExecutionQueue } from './queue';
import { mapInteraction, type ExecutionRecords } from './records';

export class ExecutionInteractions {
  constructor(
    private readonly db: AppDatabase,
    private readonly records: ExecutionRecords,
    private readonly queue: ExecutionQueue,
    private readonly now: () => Date,
    private readonly createId: () => string,
    private readonly project: ExecutionProjector,
  ) {}

  openInteraction(
    runnerId: string,
    executionId: string,
    request: OpenInteractionRequest,
  ): ExecutionInteraction {
    return projectTransaction(this.db, this.project, (emit) => {
      requireLeasedExecution(
        this.records,
        this.now,
        runnerId,
        executionId,
        request.leaseToken,
        request.method === 'xapt/manualHandoff'
          ? ['RUNNING', 'CANCEL_REQUESTED', 'WAITING_FOR_INTERACTION']
          : ['RUNNING', 'CANCEL_REQUESTED', 'WAITING_FOR_INTERACTION'],
      );
      const existing = this.records.findPendingInteraction(executionId);
      if (existing) {
        if (
          existing.kind === request.kind &&
          existing.method === request.method &&
          existing.payload_json === JSON.stringify(request.payload)
        )
          return mapInteraction(existing);
        throw new PlatformError('RESOURCE_CONFLICT', '该任务已有待处理的操作请求');
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
      emit({ kind: 'INTERACTION_OPENED', interaction });
      return interaction;
    });
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
      requireLeasedExecution(this.records, this.now, runnerId, executionId, leaseToken, [
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
          return this.waitResponse(mapInteraction(interaction), laneAcquired);
      } else if (interaction.state === 'INVALIDATED' || Date.now() >= deadline)
        return this.waitResponse(mapInteraction(interaction), false);
      await sleepUntilNextPoll(deadline);
    } while (Date.now() <= deadline);
    const interaction = this.records.latestInteraction(executionId);
    if (!interaction || interaction.id !== interactionId)
      throw new PlatformError('NOT_FOUND', '任务操作请求不存在');
    return this.waitResponse(
      mapInteraction(interaction),
      interaction.state === 'RESOLVED' && this.queue.tryAcquireResumeLane(executionId),
    );
  }

  private waitResponse(
    interaction: ExecutionInteraction,
    laneAcquired: boolean,
  ): WaitInteractionResponse {
    const turn = this.records.get(interaction.executionId).codexTurn;
    const yieldRequested =
      !laneAcquired &&
      interaction.state !== 'INVALIDATED' &&
      turn?.kind !== 'READ_SESSION' &&
      turn?.managedInteractions &&
      this.now().getTime() - Date.parse(interaction.createdAt) >= 60_000;
    return {
      interaction,
      laneAcquired,
      ...(yieldRequested ? { yieldRequested: true as const } : {}),
    };
  }

  yieldInteraction(
    runnerId: string,
    executionId: string,
    request: YieldInteractionRequest,
  ) {
    return projectTransaction(this.db, this.project, (emit) => {
      const row = this.records.getRow(executionId);
      const execution = this.records.mapExecution(row);
      const turn = execution.codexTurn;
      if (row.runner_id !== runnerId)
        throw new PlatformError('NOT_FOUND', '处理任务不存在');
      if (
        turn?.kind === 'READ_SESSION' ||
        !turn?.managedInteractions ||
        row.session_id !== request.sessionId
      )
        throw new PlatformError('INVALID_TRANSITION', '任务不支持交互让位');
      const latest = this.records.latestInteraction(executionId);
      const previous = this.db.get<{ id: string }>(
        `SELECT id FROM platform_execution_interaction
         WHERE execution_id = ? AND method = ? AND payload_json = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        executionId,
        request.method,
        JSON.stringify(request.payload),
      );
      if (previous && previous.id !== latest?.id) return execution;
      const matching =
        latest &&
        latest.method === request.method &&
        latest.payload_json === JSON.stringify(request.payload);
      if (
        !row.lease_token_hash &&
        matching &&
        ['WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME', 'CANCELLED'].includes(row.state)
      )
        return execution;
      const recoveredBeforeOpen =
        row.state === 'QUEUED' && !row.lease_token_hash && row.started_at !== null;
      if (!recoveredBeforeOpen && row.lease_token_hash !== hashSecret(request.leaseToken))
        throw new PlatformError('LEASE_EXPIRED', '任务领取凭据已失效');
      if (row.cancellation_requested === 1) {
        const outcome: ExecutionOutcome = {
          kind: 'CANCELLED',
          reason: '服务端已请求取消',
        };
        const finishedAt = this.now().toISOString();
        this.db.run(
          `UPDATE platform_execution SET state = 'CANCELLED', outcome_json = ?,
          finished_at = ?, lease_token_hash = NULL, lease_expires_at = NULL WHERE id = ?`,
          [JSON.stringify(outcome), finishedAt, executionId],
        );
        this.records.invalidatePendingInteractions(executionId, finishedAt);
        const cancelled = this.records.get(executionId);
        emit({ kind: 'TERMINAL', execution: cancelled });
        return cancelled;
      }
      if (
        !recoveredBeforeOpen &&
        !['RUNNING', 'WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME'].includes(row.state)
      )
        throw new PlatformError('INVALID_TRANSITION', '任务已经结束或不再等待交互');
      let interaction = latest;
      if (!matching) {
        if (latest?.state === 'PENDING')
          throw new PlatformError('RESOURCE_CONFLICT', '任务正在等待另一个问题');
        const id = this.createId();
        this.db.run(
          `INSERT INTO platform_execution_interaction(
          id, execution_id, kind, method, payload_json, state, resolution_json, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, ?, NULL)`,
          [
            id,
            executionId,
            request.kind,
            request.method,
            JSON.stringify(request.payload),
            this.now().toISOString(),
          ],
        );
        interaction = this.records.latestInteraction(executionId)!;
        emit({ kind: 'INTERACTION_OPENED', interaction: mapInteraction(interaction) });
      }
      if (interaction?.state === 'INVALIDATED')
        throw new PlatformError('STALE_STATE', '问题已失效');
      this.db.run(
        `UPDATE platform_execution SET state = ?, lease_token_hash = NULL,
        lease_expires_at = NULL, resume_requested_at = ? WHERE id = ?`,
        [
          interaction?.state === 'RESOLVED'
            ? 'WAITING_TO_RESUME'
            : 'WAITING_FOR_INTERACTION',
          interaction?.resolved_at ?? null,
          executionId,
        ],
      );
      return this.records.get(executionId);
    });
  }

  resolveInteraction(interactionId: string, resolution: JsonValue): ExecutionInteraction {
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
}
