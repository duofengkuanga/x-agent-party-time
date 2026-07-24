import { z } from 'zod';
import { BugDescriptionSchema } from './bug-description.ts';

const IsoUtcDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const IdSchema = z.uuid();
const UserIdSchema = z.string().trim().min(1).max(80);
const NullableIdSchema = IdSchema.nullable();

export const TestSubmissionStatusSchema = z.enum(['ACTIVE', 'CLOSED']);
export const SubmissionBugStatusSchema = z.enum([
  'WAITING_FOR_REPAIR',
  'REPAIRING',
  'WAITING_FOR_UPDATE',
  'UPDATING',
  'WAITING_FOR_VERIFICATION',
  'DONE',
  'CANCELLED',
]);
export const SubmissionRepairTaskStateSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
]);
export const SubmissionUpdateBatchStateSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_EXTERNAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export const SubmissionCleanupTaskStateSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
]);
export const CodexInteractionKindSchema = z.enum(['PERMISSION', 'USER_INPUT']);
export const CodexInteractionStateSchema = z.enum([
  'PENDING',
  'RESOLVED',
  'INVALIDATED',
]);

export const SubmissionUserSchema = z.object({
  id: UserIdSchema,
  username: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(120),
  accountType: z.enum(['DEVELOPER', 'TESTER']),
});

export const SubmissionEnvironmentSnapshotSchema = z.object({
  id: IdSchema,
  slug: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(120),
  deploymentType: z.enum(['LOCAL_SCRIPT', 'CI_CD']),
  localScriptCommand: z.string().trim().min(1).max(4_000).nullable(),
  manualConfirmationRequired: z.boolean(),
});

export const SubmissionItemTechnicalSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(2_000),
  bindingId: IdSchema,
  runnerId: IdSchema,
  targetBranch: z.string().trim().min(1).max(240),
  environment: SubmissionEnvironmentSnapshotSchema,
});

export const SubmissionTestTargetSchema = z.object({
  targetBranch: z.string().trim().min(1).max(240),
  environment: z.object({
    slug: z.string().trim().min(1).max(64),
    displayName: z.string().trim().min(1).max(120),
  }),
});

export const TestSubmissionItemSchema = z.object({
  id: IdSchema,
  submissionId: IdSchema,
  engineeringId: IdSchema,
  engineeringSlug: z.string().trim().min(1).max(64),
  engineeringDisplayName: z.string().trim().min(1).max(120),
  engineeringType: z.enum(['FRONTEND', 'BACKEND']),
  responsibleDeveloper: SubmissionUserSchema,
  testTarget: SubmissionTestTargetSchema,
  technical: SubmissionItemTechnicalSchema.nullable(),
  lockedAt: IsoUtcDateTimeSchema.nullable(),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});

export const TestSubmissionSummarySchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  projectTitle: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(160),
  requirementDescription: z.string().trim().min(1).max(12_000),
  tester: SubmissionUserSchema,
  status: TestSubmissionStatusSchema,
  itemCount: z.number().int().positive(),
  bugCounts: z.object({
    waitingForRepair: z.number().int().nonnegative(),
    repairing: z.number().int().nonnegative(),
    waitingForUpdate: z.number().int().nonnegative(),
    updating: z.number().int().nonnegative(),
    waitingForVerification: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  createdByUserId: UserIdSchema,
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
  closedAt: IsoUtcDateTimeSchema.nullable(),
});

export const TestSubmissionDetailSchema = TestSubmissionSummarySchema.extend({
  items: z.array(TestSubmissionItemSchema).min(1),
});
export type TestSubmissionSummary = z.infer<typeof TestSubmissionSummarySchema>;
export type TestSubmissionDetail = z.infer<typeof TestSubmissionDetailSchema>;

export const SubmissionBugAttachmentSchema = z.object({
  id: IdSchema,
  bugId: IdSchema,
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.enum([
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
    'application/json',
  ]),
  sizeBytes: z.number().int().positive(),
  createdAt: IsoUtcDateTimeSchema,
});

export const SubmissionUpdateFeedbackAttachmentSchema = z.object({
  id: IdSchema,
  batchId: IdSchema,
  fileName: z.string().trim().min(1).max(255),
  mediaType: SubmissionBugAttachmentSchema.shape.mediaType,
  sizeBytes: z.number().int().positive(),
  contentBase64: z.string().min(1),
  createdAt: IsoUtcDateTimeSchema,
});

