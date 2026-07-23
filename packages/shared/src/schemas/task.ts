import { z } from 'zod';

export const TaskStateSchema = z.enum([
  'triage',
  'backlog',
  'assigned',
  'in_progress',
  'waiting',
  'needs_review',
  'blocked',
  'done',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), id: z.string().min(1) }),
  z.object({ kind: z.literal('human'), id: z.string().min(1) }),
  z.object({ kind: z.literal('system'), id: z.string().min(1) }),
]);
export type TaskActor = z.infer<typeof TaskActorSchema>;

export const TaskAssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), id: z.string().min(1) }),
  z.object({ kind: z.literal('human'), id: z.string().min(1) }),
  z.object({ kind: z.literal('squad'), id: z.string().min(1) }),
]);
export type TaskAssignee = z.infer<typeof TaskAssigneeSchema>;
export const MessageAnchorSchema = z.object({
  channelKey: z.string().min(1).max(256),
  sourceSeq: z.string().min(1).max(256),
  eventId: z.string().min(1).max(256).optional(),
});
export type MessageAnchor = z.infer<typeof MessageAnchorSchema>;
export const ArtifactReferenceSchema = z.object({
  kind: z.enum(['file', 'url', 'run', 'message', 'text']),
  value: z.string().min(1).max(2_000),
  label: z.string().min(1).max(200).optional(),
});
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
export const CompletionArtifactSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1).optional(),
  submittedBy: TaskActorSchema,
  summary: z.string().trim().min(1).max(10_000),
  references: z.array(ArtifactReferenceSchema).max(100).default([]),
  createdAt: z.string().datetime(),
});
export type CompletionArtifact = z.infer<typeof CompletionArtifactSchema>;
export const CompletionReviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('approved'),
    reviewer: TaskActorSchema,
    reviewedAt: z.string().datetime(),
    reason: z.string().trim().max(2_000).optional(),
  }),
  z.object({
    status: z.literal('rejected'),
    reviewer: TaskActorSchema,
    reviewedAt: z.string().datetime(),
    reason: z.string().trim().min(1).max(2_000),
    replacementArtifactId: z.string().min(1).optional(),
  }),
]);
export type CompletionReview = z.infer<typeof CompletionReviewSchema>;

export const TaskRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().max(20_000).default(''),
    state: TaskStateSchema.default('triage'),
    priority: TaskPrioritySchema.default('normal'),
    assignee: TaskAssigneeSchema.nullable().default(null),
    creator: TaskActorSchema,
    labels: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    parentTaskId: z.string().min(1).nullable().default(null),
    anchors: z.array(MessageAnchorSchema).max(100).default([]),
    completion: CompletionArtifactSchema.nullable().default(null),
    completionReview: CompletionReviewSchema.nullable().default(null),
    revision: z.number().int().nonnegative().default(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((task, ctx) => {
    if (new Set(task.labels).size !== task.labels.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['labels'],
        message: 'labels must be unique',
      });
    }
    if (['assigned', 'in_progress'].includes(task.state) && !task.assignee) {
      ctx.addIssue({
        code: 'custom',
        path: ['assignee'],
        message: `${task.state} task requires an assignee`,
      });
    }
    if (
      task.state === 'needs_review' &&
      (!task.completion || task.completionReview?.status !== 'pending')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['completionReview'],
        message: 'needs_review task requires a completion and pending review',
      });
    }
    if (task.state === 'done' && task.completionReview?.status !== 'approved') {
      ctx.addIssue({
        code: 'custom',
        path: ['completionReview'],
        message: 'done task requires an approved completion',
      });
    }
  });
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export const TaskEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  type: z.enum([
    'created',
    'assigned',
    'claimed',
    'state_changed',
    'completion_submitted',
    'completion_approved',
    'completion_rejected',
    'label_changed',
  ]),
  actor: TaskActorSchema,
  previousRevision: z.number().int().nonnegative().nullable(),
  nextRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2_000).optional(),
  payload: z.record(z.string(), z.json()).default({}),
  createdAt: z.string().datetime(),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export const TeamLineageSchema = z.object({
  teamId: z.string().min(1),
  rootAgentId: z.string().min(1),
  parentAgentId: z.string().min(1).nullable(),
  workerAgentId: z.string().min(1),
  role: z.string().min(1).max(100),
  depth: z.number().int().min(1).max(4),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type TeamLineage = z.infer<typeof TeamLineageSchema>;
export const SquadSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    leaderAgentId: z.string().min(1),
    memberAgentIds: z.array(z.string().min(1)).min(1).max(32),
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((squad, ctx) => {
    if (new Set(squad.memberAgentIds).size !== squad.memberAgentIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['memberAgentIds'],
        message: 'memberAgentIds must be unique',
      });
    }
    if (!squad.memberAgentIds.includes(squad.leaderAgentId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['leaderAgentId'],
        message: 'leaderAgentId must be a member',
      });
    }
  });
export type Squad = z.infer<typeof SquadSchema>;
