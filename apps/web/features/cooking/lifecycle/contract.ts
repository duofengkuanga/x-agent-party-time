import { z } from 'zod';
import {
  ExecutionInteractionSchema,
  ExecutionStateSchema,
  type JsonObject,
} from '@agent-party-time/execution-contract';
import {
  BugAttachmentViewSchema,
  BugIdSchema,
} from '@/features/cooking/bugs/contract';
import { CookingMutationIdSchema } from '@/features/cooking/shared/contract';
import {
  SubmissionIdSchema,
  SubmissionItemIdSchema,
} from '@/features/cooking/submissions/contract';

export const VerificationIdSchema = z.uuid();
export const CleanupIdSchema = z.uuid();

export const VerificationRecordViewSchema = z.object({
  id: VerificationIdSchema,
  bugId: BugIdSchema,
  round: z.number().int().positive(),
  result: z.enum(['PASSED', 'FAILED']),
  comment: z.string().nullable(),
  repairAttempt: z.number().int().positive().nullable(),
  attachments: z.array(BugAttachmentViewSchema),
  createdAt: z.iso.datetime(),
});

export const ReopenRecordViewSchema = z.object({
  id: z.uuid(),
  bugId: BugIdSchema,
  round: z.number().int().positive(),
  feedback: z.string().trim().min(1),
  repairAttempt: z.number().int().positive(),
  attachments: z.array(BugAttachmentViewSchema),
  createdAt: z.iso.datetime(),
});

export const BugLifecycleTransitionViewSchema = z.object({
  id: z.uuid(),
  bugId: BugIdSchema,
  kind: z.enum(['CANCELLED', 'RESTORED']),
  createdAt: z.iso.datetime(),
});

export const CleanupAttemptViewSchema = z.object({
  id: z.uuid(),
  attempt: z.number().int().positive(),
  executionState: ExecutionStateSchema,
  summary: z.string().nullable(),
  technicalFailure: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const CleanupViewSchema = z.object({
  id: CleanupIdSchema,
  submissionId: SubmissionIdSchema,
  submissionItemId: SubmissionItemIdSchema,
  reason: z.literal('SUBMISSION_CLOSED'),
  subjectId: z.uuid(),
  state: z.enum(['READY', 'RUNNING', 'FAILED', 'COMPLETED']),
  version: z.number().int().positive(),
  attempts: z.array(CleanupAttemptViewSchema),
  availableActions: z.array(z.literal('RETRY_CLEANUP')),
  presentation: z.object({ statusLabel: z.string().trim().min(1) }),
  createdAt: z.iso.datetime(),
});

export const CleanupInteractionViewSchema = ExecutionInteractionSchema.pick({
  id: true,
  executionId: true,
  kind: true,
  state: true,
  createdAt: true,
}).extend({
  cleanupId: CleanupIdSchema,
  submissionItemId: SubmissionItemIdSchema,
  method: z.string().nullable(),
  payload: z.json().nullable(),
  canResolve: z.boolean(),
});

export const TimelineEntrySchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum([
    'VERIFICATION',
    'REOPEN',
    'REPAIR',
    'UPDATE',
    'EXTERNAL_DEPLOYMENT',
    'CLEANUP',
    'SUBMISSION',
  ]),
  bugId: BugIdSchema.nullable(),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  createdAt: z.iso.datetime(),
});

export const LifecycleWorkspaceProjectionSchema = z.object({
  verificationsByBug: z.record(
    BugIdSchema,
    z.array(VerificationRecordViewSchema),
  ),
  reopensByBug: z.record(BugIdSchema, z.array(ReopenRecordViewSchema)),
  transitionsByBug: z.record(
    BugIdSchema,
    z.array(BugLifecycleTransitionViewSchema),
  ),
  cleanups: z.array(CleanupViewSchema),
  cleanupInteractions: z.array(CleanupInteractionViewSchema),
  timeline: z.array(TimelineEntrySchema),
});

export const VerifyBugInputSchema = z.discriminatedUnion('result', [
  z.object({
    mutationId: CookingMutationIdSchema,
    expectedVersion: z.number().int().positive(),
    result: z.literal('PASSED'),
    comment: z.string().trim().min(1).max(8_000).optional(),
    attachmentIds: z.array(z.uuid()).max(5),
  }),
  z.object({
    mutationId: CookingMutationIdSchema,
    expectedVersion: z.number().int().positive(),
    result: z.literal('FAILED'),
    feedback: z.string().trim().min(1).max(8_000),
    attachmentIds: z.array(z.uuid()).max(5),
  }),
]);

export const ReopenBugInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  feedback: z.string().trim().min(1).max(8_000),
  attachmentIds: z.array(z.uuid()).max(5),
});

export const LifecycleCommandInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const ResolveCleanupInteractionInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  resolution: z.json(),
});

export const BugLifecycleMutationResultSchema = z.object({
  bugId: BugIdSchema,
  bugVersion: z.number().int().positive(),
  executionId: z.uuid().nullable(),
  cleanupId: CleanupIdSchema.nullable(),
  revision: z.number().int().positive(),
});

export const CloseSubmissionMutationResultSchema = z.object({
  submissionId: SubmissionIdSchema,
  submissionVersion: z.number().int().positive(),
  cleanupExecutionIds: z.array(z.uuid()),
  revision: z.number().int().positive(),
});

export const CleanupMutationResultSchema = z.object({
  cleanupId: CleanupIdSchema,
  cleanupVersion: z.number().int().positive(),
  executionId: z.uuid(),
  revision: z.number().int().positive(),
});

export const CleanupExecutionResultSchema = z.discriminatedUnion('outcome', [
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
]);
export const CleanupOutputJsonSchema: JsonObject = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['COMPLETED', 'FAILED'] },
    summary: { type: 'string', minLength: 1, maxLength: 4_000 },
  },
  required: ['outcome', 'summary'],
  additionalProperties: false,
};

export type VerifyBugInput = z.infer<typeof VerifyBugInputSchema>;
export type ReopenBugInput = z.infer<typeof ReopenBugInputSchema>;
export type LifecycleCommandInput = z.infer<typeof LifecycleCommandInputSchema>;
export type ResolveCleanupInteractionInput = z.infer<
  typeof ResolveCleanupInteractionInputSchema
>;
export type BugLifecycleMutationResult = z.infer<
  typeof BugLifecycleMutationResultSchema
>;
export type CloseSubmissionMutationResult = z.infer<
  typeof CloseSubmissionMutationResultSchema
>;
export type CleanupMutationResult = z.infer<typeof CleanupMutationResultSchema>;
export type CleanupInteractionView = z.infer<
  typeof CleanupInteractionViewSchema
>;
export type LifecycleWorkspaceProjection = z.infer<
  typeof LifecycleWorkspaceProjectionSchema
>;
