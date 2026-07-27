import { z } from 'zod';
import { UserIdSchema, UserSchema } from '@/server/auth/contract';
import { ProjectIdSchema } from '@/features/cooking/projects/contract';

export const EngineeringIdSchema = z.uuid();
export const EngineeringNameSchema = z.string().trim().min(1).max(120);
export const RepositoryUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      /^(https?:\/\/|ssh:\/\/|git:\/\/)/iu.test(value) ||
      /^[^\s@]+@[^\s:]+:.+$/u.test(value),
    '仓库地址必须是 HTTP(S)、SSH、Git URL 或 SCP 风格地址',
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

export const EngineeringSchema = z.object({
  id: EngineeringIdSchema,
  projectId: ProjectIdSchema,
  name: EngineeringNameSchema,
  repositoryUrl: RepositoryUrlSchema,
  version: z.number().int().positive(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

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
export type EngineeringMembership = z.infer<typeof EngineeringMembershipSchema>;
export type TestEnvironment = z.infer<typeof TestEnvironmentSchema>;
export type EngineeringMember = z.infer<typeof EngineeringMemberSchema>;
export type EngineeringWorkspace = z.infer<typeof EngineeringWorkspaceSchema>;
