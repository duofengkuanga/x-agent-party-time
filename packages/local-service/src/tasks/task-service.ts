import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AssignTaskCommandSchema,
  ChangeTaskStateCommandSchema,
  ClaimTaskCommandSchema,
  CreateTaskCommandSchema,
  CreateTaskFromMessageCommandSchema,
  DurableEventSchema,
  EVENT_NAMES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  ReviewCompletionCommandSchema,
  SubmitCompletionCommandSchema,
  TaskEventSchema,
  TaskMutationEffectSchema,
  TaskRecordSchema,
  WakeJobSchema,
  createAppError,
  type ConfigStore,
  type PageRequest,
  type StateStore,
  type TaskFilter,
  type TaskRecord,
  type TaskState,
  type TaskMutationEffect,
  type WakeJob,
} from '@agent-party-time/shared';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';
import { buildSessionKey } from '../sessions/session-manager.js';

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  triage: ['backlog', 'assigned', 'blocked'],
  backlog: ['assigned', 'blocked'],
  assigned: ['in_progress', 'backlog', 'blocked'],
  in_progress: ['waiting', 'needs_review', 'blocked'],
  waiting: ['in_progress', 'blocked'],
  needs_review: ['done', 'in_progress', 'assigned'],
  blocked: ['backlog', 'assigned', 'in_progress'],
  done: [],
};
export interface TaskServiceOptions {
  store: StateStore;
  configStore: ConfigStore;
  clock: Clock;
  logger: Logger;
}
export interface PrepareRunCompletionInput {
  taskId: string;
  expectedRevision: number;
  runId: string;
  agentId: string;
  summary: string;
  references?: z.infer<typeof SubmitCompletionCommandSchema>['references'];
}

