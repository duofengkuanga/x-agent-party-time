import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ChannelMessageSchema,
  DurableEventSchema,
  EVENT_NAMES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  WakeJobSchema,
  normalizeError,
  createAppError,
  type AppError,
  type ChannelConnection,
  type ChannelHealth,
  type ChannelMessage,
  type ChannelSubscription,
  type ChannelTransport,
  type ChannelTransportFactory,
  type ServiceConfig,
  type StateStore,
} from '@agent-party-time/shared';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';
import { buildSessionKey } from '../sessions/session-manager.js';
import type { TokenResolver } from '../security/token-resolver.js';

interface SubscriptionRuntime {
  subscription: ChannelSubscription;
  transport: ChannelTransport;
  connection: ChannelConnection | null;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  reconnectAttempt: number;
  reconnectAt: string | null;
  lastError: AppError | null;
  abortController: AbortController;
}
export const ChannelHealthSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  connecting: z.number().int().nonnegative(),
  connected: z.number().int().nonnegative(),
  degraded: z.number().int().nonnegative(),
  disconnected: z.number().int().nonnegative(),
});
export type ChannelHealthSummary = z.infer<typeof ChannelHealthSummarySchema>;
export const TriggerMatchSchema = z.object({
  matched: z.boolean(),
  reason: z.string().min(1),
});
export type TriggerMatch = z.infer<typeof TriggerMatchSchema>;
export interface ChannelManagerOptions {
  store: StateStore;
  tokenResolver: TokenResolver;
  clock: Clock;
  logger: Logger;
  onJobQueued?: () => void;
}

