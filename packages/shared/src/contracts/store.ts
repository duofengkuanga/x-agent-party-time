import { z } from 'zod';
import {
  ChannelMessageSchema,
  DurableEventSchema,
  RunnerResultSchema,
  type DurableEvent,
} from '../schemas/protocol.js';

import {
  ChannelCursorSchema,
  OutboxEntrySchema,
  RunRecordSchema,
  RunStateSchema,
  SessionRecordSchema,
  type SessionRecord,
  WakeJobSchema,
  WakeJobStateSchema,
  SessionStatusSchema,
  type WakeJob,
  type WakeJobState,
  type RunRecord,
  type ServiceHeartbeat,
  type OutboxEntry,
  type ChannelCursor,
  type Lease,
} from '../schemas/runtime.js';

import {
  CompletionArtifactSchema,
  TaskEventSchema,
  TaskRecordSchema,
  TaskStateSchema,
  TaskPrioritySchema,
  TaskAssigneeSchema,
  TeamLineageSchema,
  SquadSchema,
  type MessageAnchor,
  type TaskRecord,
  type TeamLineage,
  type Squad,
} from '../schemas/task.js';

import { type ServiceConfig } from '../schemas/service.js';
import type { AppError } from '../schemas/error.js';
export const PageRequestSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1_000),
});
export type PageRequest = z.infer<typeof PageRequestSchema>;

export function pageResultSchema<TSchema extends z.ZodType>(
  itemSchema: TSchema,
) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().min(1).nullable(),
  });
}
export type PageResult<TSchema extends z.ZodType> = z.infer<
  ReturnType<typeof pageResultSchema<TSchema>>
>;
export interface ConfigStore {
  load(): Promise<ServiceConfig>;

  save(next: ServiceConfig, expectedRevision: number): Promise<ServiceConfig>;

