import { z } from 'zod';
import { CookingWorkspaceSnapshotSchema as SubmissionWorkspaceSnapshotSchema } from '@/modules/cooking/submissions/contract';
import { BugWorkspaceProjectionSchema } from '@/modules/cooking/bugs/contract';
import { RepairWorkspaceProjectionSchema } from '@/modules/cooking/repair/contract';
import { UpdateWorkspaceProjectionSchema } from '@/modules/cooking/update/contract';
import { LifecycleWorkspaceProjectionSchema } from '@/modules/cooking/lifecycle/contract';

export const CookingWorkspaceSnapshotSchema =
  SubmissionWorkspaceSnapshotSchema.extend(BugWorkspaceProjectionSchema.shape)
    .extend(RepairWorkspaceProjectionSchema.shape)
    .extend(UpdateWorkspaceProjectionSchema.shape)
    .extend(LifecycleWorkspaceProjectionSchema.shape);

export type CookingWorkspaceSnapshot = z.infer<
  typeof CookingWorkspaceSnapshotSchema
>;