export const SubmissionRepairActivitySchema = z.enum([
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'WAITING_INTERACTION',
]);
export const SubmissionUpdateActivitySchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_INTERACTION',
  'WAITING_EXTERNAL',
  'FAILED',
]);

export const SubmissionRepairRecordSchema = z.object({
  id: IdSchema,
  bugId: IdSchema,
  taskId: IdSchema,
  phase: z.enum(['STARTUP', 'EXECUTION']),
  sessionId: z.string().trim().min(1).max(240).nullable(),
  outcome: z.enum([
    'READY',
    'NEEDS_INPUT',
    'BLOCKED',
    'FAILED',
    'INFRASTRUCTURE_ERROR',
  ]),
  summary: z.string().trim().min(1).max(12_000),
  candidateCommit: z.string().trim().min(1).max(200).nullable(),
  createdAt: IsoUtcDateTimeSchema,
});

export const SubmissionRepairFeedbackSchema = z.object({
  id: IdSchema,
  bugId: IdSchema,
  taskId: IdSchema.nullable(),
  actorUserId: UserIdSchema,
  feedback: z.string().trim().min(1).max(8_000),
  createdAt: IsoUtcDateTimeSchema,
});

export const SubmissionBugCleanupSchema = z.object({
  state: z.enum(['NOT_REQUIRED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
  taskId: IdSchema.nullable(),
  summary: z.string().trim().min(1).max(8_000).nullable(),
});

export const SubmissionBugSchema = z.object({
  id: IdSchema,
  shortId: z.string().regex(/^BUG-\d{4,}$/),
  submissionId: IdSchema,
  submissionItemId: NullableIdSchema,
  engineeringType: z.enum(['FRONTEND', 'BACKEND']).nullable(),
  engineeringDisplayName: z.string().trim().min(1).max(120).nullable(),
  status: SubmissionBugStatusSchema,
  title: z.string().trim().min(1).max(160),
  ...BugDescriptionSchema.shape,
  latestFeedback: z.string().trim().min(1).max(8_000).nullable(),
  attachments: z.array(SubmissionBugAttachmentSchema),
  repairActivity: SubmissionRepairActivitySchema.nullable(),
  updateActivity: SubmissionUpdateActivitySchema.nullable(),
  latestRepairFailed: z.boolean(),
  repairRecords: z.array(SubmissionRepairRecordSchema),
  repairFeedback: z.array(SubmissionRepairFeedbackSchema),
  candidateCommits: z.array(z.string().trim().min(1).max(200)),
  candidateCommit: z.string().trim().min(1).max(200).nullable(),
  repairSessionId: z.string().trim().min(1).max(240).nullable(),
  cancelledFromStatus: SubmissionBugStatusSchema.exclude([
    'CANCELLED',
  ]).nullable(),
  cancelledByUserId: UserIdSchema.nullable(),
  cancelledAt: IsoUtcDateTimeSchema.nullable(),
  cleanup: SubmissionBugCleanupSchema,
  createdByUserId: UserIdSchema,
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});

export type SubmissionBug = z.infer<typeof SubmissionBugSchema>;

export const SubmissionRepairTaskSchema = z.object({
  id: IdSchema,
  bugId: IdSchema,
  submissionItemId: IdSchema,
  bindingId: IdSchema,
  runnerId: IdSchema,
  state: SubmissionRepairTaskStateSchema,
  position: z.number().int().nonnegative(),
  leaseToken: z.string().trim().min(1).max(240).nullable(),
  leaseExpiresAt: IsoUtcDateTimeSchema.nullable(),
  resumeSessionId: z.string().trim().min(1).max(240).nullable(),
  failurePhase: z.enum(['STARTUP', 'EXECUTION']).nullable(),
  failureSummary: z.string().trim().min(1).max(12_000).nullable(),
  createdAt: IsoUtcDateTimeSchema,
  startedAt: IsoUtcDateTimeSchema.nullable(),
  completedAt: IsoUtcDateTimeSchema.nullable(),
});

export type SubmissionRepairTask = z.infer<typeof SubmissionRepairTaskSchema>;

export const SubmissionUpdateBatchSchema = z.object({
  id: IdSchema,
  submissionItemId: IdSchema,
  bindingId: IdSchema,
  runnerId: IdSchema,
  state: SubmissionUpdateBatchStateSchema,
  deploymentType: z.enum(['LOCAL_SCRIPT', 'CI_CD']),
  bugIds: z.array(IdSchema).min(1),
  candidateCommits: z.array(z.string().trim().min(1).max(200)),
  candidateCommitChains: z.array(
    z.object({
      bugId: IdSchema,
      commits: z.array(z.string().trim().min(1).max(200)).min(1),
    }),
  ),
  cancelRequested: z.boolean(),
  eligibleAt: IsoUtcDateTimeSchema,
  immediateRequestedAt: IsoUtcDateTimeSchema.nullable(),
  sessionId: z.string().trim().min(1).max(240).nullable(),
  leaseToken: z.string().trim().min(1).max(240).nullable(),
  leaseExpiresAt: IsoUtcDateTimeSchema.nullable(),
  externalFailure: z.string().trim().min(1).max(12_000).nullable(),
  externalFailureAttachments: z.array(SubmissionUpdateFeedbackAttachmentSchema),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
  completedAt: IsoUtcDateTimeSchema.nullable(),
});

export type SubmissionUpdateBatch = z.infer<typeof SubmissionUpdateBatchSchema>;

export const SubmissionCleanupTaskSchema = z.object({
  id: IdSchema,
  submissionId: IdSchema,
  submissionItemId: IdSchema,
  targetKind: z.enum(['SUBMISSION', 'BUG']),
  bugId: IdSchema.nullable(),
  bindingId: IdSchema,
  runnerId: IdSchema,
  state: SubmissionCleanupTaskStateSchema,
  sessionIds: z.array(z.string().trim().min(1).max(240)),
  summary: z.string().trim().min(1).max(8_000).nullable(),
  leaseToken: z.string().trim().min(1).max(240).nullable(),
  leaseExpiresAt: IsoUtcDateTimeSchema.nullable(),
  retryCount: z.number().int().nonnegative(),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});

export type SubmissionCleanupTask = z.infer<typeof SubmissionCleanupTaskSchema>;

export const CodexInteractionRequestSchema = z.object({
  id: IdSchema,
  executionKind: z.enum(['REPAIR', 'UPDATE', 'CLEANUP']),
  executionId: IdSchema,
  submissionItemId: IdSchema,
  bindingId: IdSchema,
  kind: CodexInteractionKindSchema,
  method: z.enum([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
  ]),
  threadId: z.string().trim().min(1).max(240),
  turnId: z.string().trim().min(1).max(240),
  itemId: z.string().trim().min(1).max(240),
  payload: z.record(z.string(), z.unknown()),
  state: CodexInteractionStateSchema,
  resolution: z
    .object({
      action: z.enum(['DECLINE', 'ACCEPT_FOR_SESSION', 'ANSWER']),
      answers: z.record(z.string(), z.array(z.string())).optional(),
    })
    .nullable(),
  createdAt: IsoUtcDateTimeSchema,
  resolvedAt: IsoUtcDateTimeSchema.nullable(),
});
export type CodexInteractionRequest = z.infer<
  typeof CodexInteractionRequestSchema
>;

const AttachmentUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: SubmissionBugAttachmentSchema.shape.mediaType,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  contentBase64: z.string().min(1),
});