  watch(
    onChange: (config: ServiceConfig) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}

export const SessionFilterSchema = z.object({
  agentId: z.string().min(1).optional(),
  channelKey: z.string().min(1).optional(),
  status: SessionStatusSchema.optional(),
});

export type SessionFilter = z.infer<typeof SessionFilterSchema>;
export interface SessionRepository {
  get(key: string): Promise<SessionRecord | null>;
  list(
    filter: SessionFilter,
    page: PageRequest,
  ): Promise<PageResult<typeof SessionRecordSchema>>;
  create(record: SessionRecord): Promise<SessionRecord>;
  update(
    record: SessionRecord,
    expectedRevision: number,
  ): Promise<SessionRecord>;
  invalidate(
    key: string,
    reason: string,
    expectedRevision: number,
  ): Promise<SessionRecord>;
}

export const TaskFilterSchema = z.object({
  state: TaskStateSchema.optional(),
  priority: TaskPrioritySchema.optional(),

  // undefined：不按负责人过滤
  // null：只查询未分配任务
  // TaskAssignee：查询指定负责人
  assignee: TaskAssigneeSchema.nullable().optional(),

  // undefined：不限制父任务
  // null：只查询顶层任务
  // string：查询指定父任务的子任务
  parentTaskId: z.string().min(1).nullable().optional(),
});
export type TaskFilter = z.infer<typeof TaskFilterSchema>;
export interface TaskRepository {
  get(id: string): Promise<TaskRecord | null>;
  findByAnchor(anchor: MessageAnchor): Promise<TaskRecord | null>;
  list(
    filter: TaskFilter,
    page: PageRequest,
  ): Promise<PageResult<typeof TaskRecordSchema>>;
  listEvents(
    taskId: string,
    page: PageRequest,
  ): Promise<PageResult<typeof TaskEventSchema>>;
}

export const JobFilterSchema = z.object({
  state: WakeJobStateSchema.optional(),
  agentId: z.string().min(1).optional(),
  sessionKey: z.string().min(1).optional(),

  // undefined：不按 task 过滤
  // null：查询不属于任何 task 的 job
  // string：查询指定 task 的 job
  taskId: z.string().min(1).nullable().optional(),
});

export type JobFilter = z.infer<typeof JobFilterSchema>;
export interface JobRepository {
  get(id: string): Promise<WakeJob | null>;
  findByIdempotencyKey(key: string): Promise<WakeJob | null>;
  list(
    filter: JobFilter,
    page: PageRequest,
  ): Promise<PageResult<typeof WakeJobSchema>>;
  enqueue(job: WakeJob): Promise<WakeJob>;
  cancel(id: string, expectedState?: WakeJobState): Promise<WakeJob>;
  countByState(): Promise<Record<WakeJobState, number>>;
}

export const RunFilterSchema = z.object({
  jobId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  channelKey: z.string().min(1).optional(),
  state: RunStateSchema.optional(),

  // undefined：不按 task 过滤
  // null：查询没有关联 task 的 run
  // string：查询指定 task 的 run
  taskId: z.string().min(1).nullable().optional(),
});

export type RunFilter = z.infer<typeof RunFilterSchema>;

export interface RunRepository {
  get(id: string): Promise<RunRecord | null>;
  list(
    filter: RunFilter,
    page: PageRequest,
  ): Promise<PageResult<typeof RunRecordSchema>>;
  listByJob(jobId: string): Promise<RunRecord[]>;
}

export interface CursorRepository {
  get(subscriptionId: string): Promise<ChannelCursor | null>;
}

export interface OutboxRepository {
  get(id: string): Promise<OutboxEntry | null>;
  listDue(now: string, limit: number): Promise<OutboxEntry[]>;
  listByRun(runId: string): Promise<OutboxEntry[]>;
  countByState(): Promise<
    Record<z.infer<typeof OutboxEntrySchema>['state'], number>
  >;
}

export const StoredEventSchema = z.object({
  cursor: z.string().min(1),
  event: DurableEventSchema,
  committedAt: z.string().datetime(),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

export interface EventRepository {
  readAfter(
    cursor: string | null,
    limit: number,
  ): Promise<PageResult<typeof StoredEventSchema>>;
  latestCursor(): Promise<string | null>;
}

export interface HeartbeatRepository {
  get(instanceId: string): Promise<ServiceHeartbeat | null>;
  write(snapshot: ServiceHeartbeat): Promise<void>;
}

export interface TeamRepository {
  getLineage(workerAgentId: string): Promise<TeamLineage | null>;
  listLineages(teamId: string): Promise<TeamLineage[]>;
  getSquad(id: string): Promise<Squad | null>;
  listSquads(page: PageRequest): Promise<PageResult<typeof SquadSchema>>;
  saveSquad(squad: Squad, expectedRevision: number | null): Promise<Squad>;
}

export const IngestMessageInputSchema = z.object({
  message: ChannelMessageSchema,
  nextCursor: ChannelCursorSchema,
  wakeJob: WakeJobSchema.nullable(),
  event: DurableEventSchema,
});

export type IngestMessageInput = z.infer<typeof IngestMessageInputSchema>;

export const IngestMessageResultSchema = z.object({
  duplicate: z.boolean(),
  job: WakeJobSchema.nullable(),
  cursor: ChannelCursorSchema,
});

export type IngestMessageResult = z.infer<typeof IngestMessageResultSchema>;

export const WakeSourceContextSchema = z.object({
  instructions: z.string().min(1).max(100_000),
  subscriptionId: z.string().min(1).nullable(),
  channelKey: z.string().min(1),
  threadKey: z.string().min(1).nullable(),
  messageAnchor: z
    .object({
      channelKey: z.string().min(1),
      sourceSeq: z.string().min(1),
      eventId: z.string().min(1).optional(),
    })
    .nullable(),
});
export type WakeSourceContext = z.infer<typeof WakeSourceContextSchema>;

export const LeaseNextJobInputSchema = z.object({
  ownerInstanceId: z.string().min(1),
  now: z.string().datetime(),
  expiresAt: z.string().datetime(),
  excludedSessionKeys: z.array(z.string().min(1)),
  excludedWorkspacePaths: z.array(z.string().min(1)),
});

export type LeaseNextJobInput = z.infer<typeof LeaseNextJobInputSchema>;

export const LeasedJobResultSchema = z.object({
  job: WakeJobSchema,
  run: RunRecordSchema,
});

export type LeasedJobResult = z.infer<typeof LeasedJobResultSchema>;

export const CompleteRunInputSchema = z.object({
  jobId: z.string().min(1),
  runId: z.string().min(1),
  leaseOwnerInstanceId: z.string().min(1),
  leaseGeneration: z.number().int().positive(),
  result: RunnerResultSchema,
  outboxEntry: OutboxEntrySchema.nullable(),
  taskMutation: z.lazy(() => TaskMutationEffectSchema).nullable(),
  retryNextAttemptAt: z.string().datetime().nullable(),
  events: z.array(DurableEventSchema),
});

export type CompleteRunInput = z.infer<typeof CompleteRunInputSchema>;

export const TaskMutationEffectSchema = z.object({
  currentTaskId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  nextTask: TaskRecordSchema,
  completionArtifact: CompletionArtifactSchema.nullable(),
  event: TaskEventSchema,
  durableEvent: DurableEventSchema,
  wakeJob: WakeJobSchema.nullable(),
});

export type TaskMutationEffect = z.infer<typeof TaskMutationEffectSchema>;

export const CreateTaskEffectSchema = z.object({
  task: TaskRecordSchema,
  event: TaskEventSchema,
  durableEvent: DurableEventSchema,
  wakeJob: WakeJobSchema.nullable(),
});
export type CreateTaskEffect = z.infer<typeof CreateTaskEffectSchema>;

export interface StateStore {
  sessions: SessionRepository;
  tasks: TaskRepository;
  jobs: JobRepository;
  runs: RunRepository;
  cursors: CursorRepository;
  outbox: OutboxRepository;
  events: EventRepository;
  heartbeats: HeartbeatRepository;
  teams: TeamRepository;

  ingestMessage(input: IngestMessageInput): Promise<IngestMessageResult>;
  leaseNextJob(input: LeaseNextJobInput): Promise<LeasedJobResult | null>;
  getWakeSource(jobId: string): Promise<WakeSourceContext>;
  renewJobLease(
    jobId: string,
    ownerInstanceId: string,
    generation: number,
    expiresAt: string,
  ): Promise<Lease>;
  completeRun(input: CompleteRunInput): Promise<void>;
  createTask(input: CreateTaskEffect): Promise<TaskRecord>;
  mutateTask(input: TaskMutationEffect): Promise<TaskRecord>;
  retryJob(jobId: string, now: string): Promise<WakeJob>;
  createWorker(
    lineage: TeamLineage,
    job: WakeJob,
    event: DurableEvent,
  ): Promise<void>;
  leaseNextOutboxEntry(
    ownerInstanceId: string,
    now: string,
    expiresAt: string,
  ): Promise<OutboxEntry | null>;
  acknowledgeOutbox(
    entryId: string,
    leaseGeneration: number,
    providerMessageId: string,
    deliveredAt: string,
  ): Promise<OutboxEntry>;
  failOutboxAttempt(
    entryId: string,
    leaseGeneration: number,
    error: AppError,
    nextAttemptAt: string | null,
  ): Promise<OutboxEntry>;

  integrityCheck(): Promise<void>;
  close(): Promise<void>;
}
