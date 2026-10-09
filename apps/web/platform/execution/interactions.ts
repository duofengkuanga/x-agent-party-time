import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  parseExecutionInteractionResolution,
  type ExecutionInteraction,
  type JsonValue,
  type OpenInteractionRequest,
  type WaitInteractionResponse,
} from '@agent-party-time/execution-contract';
import { requireLeasedExecution } from './lease';
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
        ['RUNNING', 'CANCEL_REQUESTED'],
      );
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
      requireLeasedExecution(
        this.records,
        this.now,
        runnerId,
        executionId,
        leaseToken,
        [
          'WAITING_FOR_INTERACTION',
          'WAITING_TO_RESUME',
          'RUNNING',
          'CANCEL_REQUESTED',
        ],
      );
      const interaction = this.records.latestInteraction(executionId);
      if (!interaction || interaction.id !== interactionId)
        throw new PlatformError('NOT_FOUND', '任务操作请求不存在');
      if (interaction.state === 'RESOLVED') {
        const laneAcquired = this.queue.tryAcquireResumeLane(executionId);
        if (laneAcquired || Date.now() >= deadline)
          return { interaction: mapInteraction(interaction), laneAcquired };
      } else if (interaction.state === 'INVALIDATED' || Date.now() >= deadline)
        return {
          interaction: mapInteraction(interaction),
          laneAcquired: false,
        };
      await sleepUntilNextPoll(deadline);
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
}
