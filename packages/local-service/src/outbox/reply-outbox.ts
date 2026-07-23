import { z } from 'zod';
import {
  ERROR_CODES,
  ReplyPayloadSchema,
  normalizeError,
  type AppError,
  type OutboxEntry,
  type StateStore,
} from '@agent-party-time/shared';
import type { ChannelManager } from '../channels/channel-manager.js';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';

interface ActiveDelivery {
  entryId: string;
  leaseGeneration: number;
  abortController: AbortController;
  completion: Promise<void>;
}
export const OutboxSummarySchema = z.object({
  activeDeliveries: z.number().int().nonnegative(),
  pendingEntries: z.number().int().nonnegative(),
  retryWaitingEntries: z.number().int().nonnegative(),
  failedEntries: z.number().int().nonnegative(),
});
export type OutboxSummary = z.infer<typeof OutboxSummarySchema>;
export interface ReplyOutboxOptions {
  instanceId: string;
  store: StateStore;
  channelManager: ChannelManager;
  clock: Clock;
  logger: Logger;
  maxConcurrentDeliveries?: number;
  leaseDurationMs: number;
  baseRetryDelayMs: number;
  maxAttempts?: number;
  tickIntervalMs?: number;
}

export class ReplyOutbox {
  private readonly active = new Map<string, ActiveDelivery>();
  private timer: unknown = null;
  private running = false;
  private ticking = false;
  private counts = {
    pendingEntries: 0,
    retryWaitingEntries: 0,
    failedEntries: 0,
  };
  constructor(private readonly options: ReplyOutboxOptions) {}
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshCounts();
    await this.tick();
    this.timer = this.options.clock.setInterval(
      () => void this.tick(),
      this.options.tickIntervalMs ?? 1_000,
    );
  }
  summary(): OutboxSummary {
    return OutboxSummarySchema.parse({
      activeDeliveries: this.active.size,
      ...this.counts,
    });
  }
  async flushOnce(): Promise<void> {
    await this.tick();
    await Promise.all([...this.active.values()].map((item) => item.completion));
  }
  async drain(): Promise<void> {
    await Promise.all([...this.active.values()].map((item) => item.completion));
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) this.options.clock.clearInterval(this.timer);
    this.timer = null;
    for (const item of this.active.values())
      item.abortController.abort('outbox stopping');
    await this.drain();
  }
  notify(): void {
    if (this.running) void this.tick();
  }
  private async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      while (this.active.size < (this.options.maxConcurrentDeliveries ?? 2)) {
        const now = this.options.clock.now();
        const entry = await this.options.store.leaseNextOutboxEntry(
          this.options.instanceId,
          now.toISOString(),
          new Date(now.getTime() + this.options.leaseDurationMs).toISOString(),
        );
        if (!entry?.lease) break;
        const controller = new AbortController();
        const active: ActiveDelivery = {
          entryId: entry.id,
          leaseGeneration: entry.lease.generation,
          abortController: controller,
          completion: Promise.resolve(),
        };
        active.completion = this.deliver(entry, active).finally(() => {
          this.active.delete(entry.id);
          void this.refreshCounts();
          this.notify();
        });
        this.active.set(entry.id, active);
      }
      await this.refreshCounts();
    } finally {
      this.ticking = false;
    }
  }
  private async deliver(
    entry: OutboxEntry,
    active: ActiveDelivery,
  ): Promise<void> {
    try {
      const subscription = this.options.channelManager.getSubscription(
        entry.destination.subscriptionId,
      );
      if (!subscription)
        throw {
          code: ERROR_CODES.entityNotFound,
          category: 'not_found',
          message: '回复目标 subscription 不存在',
          retryable: false,
        };
      const transport = this.options.channelManager.getTransportForDelivery(
        subscription.id,
      );
      const result = await transport.sendReply(
        subscription,
        ReplyPayloadSchema.parse({
          text: entry.text,
          threadKey: entry.destination.threadKey,
          replyToEventId: entry.destination.replyToEventId,
        }),
        entry.dedupeKey,
        active.abortController.signal,
      );
      await this.options.store.acknowledgeOutbox(
        entry.id,
        active.leaseGeneration,
        result.providerMessageId,
        result.acceptedAt,
      );
    } catch (error) {
      const appError = normalizeError(error);
      const nextAttemptAt = this.shouldRetry(entry, appError)
        ? new Date(
            this.options.clock.now().getTime() +
              this.options.baseRetryDelayMs *
                2 ** Math.min(entry.attemptCount, 8),
          ).toISOString()
        : null;
      await this.options.store.failOutboxAttempt(
        entry.id,
        active.leaseGeneration,
        appError,
        nextAttemptAt,
      );
      this.options.logger.error(
        'outbox.delivery_failed',
        '频道回复发送失败',
        appError,
        { outboxEntryId: entry.id, retryAt: nextAttemptAt },
      );
    }
  }
  private shouldRetry(entry: OutboxEntry, error: AppError): boolean {
    return (
      error.retryable &&
      entry.attemptCount + 1 < (this.options.maxAttempts ?? 8) &&
      !['authentication', 'permission', 'not_found', 'validation'].includes(
        error.category,
      )
    );
  }
  private async refreshCounts() {
    const counts = await this.options.store.outbox.countByState();
    this.counts = {
      pendingEntries: counts.pending,
      retryWaitingEntries: counts.retry_wait,
      failedEntries: counts.failed,
    };
  }
}
