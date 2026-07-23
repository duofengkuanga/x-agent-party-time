import { z } from 'zod';
import { PROTOCOL_VERSION } from '../config/index.js';
import { EVENT_NAMES } from '../events/index.js';
import { AppErrorSchema } from './error.js';
import {
  CompletionArtifactSchema,
  MessageAnchorSchema,
  TaskStateSchema,
} from './task.js';

const TimestampSchema = z.string().datetime();
const IdSchema = z.string().min(1);

export const EventEnvelopeSchema = z.object({
  schema: z.literal(PROTOCOL_VERSION),
  id: IdSchema,
  name: IdSchema,
  occurredAt: TimestampSchema,
  correlationId: IdSchema,
  causationId: IdSchema.nullable(),
  payload: z.json(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const ChannelIdentitySchema = z.object({
  subscriptionId: IdSchema,
  channelKey: IdSchema,
  threadKey: IdSchema.optional(),
});
export type ChannelIdentity = z.infer<typeof ChannelIdentitySchema>;

export const ChannelSenderSchema = z.object({
  id: IdSchema,
  displayName: IdSchema.optional(),
  isBot: z.boolean().default(false),
});
export type ChannelSender = z.infer<typeof ChannelSenderSchema>;

export const ChannelMessageSchema = z.object({
  channel: ChannelIdentitySchema,
  sourceSeq: IdSchema,
  sourceEventId: IdSchema.optional(),
  sender: ChannelSenderSchema,
  text: z.string().max(100_000),
  mentionedAgentIds: z.array(IdSchema).default([]),
  sentAt: TimestampSchema.optional(),
  receivedAt: TimestampSchema,
  rawRef: IdSchema.optional(),
});
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;

export const WakeObjectiveSchema = z.object({
  kind: z.enum([
    'channel_message',
    'task_assignment',
    'manual',
    'worker',
    'parent_synthesis',
  ]),
  agentId: IdSchema,
  sessionKey: IdSchema,
  workspacePath: IdSchema,
  messageAnchor: MessageAnchorSchema.nullable(),
  taskId: IdSchema.nullable(),
  parentRunId: IdSchema.nullable(),
  instructions: z.string().min(1).max(100_000),
  deadlineAt: TimestampSchema,
});
export type WakeObjective = z.infer<typeof WakeObjectiveSchema>;

export const SessionUpdateSchema = z.object({
  sessionKey: IdSchema,
  expectedRevision: z.number().int().nonnegative(),
  codexThreadId: IdSchema,
});
export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;

const RunnerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

export const RunnerResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('succeeded'),
    finalText: z.string().min(1).max(100_000),
    sessionUpdate: SessionUpdateSchema.nullable(),
    completionArtifact: CompletionArtifactSchema.nullable(),
    usage: RunnerUsageSchema.nullable(),
  }),
  z.object({
    status: z.literal('failed'),
    error: AppErrorSchema,
    sessionUpdate: SessionUpdateSchema.nullable(),
  }),
  z.object({
    status: z.literal('cancelled'),
    error: AppErrorSchema,
    sessionUpdate: SessionUpdateSchema.nullable(),
  }),
]);
export type RunnerResult = z.infer<typeof RunnerResultSchema>;

export function commandResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: AppErrorSchema }),
  ]);
}

export type CommandResult<T extends z.ZodType> = z.infer<
  ReturnType<typeof commandResultSchema<T>>
>;

function eventSchema<const TName extends string, TPayload extends z.ZodType>(
  name: TName,
  payload: TPayload,
) {
  return EventEnvelopeSchema.extend({ name: z.literal(name), payload });
}

const ServiceEventPayload = z.object({ instanceId: IdSchema });
const ChannelEventPayload = z.object({
  subscriptionId: IdSchema,
  channelKey: IdSchema,
});
const ChannelMessageEventPayload = ChannelEventPayload.extend({
  sourceSeq: IdSchema,
  sourceEventId: IdSchema.nullable(),
  jobId: IdSchema.nullable(),
  reason: z.string().min(1).max(500).optional(),
});
const JobEventPayload = z.object({
  jobId: IdSchema,
  runId: IdSchema.nullable().optional(),
  reason: z.string().max(2_000).optional(),
});
const RunEventPayload = z.object({
  runId: IdSchema,
  jobId: IdSchema,
  taskId: IdSchema.nullable(),
});
const SessionEventPayload = z.object({
  sessionKey: IdSchema,
  generation: z.number().int().positive(),
});
const TaskEventPayload = z.object({
  taskId: IdSchema,
  revision: z.number().int().nonnegative(),
});
const ReplyEventPayload = z.object({
  outboxEntryId: IdSchema,
  runId: IdSchema,
});
const WorkerEventPayload = z.object({
  teamId: IdSchema,
  workerAgentId: IdSchema,
  parentAgentId: IdSchema.nullable(),
});

