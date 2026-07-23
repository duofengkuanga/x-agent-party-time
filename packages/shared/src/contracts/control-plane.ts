import { z } from 'zod';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../config/index.ts';
import { AppErrorSchema } from '../schemas/error.ts';
import {
  CollaborativeCommandResultSchema,
  CollaborativeQueryResultSchema,
} from './collaborative-submission.ts';

export * from './collaborative-submission.ts';

export {
  createAppError,
  ERROR_CODES,
  type AppError,
} from '../schemas/error.ts';

export const CONTROL_PLANE_API_VERSION = CONTROL_PLANE_PROTOCOL_VERSION;

const IsoUtcDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

export const ProjectIdSchema = z.uuid();
export const EngineeringIdSchema = z.uuid();
export const EngineeringEnvironmentIdSchema = z.uuid();
export const EngineeringBindingIdSchema = z.uuid();
export const UserIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9-]+$/);
export const AccountTypeSchema = z.enum(['DEVELOPER', 'TESTER']);
export type AccountType = z.infer<typeof AccountTypeSchema>;
export const ControlPlaneActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system') }),
  z.object({
    kind: z.literal('user'),
    userId: UserIdSchema,
    accountType: AccountTypeSchema,
  }),
]);
export type ControlPlaneActor = z.infer<typeof ControlPlaneActorSchema>;
export const RunnerIdSchema = z.uuid();
export const BugIdSchema = z.uuid();
export const BugAttachmentIdSchema = z.uuid();
export const RepairDispatchIdSchema = z.uuid();
export const RepairAttemptIdSchema = z.uuid();
export const DeploymentBatchIdSchema = z.uuid();
export const DeploymentAttemptIdSchema = z.uuid();
export const VerificationFeedbackIdSchema = z.uuid();
export const CleanupRecordIdSchema = z.uuid();
export const ProjectSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    'slug 只能包含小写字母、数字和连字符',
  );

export const RunnerAvailabilitySchema = z.enum(['online', 'offline']);

export const RunnerSummarySchema = z.object({
  id: RunnerIdSchema,
  name: z.string().trim().min(1).max(80),
  availability: RunnerAvailabilitySchema,
  lastSeenAt: IsoUtcDateTimeSchema,
});
export type RunnerSummary = z.infer<typeof RunnerSummarySchema>;

export const ProjectSummarySchema = z.object({
  id: ProjectIdSchema,
  slug: ProjectSlugSchema,
  title: z.string().trim().min(1).max(120).nullable(),
  defaultRunner: RunnerSummarySchema.nullable(),
  executable: z.boolean(),
  memberRole: z.enum(['OWNER', 'DEVELOPER']).nullable(),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const RegisteredUserSummarySchema = z.object({
  id: UserIdSchema,
  username: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(120),
  accountType: AccountTypeSchema,
});
export type RegisteredUserSummary = z.infer<typeof RegisteredUserSummarySchema>;

export const ProjectMemberSummarySchema = z.object({
  projectId: ProjectIdSchema,
  user: RegisteredUserSummarySchema,
  role: z.enum(['OWNER', 'DEVELOPER']),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});
export type ProjectMemberSummary = z.infer<typeof ProjectMemberSummarySchema>;

export const ProjectInvitationSummarySchema = z.object({
  id: z.uuid(),
  projectId: ProjectIdSchema,
  projectTitle: z.string().trim().min(1).max(120),
  projectSlug: ProjectSlugSchema,
  invitee: RegisteredUserSummarySchema,
  invitedBy: RegisteredUserSummarySchema,
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED']),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
  resolvedAt: IsoUtcDateTimeSchema.nullable(),
});
export type ProjectInvitationSummary = z.infer<
  typeof ProjectInvitationSummarySchema
>;

export const ProjectAuditEventSummarySchema = z.object({
  id: z.uuid(),
  projectId: ProjectIdSchema,
  actorUserId: UserIdSchema,
  type: z.enum([
    'project.created',
    'project.invitation_created',
    'project.invitation_accepted',
    'project.invitation_rejected',
    'project.invitation_revoked',
    'project.member_removed',
  ]),
  subjectUserId: UserIdSchema.nullable(),
  createdAt: IsoUtcDateTimeSchema,
});
export type ProjectAuditEventSummary = z.infer<
  typeof ProjectAuditEventSummarySchema
>;

export const EngineeringSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    '工程标识只能包含小写字母、数字和连字符',
  );
export const EngineeringTypeSchema = z.enum(['FRONTEND', 'BACKEND']);
export const EngineeringRoleSchema = z.enum(['OWNER', 'MEMBER']);
export const DeploymentTypeSchema = z.enum(['LOCAL_SCRIPT', 'CI_CD']);

const SensitiveAssignmentPattern =
  /(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*=\s*(?!\$\{?[A-Za-z_][A-Za-z0-9_]*}?)(?:['"]?)[^\s'"]{4,}/i;
const SensitiveLiteralPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
] as const;

export function containsObviousSensitiveValue(value: string) {
  return (
    SensitiveAssignmentPattern.test(value) ||
    SensitiveLiteralPatterns.some((pattern) => pattern.test(value))
  );
}

export const RepositoryUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    if (/\s/.test(value)) {
      context.addIssue({ code: 'custom', message: '仓库地址不能包含空格' });
      return;
    }
    const scpStyle = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value);
    let regularUrl = false;
    try {
      const parsed = new URL(value);
      regularUrl = ['http:', 'https:', 'ssh:', 'git:'].includes(
        parsed.protocol,
      );
      if (parsed.username || parsed.password || parsed.search || parsed.hash)
        context.addIssue({
          code: 'custom',
          message: '仓库地址不能包含凭据、查询参数或片段',
        });
    } catch {
      regularUrl = false;
    }
    if (!scpStyle && !regularUrl)
      context.addIssue({ code: 'custom', message: '仓库地址格式不正确' });
    if (containsObviousSensitiveValue(value))
      context.addIssue({
        code: 'custom',
        message: '仓库地址包含疑似敏感值',
      });
  });

const LocalScriptCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .superRefine((value, context) => {
    if (value.includes('\0'))
      context.addIssue({ code: 'custom', message: '部署命令格式不正确' });
    if (containsObviousSensitiveValue(value))
      context.addIssue({
        code: 'custom',
        message: '部署命令包含疑似明文凭据，请改用环境变量引用',
      });
  });

export const EngineeringEnvironmentInputSchema = z
  .object({
    id: EngineeringEnvironmentIdSchema.optional(),
    slug: EngineeringSlugSchema,
    displayName: z.string().trim().min(1).max(120),
    deploymentType: DeploymentTypeSchema,
    localScriptCommand: z.string().trim().max(4_000).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.deploymentType === 'LOCAL_SCRIPT') {
      const result = LocalScriptCommandSchema.safeParse(
        value.localScriptCommand,
      );
      if (!result.success)
        for (const issue of result.error.issues)
          context.addIssue({
            code: 'custom',
            path: ['localScriptCommand'],
            message: issue.message,
          });
    } else if (value.localScriptCommand) {
      context.addIssue({
        code: 'custom',
        path: ['localScriptCommand'],
        message: 'CI/CD 环境不保存部署命令，由开发人员在外部人工确认',
      });
    }
  });