const CreateSubmissionItemSchema = z.object({
  engineeringId: IdSchema,
  responsibleDeveloperUserId: UserIdSchema,
  bindingId: IdSchema,
  targetBranch: z.string().trim().min(1).max(240),
  environmentId: IdSchema,
});

export const CollaborativeCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('submission.create'),
    projectId: IdSchema,
    title: z.string().trim().min(1).max(160),
    requirementDescription: z.string().trim().min(1).max(12_000),
    testerUserId: UserIdSchema,
    items: z.array(CreateSubmissionItemSchema).min(1).max(30),
  }),
  z.object({
    kind: z.literal('submission.item.update'),
    submissionItemId: IdSchema,
    responsibleDeveloperUserId: UserIdSchema,
    bindingId: IdSchema,
    targetBranch: z.string().trim().min(1).max(240),
    environmentId: IdSchema,
  }),
  z.object({
    kind: z.literal('bug.create'),
    submissionId: IdSchema,
    submissionItemId: NullableIdSchema,
    engineeringType: z.enum(['FRONTEND', 'BACKEND']).nullable().optional(),
    title: z.string().trim().min(1).max(160),
    ...BugDescriptionSchema.shape,
    attachments: z.array(AttachmentUploadSchema).max(5).default([]),
  }),
  z.object({
    kind: z.literal('bug.update'),
    bugId: IdSchema,
    submissionItemId: NullableIdSchema,
    engineeringType: z.enum(['FRONTEND', 'BACKEND']).nullable(),
    title: z.string().trim().min(1).max(160),
    ...BugDescriptionSchema.shape,
    existingAttachmentIds: z.array(IdSchema).max(5),
    attachments: z.array(AttachmentUploadSchema).max(5),
  }),
  z.object({
    kind: z.literal('bug.assign'),
    bugId: IdSchema,
    submissionItemId: NullableIdSchema,
    engineeringType: z.enum(['FRONTEND', 'BACKEND']).nullable(),
  }),
  z.object({
    kind: z.literal('bug.move'),
    bugId: IdSchema,
    targetStatus: z.literal('DONE'),
  }),
  z.object({
    kind: z.literal('bug.cancel'),
    bugId: IdSchema,
  }),
  z.object({
    kind: z.literal('repair_task.enqueue'),
    bugId: IdSchema,
    feedback: z.string().trim().min(1).max(8_000).nullable().optional(),
    insertAtFront: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('repair_task.withdraw'),
    bugId: IdSchema,
  }),
  z.object({
    kind: z.literal('repair_queue.reorder'),
    submissionItemId: IdSchema,
    bugIds: z.array(IdSchema),
  }),
  z.object({
    kind: z.literal('repair_task.claim'),
    runnerId: IdSchema,
    leaseDurationMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(60_000),
  }),
  z.object({
    kind: z.literal('repair_task.start'),
    taskId: IdSchema,
    runnerId: IdSchema,
    leaseToken: z.string().trim().min(1).max(240),
  }),
  z.object({
    kind: z.literal('repair_task.renew'),
    taskId: IdSchema,
    runnerId: IdSchema,
    leaseToken: z.string().trim().min(1).max(240),
    leaseDurationMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(60_000),
  }),
  z.object({
    kind: z.literal('repair_task.fail_start'),
    taskId: IdSchema,
    runnerId: IdSchema,
    leaseToken: z.string().trim().min(1).max(240),
    summary: z.string().trim().min(1).max(12_000),
  }),
  z.object({
    kind: z.literal('repair_task.finish'),
    taskId: IdSchema,
    runnerId: IdSchema,
    leaseToken: z.string().trim().min(1).max(240),
    sessionId: z.string().trim().min(1).max(240).nullable(),
    outcome: z.enum([
      'READY',
      'NEEDS_INPUT',
      'BLOCKED',
      'FAILED',
      'INFRASTRUCTURE_ERROR',
    ]),
    summary: z.string().trim().min(1).max(12_000),
    candidateCommit: z.string().trim().min(1).max(200).nullable(),
  }),
  z.object({
    kind: z.literal('update.trigger'),
    submissionItemId: IdSchema,
  }),
  z.object({
    kind: z.literal('update.continue'),
    batchId: IdSchema,
    feedback: z.string().trim().min(1).max(12_000),
  }),
  z.object({
    kind: z.literal('update.cancel'),
    batchId: IdSchema,
  }),
  z.object({
    kind: z.literal('interaction.open'),
    executionKind: z.enum(['REPAIR', 'UPDATE', 'CLEANUP']),
    executionId: IdSchema,
    submissionItemId: IdSchema,
    bindingId: IdSchema,
    interactionKind: CodexInteractionKindSchema,
    method: CodexInteractionRequestSchema.shape.method,
    threadId: z.string().trim().min(1).max(240),
    turnId: z.string().trim().min(1).max(240),
    itemId: z.string().trim().min(1).max(240),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('interaction.resolve'),
    interactionId: IdSchema,
    action: z.enum(['DECLINE', 'ACCEPT_FOR_SESSION', 'ANSWER']),
    answers: z.record(z.string(), z.array(z.string())).optional(),
  }),
  z.object({
    kind: z.literal('interaction.invalidate'),
    executionKind: z.enum(['REPAIR', 'UPDATE', 'CLEANUP']),
    executionId: IdSchema,
  }),
  z.object({
    kind: z.literal('update_task.claim'),
    runnerId: IdSchema,
    leaseDurationMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(60_000),
  }),
  z.object({
    kind: z.literal('update_task.renew'),
    batchId: IdSchema,
    runnerId: IdSchema,
    leaseToken: z.string().trim().min(1).max(240),
    leaseDurationMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(60_000),
  }),
  z.object({
    kind: z.literal('update_task.finish'),
    batchId: IdSchema,
    runnerId: IdSchema,
    leaseToken: z.string().trim().min(1).max(240),
    sessionId: z.string().trim().min(1).max(240).nullable(),
    outcome: z.enum(['PUSHED', 'COMPLETED', 'FAILED', 'CANCELLED']),
    summary: z.string().trim().min(1).max(12_000),
  }),
  z.object({
    kind: z.literal('update.external_failure'),
    batchId: IdSchema,
    feedback: z.string().trim().min(1).max(12_000),
    attachments: z.array(AttachmentUploadSchema).max(5).default([]),
  }),
  z.object({
    kind: z.literal('update.external_confirm'),
    batchId: IdSchema,
  }),
  z.object({
    kind: z.literal('submission.close'),
    submissionId: IdSchema,
  }),
  z.object({
    kind: z.literal('cleanup_task.claim'),
    runnerId: IdSchema,
    leaseDurationMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(60_000),
  }),
  z.object({
    kind: z.literal('cleanup_task.renew'),
    taskId: IdSchema,
    runnerId: IdSchema,
    leaseToken: z.string().trim().min(1).max(240),
    leaseDurationMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(60_000),
  }),
  z.object({
    kind: z.literal('cleanup_task.finish'),
    taskId: IdSchema,
    runnerId: IdSchema,
    leaseToken: z.string().trim().min(1).max(240),
    success: z.boolean(),
    summary: z.string().trim().min(1).max(8_000),
  }),
  z.object({
    kind: z.literal('cleanup_task.retry'),
    taskId: IdSchema,
  }),
]);
export type CollaborativeCommand = z.input<typeof CollaborativeCommandSchema>;
export type ParsedCollaborativeCommand = z.output<
  typeof CollaborativeCommandSchema
