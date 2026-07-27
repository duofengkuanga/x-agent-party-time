import { z } from 'zod';
import {
  ExecutionInteractionSchema,
  ExecutionStateSchema,
} from '@agent-party-time/execution-contract';
import { BugIdSchema } from '@/modules/cooking/bugs/contract';
import { CommitShaSchema } from '@/modules/cooking/repair/contract';
import { CookingMutationIdSchema } from '@/modules/cooking/shared/contract';
import {
  SubmissionIdSchema,
  SubmissionItemIdSchema,
} from '@/modules/cooking/submissions/contract';

export const UpdateBatchIdSchema = z.uuid();
export const UpdateAttemptIdSchema = z.uuid();
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

export const LocalScriptUpdateOutputJsonSchema = z.toJSONSchema(
  LocalScriptUpdateExecutionResultSchema,
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

export const UpdateBatchViewSchema = z.object({
  id: UpdateBatchIdSchema,
  submissionId: SubmissionIdSchema,
  submissionItemId: SubmissionItemIdSchema,
  state: UpdateBatchStateSchema,
  version: z.number().int().positive(),
  activeExecutionId: z.uuid().nullable(),
  frozenAt: z.iso.datetime(),
  entries: z.array(UpdateBatchEntryViewSchema).min(1),
  attempts: z.array(UpdateAttemptViewSchema),
  availableActions: z.array(
    z.enum(['CONTINUE_UPDATE', 'CANCEL_BATCH', 'STOP_EXECUTION']),
  ),
  presentation: z.object({ statusLabel: z.string().trim().min(1) }),
});

export const UpdateInteractionViewSchema = ExecutionInteractionSchema.pick({
  id: true,
  executionId: true,
  kind: true,
  state: true,
  createdAt: true,
}).extend({
  batchId: UpdateBatchIdSchema,
  submissionItemId: SubmissionItemIdSchema,
  method: z.string().nullable(),
  payload: z.json().nullable(),
  canResolve: z.boolean(),
});

export const UpdateWorkspaceProjectionSchema = z.object({
  pendingDeliveries: z.array(PendingDeliveryViewSchema),
  updateBatches: z.array(UpdateBatchViewSchema),
  updateInteractions: z.array(UpdateInteractionViewSchema),
});

export const FreezeUpdateInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
});

export const ContinueUpdateInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  content: z.string().trim().min(1).max(8_000),
});

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
  executionId: z.uuid(),
  revision: z.number().int().positive(),
});

export type LocalScriptUpdateExecutionResult = z.infer<
  typeof LocalScriptUpdateExecutionResultSchema
>;
export type PendingDeliveryView = z.infer<typeof PendingDeliveryViewSchema>;
export type UpdateBatchView = z.infer<typeof UpdateBatchViewSchema>;
export type UpdateInteractionView = z.infer<typeof UpdateInteractionViewSchema>;
export type UpdateWorkspaceProjection = z.infer<
  typeof UpdateWorkspaceProjectionSchema
>;
export type FreezeUpdateInput = z.infer<typeof FreezeUpdateInputSchema>;
export type ContinueUpdateInput = z.infer<typeof ContinueUpdateInputSchema>;
export type UpdateBatchCommandInput = z.infer<
  typeof UpdateBatchCommandInputSchema
>;
export type ResolveUpdateInteractionInput = z.infer<
  typeof ResolveUpdateInteractionInputSchema
>;
export type UpdateMutationResult = z.infer<typeof UpdateMutationResultSchema>;