export type EngineeringEnvironmentInput = z.infer<
  typeof EngineeringEnvironmentInputSchema
>;

export const EngineeringEnvironmentSummarySchema = z.object({
  id: EngineeringEnvironmentIdSchema,
  engineeringId: EngineeringIdSchema,
  slug: EngineeringSlugSchema,
  displayName: z.string().trim().min(1).max(120),
  deploymentType: DeploymentTypeSchema,
  localScriptCommand: z.string().trim().min(1).max(4_000).nullable(),
  manualConfirmationRequired: z.boolean(),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});
export type EngineeringEnvironmentSummary = z.infer<
  typeof EngineeringEnvironmentSummarySchema
>;

export const EngineeringMemberSummarySchema = z.object({
  engineeringId: EngineeringIdSchema,
  user: RegisteredUserSummarySchema,
  role: EngineeringRoleSchema,
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});
export type EngineeringMemberSummary = z.infer<
  typeof EngineeringMemberSummarySchema
>;

export const EngineeringSummarySchema = z.object({
  id: EngineeringIdSchema,
  projectId: ProjectIdSchema,
  slug: EngineeringSlugSchema,
  displayName: z.string().trim().min(1).max(120),
  type: EngineeringTypeSchema,
  archivedAt: IsoUtcDateTimeSchema.nullable(),
  firstReferencedAt: IsoUtcDateTimeSchema.nullable(),
  memberRole: EngineeringRoleSchema.nullable(),
  canViewTechnicalConfiguration: z.boolean(),
  canManage: z.boolean(),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});
export type EngineeringSummary = z.infer<typeof EngineeringSummarySchema>;

export const EngineeringDetailSchema = EngineeringSummarySchema.extend({
  repositoryUrl: RepositoryUrlSchema,
  members: z.array(EngineeringMemberSummarySchema),
  environments: z.array(EngineeringEnvironmentSummarySchema).min(1),
});
export type EngineeringDetail = z.infer<typeof EngineeringDetailSchema>;

const EngineeringConfigurationSchema = z
  .object({
    slug: EngineeringSlugSchema,
    displayName: z.string().trim().min(1).max(120),
    type: EngineeringTypeSchema,
    repositoryUrl: RepositoryUrlSchema,
    ownerUserId: UserIdSchema,
    memberUserIds: z.array(UserIdSchema).max(50).default([]),
    environments: z.array(EngineeringEnvironmentInputSchema).min(1).max(20),
  })
  .superRefine((value, context) => {
    if (new Set(value.memberUserIds).size !== value.memberUserIds.length)
      context.addIssue({
        code: 'custom',
        path: ['memberUserIds'],
        message: '工程成员不能重复',
      });
    if (value.memberUserIds.includes(value.ownerUserId))
      context.addIssue({
        code: 'custom',
        path: ['memberUserIds'],
        message: '工程负责人不需要重复加入成员列表',
      });
    const environmentSlugs = value.environments.map((item) => item.slug);
    if (new Set(environmentSlugs).size !== environmentSlugs.length)
      context.addIssue({
        code: 'custom',
        path: ['environments'],
        message: '测试环境标识不能重复',
      });
  });

export const CreateEngineeringCommandSchema =
  EngineeringConfigurationSchema.extend({ projectId: ProjectIdSchema });
export type CreateEngineeringCommand = z.infer<
  typeof CreateEngineeringCommandSchema
>;
export const CreateEngineeringResultSchema = z.object({
  engineering: EngineeringDetailSchema,
});
export const ListEngineeringsQuerySchema = z.object({
  projectId: ProjectIdSchema,
  includeArchived: z.boolean().default(true),
});
export const ListEngineeringsResultSchema = z.object({
  items: z.array(EngineeringSummarySchema),
});
export const GetEngineeringQuerySchema = z.object({
  engineeringId: EngineeringIdSchema,
});
export const GetEngineeringResultSchema = z.object({
  engineering: EngineeringDetailSchema,
});
export const UpdateEngineeringCommandSchema =
  EngineeringConfigurationSchema.extend({ engineeringId: EngineeringIdSchema });
export type UpdateEngineeringCommand = z.infer<
  typeof UpdateEngineeringCommandSchema
>;
export const UpdateEngineeringResultSchema = CreateEngineeringResultSchema;
export const SetEngineeringArchiveCommandSchema = z.object({
  engineeringId: EngineeringIdSchema,
  archived: z.boolean(),
});
export const SetEngineeringArchiveResultSchema = z.object({
  engineering: EngineeringSummarySchema,
});
export const DeleteEngineeringCommandSchema = z.object({
  engineeringId: EngineeringIdSchema,
});
export const DeleteEngineeringResultSchema = z.object({
  deleted: z.literal(true),
});

export const EngineeringSubmissionSnapshotSchema = z.object({
  engineeringId: EngineeringIdSchema,
  slug: EngineeringSlugSchema,
  displayName: z.string().trim().min(1).max(120),
  type: EngineeringTypeSchema,
  repositoryUrl: RepositoryUrlSchema,
  environment: EngineeringEnvironmentSummarySchema.pick({
    id: true,
    slug: true,
    displayName: true,
    deploymentType: true,
    localScriptCommand: true,
    manualConfirmationRequired: true,
  }),
  capturedAt: IsoUtcDateTimeSchema,
});
export type EngineeringSubmissionSnapshot = z.infer<
  typeof EngineeringSubmissionSnapshotSchema
>;

export const EngineeringBindingSummarySchema = z.object({
  id: EngineeringBindingIdSchema,
  engineeringId: EngineeringIdSchema,
  repositoryName: z.string().trim().min(1).max(255),
  developer: RegisteredUserSummarySchema,
  runner: RunnerSummarySchema,
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});
export type EngineeringBindingSummary = z.infer<
  typeof EngineeringBindingSummarySchema
>;
export const CreateEngineeringBindingTicketCommandSchema = z.object({
  engineeringId: EngineeringIdSchema,
});
export const CreateEngineeringBindingTicketResultSchema = z.object({
  ticket: z.string().min(32).max(500),
  expiresAt: IsoUtcDateTimeSchema,
});
export const ClaimEngineeringBindingCommandSchema = z.object({
  ticket: z.string().min(32).max(500),
  runnerId: RunnerIdSchema,
  runnerName: z.string().trim().min(1).max(80),
  repositoryName: z.string().trim().min(1).max(255).optional(),
});
export type ClaimEngineeringBindingCommand = z.infer<
  typeof ClaimEngineeringBindingCommandSchema