export class ChannelManager {
  private readonly factories = new Map<string, ChannelTransportFactory>();
  private readonly runtimes = new Map<string, SubscriptionRuntime>();
  private readonly reconnectTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private config: ServiceConfig | null = null;
  private stopping = false;
  constructor(private readonly options: ChannelManagerOptions) {}
  registerTransport(name: string, factory: ChannelTransportFactory): void {
    if (this.factories.has(name))
      throw new Error(`transport already registered: ${name}`);
    this.factories.set(name, factory);
  }
  async start(config: ServiceConfig): Promise<void> {
    this.stopping = false;
    this.config = config;
    await Promise.all(
      config.subscriptions
        .filter((item) => item.enabled)
        .map((item) => this.createAndConnect(item)),
    );
  }
  async applyConfig(next: ServiceConfig): Promise<void> {
    const enabled = new Map(
      next.subscriptions
        .filter((item) => item.enabled)
        .map((item) => [item.id, item]),
    );
    for (const [id, runtime] of this.runtimes) {
      const subscription = enabled.get(id);
      if (!subscription) {
        await this.disconnect(id);
        continue;
      }
      const reconnect =
        runtime.subscription.transport !== subscription.transport ||
        runtime.subscription.channelKey !== subscription.channelKey ||
        runtime.subscription.tokenRef !== subscription.tokenRef;
      if (reconnect) {
        await this.disconnect(id);
        await this.createAndConnect(subscription);
      } else runtime.subscription = subscription;
      enabled.delete(id);
    }
    for (const subscription of enabled.values())
      if (!this.runtimes.has(subscription.id))
        await this.createAndConnect(subscription);
    this.config = next;
  }
  async connect(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw this.notFound(id);
    runtime.status = 'connecting';
    try {
      runtime.connection = await runtime.transport.connect(
        runtime.subscription,
        (message) => this.handleMessage(runtime, message),
        runtime.abortController.signal,
      );
      runtime.status = 'connected';
      runtime.reconnectAttempt = 0;
      runtime.reconnectAt = null;
      runtime.lastError = null;
    } catch (error) {
      runtime.lastError = normalizeError(error);
      runtime.status = runtime.lastError.retryable
        ? 'degraded'
        : 'disconnected';
      runtime.reconnectAttempt += 1;
      this.options.logger.error(
        'channel.connect_failed',
        `频道 ${id} 连接失败`,
        runtime.lastError,
      );
      if (runtime.lastError.retryable && !this.stopping)
        this.scheduleReconnect(runtime);
    }
  }
  async disconnect(id: string): Promise<void> {
    const timer = this.reconnectTimers.get(id);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(id);
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.abortController.abort();
    await runtime.connection?.close().catch(() => undefined);
    await runtime.transport.close().catch(() => undefined);
    runtime.status = 'disconnected';
    this.runtimes.delete(id);
  }
  health(): ChannelHealthSummary {
    const summary = {
      total: this.runtimes.size,
      connecting: 0,
      connected: 0,
      degraded: 0,
      disconnected: 0,
    };
    for (const runtime of this.runtimes.values()) summary[runtime.status] += 1;
    return ChannelHealthSummarySchema.parse(summary);
  }
  getHealth(id: string): ChannelHealth {
    const runtime = this.runtimes.get(id);
    if (!runtime)
      return {
        status: 'disconnected',
        connectedAt: null,
        lastMessageAt: null,
        lastSuccessAt: null,
        lastError: null,
      };
    return (
      runtime.connection?.health() ?? {
        status: runtime.status === 'connecting' ? 'connecting' : runtime.status,
        connectedAt: null,
        lastMessageAt: null,
        lastSuccessAt: null,
        lastError: runtime.lastError,
      }
    );
  }
  getTransportForDelivery(subscriptionId: string): ChannelTransport {
    const runtime = this.runtimes.get(subscriptionId);
    if (!runtime) throw this.notFound(subscriptionId);
    return runtime.transport;
  }
  getSubscription(subscriptionId: string): ChannelSubscription | null {
    return (
      this.runtimes.get(subscriptionId)?.subscription ??
      this.config?.subscriptions.find((item) => item.id === subscriptionId) ??
      null
    );
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      [...this.runtimes.keys()].map((id) => this.disconnect(id)),
    );
  }
  matchesTrigger(
    subscription: ChannelSubscription,
    message: ChannelMessage,
  ): TriggerMatch {
    if (message.sender.isBot) return { matched: false, reason: 'bot message' };
    switch (subscription.trigger.kind) {
      case 'direct_mention':
        return {
          matched: message.mentionedAgentIds.includes(subscription.agentId),
          reason: 'direct mention policy',
        };
      case 'prefix':
        return {
          matched: message.text
            .trimStart()
            .startsWith(subscription.trigger.prefix),
          reason: 'prefix policy',
        };
      case 'all_messages':
        return { matched: true, reason: 'all messages policy' };
      case 'task_assignment':
        return {
          matched: false,
          reason: 'task assignment policy ignores channel messages',
        };
    }
  }

  private async createAndConnect(
    subscription: ChannelSubscription,
  ): Promise<void> {
    const factory = this.factories.get(subscription.transport);
    if (!factory) {
      this.options.logger.warn(
        'channel.transport_missing',
        `未注册 transport ${subscription.transport}`,
      );
      return;
    }
    const credential = subscription.tokenRef
      ? (await this.options.tokenResolver.resolve(subscription.tokenRef)).value
      : null;
    const runtime: SubscriptionRuntime = {
      subscription,
      transport: factory({ subscription, credential }),
      connection: null,
      status: 'disconnected',
      reconnectAttempt: 0,
      reconnectAt: null,
      lastError: null,
      abortController: new AbortController(),
    };
    this.runtimes.set(subscription.id, runtime);
    await this.connect(subscription.id);
  }
  private scheduleReconnect(runtime: SubscriptionRuntime) {
    const delay = Math.min(
      60_000,
      1_000 * 2 ** Math.min(runtime.reconnectAttempt - 1, 6),
    );
    runtime.reconnectAt = new Date(
      this.options.clock.now().getTime() + delay,
    ).toISOString();
    const previous = this.reconnectTimers.get(runtime.subscription.id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(runtime.subscription.id);
      if (
        !this.stopping &&
        this.runtimes.get(runtime.subscription.id) === runtime
      )
        void this.connect(runtime.subscription.id);
    }, delay);
    this.reconnectTimers.set(runtime.subscription.id, timer);
  }
  private async handleMessage(
    runtime: SubscriptionRuntime,
    raw: ChannelMessage,
  ): Promise<void> {
    const message = ChannelMessageSchema.parse(raw);
    const subscription = runtime.subscription;
    if (
      message.channel.subscriptionId !== subscription.id ||
      message.channel.channelKey !== subscription.channelKey
    )
      throw createAppError({
        code: ERROR_CODES.storeInvariantViolation,
        category: 'invariant',
        message: 'transport 返回了错误的 channel identity',
        retryable: false,
      });
    const match = this.matchesTrigger(subscription, message);
    const now = this.options.clock.now();
    const agent = this.config?.agents.find(
      (item) => item.id === subscription.agentId,
    );
    if (!agent) throw this.notFound(subscription.agentId);
    const sessionKey = buildSessionKey({
      agentId: agent.id,
      channelKey: subscription.channelKey,
      canonicalWorkspacePath: agent.workspacePath,
    });
    const job = match.matched
      ? WakeJobSchema.parse({
          id: randomUUID(),
          idempotencyKey: `${subscription.id}:${message.sourceEventId ?? message.sourceSeq}:${agent.id}`,
          triggerKind: 'channel_message',
          agentId: agent.id,
          sessionKey,
          taskId: null,
          sourceRef: `${message.channel.channelKey}:${message.sourceSeq}`,
          priority: subscription.trigger.kind === 'direct_mention' ? 100 : 70,
          state: 'queued',
          attemptCount: 0,
          maxAttempts: 3,
          lease: null,
          nextAttemptAt: null,
          deadlineAt: new Date(
            now.getTime() + this.config!.settings.wakeJobTimeoutMs,
          ).toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
      : null;
    const eventName = match.matched
      ? EVENT_NAMES.channelMessageReceived
      : EVENT_NAMES.channelMessageIgnored;
    const event = DurableEventSchema.parse({
      schema: PROTOCOL_VERSION,
      id: randomUUID(),
      name: eventName,
      occurredAt: now.toISOString(),
      correlationId:
        message.sourceEventId ?? `${subscription.id}:${message.sourceSeq}`,
      causationId: message.sourceEventId ?? null,
      payload: {
        subscriptionId: subscription.id,
        channelKey: subscription.channelKey,
        sourceSeq: message.sourceSeq,
        sourceEventId: message.sourceEventId ?? null,
        jobId: job?.id ?? null,
        ...(!match.matched ? { reason: match.reason } : {}),
      },
    });
    const result = await this.options.store.ingestMessage({
      message,
      nextCursor: {
        subscriptionId: subscription.id,
        sourceSeq: message.sourceSeq,
        sourceEventId: message.sourceEventId ?? null,
        updatedAt: now.toISOString(),
      },
      wakeJob: job,
      event,
    });
    if (!result.duplicate && result.job) this.options.onJobQueued?.();
  }
  private notFound(id: string) {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message: `subscription/agent ${id} 不存在`,
      retryable: false,
    });
  }
}
