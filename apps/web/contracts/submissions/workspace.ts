import { z } from 'zod';
import { SubmissionWorkspaceSnapshotSchema as SubmissionBaseSnapshotSchema } from '@/contracts/submissions/submission';
import { BugWorkspaceProjectionSchema, BugIdSchema } from '@/contracts/submissions/bug';
import {
  RepairTimelineNodeSchema,
  RepairWorkspaceProjectionSchema,
} from '@/contracts/submissions/repair';
import { SubmissionVisualPresentationSchema } from '@/contracts/shared';
import {
  UpdateBatchIdSchema,
  UpdateBatchStateSchema,
  UpdateWorkspaceProjectionSchema,
} from '@/contracts/submissions/update';
import {
  BugLifecycleTransitionViewSchema,
  LifecycleWorkspaceProjectionSchema,
  ReopenRecordViewSchema,
  VerificationRecordViewSchema,
} from '@/contracts/submissions/lifecycle';

const BugProgressTimelineNodeSchema = z.union([
  RepairTimelineNodeSchema,
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal('UPDATE_BATCH'),
    batchId: UpdateBatchIdSchema,
    batchState: UpdateBatchStateSchema,
    bugCount: z.number().int().positive(),
    statusLabel: z.string().trim().min(1),
    visual: SubmissionVisualPresentationSchema,
    occurredAt: z.iso.datetime(),
  }),
  VerificationRecordViewSchema.extend({ kind: z.literal('VERIFICATION') }),
  ReopenRecordViewSchema.extend({ kind: z.literal('REOPEN') }),
  BugLifecycleTransitionViewSchema,
]);

export const SubmissionWorkspaceSnapshotSchema = SubmissionBaseSnapshotSchema.extend(
  BugWorkspaceProjectionSchema.shape,
)
  .extend(RepairWorkspaceProjectionSchema.shape)
  .extend(UpdateWorkspaceProjectionSchema.shape)
  .extend(LifecycleWorkspaceProjectionSchema.shape)
  .extend({
    visualByBug: z.record(BugIdSchema, SubmissionVisualPresentationSchema),
    progressByBug: z.record(BugIdSchema, z.array(BugProgressTimelineNodeSchema)),
  });

export type SubmissionWorkspaceSnapshot = z.infer<
  typeof SubmissionWorkspaceSnapshotSchema
>;
export type BugProgressTimelineNode = z.infer<typeof BugProgressTimelineNodeSchema>;
