import { z } from 'zod';
import {
  RepositoryUrlSchema,
  RunnerIdSchema,
  RunnerSchema,
} from '@agent-party-time/runner-contract';
import { UserIdSchema, UserSchema } from '@/contracts/auth';
import { ProjectIdSchema } from '@/contracts/projects/project';

export { RepositoryUrlSchema } from '@agent-party-time/runner-contract';

export const EngineeringIdSchema = z.uuid();
export const EngineeringNameSchema = z.string().trim().min(1).max(120);
export const EngineeringTypeSchema = z.enum(['FRONTEND', 'BACKEND']);
export const EngineeringIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(
    /^[a-z\p{Script=Han}][a-z0-9\p{Script=Han}]*(?:-[a-z0-9\p{Script=Han}]+)*$/u,
    '工程标识只能使用中文、小写字母、数字和连字符，并以中文或小写字母开头',
  );
export const DeploymentMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('LOCAL_SCRIPT'),
    command: z.string().trim().min(1).max(4_000),
  }),
  z.strictObject({ kind: z.literal('CI_CD') }),
]);

// An environment keeps its script while CI is selected; execution still uses DeploymentMethodSchema.
export const EnvironmentDeploymentSettingsSchema = z.discriminatedUnion('kind', [
  DeploymentMethodSchema.options[0],
  DeploymentMethodSchema.options[1].extend({
    scriptCommand: DeploymentMethodSchema.options[0].shape.command.optional(),
  }),
]);

export const EffectiveEnvironmentDeploymentSchema =
  EnvironmentDeploymentSettingsSchema.transform((settings) =>
    settings.kind === 'LOCAL_SCRIPT' ? settings : { kind: 'CI_CD' as const },
  );

const EngineeringBaseSchema = z.object({
  id: EngineeringIdSchema,
  projectId: ProjectIdSchema,
  name: EngineeringNameSchema,
  type: EngineeringTypeSchema,
  identifier: EngineeringIdentifierSchema,
  version: z.number().int().positive(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const EngineeringSchema = z.discriminatedUnion('repositoryState', [
  EngineeringBaseSchema.extend({ repositoryState: z.literal('PENDING') }),
  EngineeringBaseSchema.extend({
    repositoryState: z.literal('CONFIRMED'),
    repositoryUrl: RepositoryUrlSchema,
  }),
]);

export const EngineeringMembershipSchema = z.object({
  engineeringId: EngineeringIdSchema,
  userId: UserIdSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});

export const EnvironmentIdSchema = z.uuid();
export const EnvironmentNameSchema = z.string().trim().min(1).max(120);
export const TestEnvironmentSchema = z.object({
  id: EnvironmentIdSchema,
  engineeringId: EngineeringIdSchema,
  name: EnvironmentNameSchema,
  deployment: DeploymentMethodSchema,
  scriptCommand: DeploymentMethodSchema.options[0].shape.command.optional(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const EngineeringMemberSchema = z.object({
  membership: EngineeringMembershipSchema,
  user: UserSchema,
});

export const EngineeringWorkspaceSchema = z.object({
  engineering: EngineeringSchema,
  members: z.array(EngineeringMemberSchema),
  environments: z.array(TestEnvironmentSchema),
});

export type DeploymentMethod = z.infer<typeof DeploymentMethodSchema>;
export type Engineering = z.infer<typeof EngineeringSchema>;
export type EngineeringMembership = z.infer<typeof EngineeringMembershipSchema>;
export type TestEnvironment = z.infer<typeof TestEnvironmentSchema>;
export type EngineeringMember = z.infer<typeof EngineeringMemberSchema>;
export type EngineeringWorkspace = z.infer<typeof EngineeringWorkspaceSchema>;

export const BindingIdSchema = z.uuid();
export const BindingRequestIdSchema = z.uuid();
export const EngineeringBindingSchema = z.object({
  id: BindingIdSchema,
  engineeringId: EngineeringIdSchema,
  userId: UserSchema.shape.id,
  runnerId: RunnerIdSchema,
  createdAt: z.iso.datetime(),
});

export const EngineeringBindingSummarySchema = z.object({
  binding: EngineeringBindingSchema,
  user: UserSchema,
  runner: RunnerSchema,
});

export const BindingRequestSchema = z.object({
  id: BindingRequestIdSchema,
  engineeringId: EngineeringIdSchema,
  userId: UserSchema.shape.id,
  runnerId: RunnerIdSchema,
  state: z.enum(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  errorMessage: z.string().trim().min(1).max(240).nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export type EngineeringBinding = z.infer<typeof EngineeringBindingSchema>;
export type EngineeringBindingSummary = z.infer<typeof EngineeringBindingSummarySchema>;
export type BindingRequest = z.infer<typeof BindingRequestSchema>;
