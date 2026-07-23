import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AppErrorSchema,
  DurableEventSchema,
  EVENT_NAMES,
  ERROR_CODES,
  OutboxEntrySchema,
  PROTOCOL_VERSION,
  RunnerContextSchema,
  WakeObjectiveSchema,
  createAppError,
  normalizeError,
  type AgentRunner,
  type AppError,
  type ConfigStore,
  type LeasedJobResult,
  type RunnerResult,
  type StateStore,
  type WakeJob,
} from '@agent-party-time/shared';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { TaskService } from '../tasks/task-service.js';

export const RetryDecisionSchema = z.object({
  action: z.enum(['retry', 'fail', 'cancel']),
  nextAttemptAt: z.string().datetime().nullable(),
  reason: AppErrorSchema,
});
export type RetryDecision = z.infer<typeof RetryDecisionSchema>;
export const SchedulerSummarySchema = z.object({
  acceptingJobs: z.boolean(),
  queued: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
  maxConcurrentRuns: z.number().int().positive(),
});
export type SchedulerSummary = z.infer<typeof SchedulerSummarySchema>;
interface ActiveRun {
  jobId: string;
  runId: string;
  sessionKey: string;
  workspacePath: string;
  leaseGeneration: number;
  abortController: AbortController;
  completion: Promise<void>;
}
export interface SchedulerOptions {
  instanceId: string;
  store: StateStore;
  configStore: ConfigStore;
  sessionManager: SessionManager;
  taskService: TaskService;
  runner: AgentRunner;
  clock: Clock;
  logger: Logger;
  maxConcurrentRuns: number;
  leaseDurationMs: number;
  tickIntervalMs?: number;
}

