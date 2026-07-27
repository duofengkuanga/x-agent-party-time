import { z } from 'zod';
import { CookingWorkspaceSnapshotSchema as SubmissionWorkspaceSnapshotSchema } from '@/modules/cooking/submissions/contract';
import { BugWorkspaceProjectionSchema } from '@/modules/cooking/bugs/contract';

export const CookingWorkspaceSnapshotSchema =
  SubmissionWorkspaceSnapshotSchema.extend(BugWorkspaceProjectionSchema.shape);

export type CookingWorkspaceSnapshot = z.infer<
  typeof CookingWorkspaceSnapshotSchema
>;
