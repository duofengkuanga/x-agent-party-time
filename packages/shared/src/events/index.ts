import { z } from 'zod';

export const EVENT_NAMES = {
  serviceStarted: 'service.started',
  serviceDegraded: 'service.degraded',
  serviceStopping: 'service.stopping',
  serviceStopped: 'service.stopped',

  channelConnected: 'channel.connected',
  channelDisconnected: 'channel.disconnected',
  channelMessageReceived: 'channel.message_received',
  channelMessageIgnored: 'channel.message_ignored',

  jobQueued: 'job.queued',
  jobLeased: 'job.leased',
  jobRetryScheduled: 'job.retry_scheduled',
  jobSucceeded: 'job.succeeded',
  jobFailed: 'job.failed',
  jobCancelled: 'job.cancelled',

  runStarted: 'run.started',
  runProgressed: 'run.progressed',
  runCompleted: 'run.completed',
  runFailed: 'run.failed',
  runCancelled: 'run.cancelled',

  sessionCreated: 'session.created',
  sessionUpdated: 'session.updated',
  sessionInvalidated: 'session.invalidated',

  taskCreated: 'task.created',
  taskAssigned: 'task.assigned',
  taskStateChanged: 'task.state_changed',
  taskCompletionSubmitted: 'task.completion_submitted',
  taskCompletionApproved: 'task.completion_approved',
  taskCompletionRejected: 'task.completion_rejected',

  replyQueued: 'reply.queued',
  replyDelivered: 'reply.delivered',
  replyRetryScheduled: 'reply.retry_scheduled',
  replyFailed: 'reply.failed',

  workerSpawned: 'worker.spawned',
  workerCompleted: 'worker.completed',
  workerExpired: 'worker.expired',
  parentSynthesisQueued: 'worker.parent_synthesis_queued',
} as const;
export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];
export const EventNameSchema = z.enum(EVENT_NAMES);
