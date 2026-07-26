import { z } from 'zod';
import { UserIdSchema, UserSchema } from '@/platform/auth/contract';

export const ProjectIdSchema = z.uuid();
export const ProjectNameSchema = z.string().trim().min(1).max(120);
export const MutationIdSchema = z.uuid();
export const ProjectRoleSchema = z.enum(['OWNER', 'MEMBER']);
export const ProjectInvitationDecisionSchema = z.enum(['ACCEPT', 'REJECT']);
export const ProjectInvitationStatusSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'REVOKED',
]);

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: ProjectNameSchema,
  version: z.number().int().positive(),
  createdByUserId: UserIdSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ProjectMembershipSchema = z.object({
  projectId: ProjectIdSchema,
  userId: UserIdSchema,
  role: ProjectRoleSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});

export const ProjectInvitationSchema = z.object({
  id: z.uuid(),
  projectId: ProjectIdSchema,
  invitedUserId: UserIdSchema,
  invitedByUserId: UserIdSchema,
  status: ProjectInvitationStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  respondedAt: z.iso.datetime().nullable(),
});

export const ProjectSummarySchema = z.object({
  project: ProjectSchema,
  membership: ProjectMembershipSchema,
});

export const ProjectMemberSchema = z.object({
  membership: ProjectMembershipSchema,
  user: UserSchema,
});

export const ReceivedProjectInvitationSchema = z.object({
  invitation: ProjectInvitationSchema,
  projectName: ProjectNameSchema,
  invitedByDisplayName: z.string().trim().min(1).max(120),
});

export const ProjectInvitationDetailSchema = z.object({
  invitation: ProjectInvitationSchema,
  invitedUser: UserSchema,
});

export type Project = z.infer<typeof ProjectSchema>;
export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;
export type ProjectInvitation = z.infer<typeof ProjectInvitationSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;
export type ReceivedProjectInvitation = z.infer<
  typeof ReceivedProjectInvitationSchema
>;
export type ProjectInvitationDetail = z.infer<
  typeof ProjectInvitationDetailSchema
>;