>;
export const ClaimEngineeringBindingResultSchema = z.object({
  binding: EngineeringBindingSummarySchema,
});
export const ListEngineeringBindingsQuerySchema = z.object({
  engineeringId: EngineeringIdSchema,
});
export const ListEngineeringBindingsResultSchema = z.object({
  items: z.array(EngineeringBindingSummarySchema),
});

export const BugStatusSchema = z.enum([
  'waiting_for_repair',
  'repairing',
  'repair_ready',
  'deploying',
  'waiting_for_verification',
  'done',
]);
export type BugStatus = z.infer<typeof BugStatusSchema>;

export const BugRepairStateSchema = z.enum([
  'collecting',
  'queued',
  'running',
  'retrying',
  'needs_input',
  'blocked',
  'failed',
  'cancelled',
]);
export type BugRepairState = z.infer<typeof BugRepairStateSchema>;

export const BugAttachmentMediaTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'application/json',
]);

export const BugAttachmentMetadataSchema = z.object({
  id: BugAttachmentIdSchema,
  bugId: BugIdSchema,
  fileName: z.string().trim().min(1).max(255),
  mediaType: BugAttachmentMediaTypeSchema,
  sizeBytes: z.number().int().positive(),
  createdAt: IsoUtcDateTimeSchema,
});
export type BugAttachmentMetadata = z.infer<typeof BugAttachmentMetadataSchema>;

export const BugEventSchema = z.object({
  id: z.uuid(),
  bugId: BugIdSchema,
  type: z.enum([
    'bug.created',
    'bug.repair_enqueued',
    'bug.repair_returned',
    'bug.repair_started',
    'bug.repair_ready',
    'bug.repair_failed',
    'bug.repair_needs_input',
    'bug.repair_blocked',
    'bug.repair_cancelled',
    'bug.deployment_enqueued',
    'bug.deployed',
    'bug.deployment_cancelled',
    'bug.verification_passed',
    'bug.verification_failed',
    'bug.cleanup_completed',
    'bug.cleanup_failed',
  ]),
  createdAt: IsoUtcDateTimeSchema,
});
export type BugEvent = z.infer<typeof BugEventSchema>;

export const BugSummarySchema = z.object({
  id: BugIdSchema,
  shortId: z.string().regex(/^BUG-\d{4,}$/),
  projectId: ProjectIdSchema,
  status: BugStatusSchema,
  repairState: BugRepairStateSchema.nullable(),
  repairDispatchId: RepairDispatchIdSchema.nullable(),
  deploymentBatchId: DeploymentBatchIdSchema.nullable(),
  deploymentState: z
    .enum(['collecting', 'queued', 'running', 'blocked', 'failed', 'unknown'])
    .nullable(),
  title: z.string().trim().min(1).max(160),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});
export type BugSummary = z.infer<typeof BugSummarySchema>;

export const RepairCheckStatusSchema = z.enum(['passed', 'failed', 'not_run']);
export const RepairCheckResultSchema = z.object({
  name: z.string().trim().min(1).max(160),
  status: RepairCheckStatusSchema,
  summary: z.string().trim().min(1).max(2_000),
});
export type RepairCheckResult = z.infer<typeof RepairCheckResultSchema>;

export const RepairChangeSummarySchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  summary: z.string().trim().min(1).max(2_000),
});
export type RepairChangeSummary = z.infer<typeof RepairChangeSummarySchema>;

const RepairResultBaseSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  changes: z.array(RepairChangeSummarySchema).max(200),
  checks: z.array(RepairCheckResultSchema).max(100),
});

export const RepairReadyResultSchema = RepairResultBaseSchema.extend({
  status: z.literal('ready'),
  candidateCommit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i),
  reason: z.null().optional(),
});
const RepairNonReadyResultBaseSchema = RepairResultBaseSchema.extend({
  candidateCommit: z.null().optional(),
  reason: z.string().trim().min(1).max(4_000),
});
export const RepairNeedsInputResultSchema =
  RepairNonReadyResultBaseSchema.extend({
    status: z.literal('needs_input'),
  });
export const RepairBlockedResultSchema = RepairNonReadyResultBaseSchema.extend({
  status: z.literal('blocked'),
});
export const RepairFailedResultSchema = RepairNonReadyResultBaseSchema.extend({
  status: z.literal('failed'),
});
export const RepairResultSchema = z.discriminatedUnion('status', [
  RepairReadyResultSchema,
  RepairNeedsInputResultSchema,
  RepairBlockedResultSchema,
  RepairFailedResultSchema,
]);
export type RepairResult = z.infer<typeof RepairResultSchema>;

export const RepairAttemptStateSchema = z.enum([
  'pending',
  'running',
  'ready',
  'needs_input',
  'blocked',
  'failed',
  'cancelled',
]);
export type RepairAttemptState = z.infer<typeof RepairAttemptStateSchema>;

export const RepairAttemptSummarySchema = z.object({
  id: RepairAttemptIdSchema,
  bugId: BugIdSchema,
  dispatchId: RepairDispatchIdSchema,
  runnerId: RunnerIdSchema,
  templateName: z.string().trim().min(1).max(120),
  templateVersion: z.string().trim().min(1).max(40),
  state: RepairAttemptStateSchema,
  sessionId: z.string().trim().min(1).max(200).nullable(),
  result: RepairResultSchema.nullable(),
  failureMessage: z.string().trim().min(1).max(4_000).nullable(),
  retryNumber: z.number().int().nonnegative(),
  maxInfrastructureRetries: z.number().int().nonnegative(),
  cancelRequested: z.boolean(),
  sourceDeploymentBatchId: DeploymentBatchIdSchema.nullable(),
  sourceDeployedCommit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i)
    .nullable(),
  createdAt: IsoUtcDateTimeSchema,
  startedAt: IsoUtcDateTimeSchema.nullable(),
  finishedAt: IsoUtcDateTimeSchema.nullable(),
});
export type RepairAttemptSummary = z.infer<typeof RepairAttemptSummarySchema>;

export const BugDetailSchema = BugSummarySchema.extend({
  canReopenRepair: z.boolean(),
  operationPath: z.string().trim().min(1).max(4_000),
  actualResult: z.string().trim().min(1).max(8_000),
  expectedResult: z.string().trim().min(1).max(8_000),
  supplementalDescription: z.string().trim().max(8_000).nullable(),
  attachments: z.array(BugAttachmentMetadataSchema),
  events: z.array(BugEventSchema),
  repairAttempt: RepairAttemptSummarySchema.nullable(),
  repairAttempts: z.array(RepairAttemptSummarySchema),
  verificationFeedbacks: z.array(
    z.object({
      id: VerificationFeedbackIdSchema,
      bugId: BugIdSchema,
      deploymentBatchId: DeploymentBatchIdSchema,
      feedback: z.string().trim().min(1).max(8_000),
      deployedCommit: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{7,64}$/i),
      attachments: z.array(BugAttachmentMetadataSchema),
      createdAt: IsoUtcDateTimeSchema,
    }),
  ),
});
export type BugDetail = z.infer<typeof BugDetailSchema>;

