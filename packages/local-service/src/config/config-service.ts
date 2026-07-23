import { resolve } from 'node:path';
import { z } from 'zod';
import {
  AddAgentCommandSchema,
  AddChannelCommandSchema,
  AgentProfileSchema,
  ChannelSubscriptionSchema,
  DisableAgentCommandSchema,
  DisableChannelCommandSchema,
  EnableAgentCommandSchema,
  EnableChannelCommandSchema,
  ERROR_CODES,
  PageQuerySchema,
  RemoveChannelCommandSchema,
  ServiceConfigSchema,
  ServiceSettingsSchema,
  UpdateAgentCommandSchema,
  UpdateChannelCommandSchema,
  createAppError,
  type AgentProfile,
  type ChannelSubscription,
  type ConfigStore,
  type PageQuery,
  type ServiceConfig,
  type ServiceSettings,
} from '@agent-party-time/shared';
import type { Logger } from '../logging/logger.js';
import { parseTokenReference } from '../security/token-resolver.js';

export interface ConfigServiceOptions {
  store: ConfigStore;
  workspaceResolver?: (path: string) => Promise<string>;
  logger: Logger;
}
export function configMutationResultSchema<T extends z.ZodType>(
  valueSchema: T,
) {
  return z.object({
    value: valueSchema,
    configRevision: z.number().int().nonnegative(),
  });
}
export type ConfigMutationResult<T extends z.ZodType> = z.infer<
  ReturnType<typeof configMutationResultSchema<T>>
>;

