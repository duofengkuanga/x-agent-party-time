import { BugIdSchema } from '@/cooking/bugs/contract';
import { CommitShaSchema, CommittedRepairResultSchema } from '@/cooking/repair/contract';
import { HandoffTextSchema, HandoffRelativePathSchema } from '@/cooking/repair/handoff';
import {
  CookingAttachmentViewSchema,
  CookingInteractionViewSchema,
  ManualHandoffResultViewSchema,
  CookingMutationIdSchema,
  VersionedCookingMutationSchema,
  CookingValidationSchema,
  CookingVisualPresentationSchema,
} from '@/cooking/shared/contract';
import { outputJsonSchema } from '@/cooking/shared/output-schema';
import {
  SubmissionIdSchema,
  SubmissionItemIdSchema,
} from '@/cooking/submissions/contract';
import { ExecutionStateSchema } from '@agent-party-time/execution-contract';
import { z } from 'zod';

export const UpdateBatchIdSchema = z.uuid();
export const UpdateAttemptIdSchema = z.uuid();
export const ExternalDeploymentReportIdSchema = z.uuid();
export const UpdateBatchStateSchema = z.enum([
  'READY',
  'RUNNING',
  'WAITING_EXTERNAL',
  'FAILED',
  'COMPLETED',
]);

export const UpdateValidationSchema = CookingValidationSchema;

export const FrozenRepairHandoffSchema = z.strictObject({
  attemptId: z.uuid(),
  executionId: z.uuid(),
  commits: CommittedRepairResultSchema.shape.commits,
  changes: CommittedRepairResultSchema.shape.changes,
  validations: CommittedRepairResultSchema.shape.validations,
  warnings: CommittedRepairResultSchema.shape.warnings,
  handoff: CommittedRepairResultSchema.shape.handoff,
});

export const UpdateHandoffUseSchema = z.strictObject({
  adopted: z.array(HandoffTextSchema).max(5),
  rechecked: z
    .array(z.strictObject({ context: HandoffTextSchema, reason: HandoffTextSchema }))
    .max(5),
  validationCommands: z
    .array(
      z.strictObject({
        validationIndex: z.number().int().min(0).max(4),
        command: HandoffTextSchema.min(1),
        workingDirectory: HandoffRelativePathSchema,
        reason: HandoffTextSchema,
      }),
    )
    .max(10),
});

function validateHandoffUse(
  result: {
    validations: z.infer<typeof UpdateValidationSchema>[];
    handoffUse: z.infer<typeof UpdateHandoffUseSchema>;
  },
  context: z.RefinementCtx,
) {
  result.handoffUse.validationCommands.forEach((entry, index) => {
    const validation = result.validations[entry.validationIndex];
    if (!validation || validation.status === 'SKIPPED')
      context.addIssue({
        code: 'custom',
        path: ['handoffUse', 'validationCommands', index, 'validationIndex'],
        message: '交接使用记录必须关联本次实际执行的验证',
      });
  });
}

const UpdateResultFields = {
  completedActions: z.array(z.string().trim().min(1).max(300)).max(5),
  validations: z.array(UpdateValidationSchema).max(5),
  warnings: z.array(z.string().trim().min(1).max(300)).max(3),
  handoffUse: UpdateHandoffUseSchema,
};

const CompletedUpdateExecutionResultSchema = z
  .strictObject({
    outcome: z.literal('COMPLETED'),
    ...UpdateResultFields,
  })
  .superRefine(validateHandoffUse);

const PushedUpdateExecutionResultSchema = z
  .strictObject({
    outcome: z.literal('PUSHED'),
    ...UpdateResultFields,
  })
  .superRefine(validateHandoffUse);

const FailedUpdateExecutionResultSchema = z
  .strictObject({
    outcome: z.literal('FAILED'),
    failedStep: z.string().trim().min(1).max(240),
    reason: z.string().trim().min(1).max(500),
    ...UpdateResultFields,
    pendingActions: z.array(z.string().trim().min(1).max(300)).max(5),
  })
  .superRefine(validateHandoffUse);

export const LocalScriptUpdateExecutionResultSchema = z.strictObject({
  result: z.discriminatedUnion('outcome', [
    CompletedUpdateExecutionResultSchema,
    FailedUpdateExecutionResultSchema,
  ]),
});

export const CiCdUpdateExecutionResultSchema = z.strictObject({
  result: z.discriminatedUnion('outcome', [
    PushedUpdateExecutionResultSchema,
    FailedUpdateExecutionResultSchema,
  ]),
});

export const LocalScriptUpdateOutputJsonSchema = outputJsonSchema(
  LocalScriptUpdateExecutionResultSchema,
);
export const CiCdUpdateOutputJsonSchema = outputJsonSchema(
  CiCdUpdateExecutionResultSchema,
);

export const PendingDeliveryViewSchema = z.object({
  submissionItemId: SubmissionItemIdSchema,
  lastCandidateAt: z.iso.datetime(),
  eligibleAt: z.iso.datetime(),
  availableActions: z.array(z.literal('FREEZE_NOW')),
});

export const UpdateBatchEntryViewSchema = z.object({
  bugId: BugIdSchema,
  bugShortId: z.number().int().positive(),
  bugTitle: z.string().trim().min(1).max(240),
  commits: z.array(CommitShaSchema).nullable(),
  repairHandoffs: z.array(FrozenRepairHandoffSchema).nullable(),
});