export const ControlPlaneRequestEnvelopeSchema = z.object({
  apiVersion: z.literal(CONTROL_PLANE_API_VERSION),
  requestId: z.string().min(1),
  operation: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200).optional(),
  actor: ControlPlaneActorSchema.optional(),
  payload: z.json(),
});
export type ControlPlaneRequestEnvelope = z.infer<
  typeof ControlPlaneRequestEnvelopeSchema
>;

export const ControlPlaneResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1),
    data: z.json(),
  }),
  z.object({
    ok: z.literal(false),
    requestId: z.string().min(1),
    error: AppErrorSchema,
  }),
]);
export type ControlPlaneResponseEnvelope = z.infer<
  typeof ControlPlaneResponseEnvelopeSchema
>;

export const ControlPlaneStatusQuerySchema = z.object({});
export const ControlPlaneStatusResultSchema = z.object({
  status: z.literal('ready'),
  projects: z.number().int().nonnegative(),
  runners: z.number().int().nonnegative(),
});

export const CreateProjectCommandSchema = z.object({
  slug: ProjectSlugSchema,
  title: z.string().trim().min(1).max(120).nullable().optional(),
});
export type CreateProjectCommand = z.infer<typeof CreateProjectCommandSchema>;
export const CreateProjectResultSchema = z.object({
  project: ProjectSummarySchema,
});

export const ListProjectsQuerySchema = z.object({});
export const ListProjectsResultSchema = z.object({
  items: z.array(ProjectSummarySchema),
});

export const GetProjectQuerySchema = z.object({
  project: z.string().trim().min(1).max(128),
});
export const GetProjectResultSchema = z.object({
  project: ProjectSummarySchema,
});

export const RenameProjectCommandSchema = z.object({
  projectId: ProjectIdSchema,
  title: z.string().trim().min(1).max(120),
});
export type RenameProjectCommand = z.infer<typeof RenameProjectCommandSchema>;
export const RenameProjectResultSchema = z.object({
  project: ProjectSummarySchema,
});

export const GetProjectCollaborationQuerySchema = z.object({
  projectId: ProjectIdSchema,
});
export const GetProjectCollaborationResultSchema = z.object({
  members: z.array(ProjectMemberSummarySchema),
  invitations: z.array(ProjectInvitationSummarySchema),
  auditEvents: z.array(ProjectAuditEventSummarySchema),
});

export const CreateProjectInvitationCommandSchema = z.object({
  projectId: ProjectIdSchema,
  inviteeUserId: UserIdSchema,
});
export type CreateProjectInvitationCommand = z.infer<
  typeof CreateProjectInvitationCommandSchema
>;
export const CreateProjectInvitationResultSchema = z.object({
  invitation: ProjectInvitationSummarySchema,
});

export const RespondProjectInvitationCommandSchema = z.object({
  invitationId: z.uuid(),
  action: z.enum(['ACCEPT', 'REJECT']),
});
export type RespondProjectInvitationCommand = z.infer<
  typeof RespondProjectInvitationCommandSchema
>;
export const RespondProjectInvitationResultSchema = z.object({
  invitation: ProjectInvitationSummarySchema,
});

export const RevokeProjectInvitationCommandSchema = z.object({
  invitationId: z.uuid(),
});
export type RevokeProjectInvitationCommand = z.infer<
  typeof RevokeProjectInvitationCommandSchema
>;
export const RevokeProjectInvitationResultSchema = z.object({
  invitation: ProjectInvitationSummarySchema,
});

export const RemoveProjectMemberCommandSchema = z.object({
  projectId: ProjectIdSchema,
  userId: UserIdSchema,
});
export type RemoveProjectMemberCommand = z.infer<
  typeof RemoveProjectMemberCommandSchema
>;
export const RemoveProjectMemberResultSchema = z.object({
  removed: z.literal(true),
});

export const ListReceivedProjectInvitationsQuerySchema = z.object({});
export const ListReceivedProjectInvitationsResultSchema = z.object({
  items: z.array(ProjectInvitationSummarySchema),
});

export const RegisterRunnerCommandSchema = z.object({
  runnerId: RunnerIdSchema,
  name: z.string().trim().min(1).max(80),
});
export type RegisterRunnerCommand = z.infer<typeof RegisterRunnerCommandSchema>;
export const RegisterRunnerResultSchema = z.object({
  runner: RunnerSummarySchema,
});

export const HeartbeatRunnerCommandSchema = z.object({
  runnerId: RunnerIdSchema,
});
export const HeartbeatRunnerResultSchema = RegisterRunnerResultSchema;

export const SetProjectDefaultRunnerCommandSchema = z.object({
  projectId: ProjectIdSchema,
  runnerId: RunnerIdSchema,
});
export const SetProjectDefaultRunnerResultSchema = z.object({
  project: ProjectSummarySchema,
});

export const BugAttachmentUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: BugAttachmentMediaTypeSchema,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  contentBase64: z.string().min(1),
});
export type BugAttachmentUpload = z.infer<typeof BugAttachmentUploadSchema>;

export const CreateBugCommandSchema = z.object({
  projectId: ProjectIdSchema,
  title: z.string().trim().min(1).max(160),
  operationPath: z.string().trim().min(1).max(4_000),
  actualResult: z.string().trim().min(1).max(8_000),
  expectedResult: z.string().trim().min(1).max(8_000),
  supplementalDescription: z.string().trim().max(8_000).nullable().optional(),
  attachments: z.array(BugAttachmentUploadSchema).max(5).default([]),
});
export type CreateBugCommand = z.infer<typeof CreateBugCommandSchema>;
export const CreateBugResultSchema = z.object({ bug: BugDetailSchema });

export const ListBugsQuerySchema = z.object({ projectId: ProjectIdSchema });
export const ListBugsResultSchema = z.object({
  items: z.array(BugSummarySchema),
});

export const GetBugQuerySchema = z.object({ bugId: BugIdSchema });
export const GetBugResultSchema = z.object({ bug: BugDetailSchema });

export const GetBugAttachmentQuerySchema = z.object({
  attachmentId: BugAttachmentIdSchema,
});
export const GetBugAttachmentResultSchema = z.object({
  attachment: BugAttachmentMetadataSchema,
  contentBase64: z.string().min(1),
});

export const RepairDispatchStateSchema = z.enum([
  'collecting',
  'queued',
  'claimed',
]);
export type RepairDispatchState = z.infer<typeof RepairDispatchStateSchema>;

export const RepairDispatchConfigSnapshotSchema = z.object({
  maxBugs: z.number().int().positive(),
  delayMs: z.number().int().positive(),
});
export type RepairDispatchConfigSnapshot = z.infer<
  typeof RepairDispatchConfigSnapshotSchema
