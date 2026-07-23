import { z } from 'zod';
import type { ConfigStore, ServiceConfig } from '@agent-party-time/shared';
import type { LocalApiServer } from '../api/server.js';
import {
  ChannelHealthSummarySchema,
  type ChannelManager,
} from '../channels/channel-manager.js';
import type { EventJournal } from '../events/event-journal.js';
import type { Clock, HeartbeatService } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';
import {
  OutboxSummarySchema,
  type ReplyOutbox,
} from '../outbox/reply-outbox.js';
import {
  SchedulerSummarySchema,
  type Scheduler,
} from '../scheduler/scheduler.js';

export const SupervisorStateSchema = z.enum([
  'created',
  'starting',
  'running',
  'degraded',
  'stopping',
  'stopped',
  'failed',
]);
export type SupervisorState = z.infer<typeof SupervisorStateSchema>;
export const ModuleHealthSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['ready', 'degraded', 'unavailable', 'stopped']),
  message: z.string().min(1).max(2_000).optional(),
  checkedAt: z.string().datetime(),
});
export type ModuleHealth = z.infer<typeof ModuleHealthSchema>;
export const ServiceStatusSchema = z.object({
  state: SupervisorStateSchema,
  startedAt: z.string().datetime().nullable(),
  configRevision: z.number().int().nonnegative().nullable(),
  modules: z.array(ModuleHealthSchema),
  channels: ChannelHealthSummarySchema,
  scheduler: SchedulerSummarySchema,
  outbox: OutboxSummarySchema,
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export interface SupervisedWorker {
  start(): void;
  stop(): Promise<void>;
  running(): boolean;
}
export interface ServiceSupervisorOptions {
  configStore: ConfigStore;
  apiServer: LocalApiServer;
  heartbeat: HeartbeatService;
  outbox: ReplyOutbox;
  scheduler: Scheduler;
  channels: ChannelManager;
  eventJournal: EventJournal;
  backgroundWorkers: readonly {
    name: string;
    worker: SupervisedWorker;
  }[];
  logger: Logger;
  clock: Clock;
  shutdownGracePeriodMs: number;
}

export class ServiceSupervisor {
  private state: SupervisorState = 'created';
  private startedAt: string | null = null;
  private config: ServiceConfig | null = null;
  private watcher = new AbortController();
  private shutdownPromise: Promise<void> | null = null;
  constructor(private readonly options: ServiceSupervisorOptions) {}
  async start(): Promise<void> {
    if (!['created', 'stopped'].includes(this.state)) return;
    this.state = 'starting';
    try {
      this.config = await this.options.configStore.load();
      await this.options.apiServer.start();
      await this.options.heartbeat.start();
      void this.options.configStore
        .watch((config) => this.applyConfig(config), this.watcher.signal)
        .catch((error) => {
          if (!this.watcher.signal.aborted)
            this.options.logger.error(
              'supervisor.config_watch_failed',
              '配置监听失败',
              error,
            );
        });
      await this.options.outbox.start();
      await this.options.scheduler.start();
      await this.options.channels.start(this.config);
      for (const { worker } of this.options.backgroundWorkers) worker.start();
      this.startedAt = this.options.clock.now().toISOString();
      this.state = 'running';
    } catch (error) {
      this.state = 'failed';
      this.options.logger.fatal(
        'supervisor.start_failed',
        '服务启动失败',
        error,
      );
      throw error;
    }
  }
  async applyConfig(config: ServiceConfig): Promise<void> {
    if (this.config && config.revision <= this.config.revision) return;
    await this.options.channels.applyConfig(config);
    this.config = config;
  }
  status(): ServiceStatus {
    const now = this.options.clock.now().toISOString();
    return ServiceStatusSchema.parse({
      state: this.state,
      startedAt: this.startedAt,
      configRevision: this.config?.revision ?? null,
      modules: [
        {
          name: 'api',
          status: ['running', 'degraded'].includes(this.state)
            ? 'ready'
            : 'stopped',
          checkedAt: now,
        },
        ...this.options.backgroundWorkers.map(({ name, worker }) => ({
          name,
          status: worker.running() ? ('ready' as const) : ('stopped' as const),
          checkedAt: now,
        })),
        {
          name: 'heartbeat',
          status: this.options.heartbeat.snapshot() ? 'ready' : 'unavailable',
          checkedAt: now,
        },
      ],
      channels: this.options.channels.health(),
      scheduler: this.options.scheduler.summary(),
      outbox: this.options.outbox.summary(),
    });
  }
  shutdown(reason: string): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(reason);
    return this.shutdownPromise;
  }
  private async performShutdown(reason: string): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    this.options.logger.info('service.stopping', '服务正在停止', { reason });
    this.options.apiServer.stopAccepting();
    for (const { worker } of [...this.options.backgroundWorkers].reverse())
      await worker.stop();
    await this.options.channels.stop();
    await this.options.scheduler.stop();
    await this.options.outbox.stop();
    this.watcher.abort();
    await this.options.eventJournal.close();
    await this.options.heartbeat.stop();
    await this.options.apiServer.close();
    await this.options.logger.flush();
    this.state = 'stopped';
  }
}
