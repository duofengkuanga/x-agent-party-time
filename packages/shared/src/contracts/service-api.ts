import { z } from 'zod';
import { PROTOCOL_VERSION } from '../config/index.js';
import { AppErrorSchema } from '../schemas/error.js';
import { DurableEventSchema } from '../schemas/protocol.js';
import {
  ChannelCursorSchema,
  OutboxEntrySchema,
  RunRecordSchema,
  RunStateSchema,
  ServiceHeartbeatSchema,
  SessionRecordSchema,
  SessionStatusSchema,
  WakeJobSchema,
} from '../schemas/runtime.js';
import {
  AgentProfileSchema,
  AgentRoleSchema,
  ChannelSubscriptionSchema,
  LogLevelSchema,
  TriggerPolicySchema,
} from '../schemas/service.js';
import {
  ArtifactReferenceSchema,
  MessageAnchorSchema,
  TaskActorSchema,
  TaskAssigneeSchema,
  TaskPrioritySchema,
  TaskRecordSchema,
  TaskStateSchema,
} from '../schemas/task.js';
import { ChannelHealthSchema } from './channel.js';
import {
  BindEngineeringCommandSchema,
  BindEngineeringResultSchema,
  BindProjectCommandSchema,
  BindProjectResultSchema,
  ListEngineeringBindingsLocalQuerySchema,
  ListEngineeringBindingsLocalResultSchema,
  ListProjectBindingsQuerySchema,
  ListProjectBindingsResultSchema,
} from './runner-local.js';

export const API_VERSION = PROTOCOL_VERSION;

export const ApiRequestEnvelopeSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  requestId: z.string().min(1),
  operation: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
  payload: z.json(),
});
export type ApiRequestEnvelope = z.infer<typeof ApiRequestEnvelopeSchema>;

export const ApiResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1),
    data: z.json(),
  }),
  z.object({
    ok: z.literal(false),
    requestId: z.string().min(1),
    error: AppErrorSchema,
  }),
]);
export type ApiResponseEnvelope = z.infer<typeof ApiResponseEnvelopeSchema>;

export const PageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const RevisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
});

function apiPageResultSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().min(1).nullable(),
  });
}
const ApiErrorSummarySchema = AppErrorSchema.omit({ details: true });

export const ServiceStatusQuerySchema = z.object({});
export const ServiceStatusResultSchema = z.object({
  instance: ServiceHeartbeatSchema,
  apiAddress: z.string().url(),
  configRevision: z.number().int().nonnegative(),
  channels: z.object({
    connected: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    disconnected: z.number().int().nonnegative(),
  }),
  scheduler: z.object({
    queued: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
  }),
  outbox: z.object({
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export const ShutdownServiceCommandSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
});
export const ShutdownServiceResultSchema = z.object({
  accepted: z.literal(true),
});

export const ListAgentsQuerySchema = PageQuerySchema.extend({
  enabled: z.boolean().optional(),
  role: AgentRoleSchema.optional(),
});
export const ListAgentsResultSchema = apiPageResultSchema(
  AgentProfileSchema,
).extend({ configRevision: z.number().int().nonnegative() });
export const GetAgentQuerySchema = z.object({
  id: z.string().trim().min(1).max(64),
});
export const GetAgentResultSchema = z.object({
  agent: AgentProfileSchema,
  configRevision: z.number().int().nonnegative(),
});
export const AddAgentCommandSchema = z.object({
  id: z.string().trim().min(1).max(64),
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(80),
  workspacePath: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  role: AgentRoleSchema.default('front'),
});
export const UpdateAgentCommandSchema = z.object({
  id: z.string().trim().min(1).max(64),
  expectedRevision: z.number().int().nonnegative(),
  patch: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      workspacePath: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).nullable().optional(),
      instructions: z.string().trim().min(1).max(20_000).nullable().optional(),
      role: AgentRoleSchema.optional(),
    })
    .refine(
      (value) => Object.keys(value).length > 0,
      'patch must contain at least one field',
    ),
});
export const EnableAgentCommandSchema = z.object({
  id: z.string().trim().min(1).max(64),
  expectedRevision: z.number().int().nonnegative(),
});
export const DisableAgentCommandSchema = EnableAgentCommandSchema;
export const AgentMutationResultSchema = z.object({
  agent: AgentProfileSchema,
  configRevision: z.number().int().nonnegative(),
});