>;

export const RepairDispatchSummarySchema = z.object({
  id: RepairDispatchIdSchema,
  projectId: ProjectIdSchema,
  runnerId: RunnerIdSchema,
  state: RepairDispatchStateSchema,
  closesAt: IsoUtcDateTimeSchema,
  config: RepairDispatchConfigSnapshotSchema,
  members: z.array(BugSummarySchema),
  createdAt: IsoUtcDateTimeSchema,
  queuedAt: IsoUtcDateTimeSchema.nullable(),
  claimedAt: IsoUtcDateTimeSchema.nullable(),
});
export type RepairDispatchSummary = z.infer<typeof RepairDispatchSummarySchema>;

export const EnqueueBugForRepairCommandSchema = z.object({
  bugId: BugIdSchema,
});
export const EnqueueBugForRepairResultSchema = z.object({
  bug: BugSummarySchema,
  dispatch: RepairDispatchSummarySchema,
});

export const ReturnBugToWaitingCommandSchema = z.object({
  bugId: BugIdSchema,
});
export const ReturnBugToWaitingResultSchema = z.object({
  bug: BugSummarySchema,
  dispatch: RepairDispatchSummarySchema.nullable(),
});

export const CloseRepairDispatchCommandSchema = z.object({
  dispatchId: RepairDispatchIdSchema,
});
export const CloseRepairDispatchResultSchema = z.object({
  dispatch: RepairDispatchSummarySchema,
});

export const ListRepairDispatchesQuerySchema = z.object({
  projectId: ProjectIdSchema,
});
export const ListRepairDispatchesResultSchema = z.object({
  items: z.array(RepairDispatchSummarySchema),
});

export const ClaimRepairDispatchCommandSchema = z.object({
  runnerId: RunnerIdSchema,
});
export const ClaimRepairDispatchResultSchema = z.object({
  dispatch: RepairDispatchSummarySchema.nullable(),
});

export const BUG_REPAIR_PROMPT_TEMPLATE = {
  name: 'bug-repair-start',
  version: '1.0.0',
} as const;

export const BUG_REPAIR_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'summary',
    'changes',
    'checks',
    'candidateCommit',
    'reason',
  ],
  properties: {
    status: {
      type: 'string',
      enum: ['ready', 'needs_input', 'blocked', 'failed'],
    },
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    changes: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'summary'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1000 },
          summary: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    checks: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'summary'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 160 },
          status: {
            type: 'string',
            enum: ['passed', 'failed', 'not_run'],
          },
          summary: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    candidateCommit: {
      type: ['string', 'null'],
      pattern: '^[0-9a-fA-F]{7,64}$',
    },
    reason: {
      type: ['string', 'null'],
      minLength: 1,
      maxLength: 4000,
    },
  },
} as const;

export const RepairPromptSchema = z.object({
  templateName: z.string().trim().min(1).max(120),
  templateVersion: z.string().trim().min(1).max(40),
  text: z.string().min(1).max(40_000),
  outputSchema: z.record(z.string(), z.json()),
});
export type RepairPrompt = z.infer<typeof RepairPromptSchema>;

export const RepairWorkItemSchema = z.object({
  attemptId: RepairAttemptIdSchema,
  project: z.object({
    id: ProjectIdSchema,
    slug: ProjectSlugSchema,
    title: z.string().trim().min(1).max(120).nullable(),
  }),
  bug: z.object({
    id: BugIdSchema,
    shortId: z.string().regex(/^BUG-\d{4,}$/),
    title: z.string().trim().min(1).max(160),
    operationPath: z.string().trim().min(1).max(4_000),
    actualResult: z.string().trim().min(1).max(8_000),
    expectedResult: z.string().trim().min(1).max(8_000),
    supplementalDescription: z.string().trim().max(8_000).nullable(),
    attachments: z.array(BugAttachmentMetadataSchema),
  }),
  prompt: RepairPromptSchema,
  resumeSessionId: z.string().trim().min(1).max(200).nullable(),
  retryNumber: z.number().int().nonnegative(),
  sourceDeploymentBatchId: DeploymentBatchIdSchema.nullable(),
  sourceDeployedCommit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i)
    .nullable(),
});
export type RepairWorkItem = z.infer<typeof RepairWorkItemSchema>;

export const RepairDispatchClaimSchema = z.object({
  dispatch: RepairDispatchSummarySchema,
  leaseToken: z.string().min(24).max(200),
  leaseExpiresAt: IsoUtcDateTimeSchema,
  items: z.array(RepairWorkItemSchema).min(1),
});
export type RepairDispatchClaim = z.infer<typeof RepairDispatchClaimSchema>;

export const AcquireRepairDispatchCommandSchema = z.object({
  runnerId: RunnerIdSchema,
});
export const AcquireRepairDispatchResultSchema = z.object({
  claim: RepairDispatchClaimSchema.nullable(),
});

export const RenewRepairDispatchLeaseCommandSchema = z.object({
  runnerId: RunnerIdSchema,
  dispatchId: RepairDispatchIdSchema,
  leaseToken: z.string().min(24).max(200),
});
export const RenewRepairDispatchLeaseResultSchema = z.object({
  leaseExpiresAt: IsoUtcDateTimeSchema,
});

export const StartRepairAttemptCommandSchema = z.object({
  runnerId: RunnerIdSchema,
  dispatchId: RepairDispatchIdSchema,
  attemptId: RepairAttemptIdSchema,
  leaseToken: z.string().min(24).max(200),
});
export const StartRepairAttemptResultSchema = z.object({
  attempt: RepairAttemptSummarySchema,
  bug: BugSummarySchema,
});

export const RepairAttemptOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('result'),
    sessionId: z.string().trim().min(1).max(200).nullable(),
    result: RepairResultSchema,
  }),
  z.object({
    kind: z.literal('cancelled'),
    sessionId: z.string().trim().min(1).max(200).nullable(),
    message: z.string().trim().min(1).max(4_000),
  }),
  z.object({
    kind: z.literal('execution_failure'),
    sessionId: z.string().trim().min(1).max(200).nullable(),
    message: z.string().trim().min(1).max(4_000),
  }),
]);
export type RepairAttemptOutcome = z.infer<typeof RepairAttemptOutcomeSchema>;

export const FinishRepairAttemptCommandSchema = z.object({
  runnerId: RunnerIdSchema,
  dispatchId: RepairDispatchIdSchema,
  attemptId: RepairAttemptIdSchema,
  leaseToken: z.string().min(24).max(200),
  outcome: RepairAttemptOutcomeSchema,
});
export const FinishRepairAttemptResultSchema = z.object({
  attempt: RepairAttemptSummarySchema,
  bug: BugSummarySchema,
  dispatchCompleted: z.boolean(),
  retryItem: RepairWorkItemSchema.nullable(),
});