export const DurableEventSchema = z.discriminatedUnion('name', [
  eventSchema(EVENT_NAMES.serviceStarted, ServiceEventPayload),
  eventSchema(
    EVENT_NAMES.serviceDegraded,
    ServiceEventPayload.extend({ reason: z.string().max(2_000) }),
  ),
  eventSchema(EVENT_NAMES.serviceStopping, ServiceEventPayload),
  eventSchema(EVENT_NAMES.serviceStopped, ServiceEventPayload),
  eventSchema(EVENT_NAMES.channelConnected, ChannelEventPayload),
  eventSchema(
    EVENT_NAMES.channelDisconnected,
    ChannelEventPayload.extend({ error: AppErrorSchema.nullable() }),
  ),
  eventSchema(EVENT_NAMES.channelMessageReceived, ChannelMessageEventPayload),
  eventSchema(EVENT_NAMES.channelMessageIgnored, ChannelMessageEventPayload),
  eventSchema(EVENT_NAMES.jobQueued, JobEventPayload),
  eventSchema(EVENT_NAMES.jobLeased, JobEventPayload),
  eventSchema(
    EVENT_NAMES.jobRetryScheduled,
    JobEventPayload.extend({ nextAttemptAt: TimestampSchema }),
  ),
  eventSchema(EVENT_NAMES.jobSucceeded, JobEventPayload),
  eventSchema(
    EVENT_NAMES.jobFailed,
    JobEventPayload.extend({ error: AppErrorSchema }),
  ),
  eventSchema(EVENT_NAMES.jobCancelled, JobEventPayload),
  eventSchema(EVENT_NAMES.runStarted, RunEventPayload),
  eventSchema(
    EVENT_NAMES.runProgressed,
    RunEventPayload.extend({
      phase: z.string().min(1),
      message: z.string().max(2_000),
    }),
  ),
  eventSchema(
    EVENT_NAMES.runCompleted,
    RunEventPayload.extend({ outboxEntryId: IdSchema.nullable() }),
  ),
  eventSchema(
    EVENT_NAMES.runFailed,
    RunEventPayload.extend({ error: AppErrorSchema }),
  ),
  eventSchema(EVENT_NAMES.runCancelled, RunEventPayload),
  eventSchema(EVENT_NAMES.sessionCreated, SessionEventPayload),
  eventSchema(
    EVENT_NAMES.sessionUpdated,
    SessionEventPayload.extend({ revision: z.number().int().nonnegative() }),
  ),
  eventSchema(
    EVENT_NAMES.sessionInvalidated,
    SessionEventPayload.extend({ reason: z.string().max(2_000) }),
  ),
  eventSchema(EVENT_NAMES.taskCreated, TaskEventPayload),
  eventSchema(EVENT_NAMES.taskAssigned, TaskEventPayload),
  eventSchema(
    EVENT_NAMES.taskStateChanged,
    TaskEventPayload.extend({
      previousState: TaskStateSchema,
      nextState: TaskStateSchema,
    }),
  ),
  eventSchema(
    EVENT_NAMES.taskCompletionSubmitted,
    TaskEventPayload.extend({ artifactId: IdSchema }),
  ),
  eventSchema(
    EVENT_NAMES.taskCompletionApproved,
    TaskEventPayload.extend({ artifactId: IdSchema }),
  ),
  eventSchema(
    EVENT_NAMES.taskCompletionRejected,
    TaskEventPayload.extend({ artifactId: IdSchema }),
  ),
  eventSchema(EVENT_NAMES.replyQueued, ReplyEventPayload),
  eventSchema(
    EVENT_NAMES.replyDelivered,
    ReplyEventPayload.extend({ providerMessageId: IdSchema }),
  ),
  eventSchema(
    EVENT_NAMES.replyRetryScheduled,
    ReplyEventPayload.extend({ nextAttemptAt: TimestampSchema }),
  ),
  eventSchema(
    EVENT_NAMES.replyFailed,
    ReplyEventPayload.extend({ error: AppErrorSchema }),
  ),
  eventSchema(EVENT_NAMES.workerSpawned, WorkerEventPayload),
  eventSchema(
    EVENT_NAMES.workerCompleted,
    WorkerEventPayload.extend({ runId: IdSchema }),
  ),
  eventSchema(EVENT_NAMES.workerExpired, WorkerEventPayload),
  eventSchema(
    EVENT_NAMES.parentSynthesisQueued,
    WorkerEventPayload.extend({ jobId: IdSchema }),
  ),
]);
export type DurableEvent = z.infer<typeof DurableEventSchema>;
