import { z } from 'zod';
import { UserIdSchema, UserSchema } from '@/server/auth/contract';
import { BindingIdSchema } from '@/features/cooking/bindings/contract';
import {
  DeploymentMethodSchema,
  EngineeringIdSchema,
  EngineeringIdentifierSchema,
  EngineeringNameSchema,
  EngineeringTypeSchema,
  EnvironmentIdSchema,
  EnvironmentNameSchema,
  RepositoryUrlSchema,
} from '@/features/cooking/engineering/contract';
import {
  ProjectIdSchema,
  ProjectNameSchema,
} from '@/features/cooking/projects/contract';
import { CookingMutationIdSchema } from '@/features/cooking/shared/contract';

export const SubmissionIdSchema = z.uuid();
export const SubmissionItemIdSchema = z.uuid();
export const SubmissionTitleSchema = z.string().trim().min(1).max(160);
export const RequirementDescriptionSchema = z.string().trim().min(1).max(8_000);
export const TargetBranchSchema = z.string().trim().min(1).max(240);
export const SubmissionStatusSchema = z.enum(['ACTIVE', 'CLOSED']);

export const TestSubmissionSchema = z.object({
  id: SubmissionIdSchema,
  projectId: ProjectIdSchema,
  title: SubmissionTitleSchema,
  requirementDescription: RequirementDescriptionSchema,
  testerUserId: UserIdSchema,
  status: SubmissionStatusSchema,
  version: z.number().int().positive(),
  workspaceRevision: z.number().int().positive(),
  createdByUserId: UserIdSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});

export const SubmissionItemSchema = z.object({
  id: SubmissionItemIdSchema,
  submissionId: SubmissionIdSchema,
  engineering: z.object({
    id: EngineeringIdSchema,
    name: EngineeringNameSchema,
    type: EngineeringTypeSchema,
    identifier: EngineeringIdentifierSchema,
    repositoryUrl: RepositoryUrlSchema,
  }),
  responsibleUser: UserSchema,
  bindingId: BindingIdSchema,
  targetBranch: TargetBranchSchema,
  environment: z.object({
    id: EnvironmentIdSchema,
    name: EnvironmentNameSchema,
    deployment: DeploymentMethodSchema,
  }),
  createdAt: z.iso.datetime(),
});

export const CreateSubmissionItemInputSchema = z.object({
  engineeringId: EngineeringIdSchema,
  responsibleUserId: UserIdSchema,
  bindingId: BindingIdSchema,
  targetBranch: TargetBranchSchema,
  environmentId: EnvironmentIdSchema,
});

export const CreateSubmissionInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  title: SubmissionTitleSchema,
  requirementDescription: RequirementDescriptionSchema,
  testerUserId: UserIdSchema,
  items: z.array(CreateSubmissionItemInputSchema).min(1).max(20),
});

export const SubmissionSummarySchema = z.object({
  submission: TestSubmissionSchema,
  projectName: ProjectNameSchema,
  tester: UserSchema,
  itemCount: z.number().int().positive(),
});

export const SubmissionItemViewSchema = SubmissionItemSchema.omit({
  bindingId: true,
}).extend({
  engineering: SubmissionItemSchema.shape.engineering.omit({
    repositoryUrl: true,
  }),
  environment: SubmissionItemSchema.shape.environment.omit({
    deployment: true,
  }),
  technical: z
    .object({
      bindingId: BindingIdSchema,
      repositoryUrl: RepositoryUrlSchema,
      deployment: DeploymentMethodSchema,
    })
    .nullable(),
});

export const SubmissionViewSchema = z.object({
  submission: TestSubmissionSchema,
  projectName: ProjectNameSchema,
  tester: UserSchema,
  createdBy: UserSchema,
  items: z.array(SubmissionItemViewSchema),
  availableActions: z.array(z.enum(['EDIT_DETAILS', 'CLOSE'])),
});

export const CookingWorkspaceSnapshotSchema = z.object({
  revision: z.number().int().positive(),
  currentUser: UserSchema,
  submissions: z.array(SubmissionSummarySchema),
  submission: SubmissionViewSchema,
});

export const WorkspaceInvalidationSchema = z.object({
  submissionId: SubmissionIdSchema,
  revision: z.number().int().positive(),
});

export const SubmissionCreationCatalogSchema = z.array(
  z.object({
    projectId: ProjectIdSchema,
    projectName: ProjectNameSchema,
    members: z.array(UserSchema),
    engineerings: z.array(
      z.object({
        id: EngineeringIdSchema,
        name: EngineeringNameSchema,
        type: EngineeringTypeSchema,
        identifier: EngineeringIdentifierSchema,
        members: z.array(UserSchema),
        environments: z.array(
          z.object({
            id: EnvironmentIdSchema,
            name: EnvironmentNameSchema,
          }),
        ),
        bindings: z.array(
          z.object({
            id: BindingIdSchema,
            userId: UserIdSchema,
            runnerName: z.string().trim().min(1).max(120),
          }),
        ),
      }),
    ),
  }),
);

export const UpdateSubmissionInputSchema = z.object({
  mutationId: CookingMutationIdSchema,
  expectedVersion: z.number().int().positive(),
  title: SubmissionTitleSchema,
  requirementDescription: RequirementDescriptionSchema,
});

export type TestSubmission = z.infer<typeof TestSubmissionSchema>;
export type SubmissionItem = z.infer<typeof SubmissionItemSchema>;
export type CreateSubmissionInput = z.infer<typeof CreateSubmissionInputSchema>;
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;
export type SubmissionItemView = z.infer<typeof SubmissionItemViewSchema>;
export type SubmissionView = z.infer<typeof SubmissionViewSchema>;
export type CookingWorkspaceSnapshot = z.infer<
  typeof CookingWorkspaceSnapshotSchema
>;
export type WorkspaceInvalidation = z.infer<typeof WorkspaceInvalidationSchema>;
export type SubmissionCreationCatalog = z.infer<
  typeof SubmissionCreationCatalogSchema
>;
export type UpdateSubmissionInput = z.infer<typeof UpdateSubmissionInputSchema>;
