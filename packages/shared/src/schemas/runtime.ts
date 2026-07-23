import { z } from 'zod';
import { AppErrorSchema } from './error.js';

const TimestampSchema = z.string().datetime();

export const ServiceHeartbeatSchema = z.object({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  version: z.string().min(1),
  startedAt: TimestampSchema,
  lastBeatAt: TimestampSchema,
  sequence: z.number().int().nonnegative(),
  status: z.enum(['starting', 'running', 'degraded', 'stopping']),
});
export type ServiceHeartbeat = z.infer<typeof ServiceHeartbeatSchema>;

export const ChannelCursorSchema = z.object({
  subscriptionId: z.string().min(1),
  sourceSeq: z.string().min(1).nullable(),
  sourceEventId: z.string().min(1).nullable(),
  updatedAt: TimestampSchema,
});
export type ChannelCursor = z.infer<typeof ChannelCursorSchema>;

export const SessionStatusSchema = z.enum([
  'pending',
  'active',
  'invalidated',
  'failed',
]);

export const SessionRecordSchema = z.object({
  key: z.string().min(1),
  generation: z.number().int().positive(),
  agentId: z.string().min(1),
  channelKey: z.string().min(1),
  workspacePath: z.string().min(1),
  codexThreadId: z.string().min(1).nullable(),
  status: SessionStatusSchema,
  invalidatedReason: z.string().max(2_000).nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export const LeaseSchema = z.object({
  ownerInstanceId: z.string().min(1),
  generation: z.number().int().positive(),
  acquiredAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type Lease = z.infer<typeof LeaseSchema>;

export const WakeJobStateSchema = z.enum([
  'queued',
  'leased',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
]);
export type WakeJobState = z.infer<typeof WakeJobStateSchema>;
export const WakeJobSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  triggerKind: z.enum([
    'channel_message',
    'task_assignment',
    'manual',
    'worker',
    'parent_synthesis',
  ]),
  agentId: z.string().min(1),
  sessionKey: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  sourceRef: z.string().min(1),
  priority: z.number().int(),
  state: WakeJobStateSchema,
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  lease: LeaseSchema.nullable(),
  nextAttemptAt: TimestampSchema.nullable(),
  deadlineAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WakeJob = z.infer<typeof WakeJobSchema>;
export const RunStateSchema = z.enum([
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const RunRecordSchema = z
  .object({
    id: z.string().min(1),
    jobId: z.string().min(1),
    attempt: z.number().int().positive(),
    leaseGeneration: z.number().int().positive(),
    runnerName: z.string().min(1),
    state: RunStateSchema,
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
    resultSummary: z.string().max(10_000).nullable(),
    error: AppErrorSchema.nullable(),
    usage: z.record(z.string(), z.number().nonnegative()).nullable(),
  })
  .superRefine((run, ctx) => {
    const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(
      run.state,
    );
    if (terminal && !run.finishedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'terminal run requires finishedAt',
      });
    }
    if (!terminal && run.finishedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'active run cannot have finishedAt',
      });
    }
    if (run.state === 'succeeded' && !run.resultSummary) {
      ctx.addIssue({
        code: 'custom',
        path: ['resultSummary'],
        message: 'succeeded run requires resultSummary',
      });
    }
    if (
      ['failed', 'cancelled', 'timed_out'].includes(run.state) &&
      !run.error
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: `${run.state} run requires error`,
      });
    }
  });
export type RunRecord = z.infer<typeof RunRecordSchema>;
export const OutboxStateSchema = z.enum([
  'pending',
  'sending',
  'retry_wait',
  'delivered',
  'failed',
]);

export const ReplyDestinationSchema = z.object({
  subscriptionId: z.string().min(1),
  channelKey: z.string().min(1),
  threadKey: z.string().min(1).optional(),
  replyToEventId: z.string().min(1).optional(),
});
export type ReplyDestination = z.infer<typeof ReplyDestinationSchema>;

export const OutboxEntrySchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  destination: ReplyDestinationSchema,
  text: z.string().min(1).max(100_000),
  dedupeKey: z.string().min(1),
  state: OutboxStateSchema,
  attemptCount: z.number().int().nonnegative(),
  lease: LeaseSchema.nullable(),
  nextAttemptAt: TimestampSchema.nullable(),
  providerMessageId: z.string().min(1).nullable(),
  lastError: AppErrorSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;
export type OutboxState = z.infer<typeof OutboxStateSchema>;