export const ContinueBugRepairCommandSchema = z.object({
  bugId: BugIdSchema,
  feedback: z.string().trim().min(1).max(8_000),
  reassign: z.boolean().default(false),
});
export const ContinueBugRepairResultSchema = z.object({
  bug: BugSummarySchema,
  dispatch: RepairDispatchSummarySchema,
});
export const CancelRepairAttemptCommandSchema = z.object({
  bugId: BugIdSchema,
});
export const CancelRepairAttemptResultSchema = z.object({
  attempt: RepairAttemptSummarySchema,
  bug: BugSummarySchema,
});
export const RepairAttemptControlQuerySchema = z.object({
  attemptId: RepairAttemptIdSchema,
  runnerId: RunnerIdSchema,
});
export const RepairAttemptControlResultSchema = z.object({
  cancelRequested: z.boolean(),
});

export const DeploymentBatchStateSchema = z.enum([
  'collecting',
  'queued',
  'running',
  'blocked',
  'failed',
  'unknown',
  'deployed',
  'cancelled',
]);
export type DeploymentBatchState = z.infer<typeof DeploymentBatchStateSchema>;
export const DeploymentConfigSnapshotSchema = z.object({
  maxBugs: z.number().int().positive(),
  delayMs: z.number().int().positive(),
});
export type DeploymentConfigSnapshot = z.infer<
  typeof DeploymentConfigSnapshotSchema
>;
export const DeploymentMemberSchema = z.object({
  bug: BugSummarySchema,
  candidateCommit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i),
});
export type DeploymentMember = z.infer<typeof DeploymentMemberSchema>;
export const DeploymentBatchSummarySchema = z.object({
  id: DeploymentBatchIdSchema,
  projectId: ProjectIdSchema,
  runnerId: RunnerIdSchema,
  state: DeploymentBatchStateSchema,
  closesAt: IsoUtcDateTimeSchema,
  config: DeploymentConfigSnapshotSchema,
  members: z.array(DeploymentMemberSchema),
  templateName: z.string().trim().min(1).max(120).nullable(),
  templateVersion: z.string().trim().min(1).max(40).nullable(),
  summary: z.string().trim().min(1).max(4_000).nullable(),
  reason: z.string().trim().min(1).max(4_000).nullable(),
  deployedCommit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i)
    .nullable(),
  createdAt: IsoUtcDateTimeSchema,
  queuedAt: IsoUtcDateTimeSchema.nullable(),
  startedAt: IsoUtcDateTimeSchema.nullable(),
  finishedAt: IsoUtcDateTimeSchema.nullable(),
});
export type DeploymentBatchSummary = z.infer<
  typeof DeploymentBatchSummarySchema
>;
const DeploymentResultBaseSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  checks: z.array(RepairCheckResultSchema).max(100),
  reason: z.string().trim().min(1).max(4_000).nullable(),
  deployedCommit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i)
    .nullable(),
});
export const DeploymentResultSchema = z.discriminatedUnion('status', [
  DeploymentResultBaseSchema.extend({
    status: z.literal('deployed'),
    deployedCommit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i),
    reason: z.null(),
  }),
  DeploymentResultBaseSchema.extend({
    status: z.literal('blocked'),
    reason: z.string().trim().min(1).max(4_000),
    deployedCommit: z.null(),
  }),
  DeploymentResultBaseSchema.extend({
    status: z.literal('failed'),
    reason: z.string().trim().min(1).max(4_000),
    deployedCommit: z.null(),
  }),
  DeploymentResultBaseSchema.extend({
    status: z.literal('unknown'),
    reason: z.string().trim().min(1).max(4_000),
    deployedCommit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i)
      .nullable(),
  }),
]);
export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;
export const DEPLOYMENT_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'checks', 'reason', 'deployedCommit'],
  properties: {
    status: {
      type: 'string',
      enum: ['deployed', 'blocked', 'failed', 'unknown'],
    },
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    checks: BUG_REPAIR_OUTPUT_JSON_SCHEMA.properties.checks,
    reason: { type: ['string', 'null'], maxLength: 4000 },
    deployedCommit: {
      type: ['string', 'null'],
      pattern: '^[0-9a-fA-F]{7,64}$',
    },
  },
} as const;
export const PROMPT_TEMPLATES = [
  {
    name: 'bug-repair-start',
    version: '1.0.0',
    purpose: '在独立本地上下文中分析并修复一个 Bug，生成候选提交。',
    variables: ['REPOSITORY_PATH', 'ATTACHMENTS', 'ATTEMPT_ID', 'BUG_JSON'],
    outputSchema: BUG_REPAIR_OUTPUT_JSON_SCHEMA,
    text: `你正在执行单个 Bug 的独立修复。\n\n仓库路径：{{REPOSITORY_PATH}}\n附件：\n{{ATTACHMENTS}}\n\nBug 输入：\n{{BUG_JSON}}\n\n要求：\n1. 先发现并遵守仓库内 AGENTS.md、CLAUDE.md、README 和贡献规范。\n2. 由你负责 Git 与项目工作流；Agent 不会执行 Git、测试、构建或部署命令。\n3. 为本 Bug 创建独立逻辑 worktree，标识为 repair-{{ATTEMPT_ID}}，不要复用其他 Bug 的工作树。\n4. 复现并最小修改，运行匹配的检查；不得修改附件。\n5. 成功时创建只包含本 Bug 修复的本地候选提交，不要 push。\n6. 最终只返回符合输出 Schema 的 JSON；需要用户信息时返回 needs_input，受外部条件阻塞时返回 blocked，业务失败返回 failed。`,
  },
  {
    name: 'bug-repair-resume',
    version: '1.0.0',
    purpose: '在原 Bug 会话中结合用户补充或验证失败反馈继续修复。',
    variables: [
      'REPOSITORY_PATH',
      'ATTACHMENTS',
      'BUG_JSON',
      'FEEDBACK',
      'SOURCE_DEPLOYED_COMMIT',
    ],
    outputSchema: BUG_REPAIR_OUTPUT_JSON_SCHEMA,
    text: `继续处理原 Bug 修复。\n\n仓库路径：{{REPOSITORY_PATH}}\n附件：\n{{ATTACHMENTS}}\n\nBug 输入：\n{{BUG_JSON}}\n\n用户补充：\n{{FEEDBACK}}\n\n上次部署提交：{{SOURCE_DEPLOYED_COMMIT}}\n\n先确认本地状态与上次部署提交一致；若不一致先安全对齐。保留原问题脉络，最小修改并执行匹配检查。成功时创建新的本地候选提交，不要 push。最终只返回符合输出 Schema 的 JSON。`,
  },
  {
    name: 'deployment-start',
    version: '1.0.0',
    purpose: '在独立部署会话中集成同一批次候选提交并执行项目部署工作流。',
    variables: ['REPOSITORY_PATH', 'BATCH_ID', 'CANDIDATE_COMMITS'],
    outputSchema: DEPLOYMENT_OUTPUT_JSON_SCHEMA,
    text: `你正在执行一个原子部署批次。\n\n仓库路径：{{REPOSITORY_PATH}}\n批次：{{BATCH_ID}}\n候选提交：\n{{CANDIDATE_COMMITS}}\n\n要求：\n1. 先遵守仓库规范并确认本地基准。\n2. 仅允许执行明确的非生产部署工作流；禁止访问或变更生产环境。如果无法确认安全的非生产目标，必须返回 blocked。\n3. 由你完成候选提交集成、项目规定的检查与非生产部署；Agent 不执行 Git、测试、构建或部署脚本。\n4. 全批次必须按全有或全无处理，不得报告部分成功。\n5. 成功返回 deployed 和最终 deployedCommit；条件不足返回 blocked；明确失败返回 failed；无法确认结果返回 unknown。\n6. 摘要、原因和检查结果不得包含绝对路径或原始 CLI 日志。\n7. 最终只返回符合输出 Schema 的 JSON。`,
  },
  {
    name: 'deployment-resume',
    version: '1.0.0',
    purpose: '在原部署会话中根据用户补充继续执行整个批次。',
    variables: ['REPOSITORY_PATH', 'BATCH_ID', 'CANDIDATE_COMMITS', 'FEEDBACK'],
    outputSchema: DEPLOYMENT_OUTPUT_JSON_SCHEMA,
    text: `继续执行原部署批次。\n\n仓库路径：{{REPOSITORY_PATH}}\n批次：{{BATCH_ID}}\n候选提交：\n{{CANDIDATE_COMMITS}}\n\n用户补充：\n{{FEEDBACK}}\n\n仅允许继续明确的非生产部署，禁止访问或变更生产环境；无法确认安全的非生产目标时返回 blocked。保持批次原子性，先核对原会话的仓库状态，再继续项目规定的集成、检查和非生产部署。摘要、原因和检查结果不得包含绝对路径或原始 CLI 日志。最终只返回符合输出 Schema 的 JSON。`,
  },
  {
    name: 'cleanup',
    version: '1.0.0',
    purpose:
      '在用户明确确认后清理一个已完成目标的本地 worktree、分支和执行上下文。',
    variables: ['REPOSITORY_PATH', 'TARGET_KIND', 'TARGET_ID', 'SESSION_IDS'],
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'summary'],
      properties: {
        success: { type: 'boolean' },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
      },
    },
    text: `清理一个已经完成的本地执行目标。\n\n仓库路径：{{REPOSITORY_PATH}}\n目标类型：{{TARGET_KIND}}\n目标 ID：{{TARGET_ID}}\n关联会话：{{SESSION_IDS}}\n\n用户已经在本地 CLI 明确确认此单一目标。请遵守仓库规则，仅清理该目标对应的 worktree、临时分支和本地执行上下文；不要尝试删除 Codex 会话，确认后的本地 CLI 会精确删除上方列出的会话；不要删除控制平面数据，不要影响其他目标，不要执行远端操作。摘要只报告由你完成的仓库和执行上下文清理，不要声称会话已保留或删除。最终返回 {"success": boolean, "summary": string}。`,
  },
] as const;

