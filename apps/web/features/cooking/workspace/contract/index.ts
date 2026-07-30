import { z } from 'zod';
import { CookingWorkspaceSnapshotSchema as SubmissionWorkspaceSnapshotSchema } from '@/features/cooking/submissions/contract';
import { BugWorkspaceProjectionSchema } from '@/features/cooking/bugs/contract';
import {
  RepairTimelineNodeSchema,
  RepairWorkspaceProjectionSchema,
} from '@/features/cooking/repair/contract';
import { CookingVisualPresentationSchema } from '@/features/cooking/shared/contract';
import { BugIdSchema } from '@/features/cooking/bugs/contract';
import {
  UpdateBatchIdSchema,
  UpdateBatchStateSchema,
  UpdateWorkspaceProjectionSchema,
} from '@/features/cooking/update/contract';
import {
  BugLifecycleTransitionViewSchema,
  LifecycleWorkspaceProjectionSchema,
  ReopenRecordViewSchema,
  VerificationRecordViewSchema,
} from '@/features/cooking/lifecycle/contract';

export const BugProgressTimelineNodeSchema = z.union([
  RepairTimelineNodeSchema,
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal('UPDATE_BATCH'),
    batchId: UpdateBatchIdSchema,
    batchState: UpdateBatchStateSchema,
    bugCount: z.number().int().positive(),
    statusLabel: z.string().trim().min(1),
    visual: CookingVisualPresentationSchema,
    occurredAt: z.iso.datetime(),
  }),
  VerificationRecordViewSchema.extend({ kind: z.literal('VERIFICATION') }),
  ReopenRecordViewSchema.extend({ kind: z.literal('REOPEN') }),
  BugLifecycleTransitionViewSchema,
]);

export const CookingWorkspaceSnapshotSchema =
  SubmissionWorkspaceSnapshotSchema.extend(BugWorkspaceProjectionSchema.shape)
    .extend(RepairWorkspaceProjectionSchema.shape)
    .extend(UpdateWorkspaceProjectionSchema.shape)
    .extend(LifecycleWorkspaceProjectionSchema.shape)
    .extend({
      visualByBug: z.record(BugIdSchema, CookingVisualPresentationSchema),
      progressByBug: z.record(
        BugIdSchema,
        z.array(BugProgressTimelineNodeSchema),
      ),
    });

export type CookingWorkspaceSnapshot = z.infer<
  typeof CookingWorkspaceSnapshotSchema
>;
export type BugProgressTimelineNode = z.infer<
  typeof BugProgressTimelineNodeSchema
>;