export class TaskService {
  constructor(private readonly options: TaskServiceOptions) {}
  async create(
    raw: z.input<typeof CreateTaskCommandSchema>,
  ): Promise<TaskRecord> {
    const input = CreateTaskCommandSchema.parse(raw);
    const existing = await this.options.store.tasks.get(input.taskId);
    if (existing) {
      const same =
        existing.title === input.title &&
        existing.description === input.description &&
        existing.priority === input.priority &&
        JSON.stringify(existing.assignee) === JSON.stringify(input.assignee) &&
        JSON.stringify(existing.creator) === JSON.stringify(input.creator) &&
        JSON.stringify(existing.labels) ===
          JSON.stringify([...new Set(input.labels)]) &&
        existing.parentTaskId === input.parentTaskId;
      if (same) return existing;
      throw this.conflict('task id 已存在');
    }
    if (input.assignee) await this.validateAssignee(input.assignee);
    const now = this.options.clock.now().toISOString();
    const task = TaskRecordSchema.parse({
      id: input.taskId,
      title: input.title,
      description: input.description,
      state: input.assignee ? 'assigned' : 'triage',
      priority: input.priority,
      assignee: input.assignee,
      creator: input.creator,
      labels: [...new Set(input.labels)],
      parentTaskId: input.parentTaskId,
      anchors: [],
      completion: null,
      completionReview: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    const event = TaskEventSchema.parse({
      id: randomUUID(),
      taskId: task.id,
      type: 'created',
      actor: input.creator,
      previousRevision: null,
      nextRevision: 0,
      payload: {},
      createdAt: now,
    });
    return this.options.store.createTask({
      task,
      event,
      durableEvent: this.event(
        EVENT_NAMES.taskCreated,
        task.id,
        task.revision,
        event.id,
      ),
      wakeJob: input.assignee ? await this.assignmentJob(task, event.id) : null,
    });
  }
  async createFromMessage(
    raw: z.input<typeof CreateTaskFromMessageCommandSchema>,
  ): Promise<TaskRecord> {
    const input = CreateTaskFromMessageCommandSchema.parse(raw);
    const existing = await this.options.store.tasks.findByAnchor(input.anchor);
    if (existing) return existing;
    if (input.assignee) await this.validateAssignee(input.assignee);
    const now = this.options.clock.now().toISOString();
    const task = TaskRecordSchema.parse({
      id: randomUUID(),
      title: `频道任务 ${input.anchor.channelKey}:${input.anchor.sourceSeq}`,
      description: '',
      state: input.assignee ? 'assigned' : 'triage',
      priority: input.priority,
      assignee: input.assignee,
      creator: input.creator,
      labels: [],
      parentTaskId: input.parentTaskId,
      anchors: [input.anchor],
      completion: null,
      completionReview: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    const event = TaskEventSchema.parse({
      id: randomUUID(),
      taskId: task.id,
      type: 'created',
      actor: input.creator,
      previousRevision: null,
      nextRevision: 0,
      payload: { anchor: input.anchor },
      createdAt: now,
    });
    try {
      return await this.options.store.createTask({
        task,
        event,
        durableEvent: this.event(
          EVENT_NAMES.taskCreated,
          task.id,
          task.revision,
          event.id,
        ),
        wakeJob: input.assignee
          ? await this.assignmentJob(task, event.id)
          : null,
      });
    } catch (error) {
      const concurrent = await this.options.store.tasks.findByAnchor(
        input.anchor,
      );
      if (concurrent) return concurrent;
      throw error;
    }
  }
  async assign(
    raw: z.input<typeof AssignTaskCommandSchema>,
  ): Promise<TaskRecord> {
    const input = AssignTaskCommandSchema.parse(raw);
    await this.validateAssignee(input.assignee);
    const current = await this.loadForMutation(
      input.taskId,
      input.expectedRevision,
    );
    const now = this.options.clock.now().toISOString();
    const next = TaskRecordSchema.parse({
      ...current,
      assignee: input.assignee,
      state: 'assigned',
      revision: current.revision + 1,
      updatedAt: now,
    });
    const event = TaskEventSchema.parse({
      id: randomUUID(),
      taskId: current.id,
      type: 'assigned',
      actor: input.actor,
      previousRevision: current.revision,
      nextRevision: next.revision,
      reason: input.reason,
      payload: { assignee: input.assignee },
      createdAt: now,
    });
    return this.options.store.mutateTask({
      currentTaskId: current.id,
      expectedRevision: current.revision,
      nextTask: next,
      completionArtifact: null,
      event,
      durableEvent: this.event(
        EVENT_NAMES.taskAssigned,
        current.id,
        next.revision,
        event.id,
      ),
      wakeJob: await this.assignmentJob(next, event.id),
    });
  }
  async claim(
    raw: z.input<typeof ClaimTaskCommandSchema>,
  ): Promise<TaskRecord> {
    const input = ClaimTaskCommandSchema.parse(raw);
    return this.assign({
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      assignee: input.actor,
      actor: input.actor,
      reason: 'task claimed',
    });
  }
  async changeState(
    raw: z.input<typeof ChangeTaskStateCommandSchema>,
  ): Promise<TaskRecord> {
    const input = ChangeTaskStateCommandSchema.parse(raw);
    if (['needs_review', 'done'].includes(input.nextState))
      throw this.transition('必须使用 completion/review 流程进入目标状态');
    const current = await this.loadForMutation(
      input.taskId,
      input.expectedRevision,
    );
    if (!TASK_TRANSITIONS[current.state].includes(input.nextState))
      throw this.transition(`${current.state} 不能迁移到 ${input.nextState}`);
    if (
      ['assigned', 'in_progress'].includes(input.nextState) &&
      !current.assignee
    )
      throw this.transition('目标状态需要 assignee');
    if (input.nextState === 'blocked' && !input.reason)
      throw this.transition('blocked 状态必须提供 reason');
    return this.commitState(
      current,
      input.nextState,
      input.actor,
      input.reason,
    );
  }
  async submitCompletion(
    raw: z.input<typeof SubmitCompletionCommandSchema>,
  ): Promise<TaskRecord> {
    const input = SubmitCompletionCommandSchema.parse(raw);
    const current = await this.loadForMutation(
      input.taskId,
      input.expectedRevision,
    );
    if (!['in_progress', 'waiting', 'blocked'].includes(current.state))
      throw this.transition('当前状态不能提交 completion');
    const now = this.options.clock.now().toISOString();
    const artifact = {
      id: randomUUID(),
      taskId: current.id,
      ...(input.runId ? { runId: input.runId } : {}),
      submittedBy: input.submittedBy,
      summary: input.summary,
      references: input.references,
      createdAt: now,
    };
    const next = TaskRecordSchema.parse({
      ...current,
      state: 'needs_review',
      completion: artifact,
      completionReview: { status: 'pending' },
      revision: current.revision + 1,
      updatedAt: now,
    });
    const event = TaskEventSchema.parse({
      id: randomUUID(),
      taskId: current.id,
      type: 'completion_submitted',
      actor: input.submittedBy,
      previousRevision: current.revision,
      nextRevision: next.revision,
      payload: { artifactId: artifact.id },
      createdAt: now,
    });
    return this.options.store.mutateTask({
      currentTaskId: current.id,
      expectedRevision: current.revision,
      nextTask: next,
      completionArtifact: artifact,
      event,
      durableEvent: this.event(
        EVENT_NAMES.taskCompletionSubmitted,
        current.id,
        next.revision,
        event.id,
        { artifactId: artifact.id },
      ),
      wakeJob: null,
    });
  }
  async prepareRunCompletion(
    input: PrepareRunCompletionInput,
  ): Promise<TaskMutationEffect> {
    const current = await this.loadForMutation(
      input.taskId,
      input.expectedRevision,
    );
    const now = this.options.clock.now().toISOString();
    const artifact = {
      id: randomUUID(),
      taskId: current.id,
      runId: input.runId,
      submittedBy: { kind: 'agent' as const, id: input.agentId },
      summary: input.summary,
      references: input.references ?? [],
      createdAt: now,
    };
    const next = TaskRecordSchema.parse({
      ...current,
      state: 'needs_review',
      completion: artifact,
      completionReview: { status: 'pending' },
      revision: current.revision + 1,
      updatedAt: now,
    });
    const event = TaskEventSchema.parse({
      id: randomUUID(),
      taskId: current.id,
      type: 'completion_submitted',
      actor: artifact.submittedBy,
      previousRevision: current.revision,
      nextRevision: next.revision,
      payload: { artifactId: artifact.id },
      createdAt: now,
    });
    return TaskMutationEffectSchema.parse({
      currentTaskId: current.id,
      expectedRevision: current.revision,
      nextTask: next,
      completionArtifact: artifact,
      event,
      durableEvent: this.event(
        EVENT_NAMES.taskCompletionSubmitted,
        current.id,
        next.revision,
        event.id,
        { artifactId: artifact.id },
      ),
      wakeJob: null,
    });
  }
  async reviewCompletion(
    raw: z.input<typeof ReviewCompletionCommandSchema>,
  ): Promise<TaskRecord> {
    const input = ReviewCompletionCommandSchema.parse(raw);
    const current = await this.loadForMutation(
      input.taskId,
      input.expectedRevision,
    );
    if (
      current.state !== 'needs_review' ||
      !current.completion ||
      current.completionReview?.status !== 'pending'
    )
      throw this.transition('没有待审核 completion');
    const now = this.options.clock.now().toISOString();
    const approved = input.decision === 'approve';
    const nextState: TaskState = approved
      ? 'done'
      : current.assignee
        ? 'in_progress'
        : 'backlog';
    const review = approved
      ? {
          status: 'approved' as const,
          reviewer: input.reviewer,
          reviewedAt: now,
          ...(input.reason ? { reason: input.reason } : {}),
        }
      : {
          status: 'rejected' as const,
          reviewer: input.reviewer,
          reviewedAt: now,
          reason: input.reason!,
        };
    const next = TaskRecordSchema.parse({
      ...current,
      state: nextState,
      completionReview: review,
      revision: current.revision + 1,
      updatedAt: now,
    });
    const eventName = approved
      ? EVENT_NAMES.taskCompletionApproved
      : EVENT_NAMES.taskCompletionRejected;
    const event = TaskEventSchema.parse({
      id: randomUUID(),
      taskId: current.id,
      type: approved ? 'completion_approved' : 'completion_rejected',
      actor: input.reviewer,
      previousRevision: current.revision,
      nextRevision: next.revision,
      reason: input.reason,
      payload: { artifactId: current.completion.id },
      createdAt: now,
    });
    return this.options.store.mutateTask({
      currentTaskId: current.id,
      expectedRevision: current.revision,
      nextTask: next,
      completionArtifact: current.completion,
      event,
      durableEvent: this.event(eventName, current.id, next.revision, event.id, {
        artifactId: current.completion.id,
      }),
      wakeJob: approved ? null : await this.assignmentJob(next, event.id),
    });
  }
  async get(id: string): Promise<TaskRecord> {
    const task = await this.options.store.tasks.get(id);
    if (!task)
      throw createAppError({
        code: ERROR_CODES.entityNotFound,
        category: 'not_found',
        message: `task ${id} 不存在`,
        retryable: false,
      });
    return task;
  }
  list(filter: TaskFilter, page: PageRequest) {
    return this.options.store.tasks.list(filter, page);
  }
  private async commitState(
    current: TaskRecord,
    nextState: TaskState,
    actor: z.infer<typeof ChangeTaskStateCommandSchema>['actor'],
    reason?: string,
  ) {
    const now = this.options.clock.now().toISOString();
    const next = TaskRecordSchema.parse({
      ...current,
      state: nextState,
      revision: current.revision + 1,
      updatedAt: now,
    });
    const event = TaskEventSchema.parse({
      id: randomUUID(),
      taskId: current.id,
      type: 'state_changed',
      actor,
      previousRevision: current.revision,
      nextRevision: next.revision,
      reason,
      payload: { previousState: current.state, nextState },
      createdAt: now,
    });
    return this.options.store.mutateTask({
      currentTaskId: current.id,
      expectedRevision: current.revision,
      nextTask: next,
      completionArtifact: null,
      event,
      durableEvent: this.event(
        EVENT_NAMES.taskStateChanged,
        current.id,
        next.revision,
        event.id,
        { previousState: current.state, nextState },
      ),
      wakeJob: null,
    });
  }
  private async assignmentJob(
    task: TaskRecord,
    causationId: string,
  ): Promise<WakeJob | null> {
    if (!task.assignee || task.assignee.kind !== 'agent') return null;
    const config = await this.options.configStore.load();
    const agent = config.agents.find(
      (item) => item.id === task.assignee!.id && item.enabled,
    );
    if (!agent) return null;
    const channelKey = task.anchors[0]?.channelKey ?? 'task-ledger';
    const sessionKey = buildSessionKey({
      agentId: agent.id,
      channelKey,
      canonicalWorkspacePath: agent.workspacePath,
    });
    const now = this.options.clock.now();
    return WakeJobSchema.parse({
      id: randomUUID(),
      idempotencyKey: `task:${task.id}:${task.revision}:${agent.id}`,
      triggerKind: 'task_assignment',
      agentId: agent.id,
      sessionKey,
      taskId: task.id,
      sourceRef: task.id,
      priority: 80,
      state: 'queued',
      attemptCount: 0,
      maxAttempts: 3,
      lease: null,
      nextAttemptAt: null,
      deadlineAt: new Date(
        now.getTime() + config.settings.wakeJobTimeoutMs,
      ).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }
  private async validateAssignee(
    assignee: z.infer<typeof AssignTaskCommandSchema>['assignee'],
  ) {
    if (assignee.kind !== 'agent') return;
    const config = await this.options.configStore.load();
    if (
      !config.agents.some((agent) => agent.id === assignee.id && agent.enabled)
    )
      throw this.conflict(`agent ${assignee.id} 不存在或已禁用`);
  }
  private async loadForMutation(id: string, revision: number) {
    const task = await this.get(id);
    if (task.revision !== revision)
      throw createAppError({
        code: ERROR_CODES.taskRevisionConflict,
        category: 'conflict',
        message: 'task revision 冲突',
        retryable: false,
        details: { expectedRevision: revision, actualRevision: task.revision },
      });
    return task;
  }
  private event(
    name: string,
    taskId: string,
    revision: number,
    causationId: string,
    extra: Record<string, unknown> = {},
  ) {
    return DurableEventSchema.parse({
      schema: PROTOCOL_VERSION,
      id: randomUUID(),
      name,
      occurredAt: this.options.clock.now().toISOString(),
      correlationId: taskId,
      causationId,
      payload: { taskId, revision, ...extra },
    });
  }
  private transition(message: string) {
    return createAppError({
      code: ERROR_CODES.taskTransitionInvalid,
      category: 'conflict',
      message,
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
