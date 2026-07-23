import { z } from 'zod';
import { CONFIG_SCHEMA_VERSION, DEFAULTS } from '../config/index.js';

export const LogLevelSchema = z.enum([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const AgentRoleSchema = z.enum(['front', 'specialist']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

//agent 定义
export const AgentProfileSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  role: AgentRoleSchema.default('front'),
  workspacePath: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

//定义触发规则
export const TriggerPolicySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('direct_mention'),
  }),
  z.object({
    kind: z.literal('prefix'),
    prefix: z.string().min(1).max(32),
  }),
  z.object({
    kind: z.literal('all_messages'),
  }),
  z.object({
    kind: z.literal('task_assignment'),
  }),
]);

export type TriggerPolicy = z.infer<typeof TriggerPolicySchema>;

// 某个 agent 订阅的某个频道
export const ChannelSubscriptionSchema = z.object({
  id: z.string().trim().min(1).max(128),
  channelKey: z.string().trim().min(1).max(256),
  transport: z.string().trim().min(1).max(64),
  agentId: z.string().trim().min(1).max(64),
  enabled: z.boolean().default(true),
  trigger: TriggerPolicySchema.default({ kind: 'direct_mention' }),
  tokenRef: z.string().trim().min(1).max(512).optional(),
});

export type ChannelSubscription = z.infer<typeof ChannelSubscriptionSchema>;

//本地 service 的主配置
export const ServiceSettingsSchema = z.object({
  localApiHost: z.string().default(DEFAULTS.localApiHost),
  localApiPort: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .default(DEFAULTS.localApiPort),
  heartbeatIntervalMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULTS.heartbeatIntervalMs),
  heartbeatStaleAfterMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULTS.heartbeatStaleAfterMs),
  wakeJobTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULTS.wakeJobTimeoutMs),
  codexRunTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULTS.codexRunTimeoutMs),
  leaseDurationMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULTS.leaseDurationMs),
  maxConcurrentRuns: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(DEFAULTS.maxConcurrentRuns),
  logLevel: LogLevelSchema.default(DEFAULTS.logLevel),
});

export type ServiceSettings = z.infer<typeof ServiceSettingsSchema>;

export const DEFAULT_SERVICE_SETTINGS = ServiceSettingsSchema.parse({});

export const ServiceConfigSchema = z
  .object({
    schemaVersion: z
      .literal(CONFIG_SCHEMA_VERSION)
      .default(CONFIG_SCHEMA_VERSION),
    revision: z.number().int().nonnegative().default(0),
    agents: z.array(AgentProfileSchema).default([]),
    subscriptions: z.array(ChannelSubscriptionSchema).default([]),
    settings: ServiceSettingsSchema.default(DEFAULT_SERVICE_SETTINGS),
  })
  .superRefine((config, ctx) => {
    const agentIds = new Set<string>();
    config.agents.forEach((agent, index) => {
      if (agentIds.has(agent.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', index, 'id'],
          message: `duplicate agent id: ${agent.id}`,
        });
      }
      agentIds.add(agent.id);
    });

    const subscriptionIds = new Set<string>();
    config.subscriptions.forEach((subscription, index) => {
      if (subscriptionIds.has(subscription.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['subscriptions', index, 'id'],
          message: `duplicate subscription id: ${subscription.id}`,
        });
      }
      if (!agentIds.has(subscription.agentId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['subscriptions', index, 'agentId'],
          message: `unknown agent id: ${subscription.agentId}`,
        });
      }
      subscriptionIds.add(subscription.id);
    });

    if (
      config.settings.heartbeatStaleAfterMs <=
      config.settings.heartbeatIntervalMs
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['settings', 'heartbeatStaleAfterMs'],
        message: 'heartbeatStaleAfterMs must exceed heartbeatIntervalMs',
      });
    }
    if (config.settings.wakeJobTimeoutMs <= config.settings.codexRunTimeoutMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['settings', 'wakeJobTimeoutMs'],
        message: 'wakeJobTimeoutMs must exceed codexRunTimeoutMs',
      });
    }
  });

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
