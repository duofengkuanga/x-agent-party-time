import { z } from 'zod';
import { CookingWorkspaceSnapshotSchema as SubmissionWorkspaceSnapshotSchema } from '@/features/cooking/submissions/contract';
import { BugWorkspaceProjectionSchema } from '@/features/cooking/bugs/contract';
import { RepairWorkspaceProjectionSchema } from '@/features/cooking/repair/contract';
import { UpdateWorkspaceProjectionSchema } from '@/features/cooking/update/contract';
import { LifecycleWorkspaceProjectionSchema } from '@/features/cooking/lifecycle/contract';

export const CookingWorkspaceSnapshotSchema =
  SubmissionWorkspaceSnapshotSchema.extend(BugWorkspaceProjectionSchema.shape)
    .extend(RepairWorkspaceProjectionSchema.shape)
    .extend(UpdateWorkspaceProjectionSchema.shape)
    .extend(LifecycleWorkspaceProjectionSchema.shape);

export type CookingWorkspaceSnapshot = z.infer<
  typeof CookingWorkspaceSnapshotSchema
>;