>;

export const CollaborativeQuerySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('submission.list'),
    projectId: IdSchema.optional(),
    includeClosed: z.boolean().default(true),
  }),
  z.object({ kind: z.literal('submission.get'), submissionId: IdSchema }),
  z.object({ kind: z.literal('bug.board'), submissionId: IdSchema }),
  z.object({ kind: z.literal('bug.get'), bugId: IdSchema }),
  z.object({ kind: z.literal('bug.attachment.get'), attachmentId: IdSchema }),
  z.object({ kind: z.literal('repair_queue.get'), submissionItemId: IdSchema }),
  z.object({
    kind: z.literal('update_batches.list'),
    submissionItemId: IdSchema,
  }),
  z.object({
    kind: z.literal('update_task.control'),
    batchId: IdSchema,
    runnerId: IdSchema,
  }),
  z.object({ kind: z.literal('cleanup_tasks.list'), runnerId: IdSchema }),
  z.object({ kind: z.literal('interaction.get'), interactionId: IdSchema }),
  z.object({
    kind: z.literal('interactions.list'),
    submissionItemId: IdSchema,
    pendingOnly: z.boolean().default(false),
  }),
]);
export type CollaborativeQuery = z.infer<typeof CollaborativeQuerySchema>;

export const CollaborativeCommandResultSchema = z.object({
  kind: z.string().min(1),
  submission: TestSubmissionDetailSchema.optional(),
  bug: SubmissionBugSchema.optional(),
  repairTask: SubmissionRepairTaskSchema.nullable().optional(),
  updateBatch: SubmissionUpdateBatchSchema.nullable().optional(),
  cleanupTask: SubmissionCleanupTaskSchema.nullable().optional(),
  interaction: CodexInteractionRequestSchema.nullable().optional(),
});
export type CollaborativeCommandResult = z.infer<
  typeof CollaborativeCommandResultSchema
>;

export const CollaborativeQueryResultSchema = z.object({
  kind: z.string().min(1),
  submissions: z.array(TestSubmissionSummarySchema).optional(),
  submission: TestSubmissionDetailSchema.optional(),
  bugs: z.array(SubmissionBugSchema).optional(),
  bug: SubmissionBugSchema.optional(),
  repairTasks: z.array(SubmissionRepairTaskSchema).optional(),
  updateBatches: z.array(SubmissionUpdateBatchSchema).optional(),
  cleanupTasks: z.array(SubmissionCleanupTaskSchema).optional(),
  interactions: z.array(CodexInteractionRequestSchema).optional(),
  interaction: CodexInteractionRequestSchema.optional(),
  attachment: SubmissionBugAttachmentSchema.optional(),
  contentBase64: z.string().min(1).optional(),
  updateCancelRequested: z.boolean().optional(),
});
export type CollaborativeQueryResult = z.infer<
  typeof CollaborativeQueryResultSchema
>;