export const ChannelSubscriptionSummarySchema = ChannelSubscriptionSchema.omit({
  tokenRef: true,
}).extend({ tokenRefSummary: z.string().min(1).max(512).nullable() });
export const ChannelHealthSummarySchema = ChannelHealthSchema.extend({
  lastError: ApiErrorSummarySchema.nullable(),
});
export const ChannelListItemSchema = z.object({
  subscription: ChannelSubscriptionSummarySchema,
  health: ChannelHealthSummarySchema,
});
export const ListChannelsQuerySchema = PageQuerySchema.extend({
  enabled: z.boolean().optional(),
  transport: z.string().trim().min(1).max(64).optional(),
  agentId: z.string().trim().min(1).max(64).optional(),
});
export const ListChannelsResultSchema = apiPageResultSchema(
  ChannelListItemSchema,
).extend({ configRevision: z.number().int().nonnegative() });
export const GetChannelQuerySchema = z.object({
  id: z.string().trim().min(1).max(128),
});
export const GetChannelResultSchema = z.object({
  subscription: ChannelSubscriptionSummarySchema,
  cursor: ChannelCursorSchema.nullable(),
  health: ChannelHealthSummarySchema,
  configRevision: z.number().int().nonnegative(),
});
export const AddChannelCommandSchema = z.object({
  id: z.string().trim().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  channelKey: z.string().trim().min(1).max(256),
  transport: z.string().trim().min(1).max(64),
  agentId: z.string().trim().min(1).max(64),
  trigger: TriggerPolicySchema.default({ kind: 'direct_mention' }),
  tokenRef: z.string().trim().min(1).max(512).optional(),
});
export const UpdateChannelCommandSchema = z.object({
  id: z.string().trim().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  patch: z
    .object({
      channelKey: z.string().trim().min(1).max(256).optional(),
      transport: z.string().trim().min(1).max(64).optional(),
      agentId: z.string().trim().min(1).max(64).optional(),
      trigger: TriggerPolicySchema.optional(),
      tokenRef: z.string().trim().min(1).max(512).nullable().optional(),
    })
    .refine(
      (value) => Object.keys(value).length > 0,
      'patch must contain at least one field',
    ),
});
export const EnableChannelCommandSchema = z.object({
  id: z.string().trim().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
});
export const DisableChannelCommandSchema = EnableChannelCommandSchema;
export const RemoveChannelCommandSchema = EnableChannelCommandSchema;
export const ChannelMutationResultSchema = z.object({
  subscription: ChannelSubscriptionSummarySchema,
  configRevision: z.number().int().nonnegative(),
});
export const RemoveChannelResultSchema = z.object({
  removedId: z.string().trim().min(1).max(128),
  configRevision: z.number().int().nonnegative(),
});

