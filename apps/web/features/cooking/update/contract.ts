import { z } from 'zod';
import {
  ExecutionStateSchema,
  type JsonObject,
} from '@agent-party-time/execution-contract';
import { BugIdSchema } from '@/features/cooking/bugs/contract';
import { CommitShaSchema } from '@/features/cooking/repair/contract';
import {
  CookingInteractionViewSchema,
  CookingMutationIdSchema,
  CookingVisualPresentationSchema,
} from '@/features/cooking/shared/contract';
import {
  SubmissionIdSchema,
  SubmissionItemIdSchema,
} from '@/features/cooking/submissions/contract';

export const UpdateBatchIdSchema = z.uuid();
export const UpdateAttemptIdSchema = z.uuid();
export const ExternalDeploymentReportIdSchema = z.uuid();
export const UpdateBatchStateSchema = z.enum([
  'READY',
  'RUNNING',
  'WAITING_EXTERNAL',
  'FAILED',
  'COMPLETED',
  'CANCELLED',
]);

export const LocalScriptUpdateExecutionResultSchema = z.discriminatedUnion(
  'outcome',
  [
    z
      .object({
        outcome: z.literal('COMPLETED'),
        summary: z.string().trim().min(1).max(4_000),
      })
      .strict(),
    z
      .object({
        outcome: z.literal('FAILED'),
        summary: z.string().trim().min(1).max(4_000),
      })
      .strict(),
  ],
);

export const CiCdUpdateExecutionResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('PUSHED'),
      summary: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('FAILED'),
      summary: z.string().trim().min(1).max(4_000),
    })
    .strict(),
]);

export const LocalScriptUpdateOutputJsonSchema: JsonObject = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['COMPLETED', 'FAILED'] },
    summary: { type: 'string', minLength: 1, maxLength: 4_000 },
  },
  required: ['outcome', 'summary'],
  additionalProperties: false,
};
export const CiCdUpdateOutputJsonSchema: JsonObject = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['PUSHED', 'FAILED'] },
    summary: { type: 'string', minLength: 1, maxLength: 4_000 },
  },
  required: ['outcome', 'summary'],
  additionalProperties: false,
};

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
});

export const UpdateAttemptViewSchema = z.object({
  id: UpdateAttemptIdSchema,
  executionId: z.uuid(),
  attempt: z.number().int().positive(),
  executionState: ExecutionStateSchema,
  summary: z.string().nullable(),
  technicalFailure: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const UpdateAttachmentViewSchema = z.object({
  id: z.uuid(),
  originalName: z.string().trim().min(1).max(255),
  mediaType: z.enum([
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
    'application/json',
  ]),
  sizeBytes: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});

export const ExternalDeploymentReportViewSchema = z.object({
  id: ExternalDeploymentReportIdSchema,
  round: z.number().int().positive(),
  outcome: z.enum(['SUCCEEDED', 'FAILED']),
  summary: z.string().nullable(),
  attachments: z.array(UpdateAttachmentViewSchema),
  createdAt: z.iso.datetime(),
});

export const UpdateBatchViewSchema = z.object({
  id: UpdateBatchIdSchema,
  submissionId: SubmissionIdSchema,
  submissionItemId: SubmissionItemIdSchema,
  state: UpdateBatchStateSchema,
  version: z.number().int().positive(),
  activeExecutionId: z.uuid().nullable(),
  frozenAt: z.iso.datetime(),
  deploymentKind: z.enum(['LOCAL_SCRIPT', 'CI_CD']),
  entries: z.array(UpdateBatchEntryViewSchema).min(1),
  attempts: z.array(UpdateAttemptViewSchema),
  interactions: z.array(CookingInteractionViewSchema),
  externalReports: z.array(ExternalDeploymentReportViewSchema),
  availableActions: z.array(
    z.enum([
      'CONTINUE_UPDATE',
      'CANCEL_BATCH',
      'STOP_EXECUTION',
      'REPORT_EXTERNAL',
    ]),
  ),
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

export const ContinueUpdateInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  content: z.string().trim().min(1).max(8_000).optional(),
});

export const ExternalDeploymentReportInputSchema = z.discriminatedUnion(
  'outcome',
  [
    z.object({
      mutationId: CookingMutationIdSchema,
      expectedVersion: z.number().int().positive(),
      outcome: z.literal('SUCCEEDED'),
      summary: z.string().trim().min(1).max(8_000).optional(),
      attachmentIds: z.array(z.uuid()).max(5),
    }),
    z.object({
      mutationId: CookingMutationIdSchema,
      expectedVersion: z.number().int().positive(),
      outcome: z.literal('FAILED'),
      summary: z.string().trim().min(1).max(8_000),
      attachmentIds: z.array(z.uuid()).max(5),
    }),
  ],
);

export const UpdateBatchCommandInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const ResolveUpdateInteractionInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  resolution: z.json(),
});

export const UpdateMutationResultSchema = z.object({
  batchId: UpdateBatchIdSchema,
  batchVersion: z.number().int().positive(),
  executionId: z.uuid().nullable(),
  revision: z.number().int().positive(),
});

export type LocalScriptUpdateExecutionResult = z.infer<
  typeof LocalScriptUpdateExecutionResultSchema
>;
export type CiCdUpdateExecutionResult = z.infer<
  typeof CiCdUpdateExecutionResultSchema
>;
export type PendingDeliveryView = z.infer<typeof PendingDeliveryViewSchema>;
export type UpdateBatchView = z.infer<typeof UpdateBatchViewSchema>;
export type UpdateWorkspaceProjection = z.infer<
  typeof UpdateWorkspaceProjectionSchema
>;
export type FreezeUpdateInput = z.infer<typeof FreezeUpdateInputSchema>;
export type ContinueUpdateInput = z.infer<typeof ContinueUpdateInputSchema>;
export type ExternalDeploymentReportInput = z.infer<
  typeof ExternalDeploymentReportInputSchema
>;
export type UpdateBatchCommandInput = z.infer<
  typeof UpdateBatchCommandInputSchema
>;
export type ResolveUpdateInteractionInput = z.infer<
  typeof ResolveUpdateInteractionInputSchema
>;
export type UpdateMutationResult = z.infer<typeof UpdateMutationResultSchema>;