const UpdateAttemptResultViewSchema = z.discriminatedUnion('outcome', [
  ManualHandoffResultViewSchema,
  z.object({
    outcome: z.enum(['COMPLETED', 'PUSHED']),
    completedActions: z.array(z.string()),
    validations: z.array(UpdateValidationSchema),
    warnings: z.array(z.string()),
    handoffUse: UpdateHandoffUseSchema.nullable(),
  }),
  z.object({
    outcome: z.literal('FAILED'),
    failedStep: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    completedActions: z.array(z.string()),
    validations: z.array(UpdateValidationSchema),
    warnings: z.array(z.string()),
    pendingActions: z.array(z.string()),
    failureCode: z.string().nullable(),
    handoffUse: UpdateHandoffUseSchema.nullable(),
  }),
]);

export const UpdateAttachmentViewSchema = CookingAttachmentViewSchema;

export const UpdateBatchTimelineNodeSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal('BATCH_FORMED'),
    occurredAt: z.iso.datetime(),
    bugCount: z.number().int().positive(),
  }),
  z.object({
    id: UpdateAttemptIdSchema,
    kind: z.literal('UPDATE_ATTEMPT'),
    executionId: z.uuid(),
    sessionId: z.string().trim().min(1).nullable(),
    canReadObservations: z.boolean(),
    attempt: z.number().int().positive(),
    executionState: ExecutionStateSchema,
    queuedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    interactions: z.array(CookingInteractionViewSchema),
    result: UpdateAttemptResultViewSchema.nullable(),
  }),
  z.object({
    id: ExternalDeploymentReportIdSchema,
    kind: z.literal('EXTERNAL_REPORT'),
    round: z.number().int().positive(),
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    summary: z.string().nullable(),
    attachments: z.array(UpdateAttachmentViewSchema),
    occurredAt: z.iso.datetime(),
  }),
]);

export const UpdateBatchViewSchema = z.object({
  id: UpdateBatchIdSchema,
  submissionId: SubmissionIdSchema,
  submissionItemId: SubmissionItemIdSchema,
  state: UpdateBatchStateSchema,
  version: z.number().int().positive(),
  activeExecutionId: z.uuid().nullable(),
  frozenAt: z.iso.datetime(),
  engineeringName: z.string().trim().min(1),
  targetBranch: z.string().trim().min(1),
  environmentName: z.string().trim().min(1),
  deploymentKind: z.enum(['LOCAL_SCRIPT', 'CI_CD']),
  hasManualDatabaseOperation: z.boolean(),
  synchronizationError: z.string().nullable(),
  entries: z.array(UpdateBatchEntryViewSchema).min(1),
  timeline: z.array(UpdateBatchTimelineNodeSchema),
  availableActions: z.array(z.enum(['RETRY_UPDATE', 'SYNC_SESSION', 'REPORT_EXTERNAL'])),
  presentation: z.object({
    statusLabel: z.string().trim().min(1),
    visual: CookingVisualPresentationSchema,
  }),
});

export const UpdateWorkspaceProjectionSchema = z.object({
  pendingDeliveries: z.array(PendingDeliveryViewSchema),
  updateBatches: z.array(UpdateBatchViewSchema),
});

export const FreezeUpdateInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
});

export const RetryUpdateInputSchema = VersionedCookingMutationSchema;

export const SynchronizeUpdateSessionInputSchema = RetryUpdateInputSchema;

export const ExternalDeploymentReportInputSchema = z.discriminatedUnion('outcome', [
  VersionedCookingMutationSchema.extend({
    outcome: z.literal('SUCCEEDED'),
    summary: z.string().trim().min(1).max(8_000).optional(),
    attachmentIds: z.array(z.uuid()).max(5),
  }),
  VersionedCookingMutationSchema.extend({
    outcome: z.literal('FAILED'),
    summary: z.string().trim().min(1).max(8_000),
    attachmentIds: z.array(z.uuid()).max(5),
  }),
]);

export const ResolveUpdateInteractionInputSchema = RetryUpdateInputSchema.extend({
  resolution: z.json(),
});

export const UpdateMutationResultSchema = z.object({
  batchId: UpdateBatchIdSchema,
  batchVersion: z.number().int().positive(),
  executionId: z.uuid().nullable(),
  revision: z.number().int().positive(),
});

export type UpdateBatchView = z.infer<typeof UpdateBatchViewSchema>;
export type FrozenRepairHandoff = z.infer<typeof FrozenRepairHandoffSchema>;
export type UpdateHandoffUse = z.infer<typeof UpdateHandoffUseSchema>;
export type UpdateWorkspaceProjection = z.infer<typeof UpdateWorkspaceProjectionSchema>;
export type RetryUpdateInput = z.infer<typeof RetryUpdateInputSchema>;
export type SynchronizeUpdateSessionInput = z.infer<
  typeof SynchronizeUpdateSessionInputSchema
>;
export type ExternalDeploymentReportInput = z.infer<
  typeof ExternalDeploymentReportInputSchema
>;
export type ResolveUpdateInteractionInput = z.infer<
  typeof ResolveUpdateInteractionInputSchema
>;
export type UpdateMutationResult = z.infer<typeof UpdateMutationResultSchema>;
