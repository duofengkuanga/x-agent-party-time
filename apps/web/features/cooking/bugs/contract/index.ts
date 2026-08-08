import { z } from 'zod';
import { UserIdSchema, UserSchema } from '@/server/auth/contract';
import {
  SubmissionIdSchema,
  SubmissionItemIdSchema,
} from '@/features/cooking/submissions/contract';
import {
  EngineeringIdentifierSchema,
  EngineeringTypeSchema,
} from '@/features/cooking/engineering/contract';
import { CookingMutationIdSchema } from '@/features/cooking/shared/contract';

export const BugIdSchema = z.uuid();
export const BugStageSchema = z.enum([
  'WAITING_FOR_REPAIR',
  'REPAIRING',
  'WAITING_FOR_UPDATE',
  'UPDATING',
  'WAITING_FOR_VERIFICATION',
  'DONE',
  'CANCELLED',
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
  archivedAt: z.iso.datetime().nullable(),
  archivedByUserId: UserIdSchema.nullable(),
  version: z.number().int().positive(),
  createdByUserId: UserIdSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
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
  'VERIFY_PASS',
  'VERIFY_FAIL',
  'REOPEN',
  'CANCEL',
  'RESTORE',
  'ARCHIVE',
  'UNARCHIVE',
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
      engineeringType: EngineeringTypeSchema,
      engineeringIdentifier: EngineeringIdentifierSchema,
      responsibleUser: UserSchema,
    })
    .nullable(),
  availableActions: z.array(BugActionSchema),
  presentation: z.object({
    stageLabel: z.string().trim().min(1),
    assignmentLabel: z.string().trim().min(1),
  }),
});

export const BugWorkspaceProjectionSchema = z.object({
  availableActions: z.array(z.literal('CREATE_BUG')),
  bugs: z.array(BugViewSchema),
});

export const BugMutationResultSchema = z.object({
  bug: BugSchema,
  revision: z.number().int().positive(),
  boundAttachmentIds: BugAttachmentIdsSchema,
  unboundAttachmentIds: BugAttachmentIdsSchema,
});

export type Bug = z.infer<typeof BugSchema>;
export type BugView = z.infer<typeof BugViewSchema>;
export type CreateBugInput = z.infer<typeof CreateBugInputSchema>;
export type UpdateBugReportInput = z.infer<typeof UpdateBugReportInputSchema>;
export type AssignBugInput = z.infer<typeof AssignBugInputSchema>;
export type RequestRepairInput = z.infer<typeof RequestRepairInputSchema>;
export type BugWorkspaceProjection = z.infer<
  typeof BugWorkspaceProjectionSchema
>;
export type BugMutationResult = z.infer<typeof BugMutationResultSchema>;

export const BugDeleteRequestSchema = z
  .object({
    bugIds: z.array(z.uuid()).min(1).optional(),
    all: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => (value.all ? !value.bugIds : value.bugIds !== undefined),
    { message: '必须指定 bugIds 或 all 之一' },
  );
export const BugDeleteResponseSchema = z.object({
  deletedBugIds: z.array(z.uuid()),
  deletedExecutionIds: z.array(z.uuid()),
});
export type BugDeleteRequest = z.infer<typeof BugDeleteRequestSchema>;
export type BugDeleteResponse = z.infer<typeof BugDeleteResponseSchema>;
