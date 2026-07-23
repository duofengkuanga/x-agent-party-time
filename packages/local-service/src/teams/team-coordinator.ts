import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AppErrorSchema,
  ArtifactReferenceSchema,
  DurableEventSchema,
  EVENT_NAMES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  WakeJobSchema,
  createAppError,
  type ConfigStore,
  type StateStore,
  type TeamLineage,
} from '@agent-party-time/shared';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';

export const WorkerRequestSchema = z.object({
  rootAgentId: z.string().min(1),
  parentAgentId: z.string().min(1),
  parentRunId: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  role: z.string().min(1),
  objective: z.string().min(1).max(100_000),
  workspacePath: z.string().min(1),
  depth: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
});
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export const WorkerResultSchema = z.object({
  workerAgentId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'expired']),
  summary: z.string().max(100_000).nullable(),
  references: z.array(ArtifactReferenceSchema).max(100),
  error: AppErrorSchema.nullable(),
});
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export const TeamPolicySchema = z.object({
  maxDepth: z.number().int().nonnegative(),
  maxWorkersPerTeam: z.number().int().positive(),
  maxConcurrentWorkersPerRoot: z.number().int().positive(),
  defaultWorkerTtlMs: z.number().int().positive(),
  workerCanReplyToChannel: z.literal(false),
});
export type TeamPolicy = z.infer<typeof TeamPolicySchema>;
export interface TeamCoordinatorOptions {
  store: StateStore;
  configStore: ConfigStore;
  clock: Clock;
  logger: Logger;
  policy?: TeamPolicy;
  onJobQueued?: () => void;
}

export class TeamCoordinator {
  private readonly lineages = new Map<string, TeamLineage>();
  private readonly results = new Map<string, WorkerResult>();
  private readonly policy: TeamPolicy;
  constructor(private readonly options: TeamCoordinatorOptions) {
    this.policy = TeamPolicySchema.parse(
      options.policy ?? {
        maxDepth: 2,
        maxWorkersPerTeam: 8,
        maxConcurrentWorkersPerRoot: 4,
        defaultWorkerTtlMs: 30 * 60_000,
        workerCanReplyToChannel: false,
      },
    );
  }
  async spawnWorker(raw: WorkerRequest) {
    const input = WorkerRequestSchema.parse(raw);
    if (input.depth + 1 > this.policy.maxDepth)
      throw createAppError({
        code: ERROR_CODES.storeConstraintConflict,
        category: 'conflict',
        message: 'worker depth 超出限制',
        retryable: false,
      });
    const config = await this.options.configStore.load();
    if (
      !config.agents.some(
        (agent) => agent.id === input.rootAgentId && agent.enabled,
      ) ||
      !config.agents.some(
        (agent) => agent.id === input.parentAgentId && agent.enabled,
      )
    )
      throw this.notFound('root/parent agent');
    const teamId = `${input.rootAgentId}:${input.parentRunId}`;
    const persisted = await this.options.store.teams.listLineages(teamId);
    if (persisted.length >= this.policy.maxWorkersPerTeam)
      throw createAppError({
        code: ERROR_CODES.storeConstraintConflict,
        category: 'conflict',
        message: 'team worker 数量已达上限',
        retryable: false,
      });
    const workerAgentId = `worker-${randomUUID()}`;
    const now = this.options.clock.now();
    const lineage: TeamLineage = {
      teamId,
      rootAgentId: input.rootAgentId,
      parentAgentId: input.parentAgentId,
      workerAgentId,
      role: input.role,
      depth: input.depth + 1,
      expiresAt: input.expiresAt,
      createdAt: now.toISOString(),
    };
    this.lineages.set(workerAgentId, lineage);
    const job = WakeJobSchema.parse({
      id: randomUUID(),
      idempotencyKey: `worker:${input.parentRunId}:${workerAgentId}`,
      triggerKind: 'worker',
      agentId: input.parentAgentId,
      sessionKey: `worker:${workerAgentId}`,
      taskId: input.taskId,
      sourceRef: input.objective,
      priority: 30,
      state: 'queued',
      attemptCount: 0,
      maxAttempts: 2,
      lease: null,
      nextAttemptAt: null,
      deadlineAt: input.expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const event = DurableEventSchema.parse({
      schema: PROTOCOL_VERSION,
      id: randomUUID(),
      name: EVENT_NAMES.workerSpawned,
      occurredAt: now.toISOString(),
      correlationId: teamId,
      causationId: input.parentRunId,
      payload: { teamId, workerAgentId, parentAgentId: input.parentAgentId },
    });
    await this.options.store.createWorker(lineage, job, event);
    this.options.onJobQueued?.();
    return { lineage, job };
  }
  async submitWorkerResult(raw: WorkerResult) {
    const result = WorkerResultSchema.parse(raw);
    if (!(await this.options.store.teams.getLineage(result.workerAgentId)))
      throw this.notFound('worker');
    this.results.set(result.workerAgentId, result);
    return this.queueParentSynthesis(result.workerAgentId);
  }
  async queueParentSynthesis(workerAgentId: string) {
    const lineage =
      this.lineages.get(workerAgentId) ??
      (await this.options.store.teams.getLineage(workerAgentId));
    const result = this.results.get(workerAgentId);
    if (!lineage || !result) throw this.notFound('worker result');
    const now = this.options.clock.now();
    const job = WakeJobSchema.parse({
      id: randomUUID(),
      idempotencyKey: `parent-synthesis:${result.runId}`,
      triggerKind: 'parent_synthesis',
      agentId: lineage.parentAgentId ?? lineage.rootAgentId,
      sessionKey: `parent:${lineage.parentAgentId ?? lineage.rootAgentId}`,
      taskId: null,
      sourceRef: result.summary ?? result.error?.message ?? result.status,
      priority: 60,
      state: 'queued',
      attemptCount: 0,
      maxAttempts: 2,
      lease: null,
      nextAttemptAt: null,
      deadlineAt: new Date(
        now.getTime() + this.policy.defaultWorkerTtlMs,
      ).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await this.options.store.jobs.enqueue(job);
    this.options.onJobQueued?.();
    return job;
  }
  async routeToSquad(squadId: string, preferredAgentId?: string) {
    const squad = await this.options.store.teams.getSquad(squadId);
    if (!squad) throw this.notFound('squad');
    const config = await this.options.configStore.load();
    const enabled = new Set(
      config.agents.filter((agent) => agent.enabled).map((agent) => agent.id),
    );
    if (
      preferredAgentId &&
      squad.memberAgentIds.includes(preferredAgentId) &&
      enabled.has(preferredAgentId)
    )
      return preferredAgentId;
    const candidate = [...squad.memberAgentIds]
      .filter((id) => enabled.has(id))
      .sort()[0];
    return candidate ?? squad.leaderAgentId;
  }
  async expireWorkers() {
    const now = this.options.clock.now().getTime();
    const expired = [...this.lineages.values()].filter(
      (item) =>
        Date.parse(item.expiresAt) <= now &&
        !this.results.has(item.workerAgentId),
    );
    for (const lineage of expired)
      this.results.set(
        lineage.workerAgentId,
        WorkerResultSchema.parse({
          workerAgentId: lineage.workerAgentId,
          runId: `expired:${lineage.workerAgentId}`,
          status: 'expired',
          summary: null,
          references: [],
          error: null,
        }),
      );
    return expired;
  }
  private notFound(entity: string) {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message: `${entity} 不存在`,
      retryable: false,
    });
  }
}