export function getPromptTemplate(name: string) {
  return PROMPT_TEMPLATES.find((template) => template.name === name) ?? null;
}

export const DeploymentWorkClaimSchema = z.object({
  batch: DeploymentBatchSummarySchema,
  attemptId: DeploymentAttemptIdSchema,
  leaseToken: z.string().min(24).max(200),
  leaseExpiresAt: IsoUtcDateTimeSchema,
  prompt: RepairPromptSchema,
  resumeSessionId: z.string().trim().min(1).max(200).nullable(),
});
export type DeploymentWorkClaim = z.infer<typeof DeploymentWorkClaimSchema>;
export const EnqueueBugForDeploymentCommandSchema = z.object({
  bugId: BugIdSchema,
});
export const EnqueueBugForDeploymentResultSchema = z.object({
  bug: BugSummarySchema,
  batch: DeploymentBatchSummarySchema,
});
export const CloseDeploymentBatchCommandSchema = z.object({
  batchId: DeploymentBatchIdSchema,
});
export const CloseDeploymentBatchResultSchema = z.object({
  batch: DeploymentBatchSummarySchema,
});
export const ListDeploymentBatchesQuerySchema = z.object({
  projectId: ProjectIdSchema,
});
export const ListDeploymentBatchesResultSchema = z.object({
  items: z.array(DeploymentBatchSummarySchema),
});
export const AcquireDeploymentBatchCommandSchema = z.object({
  runnerId: RunnerIdSchema,
});
export const AcquireDeploymentBatchResultSchema = z.object({
  claim: DeploymentWorkClaimSchema.nullable(),
});
export const RenewDeploymentLeaseCommandSchema = z.object({
  runnerId: RunnerIdSchema,
  batchId: DeploymentBatchIdSchema,
  leaseToken: z.string().min(24).max(200),
});
export const RenewDeploymentLeaseResultSchema = z.object({
  leaseExpiresAt: IsoUtcDateTimeSchema,
});
export const StartDeploymentAttemptCommandSchema =
  RenewDeploymentLeaseCommandSchema.extend({
    attemptId: DeploymentAttemptIdSchema,
  });
export const StartDeploymentAttemptResultSchema = z.object({
  batch: DeploymentBatchSummarySchema,
});
export const FinishDeploymentAttemptCommandSchema =
  StartDeploymentAttemptCommandSchema.extend({
    outcome: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('result'),
        sessionId: z.string().trim().min(1).max(200).nullable(),
        result: DeploymentResultSchema,
      }),
      z.object({
        kind: z.literal('execution_failure'),
        sessionId: z.string().trim().min(1).max(200).nullable(),
        message: z.string().trim().min(1).max(4_000),
      }),
      z.object({
        kind: z.literal('cancelled'),
        sessionId: z.string().trim().min(1).max(200).nullable(),
        message: z.string().trim().min(1).max(4_000),
      }),
    ]),
  });
export const FinishDeploymentAttemptResultSchema = z.object({
  batch: DeploymentBatchSummarySchema,
});
export const ContinueDeploymentBatchCommandSchema = z.object({
  batchId: DeploymentBatchIdSchema,
  feedback: z.string().trim().min(1).max(8_000),
});
export const ContinueDeploymentBatchResultSchema = z.object({
  batch: DeploymentBatchSummarySchema,
});
export const CancelDeploymentBatchCommandSchema = z.object({
  batchId: DeploymentBatchIdSchema,
});
export const CancelDeploymentBatchResultSchema = z.object({
  batch: DeploymentBatchSummarySchema,
});
export const DeploymentAttemptControlQuerySchema = z.object({
  batchId: DeploymentBatchIdSchema,
  runnerId: RunnerIdSchema,
});
export const DeploymentAttemptControlResultSchema = z.object({
  cancelRequested: z.boolean(),
});