export class Scheduler {
  private readonly active = new Map<string, ActiveRun>();
  private timer: unknown = null;
  private ticking = false;
  private accepting = false;
  private queuedCount = 0;
  constructor(private readonly options: SchedulerOptions) {}
  async start(): Promise<void> {
    if (this.accepting) return;
    this.accepting = true;
    await this.refreshCounts();
    await this.tick();
    this.timer = this.options.clock.setInterval(
      () => void this.tick(),
      this.options.tickIntervalMs ?? 500,
    );
  }
  notify(): void {
    if (this.accepting) void this.tick();
  }
  summary(): SchedulerSummary {
    return SchedulerSummarySchema.parse({
      acceptingJobs: this.accepting,
      queued: this.queuedCount,
      activeRuns: this.active.size,
      maxConcurrentRuns: this.options.maxConcurrentRuns,
    });
  }
  async tick(): Promise<void> {
    if (!this.accepting || this.ticking) return;
    this.ticking = true;
    try {
      while (this.active.size < this.options.maxConcurrentRuns) {
        const now = this.options.clock.now();
        const leased = await this.options.store.leaseNextJob({
          ownerInstanceId: this.options.instanceId,
          now: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + this.options.leaseDurationMs,
          ).toISOString(),
          excludedSessionKeys: [...this.active.values()].map(
            (item) => item.sessionKey,
          ),
          excludedWorkspacePaths: [...this.active.values()].map(
            (item) => item.workspacePath,
          ),
        });
        if (!leased) break;
        const controller = new AbortController();
        const placeholder = Promise.resolve();
        const active: ActiveRun = {
          jobId: leased.job.id,
          runId: leased.run.id,
          sessionKey: leased.job.sessionKey,
          workspacePath: '',
          leaseGeneration: leased.run.leaseGeneration,
          abortController: controller,
          completion: placeholder,
        };
        active.completion = this.execute(leased, active).finally(() => {
          this.active.delete(active.runId);
          void this.refreshCounts();
          this.notify();
        });
        this.active.set(active.runId, active);
      }
      await this.refreshCounts();
    } finally {
      this.ticking = false;
    }
  }
  async cancel(
    target:
      | { targetKind: 'job'; jobId: string; reason: string }
      | { targetKind: 'run'; runId: string; reason: string },
  ) {
    const active =
      target.targetKind === 'run'
        ? this.active.get(target.runId)
        : [...this.active.values()].find((item) => item.jobId === target.jobId);
    if (active) {
      active.abortController.abort(target.reason);
      return {
        job: await this.options.store.jobs.get(active.jobId),
        run: await this.options.store.runs.get(active.runId),
      };
    }
    const jobId =
      target.targetKind === 'job'
        ? target.jobId
        : (await this.options.store.runs.get(target.runId))?.jobId;
    if (!jobId) throw this.notFound();
    const job = await this.options.store.jobs.cancel(jobId);
    return {
      job,
      run:
        target.targetKind === 'run'
          ? await this.options.store.runs.get(target.runId)
          : null,
    };
  }
  async retry(jobId: string) {
    const job = await this.options.store.retryJob(
      jobId,
      this.options.clock.now().toISOString(),
    );
    this.notify();
    return {
      job,
      run: (await this.options.store.runs.listByJob(jobId)).at(-1) ?? null,
    };
  }
  async drain(): Promise<void> {
    await Promise.all([...this.active.values()].map((item) => item.completion));
  }
  async stop(): Promise<void> {
    this.accepting = false;
    if (this.timer) this.options.clock.clearInterval(this.timer);
    this.timer = null;
    for (const item of this.active.values())
      item.abortController.abort('service stopping');
    await this.drain();
  }

  private async execute(
    leased: LeasedJobResult,
    active: ActiveRun,
  ): Promise<void> {
    const { job, run } = leased;
    const logger = this.options.logger.child({
      jobId: job.id,
      runId: run.id,
      agentId: job.agentId,
    });
    let renewal: unknown = null;
    try {
      const config = await this.options.configStore.load();
      const agent = config.agents.find(
        (item) => item.id === job.agentId && item.enabled,
      );
      if (!agent)
        throw createAppError({
          code: ERROR_CODES.entityNotFound,
          category: 'not_found',
          message: `agent ${job.agentId} 不存在或已禁用`,
          retryable: false,
        });
      const source = await this.options.store.getWakeSource(job.id);
      const session = await this.options.sessionManager.getOrCreate({
        agentId: agent.id,
        channelKey: source.channelKey,
        workspacePath: agent.workspacePath,
      });
      active.workspacePath = session.workspacePath;
      const objective = WakeObjectiveSchema.parse({
        kind: job.triggerKind,
        agentId: agent.id,
        sessionKey: session.key,
        workspacePath: session.workspacePath,
        messageAnchor: source.messageAnchor,
        taskId: job.taskId,
        parentRunId: null,
        instructions: source.instructions,
        deadlineAt: job.deadlineAt,
      });
      const deadlineAt = new Date(
        Math.min(
          Date.parse(job.deadlineAt),
          this.options.clock.now().getTime() +
            config.settings.codexRunTimeoutMs,
        ),
      ).toISOString();
      const context = RunnerContextSchema.parse({
        jobId: job.id,
        runId: run.id,
        correlationId: job.idempotencyKey,
        agent,
        session,
        objective,
        workspacePath: session.workspacePath,
        deadlineAt,
      });
      renewal = this.options.clock.setInterval(
        () => void this.renew(active),
        Math.max(1_000, Math.floor(this.options.leaseDurationMs / 2)),
      );
      let result: RunnerResult;
      try {
        result = await this.options.runner.run(
          context,
          {
            onProgress: (progress) =>
              logger.info('run.progress', progress.message, {
                phase: progress.phase,
              }),
          },
          active.abortController.signal,
        );
      } catch (error) {
        result = {
          status: 'failed',
          error: normalizeError(error),
          sessionUpdate: null,
        };
      }
      if (renewal) this.options.clock.clearInterval(renewal);
      renewal = null;
      const outbox =
        result.status === 'succeeded' && source.subscriptionId
          ? OutboxEntrySchema.parse({
              id: randomUUID(),
              runId: run.id,
              destination: {
                subscriptionId: source.subscriptionId,
                channelKey: source.channelKey,
                ...(source.threadKey ? { threadKey: source.threadKey } : {}),
                ...(source.messageAnchor?.eventId
                  ? { replyToEventId: source.messageAnchor.eventId }
                  : {}),
              },
              text: result.finalText,
              dedupeKey: `run:${run.id}:reply`,
              state: 'pending',
              attemptCount: 0,
              lease: null,
              nextAttemptAt: null,
              providerMessageId: null,
              lastError: null,
              createdAt: this.options.clock.now().toISOString(),
              updatedAt: this.options.clock.now().toISOString(),
            })
          : null;
      const taskMutation =
        result.status === 'succeeded' && job.taskId
          ? await this.options.taskService.prepareRunCompletion({
              taskId: job.taskId,
              expectedRevision: (await this.options.taskService.get(job.taskId))
                .revision,
              runId: run.id,
              agentId: agent.id,
              summary: result.finalText,
            })
          : null;
      const retryNextAttemptAt = this.retryNextAttemptAt(job, result);
      const events = this.completionEvents(
        job,
        run.id,
        result,
        outbox?.id ?? null,
        retryNextAttemptAt,
      );
      await this.options.store.completeRun({
        jobId: job.id,
        runId: run.id,
        leaseOwnerInstanceId: this.options.instanceId,
        leaseGeneration: run.leaseGeneration,
        result,
        outboxEntry: outbox,
        taskMutation,
        retryNextAttemptAt,
        events,
      });
    } catch (error) {
      if (renewal) this.options.clock.clearInterval(renewal);
      const appError = normalizeError(error);
      logger.error(
        'scheduler.execute_failed',
        'scheduler 执行 job 失败',
        appError,
      );
      try {
        const terminalResult: RunnerResult = active.abortController.signal
          .aborted
          ? {
              status: 'cancelled',
              error: createAppError({
                code: ERROR_CODES.runnerCancelled,
                category: 'cancelled',
                message: 'run 已取消',
                retryable: false,
              }),
              sessionUpdate: null,
            }
          : { status: 'failed', error: appError, sessionUpdate: null };
        const retryNextAttemptAt = this.retryNextAttemptAt(job, terminalResult);
        await this.options.store.completeRun({
          jobId: job.id,
          runId: run.id,
          leaseOwnerInstanceId: this.options.instanceId,
          leaseGeneration: run.leaseGeneration,
          result: terminalResult,
          outboxEntry: null,
          taskMutation: null,
          retryNextAttemptAt,
          events: this.completionEvents(
            job,
            run.id,
            terminalResult,
            null,
            retryNextAttemptAt,
          ),
        });
      } catch (commitError) {
        logger.fatal(
          'scheduler.commit_failed',
          '无法提交 run 终态',
          commitError,
        );
      }
    }
  }
  private async renew(active: ActiveRun) {
    try {
      const now = this.options.clock.now();
      await this.options.store.renewJobLease(
        active.jobId,
        this.options.instanceId,
        active.leaseGeneration,
        new Date(now.getTime() + this.options.leaseDurationMs).toISOString(),
      );
    } catch (error) {
      this.options.logger.error(
        'scheduler.lease_renew_failed',
        'job lease 续租失败',
        error,
        { jobId: active.jobId },
      );
      if ((error as { code?: string }).code === ERROR_CODES.jobLeaseLost)
        active.abortController.abort('lease lost');
    }
  }
  private completionEvents(
    job: WakeJob,
    runId: string,
    result: RunnerResult,
    outboxEntryId: string | null,
    retryNextAttemptAt: string | null,
  ) {
    const now = this.options.clock.now().toISOString();
    const base = (name: string, payload: object) =>
      DurableEventSchema.parse({
        schema: PROTOCOL_VERSION,
        id: randomUUID(),
        name,
        occurredAt: now,
        correlationId: job.idempotencyKey,
        causationId: runId,
        payload,
      });
    if (result.status === 'succeeded') {
      const events = [
        base(EVENT_NAMES.runCompleted, {
          runId,
          jobId: job.id,
          taskId: job.taskId,
          outboxEntryId,
        }),
        base(EVENT_NAMES.jobSucceeded, { jobId: job.id, runId }),
      ];
      if (outboxEntryId)
        events.push(base(EVENT_NAMES.replyQueued, { outboxEntryId, runId }));
      return events;
    }
    if (result.status === 'cancelled')
      return [
        base(EVENT_NAMES.runCancelled, {
          runId,
          jobId: job.id,
          taskId: job.taskId,
        }),
        base(EVENT_NAMES.jobCancelled, { jobId: job.id, runId }),
      ];
    return [
      base(EVENT_NAMES.runFailed, {
        runId,
        jobId: job.id,
        taskId: job.taskId,
        error: result.error,
      }),
      retryNextAttemptAt
        ? base(EVENT_NAMES.jobRetryScheduled, {
            jobId: job.id,
            runId,
            nextAttemptAt: retryNextAttemptAt,
          })
        : base(EVENT_NAMES.jobFailed, {
            jobId: job.id,
            runId,
            error: result.error,
          }),
    ];
  }
  private retryNextAttemptAt(
    job: WakeJob,
    result: RunnerResult,
  ): string | null {
    if (
      result.status !== 'failed' ||
      !result.error.retryable ||
      job.attemptCount >= job.maxAttempts
    )
      return null;
    const next = new Date(
      this.options.clock.now().getTime() +
        Math.min(60_000, 2_000 * 2 ** Math.max(0, job.attemptCount - 1)),
    );
    return next.getTime() < Date.parse(job.deadlineAt)
      ? next.toISOString()
      : null;
  }
  private notFound() {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message: 'run/job 不存在',
      retryable: false,
    });
  }
  private async refreshCounts() {
    const counts = await this.options.store.jobs.countByState();
    this.queuedCount = counts.queued + counts.retry_wait;
  }
}