export const RunRecordSummarySchema = RunRecordSchema.safeExtend({
  error: ApiErrorSummarySchema.nullable(),
});
export const RunJobSummarySchema = WakeJobSchema.pick({
  id: true,
  triggerKind: true,
  agentId: true,
  sessionKey: true,
  taskId: true,
  priority: true,
  state: true,
  attemptCount: true,
  maxAttempts: true,
  deadlineAt: true,
  createdAt: true,
  updatedAt: true,
});
export const RunOutboxSummarySchema = OutboxEntrySchema.pick({
  id: true,
  destination: true,
  state: true,
  attemptCount: true,
  providerMessageId: true,
  createdAt: true,
  updatedAt: true,
});
export const ListRunsQuerySchema = PageQuerySchema.extend({
  jobId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  channelKey: z.string().min(1).optional(),
  state: RunStateSchema.optional(),
  taskId: z.string().min(1).nullable().optional(),
});
export const ListRunsResultSchema = apiPageResultSchema(RunRecordSummarySchema);
export const ShowRunQuerySchema = z.object({ runId: z.string().min(1) });
export const ShowRunResultSchema = z.object({
  run: RunRecordSummarySchema,
  job: RunJobSummarySchema,
  session: SessionRecordSchema.nullable(),
  outbox: z.array(RunOutboxSummarySchema),
});
export const CancelRunCommandSchema = z.discriminatedUnion('targetKind', [
  z.object({
    targetKind: z.literal('job'),
    jobId: z.string().min(1),
    reason: z.string().trim().min(1).max(2_000),
  }),
  z.object({
    targetKind: z.literal('run'),
    runId: z.string().min(1),
    reason: z.string().trim().min(1).max(2_000),
  }),
]);
export const RetryRunCommandSchema = z.object({
  jobId: z.string().min(1),
  reason: z.string().trim().min(1).max(2_000),
});
export const RunActionResultSchema = z.object({
  job: RunJobSummarySchema,
  run: RunRecordSummarySchema.nullable(),
});

export const ListSessionsQuerySchema = PageQuerySchema.extend({
  agentId: z.string().min(1).optional(),
  channelKey: z.string().min(1).optional(),
  status: SessionStatusSchema.optional(),
});
export const ListSessionsResultSchema =
  apiPageResultSchema(SessionRecordSchema);
export const ShowSessionQuerySchema = z.object({
  sessionKey: z.string().min(1),
  generation: z.number().int().positive(),
});
export const ShowSessionResultSchema = z.object({
  session: SessionRecordSchema,
});
export const InvalidateSessionCommandSchema = z.object({
  sessionKey: z.string().min(1),
  generation: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2_000),
});
export const InvalidateSessionResultSchema = z.object({
  session: SessionRecordSchema,
});

export const ListTasksQuerySchema = PageQuerySchema.extend({
  state: TaskStateSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assignee: TaskAssigneeSchema.nullable().optional(),
  parentTaskId: z.string().min(1).nullable().optional(),
});
export const ListTasksResultSchema = apiPageResultSchema(TaskRecordSchema);
export const GetTaskQuerySchema = z.object({ taskId: z.string().min(1) });
export const GetTaskResultSchema = z.object({ task: TaskRecordSchema });
export const CreateTaskCommandSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).default(''),
  priority: TaskPrioritySchema.default('normal'),
  assignee: TaskAssigneeSchema.nullable().default(null),
  creator: TaskActorSchema,
  labels: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  parentTaskId: z.string().min(1).nullable().default(null),
});
export const CreateTaskFromMessageCommandSchema = z.object({
  anchor: MessageAnchorSchema,
  creator: TaskActorSchema,
  priority: TaskPrioritySchema.default('normal'),
  assignee: TaskAssigneeSchema.nullable().default(null),
  parentTaskId: z.string().min(1).nullable().default(null),
});
export const AssignTaskCommandSchema = z.object({
  taskId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  assignee: TaskAssigneeSchema,
  actor: TaskActorSchema,
  reason: z.string().trim().min(1).max(2_000).optional(),
});
const ClaimActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), id: z.string().min(1) }),
  z.object({ kind: z.literal('human'), id: z.string().min(1) }),
]);
export const ClaimTaskCommandSchema = z.object({
  taskId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  actor: ClaimActorSchema,
});
export const ChangeTaskStateCommandSchema = z.object({
  taskId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  nextState: TaskStateSchema,
  actor: TaskActorSchema,
  reason: z.string().trim().min(1).max(2_000).optional(),
});
export const SubmitCompletionCommandSchema = z.object({
  taskId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  submittedBy: TaskActorSchema,
  summary: z.string().trim().min(1).max(10_000),
  references: z.array(ArtifactReferenceSchema).max(100).default([]),
  runId: z.string().min(1).optional(),
});
export const ReviewCompletionCommandSchema = z
  .object({
    taskId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    reviewer: TaskActorSchema,
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.decision === 'reject' && !input.reason)
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is required when rejecting completion',
      });
  });