export const VerifyBugPassedCommandSchema = z.object({ bugId: BugIdSchema });
export const VerifyBugPassedResultSchema = z.object({ bug: BugSummarySchema });
export const VerifyBugFailedCommandSchema = z.object({
  bugId: BugIdSchema,
  feedback: z.string().trim().min(1).max(8_000),
  attachments: z.array(BugAttachmentUploadSchema).max(5).default([]),
});
export const VerifyBugFailedResultSchema = z.object({
  bug: BugSummarySchema,
  dispatch: RepairDispatchSummarySchema,
});

export const PromptTemplateSummarySchema = z.object({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(40),
  purpose: z.string().trim().min(1).max(500),
  text: z.string().min(1).max(40_000),
  variables: z.array(z.string().trim().min(1).max(120)),
  outputSchema: z.record(z.string(), z.json()),
});
export type PromptTemplateSummary = z.infer<typeof PromptTemplateSummarySchema>;
export const ListPromptTemplatesQuerySchema = z.object({});
export const ListPromptTemplatesResultSchema = z.object({
  items: z.array(PromptTemplateSummarySchema),
});

export const CleanupTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bug'),
    id: BugIdSchema,
    label: z.string().min(1),
    projectId: ProjectIdSchema,
    runnerId: RunnerIdSchema,
    sessionIds: z.array(z.string().min(1)),
    cleanedAt: IsoUtcDateTimeSchema.nullable(),
  }),
  z.object({
    kind: z.literal('deployment'),
    id: DeploymentBatchIdSchema,
    label: z.string().min(1),
    projectId: ProjectIdSchema,
    runnerId: RunnerIdSchema,
    sessionIds: z.array(z.string().min(1)),
    cleanedAt: IsoUtcDateTimeSchema.nullable(),
  }),
]);
export type CleanupTarget = z.infer<typeof CleanupTargetSchema>;
export const ListCleanupTargetsQuerySchema = z.object({
  runnerId: RunnerIdSchema,
});
export const ListCleanupTargetsResultSchema = z.object({
  items: z.array(CleanupTargetSchema),
});
export const GetCleanupTargetQuerySchema = z.object({
  runnerId: RunnerIdSchema,
  kind: z.enum(['bug', 'deployment']),
  id: z.uuid(),
});
export const GetCleanupTargetResultSchema = z.object({
  target: CleanupTargetSchema,
  prompt: RepairPromptSchema,
});
export const FinishCleanupCommandSchema = GetCleanupTargetQuerySchema.extend({
  success: z.boolean(),
  summary: z.string().trim().min(1).max(4_000),
  sessionId: z.string().trim().min(1).max(200).nullable(),
});
export const FinishCleanupResultSchema = z.object({
  target: CleanupTargetSchema,
});

export const CONTROL_PLANE_RESULT_SCHEMAS = {
  'control.status': ControlPlaneStatusResultSchema,
  'project.create': CreateProjectResultSchema,
  'project.list': ListProjectsResultSchema,
  'project.get': GetProjectResultSchema,
  'project.rename': RenameProjectResultSchema,
  'project.collaboration.get': GetProjectCollaborationResultSchema,
  'project.invitation.create': CreateProjectInvitationResultSchema,
  'project.invitation.respond': RespondProjectInvitationResultSchema,
  'project.invitation.revoke': RevokeProjectInvitationResultSchema,
  'project.member.remove': RemoveProjectMemberResultSchema,
  'project.invitation.list_received':
    ListReceivedProjectInvitationsResultSchema,
  'engineering.create': CreateEngineeringResultSchema,
  'engineering.list': ListEngineeringsResultSchema,
  'engineering.get': GetEngineeringResultSchema,
  'engineering.update': UpdateEngineeringResultSchema,
  'engineering.archive': SetEngineeringArchiveResultSchema,
  'engineering.delete': DeleteEngineeringResultSchema,
  'engineering.binding.ticket.create':
    CreateEngineeringBindingTicketResultSchema,
  'engineering.binding.claim': ClaimEngineeringBindingResultSchema,
  'engineering.binding.list': ListEngineeringBindingsResultSchema,
  'project.set_default_runner': SetProjectDefaultRunnerResultSchema,
  'runner.register': RegisterRunnerResultSchema,
  'runner.heartbeat': HeartbeatRunnerResultSchema,
  'bug.create': CreateBugResultSchema,
  'bug.list': ListBugsResultSchema,
  'bug.get': GetBugResultSchema,
  'bug.attachment.get': GetBugAttachmentResultSchema,
  'bug.repair.enqueue': EnqueueBugForRepairResultSchema,
  'bug.repair.return': ReturnBugToWaitingResultSchema,
  'repair_dispatch.close': CloseRepairDispatchResultSchema,
  'repair_dispatch.list': ListRepairDispatchesResultSchema,
  'repair_dispatch.claim': ClaimRepairDispatchResultSchema,
  'repair_dispatch.acquire': AcquireRepairDispatchResultSchema,
  'repair_dispatch.renew': RenewRepairDispatchLeaseResultSchema,
  'repair_attempt.start': StartRepairAttemptResultSchema,
  'repair_attempt.finish': FinishRepairAttemptResultSchema,
  'bug.repair.continue': ContinueBugRepairResultSchema,
  'repair_attempt.cancel': CancelRepairAttemptResultSchema,
  'repair_attempt.control': RepairAttemptControlResultSchema,
  'bug.deployment.enqueue': EnqueueBugForDeploymentResultSchema,
  'deployment_batch.close': CloseDeploymentBatchResultSchema,
  'deployment_batch.list': ListDeploymentBatchesResultSchema,
  'deployment_batch.acquire': AcquireDeploymentBatchResultSchema,
  'deployment_batch.renew': RenewDeploymentLeaseResultSchema,
  'deployment_attempt.start': StartDeploymentAttemptResultSchema,
  'deployment_attempt.finish': FinishDeploymentAttemptResultSchema,
  'deployment_batch.continue': ContinueDeploymentBatchResultSchema,
  'deployment_batch.cancel': CancelDeploymentBatchResultSchema,
  'deployment_attempt.control': DeploymentAttemptControlResultSchema,
  'bug.verify.pass': VerifyBugPassedResultSchema,
  'bug.verify.fail': VerifyBugFailedResultSchema,
  'prompt_template.list': ListPromptTemplatesResultSchema,
  'cleanup_target.list': ListCleanupTargetsResultSchema,
  'cleanup_target.get': GetCleanupTargetResultSchema,
  'cleanup.finish': FinishCleanupResultSchema,
  'collaborative.command': CollaborativeCommandResultSchema,
  'collaborative.query': CollaborativeQueryResultSchema,
} as const;

export type ControlPlaneOperation = keyof typeof CONTROL_PLANE_RESULT_SCHEMAS;