export class ConfigService {
  constructor(private readonly options: ConfigServiceOptions) {}
  getConfig(): Promise<ServiceConfig> {
    return this.options.store.load();
  }
  async listAgents(
    filter: { enabled?: boolean; role?: AgentProfile['role'] },
    page: PageQuery,
  ) {
    const config = await this.options.store.load();
    const parsed = PageQuerySchema.parse(page);
    const all = config.agents.filter(
      (agent) =>
        (filter.enabled === undefined || agent.enabled === filter.enabled) &&
        (!filter.role || agent.role === filter.role),
    );
    const offset = this.offset(parsed.cursor);
    const items = all.slice(offset, offset + parsed.limit);
    return {
      items,
      nextCursor:
        items.length === parsed.limit
          ? this.cursor(offset + items.length)
          : null,
      configRevision: config.revision,
    };
  }
  async getAgent(
    id: string,
  ): Promise<{ agent: AgentProfile; configRevision: number }> {
    const config = await this.options.store.load();
    const agent = config.agents.find((item) => item.id === id);
    if (!agent) throw this.notFound('agent', id);
    return { agent, configRevision: config.revision };
  }
  async addAgent(raw: unknown) {
    const input = AddAgentCommandSchema.parse(raw);
    const workspacePath = await this.resolveWorkspace(input.workspacePath);
    return this.mutate(
      input.expectedRevision,
      AgentProfileSchema,
      (current) => {
        const agent = AgentProfileSchema.parse({ ...input, workspacePath });
        const existing = current.agents.find((item) => item.id === agent.id);
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(agent))
            return { next: current, value: existing };
          throw this.conflict('agent id 已存在');
        }
        return {
          next: { ...current, agents: [...current.agents, agent] },
          value: agent,
        };
      },
    );
  }
  async updateAgent(raw: unknown) {
    const input = UpdateAgentCommandSchema.parse(raw);
    const patch = { ...input.patch };
    if (patch.workspacePath)
      patch.workspacePath = await this.resolveWorkspace(patch.workspacePath);
    return this.mutate(
      input.expectedRevision,
      AgentProfileSchema,
      (current) => {
        const index = current.agents.findIndex((item) => item.id === input.id);
        if (index < 0) throw this.notFound('agent', input.id);
        const previous = current.agents[index]!;
        const agent = AgentProfileSchema.parse({
          ...previous,
          ...patch,
          model:
            patch.model === null ? undefined : (patch.model ?? previous.model),
          instructions:
            patch.instructions === null
              ? undefined
              : (patch.instructions ?? previous.instructions),
        });
        const agents = [...current.agents];
        agents[index] = agent;
        return { next: { ...current, agents }, value: agent };
      },
    );
  }
  enableAgent(raw: unknown) {
    return this.setAgentEnabled(EnableAgentCommandSchema.parse(raw), true);
  }
  disableAgent(raw: unknown) {
    return this.setAgentEnabled(DisableAgentCommandSchema.parse(raw), false);
  }
  async listChannels(
    filter: { enabled?: boolean; transport?: string; agentId?: string },
    page: PageQuery,
  ) {
    const config = await this.options.store.load();
    const parsed = PageQuerySchema.parse(page);
    const all = config.subscriptions.filter(
      (item) =>
        (filter.enabled === undefined || item.enabled === filter.enabled) &&
        (!filter.transport || item.transport === filter.transport) &&
        (!filter.agentId || item.agentId === filter.agentId),
    );
    const offset = this.offset(parsed.cursor);
    const items = all.slice(offset, offset + parsed.limit);
    return {
      items,
      nextCursor:
        items.length === parsed.limit
          ? this.cursor(offset + items.length)
          : null,
      configRevision: config.revision,
    };
  }
  async getChannel(
    id: string,
  ): Promise<{ subscription: ChannelSubscription; configRevision: number }> {
    const config = await this.options.store.load();
    const subscription = config.subscriptions.find((item) => item.id === id);
    if (!subscription) throw this.notFound('subscription', id);
    return { subscription, configRevision: config.revision };
  }
  async addChannel(raw: unknown) {
    const input = AddChannelCommandSchema.parse(raw);
    if (input.tokenRef) parseTokenReference(input.tokenRef);
    return this.mutate(
      input.expectedRevision,
      ChannelSubscriptionSchema,
      (current) => {
        if (!current.agents.some((agent) => agent.id === input.agentId))
          throw this.conflict('subscription 引用了不存在的 agent');
        const subscription = ChannelSubscriptionSchema.parse(input);
        const sameId = current.subscriptions.find(
          (item) => item.id === input.id,
        );
        if (sameId) {
          if (JSON.stringify(sameId) === JSON.stringify(subscription))
            return { next: current, value: sameId };
          throw this.conflict('subscription id 已存在');
        }
        if (
          current.subscriptions.some(
            (item) =>
              item.transport === input.transport &&
              item.channelKey === input.channelKey &&
              item.agentId === input.agentId,
          )
        )
          throw this.conflict('相同频道和 agent 的 subscription 已存在');
        return {
          next: {
            ...current,
            subscriptions: [...current.subscriptions, subscription],
          },
          value: subscription,
        };
      },
    );
  }
  async updateChannel(raw: unknown) {
    const input = UpdateChannelCommandSchema.parse(raw);
    if (input.patch.tokenRef) parseTokenReference(input.patch.tokenRef);
    return this.mutate(
      input.expectedRevision,
      ChannelSubscriptionSchema,
      (current) => {
        const index = current.subscriptions.findIndex(
          (item) => item.id === input.id,
        );
        if (index < 0) throw this.notFound('subscription', input.id);
        const previous = current.subscriptions[index]!;
        const subscription = ChannelSubscriptionSchema.parse({
          ...previous,
          ...input.patch,
          tokenRef:
            input.patch.tokenRef === null
              ? undefined
              : (input.patch.tokenRef ?? previous.tokenRef),
        });
        if (!current.agents.some((agent) => agent.id === subscription.agentId))
          throw this.conflict('subscription 引用了不存在的 agent');
        const subscriptions = [...current.subscriptions];
        subscriptions[index] = subscription;
        return { next: { ...current, subscriptions }, value: subscription };
      },
    );
  }
  enableChannel(raw: unknown) {
    return this.setChannelEnabled(EnableChannelCommandSchema.parse(raw), true);
  }
  disableChannel(raw: unknown) {
    return this.setChannelEnabled(
      DisableChannelCommandSchema.parse(raw),
      false,
    );
  }
  async removeChannel(
    raw: unknown,
  ): Promise<{ removedId: string; configRevision: number }> {
    const input = RemoveChannelCommandSchema.parse(raw);
    const current = await this.options.store.load();
    const subscriptions = current.subscriptions.filter(
      (item) => item.id !== input.id,
    );
    if (subscriptions.length === current.subscriptions.length)
      throw this.notFound('subscription', input.id);
    const saved = await this.options.store.save(
      ServiceConfigSchema.parse({ ...current, subscriptions }),
      input.expectedRevision,
    );
    return { removedId: input.id, configRevision: saved.revision };
  }
  async updateSettings(
    patch: Partial<ServiceSettings>,
    expectedRevision: number,
  ) {
    const current = await this.options.store.load();
    const settings = ServiceSettingsSchema.parse({
      ...current.settings,
      ...patch,
    });
    const restartFields = ['localApiHost', 'localApiPort'].filter(
      (field) => field in patch,
    );
    const saved = await this.options.store.save(
      ServiceConfigSchema.parse({ ...current, settings }),
      expectedRevision,
    );
    return {
      settings,
      configRevision: saved.revision,
      restartRequired: restartFields.length > 0,
      restartFields,
    };
  }

  private setAgentEnabled(
    input: z.infer<typeof EnableAgentCommandSchema>,
    enabled: boolean,
  ) {
    return this.mutate(
      input.expectedRevision,
      AgentProfileSchema,
      (current) => {
        const index = current.agents.findIndex((item) => item.id === input.id);
        if (index < 0) throw this.notFound('agent', input.id);
        const agent = AgentProfileSchema.parse({
          ...current.agents[index],
          enabled,
        });
        const agents = [...current.agents];
        agents[index] = agent;
        return { next: { ...current, agents }, value: agent };
      },
    );
  }
  private setChannelEnabled(
    input: z.infer<typeof EnableChannelCommandSchema>,
    enabled: boolean,
  ) {
    return this.mutate(
      input.expectedRevision,
      ChannelSubscriptionSchema,
      (current) => {
        const index = current.subscriptions.findIndex(
          (item) => item.id === input.id,
        );
        if (index < 0) throw this.notFound('subscription', input.id);
        const subscription = ChannelSubscriptionSchema.parse({
          ...current.subscriptions[index],
          enabled,
        });
        const subscriptions = [...current.subscriptions];
        subscriptions[index] = subscription;
        return { next: { ...current, subscriptions }, value: subscription };
      },
    );
  }
  private async mutate<T extends z.ZodType>(
    expectedRevision: number,
    schema: T,
    change: (current: ServiceConfig) => {
      next: ServiceConfig;
      value: z.input<T>;
    },
  ): Promise<ConfigMutationResult<T>> {
    const current = await this.options.store.load();
    if (current.revision !== expectedRevision)
      throw createAppError({
        code: ERROR_CODES.configRevisionConflict,
        category: 'conflict',
        message: '配置 revision 冲突',
        retryable: false,
        details: { expectedRevision, actualRevision: current.revision },
      });
    const { next, value } = change(current);
    if (next === current)
      return configMutationResultSchema(schema).parse({
        value,
        configRevision: current.revision,
      });
    const saved = await this.options.store.save(
      ServiceConfigSchema.parse(next),
      expectedRevision,
    );
    return configMutationResultSchema(schema).parse({
      value,
      configRevision: saved.revision,
    });
  }
  private resolveWorkspace(path: string) {
    return this.options.workspaceResolver
      ? this.options.workspaceResolver(path)
      : Promise.resolve(resolve(path));
  }
  private offset(cursor?: string) {
    return cursor
      ? Number(Buffer.from(cursor, 'base64url').toString()) || 0
      : 0;
  }
  private cursor(offset: number) {
    return Buffer.from(String(offset)).toString('base64url');
  }
  private notFound(entity: string, id: string) {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message: `${entity} ${id} 不存在`,
      retryable: false,
    });
  }
  private conflict(message: string) {
    return createAppError({
      code: ERROR_CODES.storeConstraintConflict,
      category: 'conflict',
      message,
      retryable: false,
    });
  }
}