export const TaskMutationResultSchema = z.object({ task: TaskRecordSchema });

export const LogsQuerySchema = PageQuerySchema.extend({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  levels: z.array(LogLevelSchema).optional(),
  event: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  channelKey: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
}).superRefine((query, ctx) => {
  if (query.since && query.until && query.since > query.until)
    ctx.addIssue({
      code: 'custom',
      path: ['until'],
      message: 'until must not be earlier than since',
    });
});
export const ServiceLogRecordSchema = z.object({
  timestamp: z.string().datetime(),
  level: LogLevelSchema,
  event: z.string().min(1),
  message: z.string().min(1),
  correlationId: z.string().optional(),
  agentId: z.string().optional(),
  channelKey: z.string().optional(),
  jobId: z.string().optional(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  details: z.record(z.string(), z.json()).optional(),
  error: AppErrorSchema.optional(),
});
export const ListLogsResultSchema = apiPageResultSchema(ServiceLogRecordSchema);
export const ServiceLogStreamItemSchema = z.object({
  cursor: z.string().min(1),
  record: ServiceLogRecordSchema,
});
export const ServiceEventStreamItemSchema = z.object({
  cursor: z.string().min(1),
  event: DurableEventSchema,
});

function operationRequestSchema<
  const TOperation extends string,
  TPayload extends z.ZodType,
>(operation: TOperation, payload: TPayload) {
  return z.object({ operation: z.literal(operation), payload });
}

const queryRequests = [
  operationRequestSchema('service.status', ServiceStatusQuerySchema),
  operationRequestSchema('agent.list', ListAgentsQuerySchema),
  operationRequestSchema('agent.get', GetAgentQuerySchema),
  operationRequestSchema('channel.list', ListChannelsQuerySchema),
  operationRequestSchema('channel.get', GetChannelQuerySchema),
  operationRequestSchema('run.list', ListRunsQuerySchema),
  operationRequestSchema('run.show', ShowRunQuerySchema),
  operationRequestSchema('session.list', ListSessionsQuerySchema),
  operationRequestSchema('session.show', ShowSessionQuerySchema),
  operationRequestSchema('task.list', ListTasksQuerySchema),
  operationRequestSchema('task.get', GetTaskQuerySchema),
  operationRequestSchema('logs.query', LogsQuerySchema),
  operationRequestSchema(
    'project.binding.list',
    ListProjectBindingsQuerySchema,
  ),
  operationRequestSchema(
    'engineering.binding.list',
    ListEngineeringBindingsLocalQuerySchema,
  ),
] as const;
export const ServiceQuerySchema = z.discriminatedUnion(
  'operation',
  queryRequests,
);
export type ServiceQuery = z.infer<typeof ServiceQuerySchema>;

const commandRequests = [
  operationRequestSchema('service.shutdown', ShutdownServiceCommandSchema),
  operationRequestSchema('agent.add', AddAgentCommandSchema),
  operationRequestSchema('agent.update', UpdateAgentCommandSchema),
  operationRequestSchema('agent.enable', EnableAgentCommandSchema),
  operationRequestSchema('agent.disable', DisableAgentCommandSchema),
  operationRequestSchema('channel.add', AddChannelCommandSchema),
  operationRequestSchema('channel.update', UpdateChannelCommandSchema),
  operationRequestSchema('channel.enable', EnableChannelCommandSchema),
  operationRequestSchema('channel.disable', DisableChannelCommandSchema),
  operationRequestSchema('channel.remove', RemoveChannelCommandSchema),
  operationRequestSchema('run.cancel', CancelRunCommandSchema),
  operationRequestSchema('run.retry', RetryRunCommandSchema),
  operationRequestSchema('session.invalidate', InvalidateSessionCommandSchema),
  operationRequestSchema('task.create', CreateTaskCommandSchema),
  operationRequestSchema(
    'task.create_from_message',
    CreateTaskFromMessageCommandSchema,
  ),
  operationRequestSchema('task.assign', AssignTaskCommandSchema),
  operationRequestSchema('task.claim', ClaimTaskCommandSchema),
  operationRequestSchema('task.change_state', ChangeTaskStateCommandSchema),
  operationRequestSchema(
    'task.submit_completion',
    SubmitCompletionCommandSchema,
  ),
  operationRequestSchema(
    'task.review_completion',
    ReviewCompletionCommandSchema,
  ),
  operationRequestSchema('project.bind', BindProjectCommandSchema),
  operationRequestSchema('engineering.bind', BindEngineeringCommandSchema),
] as const;
export const ServiceCommandSchema = z.discriminatedUnion(
  'operation',
  commandRequests,
);
export type ServiceCommand = z.infer<typeof ServiceCommandSchema>;

export const SERVICE_RESULT_SCHEMAS = {
  'service.status': ServiceStatusResultSchema,
  'agent.list': ListAgentsResultSchema,
  'agent.get': GetAgentResultSchema,
  'service.shutdown': ShutdownServiceResultSchema,
  'agent.add': AgentMutationResultSchema,
  'agent.update': AgentMutationResultSchema,
  'agent.enable': AgentMutationResultSchema,
  'agent.disable': AgentMutationResultSchema,
  'channel.list': ListChannelsResultSchema,
  'channel.get': GetChannelResultSchema,
  'channel.add': ChannelMutationResultSchema,
  'channel.update': ChannelMutationResultSchema,
  'channel.enable': ChannelMutationResultSchema,
  'channel.disable': ChannelMutationResultSchema,
  'channel.remove': RemoveChannelResultSchema,
  'run.list': ListRunsResultSchema,
  'run.show': ShowRunResultSchema,
  'run.cancel': RunActionResultSchema,
  'run.retry': RunActionResultSchema,
  'session.list': ListSessionsResultSchema,
  'session.show': ShowSessionResultSchema,
  'session.invalidate': InvalidateSessionResultSchema,
  'task.list': ListTasksResultSchema,
  'task.get': GetTaskResultSchema,
  'task.create': TaskMutationResultSchema,
  'task.create_from_message': TaskMutationResultSchema,
  'task.assign': TaskMutationResultSchema,
  'task.claim': TaskMutationResultSchema,
  'task.change_state': TaskMutationResultSchema,
  'task.submit_completion': TaskMutationResultSchema,
  'task.review_completion': TaskMutationResultSchema,
  'logs.query': ListLogsResultSchema,
  'project.binding.list': ListProjectBindingsResultSchema,
  'project.bind': BindProjectResultSchema,
  'engineering.binding.list': ListEngineeringBindingsLocalResultSchema,
  'engineering.bind': BindEngineeringResultSchema,
} as const;

export type ServiceStatusResult = z.infer<typeof ServiceStatusResultSchema>;
export type ServiceLogRecord = z.infer<typeof ServiceLogRecordSchema>;
export type ServiceLogStreamItem = z.infer<typeof ServiceLogStreamItemSchema>;
export type ServiceEventStreamItem = z.infer<
  typeof ServiceEventStreamItemSchema
>;
export type LogsQuery = z.infer<typeof LogsQuerySchema>;
export type ListLogsResult = z.infer<typeof ListLogsResultSchema>;
export type ListAgentsQuery = z.infer<typeof ListAgentsQuerySchema>;
export type ListChannelsQuery = z.infer<typeof ListChannelsQuerySchema>;
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;
