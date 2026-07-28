import { z } from 'zod';
import { RepositoryUrlSchema } from '@agent-party-time/runner-contract';
import { UserIdSchema, UserSchema } from '@/server/auth/contract';
import { ProjectIdSchema } from '@/features/cooking/projects/contract';

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
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    '工程标识只能使用小写字母、数字和连字符，并以小写字母开头',
  );
export const DeploymentMethodSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('LOCAL_SCRIPT'),
      command: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z.object({ kind: z.literal('CI_CD') }).strict(),
]);

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
export type EngineeringType = z.infer<typeof EngineeringTypeSchema>;
export type EngineeringMembership = z.infer<typeof EngineeringMembershipSchema>;
export type TestEnvironment = z.infer<typeof TestEnvironmentSchema>;
export type EngineeringMember = z.infer<typeof EngineeringMemberSchema>;
export type EngineeringWorkspace = z.infer<typeof EngineeringWorkspaceSchema>;
