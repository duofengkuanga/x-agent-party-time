import { z } from 'zod';
import { UserIdSchema, UserSchema } from '@/platform/auth/contract';
import {
  SubmissionIdSchema,
  SubmissionItemIdSchema,
} from '@/modules/cooking/submissions/contract';
import { CookingMutationIdSchema } from '@/modules/cooking/shared/contract';

export const BugIdSchema = z.uuid();
export const BugFeedbackIdSchema = z.uuid();
export const BugStageSchema = z.enum([
  'WAITING_FOR_REPAIR',
  'REPAIRING',
  'WAITING_FOR_UPDATE',
  'UPDATING',
  'WAITING_FOR_VERIFICATION',
  'DONE',
  'CANCELLED',
]);
export const BugFeedbackKindSchema = z.enum([
  'TESTER_FEEDBACK',
  'DEVELOPER_NOTE',
  'EXECUTION_FAILURE',
]);
export const BugTitleSchema = z.string().trim().min(1).max(240);
const OptionalReportTextSchema = z.string().trim().min(1).max(8_000);
export const BugAttachmentIdsSchema = z.array(z.uuid()).max(5);

export const BugReportSchema = z.object({
  title: BugTitleSchema,
  operationPath: OptionalReportTextSchema.optional(),
  actualResult: OptionalReportTextSchema.optional(),
  expectedResult: OptionalReportTextSchema.optional(),
  notes: OptionalReportTextSchema.optional(),
  attachmentIds: BugAttachmentIdsSchema,
});

export const BugSchema = z.object({
  id: BugIdSchema,
  shortId: z.number().int().positive(),
  submissionId: SubmissionIdSchema,
  submissionItemId: SubmissionItemIdSchema.nullable(),
  stage: BugStageSchema,
  report: BugReportSchema,
  reportLockedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdByUserId: UserIdSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const BugFeedbackSchema = z.object({
  id: BugFeedbackIdSchema,
  bugId: BugIdSchema,
  kind: BugFeedbackKindSchema,
  authorUserId: UserIdSchema.nullable(),
  content: z.string().trim().min(1).max(8_000),
  attachmentIds: BugAttachmentIdsSchema,
  createdAt: z.iso.datetime(),
});

export const CreateBugInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  submissionItemId: SubmissionItemIdSchema.nullable(),
  title: BugTitleSchema,
  operationPath: z.string().max(8_000).optional(),
  actualResult: z.string().max(8_000).optional(),
  expectedResult: z.string().max(8_000).optional(),
  notes: z.string().max(8_000).optional(),
  attachmentIds: BugAttachmentIdsSchema,
});

export const UpdateBugReportInputSchema = CreateBugInputSchema.omit({
  mutationId: true,
}).extend({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const AssignBugInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  submissionItemId: SubmissionItemIdSchema.nullable(),
});

export const RequestRepairInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});

export const WithdrawRepairInputSchema = RequestRepairInputSchema;

export const ReorderRepairQueueInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  bugIds: z.array(BugIdSchema).max(500),
});

export const AddBugFeedbackInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  content: z.string().trim().min(1).max(8_000),
  attachmentIds: BugAttachmentIdsSchema,
});

export const BugAttachmentViewSchema = z.object({
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

export const BugActionSchema = z.enum([
  'EDIT_REPORT',
  'ASSIGN',
  'REQUEST_REPAIR',
  'WITHDRAW_REPAIR',
  'ADD_FEEDBACK',
]);

export const BugViewSchema = BugSchema.omit({
  report: true,
}).extend({
  report: BugReportSchema.omit({ attachmentIds: true }).extend({
    attachments: z.array(BugAttachmentViewSchema),
  }),
  createdBy: UserSchema,
  assignment: z
    .object({
      submissionItemId: SubmissionItemIdSchema,
      engineeringName: z.string().trim().min(1).max(120),
      responsibleUser: UserSchema,
    })
    .nullable(),
  feedback: z.array(
    BugFeedbackSchema.omit({ attachmentIds: true }).extend({
      attachments: z.array(BugAttachmentViewSchema),
    }),
  ),
  availableActions: z.array(BugActionSchema),
  presentation: z.object({
    stageLabel: z.string().trim().min(1),
    assignmentLabel: z.string().trim().min(1),
    queuePosition: z.number().int().nonnegative().nullable(),
  }),
});

export const RepairQueueViewSchema = z.object({
  submissionId: SubmissionIdSchema,
  version: z.number().int().positive(),
  entries: z.array(
    z.object({
      bugId: BugIdSchema,
      submissionItemId: SubmissionItemIdSchema,
      position: z.number().int().nonnegative(),
      queuedAt: z.iso.datetime(),
    }),
  ),
  availableActions: z.array(z.literal('REORDER')),
});

export const BugWorkspaceProjectionSchema = z.object({
  availableActions: z.array(z.literal('CREATE_BUG')),
  repairQueue: RepairQueueViewSchema,
  bugs: z.array(BugViewSchema),
});

export const BugMutationResultSchema = z.object({
  bug: BugSchema,
  revision: z.number().int().positive(),
  boundAttachmentIds: BugAttachmentIdsSchema,
  unboundAttachmentIds: BugAttachmentIdsSchema,
});

export const RepairQueueMutationResultSchema = z.object({
  submissionId: SubmissionIdSchema,
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
});

export type Bug = z.infer<typeof BugSchema>;
export type BugView = z.infer<typeof BugViewSchema>;
export type BugFeedback = z.infer<typeof BugFeedbackSchema>;
export type CreateBugInput = z.infer<typeof CreateBugInputSchema>;
export type UpdateBugReportInput = z.infer<typeof UpdateBugReportInputSchema>;
export type AssignBugInput = z.infer<typeof AssignBugInputSchema>;
export type RequestRepairInput = z.infer<typeof RequestRepairInputSchema>;
export type WithdrawRepairInput = z.infer<typeof WithdrawRepairInputSchema>;
export type ReorderRepairQueueInput = z.infer<
  typeof ReorderRepairQueueInputSchema
>;
export type AddBugFeedbackInput = z.infer<typeof AddBugFeedbackInputSchema>;
export type BugWorkspaceProjection = z.infer<
  typeof BugWorkspaceProjectionSchema
>;
export type BugMutationResult = z.infer<typeof BugMutationResultSchema>;
export type RepairQueueMutationResult = z.infer<
  typeof RepairQueueMutationResultSchema
>;
