import { randomUUID } from 'node:crypto';
import {
  CONTROL_PLANE_API_VERSION,
  CreateBugCommandSchema,
  CreateBugResultSchema,
  ControlPlaneRequestEnvelopeSchema,
  ControlPlaneResponseEnvelopeSchema,
  ControlPlaneStatusQuerySchema,
  ControlPlaneStatusResultSchema,
  CreateProjectCommandSchema,
  CreateProjectResultSchema,
  GetBugAttachmentQuerySchema,
  GetBugAttachmentResultSchema,
  GetBugQuerySchema,
  GetBugResultSchema,
  GetProjectQuerySchema,
  GetProjectResultSchema,
  HeartbeatRunnerCommandSchema,
  HeartbeatRunnerResultSchema,
  createAppError,
  ERROR_CODES,
  ListBugsQuerySchema,
  ListBugsResultSchema,
  ListProjectsQuerySchema,
  ListProjectsResultSchema,
  RegisterRunnerCommandSchema,
  RegisterRunnerResultSchema,
  RenameProjectCommandSchema,
  RenameProjectResultSchema,
  SetProjectDefaultRunnerCommandSchema,
  SetProjectDefaultRunnerResultSchema,
  EnqueueBugForRepairCommandSchema,
  EnqueueBugForRepairResultSchema,
  ReturnBugToWaitingCommandSchema,
  ReturnBugToWaitingResultSchema,
  CloseRepairDispatchCommandSchema,
  CloseRepairDispatchResultSchema,
  ListRepairDispatchesQuerySchema,
  ListRepairDispatchesResultSchema,
  ClaimRepairDispatchCommandSchema,
  ClaimRepairDispatchResultSchema,
  AcquireRepairDispatchCommandSchema,
  AcquireRepairDispatchResultSchema,
  RenewRepairDispatchLeaseCommandSchema,
  RenewRepairDispatchLeaseResultSchema,
  StartRepairAttemptCommandSchema,
  StartRepairAttemptResultSchema,
  FinishRepairAttemptCommandSchema,
  FinishRepairAttemptResultSchema,
  type BugAttachmentMetadata,
  type BugDetail,
  type BugSummary,
  type AppError,
  type ControlPlaneOperation,
  type CreateBugCommand,
  type CreateProjectCommand,
  type ProjectSummary,
  type RegisterRunnerCommand,
  type RunnerSummary,
  type RepairDispatchSummary,
  type RepairDispatchState,
  type RepairDispatchConfigSnapshot,
  type RepairDispatchClaim,
  type RepairAttemptOutcome,
  type RepairAttemptSummary,
} from '@agent-party-time/shared/control-plane';
import * as Contract from '@agent-party-time/shared/control-plane';

export interface ControlPlanePort {
  status(): Promise<{
    status: 'ready';
    projects: number;
    runners: number;
  }>;
  createProject(
    input: CreateProjectCommand,
    idempotencyKey: string,
  ): Promise<ProjectSummary>;
  listProjects(): Promise<ProjectSummary[]>;
  getProject(project: string): Promise<ProjectSummary>;
  renameProject(projectId: string, title: string): Promise<ProjectSummary>;
  getProjectCollaboration(projectId: string): Promise<{
    members: Contract.ProjectMemberSummary[];
    invitations: Contract.ProjectInvitationSummary[];
    auditEvents: Contract.ProjectAuditEventSummary[];
  }>;
  createProjectInvitation(
    input: Contract.CreateProjectInvitationCommand,
    idempotencyKey: string,
  ): Promise<Contract.ProjectInvitationSummary>;
  respondProjectInvitation(
    input: Contract.RespondProjectInvitationCommand,
    idempotencyKey: string,
  ): Promise<Contract.ProjectInvitationSummary>;
  revokeProjectInvitation(
    invitationId: string,
    idempotencyKey: string,
  ): Promise<Contract.ProjectInvitationSummary>;
  removeProjectMember(
    input: Contract.RemoveProjectMemberCommand,
    idempotencyKey: string,
  ): Promise<void>;
  listReceivedProjectInvitations(): Promise<
    Contract.ProjectInvitationSummary[]
  >;
  createEngineering(
    input: Contract.CreateEngineeringCommand,
    idempotencyKey: string,
  ): Promise<Contract.EngineeringDetail>;
  listEngineerings(
    projectId: string,
    includeArchived?: boolean,
  ): Promise<Contract.EngineeringSummary[]>;
  getEngineering(engineeringId: string): Promise<Contract.EngineeringDetail>;
  updateEngineering(
    input: Contract.UpdateEngineeringCommand,
    idempotencyKey: string,
  ): Promise<Contract.EngineeringDetail>;
  setEngineeringArchived(
    engineeringId: string,
    archived: boolean,
    idempotencyKey: string,
  ): Promise<Contract.EngineeringSummary>;
  deleteEngineering(
    engineeringId: string,
    idempotencyKey: string,
  ): Promise<void>;
  createEngineeringBindingTicket(
    engineeringId: string,
  ): Promise<{ ticket: string; expiresAt: string }>;
  claimEngineeringBinding(
    input: Contract.ClaimEngineeringBindingCommand,
  ): Promise<Contract.EngineeringBindingSummary>;
  listEngineeringBindings(
    engineeringId: string,
  ): Promise<Contract.EngineeringBindingSummary[]>;
  registerRunner(input: RegisterRunnerCommand): Promise<RunnerSummary>;
  heartbeatRunner(runnerId: string): Promise<RunnerSummary>;
  setProjectDefaultRunner(
    projectId: string,
    runnerId: string,
  ): Promise<ProjectSummary>;
  createBug(
    input: CreateBugCommand,
    idempotencyKey: string,
  ): Promise<BugDetail>;
  listBugs(projectId: string): Promise<BugSummary[]>;
  getBug(bugId: string): Promise<BugDetail>;
  getBugAttachment(attachmentId: string): Promise<{
    attachment: BugAttachmentMetadata;
    contentBase64: string;
  }>;
  enqueueBugForRepair(
    bugId: string,
    idempotencyKey: string,
  ): Promise<{ bug: BugSummary; dispatch: RepairDispatchSummary }>;
  returnBugToWaiting(
    bugId: string,
    idempotencyKey: string,
  ): Promise<{ bug: BugSummary; dispatch: RepairDispatchSummary | null }>;
  closeRepairDispatch(
    dispatchId: string,
    idempotencyKey: string,
  ): Promise<RepairDispatchSummary>;
  listRepairDispatches(projectId: string): Promise<RepairDispatchSummary[]>;
  claimRepairDispatch(runnerId: string): Promise<RepairDispatchSummary | null>;
  acquireRepairDispatch(runnerId: string): Promise<RepairDispatchClaim | null>;
  renewRepairDispatchLease(input: {
    runnerId: string;
    dispatchId: string;
    leaseToken: string;
  }): Promise<string>;
  startRepairAttempt(input: {
    runnerId: string;
    dispatchId: string;
    attemptId: string;
    leaseToken: string;
  }): Promise<{ attempt: RepairAttemptSummary; bug: BugSummary }>;
  finishRepairAttempt(input: {
    runnerId: string;
    dispatchId: string;
    attemptId: string;
    leaseToken: string;
    outcome: RepairAttemptOutcome;
  }): Promise<{
    attempt: RepairAttemptSummary;
    bug: BugSummary;
    dispatchCompleted: boolean;
    retryItem: Contract.RepairWorkItem | null;
  }>;
  continueBugRepair(
    input: { bugId: string; feedback: string; reassign?: boolean },
    idempotencyKey: string,
  ): Promise<{ bug: BugSummary; dispatch: RepairDispatchSummary }>;
  cancelRepairAttempt(
    bugId: string,
    idempotencyKey: string,
  ): Promise<{ attempt: RepairAttemptSummary; bug: BugSummary }>;
  repairAttemptControl(input: {
    attemptId: string;
    runnerId: string;
  }): Promise<boolean>;
  enqueueBugForDeployment(
    bugId: string,
    idempotencyKey: string,
  ): Promise<{ bug: BugSummary; batch: Contract.DeploymentBatchSummary }>;
  closeDeploymentBatch(
    batchId: string,
    idempotencyKey: string,
  ): Promise<Contract.DeploymentBatchSummary>;
  listDeploymentBatches(
    projectId: string,
  ): Promise<Contract.DeploymentBatchSummary[]>;
  acquireDeploymentBatch(
    runnerId: string,
  ): Promise<Contract.DeploymentWorkClaim | null>;
  renewDeploymentLease(input: {
    runnerId: string;
    batchId: string;
    leaseToken: string;
  }): Promise<string>;
  startDeploymentAttempt(input: {
    runnerId: string;
    batchId: string;
    attemptId: string;
    leaseToken: string;
  }): Promise<Contract.DeploymentBatchSummary>;
  finishDeploymentAttempt(input: {
    runnerId: string;
    batchId: string;
    attemptId: string;
    leaseToken: string;
    outcome:
      | {
          kind: 'result';
          sessionId: string | null;
          result: Contract.DeploymentResult;
        }
      | {
          kind: 'execution_failure' | 'cancelled';
          sessionId: string | null;
          message: string;
        };
  }): Promise<Contract.DeploymentBatchSummary>;
  continueDeploymentBatch(
    input: { batchId: string; feedback: string },
    idempotencyKey: string,
  ): Promise<Contract.DeploymentBatchSummary>;
  cancelDeploymentBatch(
    batchId: string,
    idempotencyKey: string,
  ): Promise<Contract.DeploymentBatchSummary>;
  deploymentAttemptControl(input: {
    batchId: string;
    runnerId: string;
  }): Promise<boolean>;
  verifyBugPassed(bugId: string, idempotencyKey: string): Promise<BugSummary>;
  verifyBugFailed(
    input: {
      bugId: string;
      feedback: string;
      attachments: CreateBugCommand['attachments'];
    },
    idempotencyKey: string,
  ): Promise<{ bug: BugSummary; dispatch: RepairDispatchSummary }>;
  listPromptTemplates(): Promise<Contract.PromptTemplateSummary[]>;
  listCleanupTargets(runnerId: string): Promise<Contract.CleanupTarget[]>;
  getCleanupTarget(input: {
    runnerId: string;
    kind: 'bug' | 'deployment';
    id: string;
  }): Promise<{
    target: Contract.CleanupTarget;
    prompt: Contract.RepairPrompt;
  }>;
  finishCleanup(
    input: {
      runnerId: string;
      kind: 'bug' | 'deployment';
      id: string;
      success: boolean;
      summary: string;
      sessionId: string | null;
    },
    idempotencyKey: string,
  ): Promise<Contract.CleanupTarget>;
  collaborativeCommand(
    input: Contract.CollaborativeCommand,
    idempotencyKey?: string,
  ): Promise<Contract.CollaborativeCommandResult>;
  collaborativeQuery(
    input: Contract.CollaborativeQuery,
  ): Promise<Contract.CollaborativeQueryResult>;
}

export class ControlPlaneClientError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message);
    this.name = 'ControlPlaneClientError';
  }
}

export interface HttpControlPlaneAdapterOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  actor?: Contract.ControlPlaneActor;
}

export class HttpControlPlaneAdapter implements ControlPlanePort {
  constructor(private readonly options: HttpControlPlaneAdapterOptions) {}

  async status() {
    return ControlPlaneStatusResultSchema.parse(
      await this.request(
        'control.status',
        ControlPlaneStatusQuerySchema.parse({}),
      ),
    );
  }

  async createProject(input: CreateProjectCommand, idempotencyKey: string) {
    const result = CreateProjectResultSchema.parse(
      await this.request(
        'project.create',
        CreateProjectCommandSchema.parse(input),
        idempotencyKey,
      ),
    );
    return result.project;
  }

  async listProjects() {
    return ListProjectsResultSchema.parse(
      await this.request('project.list', ListProjectsQuerySchema.parse({})),
    ).items;
  }

  async getProject(project: string) {
    return GetProjectResultSchema.parse(
      await this.request(
        'project.get',
        GetProjectQuerySchema.parse({ project }),
      ),
    ).project;
  }

  async renameProject(projectId: string, title: string) {
    return RenameProjectResultSchema.parse(
      await this.request(
        'project.rename',
        RenameProjectCommandSchema.parse({ projectId, title }),
      ),
    ).project;
  }

  async getProjectCollaboration(projectId: string) {
    return Contract.GetProjectCollaborationResultSchema.parse(
      await this.request(
        'project.collaboration.get',
        Contract.GetProjectCollaborationQuerySchema.parse({ projectId }),
      ),
    );
  }

  async createProjectInvitation(
    input: Contract.CreateProjectInvitationCommand,
    idempotencyKey: string,
  ) {
    return Contract.CreateProjectInvitationResultSchema.parse(
      await this.request(
        'project.invitation.create',
        Contract.CreateProjectInvitationCommandSchema.parse(input),
        idempotencyKey,
      ),
    ).invitation;
  }

  async respondProjectInvitation(
    input: Contract.RespondProjectInvitationCommand,
    idempotencyKey: string,
  ) {
    return Contract.RespondProjectInvitationResultSchema.parse(
      await this.request(
        'project.invitation.respond',
        Contract.RespondProjectInvitationCommandSchema.parse(input),
        idempotencyKey,
      ),
    ).invitation;
  }

  async revokeProjectInvitation(invitationId: string, idempotencyKey: string) {
    return Contract.RevokeProjectInvitationResultSchema.parse(
      await this.request(
        'project.invitation.revoke',
        Contract.RevokeProjectInvitationCommandSchema.parse({ invitationId }),
        idempotencyKey,
      ),
    ).invitation;
  }

  async removeProjectMember(
    input: Contract.RemoveProjectMemberCommand,
    idempotencyKey: string,
  ) {
    Contract.RemoveProjectMemberResultSchema.parse(
      await this.request(
        'project.member.remove',
        Contract.RemoveProjectMemberCommandSchema.parse(input),
        idempotencyKey,
      ),
    );
  }

  async listReceivedProjectInvitations() {
    return Contract.ListReceivedProjectInvitationsResultSchema.parse(
      await this.request(
        'project.invitation.list_received',
        Contract.ListReceivedProjectInvitationsQuerySchema.parse({}),
      ),
    ).items;
  }

  async createEngineering(
    input: Contract.CreateEngineeringCommand,
    idempotencyKey: string,
  ) {
    return Contract.CreateEngineeringResultSchema.parse(
      await this.request(
        'engineering.create',
        Contract.CreateEngineeringCommandSchema.parse(input),
        idempotencyKey,
      ),
    ).engineering;
  }

  async listEngineerings(projectId: string, includeArchived = true) {
    return Contract.ListEngineeringsResultSchema.parse(
      await this.request(
        'engineering.list',
        Contract.ListEngineeringsQuerySchema.parse({
          projectId,
          includeArchived,
        }),
      ),
    ).items;
  }

  async getEngineering(engineeringId: string) {
    return Contract.GetEngineeringResultSchema.parse(
      await this.request(
        'engineering.get',
        Contract.GetEngineeringQuerySchema.parse({ engineeringId }),
      ),
    ).engineering;
  }

  async updateEngineering(
    input: Contract.UpdateEngineeringCommand,
    idempotencyKey: string,
  ) {
    return Contract.UpdateEngineeringResultSchema.parse(
      await this.request(
        'engineering.update',
        Contract.UpdateEngineeringCommandSchema.parse(input),
        idempotencyKey,
      ),
    ).engineering;
  }

  async setEngineeringArchived(
    engineeringId: string,
    archived: boolean,
    idempotencyKey: string,
  ) {
    return Contract.SetEngineeringArchiveResultSchema.parse(
      await this.request(
        'engineering.archive',
        Contract.SetEngineeringArchiveCommandSchema.parse({
          engineeringId,
          archived,
        }),
        idempotencyKey,
      ),
    ).engineering;
  }

  async deleteEngineering(engineeringId: string, idempotencyKey: string) {
    Contract.DeleteEngineeringResultSchema.parse(
      await this.request(
        'engineering.delete',
        Contract.DeleteEngineeringCommandSchema.parse({ engineeringId }),
        idempotencyKey,
      ),
    );
  }

  async createEngineeringBindingTicket(engineeringId: string) {
    return Contract.CreateEngineeringBindingTicketResultSchema.parse(
      await this.request(
        'engineering.binding.ticket.create',
        Contract.CreateEngineeringBindingTicketCommandSchema.parse({
          engineeringId,
        }),
      ),
    );
  }

  async claimEngineeringBinding(
    input: Contract.ClaimEngineeringBindingCommand,
  ) {
    return Contract.ClaimEngineeringBindingResultSchema.parse(
      await this.request(
        'engineering.binding.claim',
        Contract.ClaimEngineeringBindingCommandSchema.parse(input),
      ),
    ).binding;
  }

  async listEngineeringBindings(engineeringId: string) {
    return Contract.ListEngineeringBindingsResultSchema.parse(
      await this.request(
        'engineering.binding.list',
        Contract.ListEngineeringBindingsQuerySchema.parse({ engineeringId }),
      ),
    ).items;
  }

  async registerRunner(input: RegisterRunnerCommand) {
    return RegisterRunnerResultSchema.parse(
      await this.request(
        'runner.register',
        RegisterRunnerCommandSchema.parse(input),
        `runner:${input.runnerId}`,
      ),
    ).runner;
  }

  async heartbeatRunner(runnerId: string) {
    return HeartbeatRunnerResultSchema.parse(
      await this.request(
        'runner.heartbeat',
        HeartbeatRunnerCommandSchema.parse({ runnerId }),
      ),
    ).runner;
  }

  async setProjectDefaultRunner(projectId: string, runnerId: string) {
    return SetProjectDefaultRunnerResultSchema.parse(
      await this.request(
        'project.set_default_runner',
        SetProjectDefaultRunnerCommandSchema.parse({ projectId, runnerId }),
        `project-runner:${projectId}:${runnerId}`,
      ),
    ).project;
  }

  async createBug(input: CreateBugCommand, idempotencyKey: string) {
    return CreateBugResultSchema.parse(
      await this.request(
        'bug.create',
        CreateBugCommandSchema.parse(input),
        idempotencyKey,
      ),
    ).bug;
  }

  async listBugs(projectId: string) {
    return ListBugsResultSchema.parse(
      await this.request('bug.list', ListBugsQuerySchema.parse({ projectId })),
    ).items;
  }

  async getBug(bugId: string) {
    return GetBugResultSchema.parse(
      await this.request('bug.get', GetBugQuerySchema.parse({ bugId })),
    ).bug;
  }

  async getBugAttachment(attachmentId: string) {
    return GetBugAttachmentResultSchema.parse(
      await this.request(
        'bug.attachment.get',
        GetBugAttachmentQuerySchema.parse({ attachmentId }),
      ),
    );
  }

  async enqueueBugForRepair(bugId: string, idempotencyKey: string) {
    return EnqueueBugForRepairResultSchema.parse(
      await this.request(
        'bug.repair.enqueue',
        EnqueueBugForRepairCommandSchema.parse({ bugId }),
        idempotencyKey,
      ),
    );
  }

  async returnBugToWaiting(bugId: string, idempotencyKey: string) {
    return ReturnBugToWaitingResultSchema.parse(
      await this.request(
        'bug.repair.return',
        ReturnBugToWaitingCommandSchema.parse({ bugId }),
        idempotencyKey,
      ),
    );
  }

  async closeRepairDispatch(dispatchId: string, idempotencyKey: string) {
    return CloseRepairDispatchResultSchema.parse(
      await this.request(
        'repair_dispatch.close',
        CloseRepairDispatchCommandSchema.parse({ dispatchId }),
        idempotencyKey,
      ),
    ).dispatch;
  }

  async listRepairDispatches(projectId: string) {
    return ListRepairDispatchesResultSchema.parse(
      await this.request(
        'repair_dispatch.list',
        ListRepairDispatchesQuerySchema.parse({ projectId }),
      ),
    ).items;
  }

  async claimRepairDispatch(runnerId: string) {
    return ClaimRepairDispatchResultSchema.parse(
      await this.request(
        'repair_dispatch.claim',
        ClaimRepairDispatchCommandSchema.parse({ runnerId }),
      ),
    ).dispatch;
  }

  async acquireRepairDispatch(runnerId: string) {
    return AcquireRepairDispatchResultSchema.parse(
      await this.request(
        'repair_dispatch.acquire',
        AcquireRepairDispatchCommandSchema.parse({ runnerId }),
      ),
    ).claim;
  }

  async renewRepairDispatchLease(input: {
    runnerId: string;
    dispatchId: string;
    leaseToken: string;
  }) {
    return RenewRepairDispatchLeaseResultSchema.parse(
      await this.request(
        'repair_dispatch.renew',
        RenewRepairDispatchLeaseCommandSchema.parse(input),
      ),
    ).leaseExpiresAt;
  }

  async startRepairAttempt(input: {
    runnerId: string;
    dispatchId: string;
    attemptId: string;
    leaseToken: string;
  }) {
    return StartRepairAttemptResultSchema.parse(
      await this.request(
        'repair_attempt.start',
        StartRepairAttemptCommandSchema.parse(input),
      ),
    );
  }

  async finishRepairAttempt(input: {
    runnerId: string;
    dispatchId: string;
    attemptId: string;
    leaseToken: string;
    outcome: RepairAttemptOutcome;
  }) {
    return FinishRepairAttemptResultSchema.parse(
      await this.request(
        'repair_attempt.finish',
        FinishRepairAttemptCommandSchema.parse(input),
      ),
    );
  }

  async continueBugRepair(
    input: { bugId: string; feedback: string; reassign?: boolean },
    idempotencyKey: string,
  ) {
    return Contract.ContinueBugRepairResultSchema.parse(
      await this.request(
        'bug.repair.continue',
        Contract.ContinueBugRepairCommandSchema.parse(input),
        idempotencyKey,
      ),
    );
  }

  async cancelRepairAttempt(bugId: string, idempotencyKey: string) {
    return Contract.CancelRepairAttemptResultSchema.parse(
      await this.request(
        'repair_attempt.cancel',
        Contract.CancelRepairAttemptCommandSchema.parse({ bugId }),
        idempotencyKey,
      ),
    );
  }

  async repairAttemptControl(input: { attemptId: string; runnerId: string }) {
    return Contract.RepairAttemptControlResultSchema.parse(
      await this.request(
        'repair_attempt.control',
        Contract.RepairAttemptControlQuerySchema.parse(input),
      ),
    ).cancelRequested;
  }

  async enqueueBugForDeployment(bugId: string, idempotencyKey: string) {
    return Contract.EnqueueBugForDeploymentResultSchema.parse(
      await this.request(
        'bug.deployment.enqueue',
        Contract.EnqueueBugForDeploymentCommandSchema.parse({ bugId }),
        idempotencyKey,
      ),
    );
  }

  async closeDeploymentBatch(batchId: string, idempotencyKey: string) {
    return Contract.CloseDeploymentBatchResultSchema.parse(
      await this.request(
        'deployment_batch.close',
        Contract.CloseDeploymentBatchCommandSchema.parse({ batchId }),
        idempotencyKey,
      ),
    ).batch;
  }

  async listDeploymentBatches(projectId: string) {
    return Contract.ListDeploymentBatchesResultSchema.parse(
      await this.request(
        'deployment_batch.list',
        Contract.ListDeploymentBatchesQuerySchema.parse({ projectId }),
      ),
    ).items;
  }

  async acquireDeploymentBatch(runnerId: string) {
    return Contract.AcquireDeploymentBatchResultSchema.parse(
      await this.request(
        'deployment_batch.acquire',
        Contract.AcquireDeploymentBatchCommandSchema.parse({ runnerId }),
      ),
    ).claim;
  }

  async renewDeploymentLease(input: {
    runnerId: string;
    batchId: string;
    leaseToken: string;
  }) {
    return Contract.RenewDeploymentLeaseResultSchema.parse(
      await this.request(
        'deployment_batch.renew',
        Contract.RenewDeploymentLeaseCommandSchema.parse(input),
      ),
    ).leaseExpiresAt;
  }

  async startDeploymentAttempt(input: {
    runnerId: string;
    batchId: string;
    attemptId: string;
    leaseToken: string;
  }) {
    return Contract.StartDeploymentAttemptResultSchema.parse(
      await this.request(
        'deployment_attempt.start',
        Contract.StartDeploymentAttemptCommandSchema.parse(input),
      ),
    ).batch;
  }

  async finishDeploymentAttempt(input: {
    runnerId: string;
    batchId: string;
    attemptId: string;
    leaseToken: string;
    outcome:
      | {
          kind: 'result';
          sessionId: string | null;
          result: Contract.DeploymentResult;
        }
      | {
          kind: 'execution_failure' | 'cancelled';
          sessionId: string | null;
          message: string;
        };
  }) {
    return Contract.FinishDeploymentAttemptResultSchema.parse(
      await this.request(
        'deployment_attempt.finish',
        Contract.FinishDeploymentAttemptCommandSchema.parse(input),
      ),
    ).batch;
  }

  async continueDeploymentBatch(
    input: { batchId: string; feedback: string },
    idempotencyKey: string,
  ) {
    return Contract.ContinueDeploymentBatchResultSchema.parse(
      await this.request(
        'deployment_batch.continue',
        Contract.ContinueDeploymentBatchCommandSchema.parse(input),
        idempotencyKey,
      ),
    ).batch;
  }

  async cancelDeploymentBatch(batchId: string, idempotencyKey: string) {
    return Contract.CancelDeploymentBatchResultSchema.parse(
      await this.request(
        'deployment_batch.cancel',
        Contract.CancelDeploymentBatchCommandSchema.parse({ batchId }),
        idempotencyKey,
      ),
    ).batch;
  }

  async deploymentAttemptControl(input: { batchId: string; runnerId: string }) {
    return Contract.DeploymentAttemptControlResultSchema.parse(
      await this.request(
        'deployment_attempt.control',
        Contract.DeploymentAttemptControlQuerySchema.parse(input),
      ),
    ).cancelRequested;
  }

  async verifyBugPassed(bugId: string, idempotencyKey: string) {
    return Contract.VerifyBugPassedResultSchema.parse(
      await this.request(
        'bug.verify.pass',
        Contract.VerifyBugPassedCommandSchema.parse({ bugId }),
        idempotencyKey,
      ),
    ).bug;
  }

  async verifyBugFailed(
    input: {
      bugId: string;
      feedback: string;
      attachments: CreateBugCommand['attachments'];
    },
    idempotencyKey: string,
  ) {
    return Contract.VerifyBugFailedResultSchema.parse(
      await this.request(
        'bug.verify.fail',
        Contract.VerifyBugFailedCommandSchema.parse(input),
        idempotencyKey,
      ),
    );
  }

  async listPromptTemplates() {
    return Contract.ListPromptTemplatesResultSchema.parse(
      await this.request(
        'prompt_template.list',
        Contract.ListPromptTemplatesQuerySchema.parse({}),
      ),
    ).items;
  }

  async listCleanupTargets(runnerId: string) {
    return Contract.ListCleanupTargetsResultSchema.parse(
      await this.request(
        'cleanup_target.list',
        Contract.ListCleanupTargetsQuerySchema.parse({ runnerId }),
      ),
    ).items;
  }

  async getCleanupTarget(input: {
    runnerId: string;
    kind: 'bug' | 'deployment';
    id: string;
  }) {
    return Contract.GetCleanupTargetResultSchema.parse(
      await this.request(
        'cleanup_target.get',
        Contract.GetCleanupTargetQuerySchema.parse(input),
      ),
    );
  }

  async finishCleanup(
    input: {
      runnerId: string;
      kind: 'bug' | 'deployment';
      id: string;
      success: boolean;
      summary: string;
      sessionId: string | null;
    },
    idempotencyKey: string,
  ) {
    return Contract.FinishCleanupResultSchema.parse(
      await this.request(
        'cleanup.finish',
        Contract.FinishCleanupCommandSchema.parse(input),
        idempotencyKey,
      ),
    ).target;
  }

  async collaborativeCommand(
    input: Contract.CollaborativeCommand,
    idempotencyKey = randomUUID(),
  ) {
    return Contract.CollaborativeCommandResultSchema.parse(
      await this.request(
        'collaborative.command',
        Contract.CollaborativeCommandSchema.parse(input),
        idempotencyKey,
      ),
    );
  }

  async collaborativeQuery(input: Contract.CollaborativeQuery) {
    return Contract.CollaborativeQueryResultSchema.parse(
      await this.request(
        'collaborative.query',
        Contract.CollaborativeQuerySchema.parse(input),
      ),
    );
  }

  private async request<TOperation extends ControlPlaneOperation>(
    operation: TOperation,
    payload: unknown,
    idempotencyKey?: string,
  ) {
    const requestId = randomUUID();
    const envelope = ControlPlaneRequestEnvelopeSchema.parse({
      apiVersion: CONTROL_PLANE_API_VERSION,
      requestId,
      operation,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(this.options.actor ? { actor: this.options.actor } : {}),
      payload,
    });
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(
        new URL('/api', this.options.baseUrl),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
        },
      );
    } catch {
      throw new ControlPlaneClientError(
        createAppError({
          code: ERROR_CODES.channelDisconnected,
          category: 'transport',
          message: '无法连接 Control Plane',
          retryable: true,
        }),
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw this.invalidResponse();
    let parsed: ReturnType<typeof ControlPlaneResponseEnvelopeSchema.parse>;
    try {
      parsed = ControlPlaneResponseEnvelopeSchema.parse(await response.json());
    } catch {
      throw this.invalidResponse();
    }
    if (parsed.requestId !== requestId) throw this.invalidResponse();
    if (!parsed.ok) throw new ControlPlaneClientError(parsed.error);
    return parsed.data;
  }

  private invalidResponse() {
    return new ControlPlaneClientError(
      createAppError({
        code: ERROR_CODES.internalUnexpected,
        category: 'internal',
        message: 'Control Plane 返回了无效响应',
        retryable: false,
      }),
    );
  }
}

export interface InMemoryControlPlaneAdapterOptions {
  now?: () => Date;
  offlineAfterMs?: number;
  repairDispatchMaxBugs?: number;
  repairDispatchDelayMs?: number;
}

interface MemoryProject {
  id: string;
  slug: string;
  title: string | null;
  defaultRunnerId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRunner {
  id: string;
  name: string;
  lastSeenAt: string;
}

interface MemoryBug extends Omit<BugDetail, 'attachments' | 'events'> {
  attachments: Array<BugAttachmentMetadata & { contentBase64: string }>;
  events: BugDetail['events'];
}

interface MemoryRepairDispatch {
  id: string;
  projectId: string;
  runnerId: string;
  state: RepairDispatchState | 'cancelled';
  closesAt: string;
  config: RepairDispatchConfigSnapshot;
  memberIds: string[];
  createdAt: string;
  queuedAt: string | null;
  claimedAt: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}

export class InMemoryControlPlaneAdapter implements ControlPlanePort {
  private readonly projects = new Map<string, MemoryProject>();
  private readonly runners = new Map<string, MemoryRunner>();
  private readonly idempotency = new Map<string, ProjectSummary>();
  private readonly bugs = new Map<string, MemoryBug>();
  private readonly bugIdempotency = new Map<string, BugDetail>();
  private readonly repairDispatches = new Map<string, MemoryRepairDispatch>();
  private readonly now: () => Date;
  private readonly offlineAfterMs: number;
  private readonly repairDispatchConfig: RepairDispatchConfigSnapshot;

  constructor(options: InMemoryControlPlaneAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.offlineAfterMs = options.offlineAfterMs ?? 20_000;
    this.repairDispatchConfig = {
      maxBugs: options.repairDispatchMaxBugs ?? 5,
      delayMs: options.repairDispatchDelayMs ?? 120_000,
    };
  }

  async status() {
    return {
      status: 'ready' as const,
      projects: this.projects.size,
      runners: this.runners.size,
    };
  }

  async createProject(input: CreateProjectCommand, idempotencyKey: string) {
    const parsed = CreateProjectCommandSchema.parse(input);
    const previous = this.idempotency.get(idempotencyKey);
    if (previous) return previous;
    if ([...this.projects.values()].some((item) => item.slug === parsed.slug))
      throw this.conflict('项目 slug 已存在');
    const now = this.now().toISOString();
    const project: MemoryProject = {
      id: randomUUID(),
      slug: parsed.slug,
      title: parsed.title ?? null,
      defaultRunnerId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    const summary = this.projectSummary(project);
    this.idempotency.set(idempotencyKey, summary);
    return summary;
  }

  async listProjects() {
    return [...this.projects.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((project) => this.projectSummary(project));
  }

  async getProject(identifier: string) {
    const project = [...this.projects.values()].find(
      (item) => item.id === identifier || item.slug === identifier,
    );
    if (!project) throw this.notFound('项目不存在');
    return this.projectSummary(project);
  }

  async renameProject(projectId: string, title: string) {
    const project = this.projects.get(projectId);
    if (!project) throw this.notFound('项目不存在');
    project.title = RenameProjectCommandSchema.parse({
      projectId,
      title,
    }).title;
    project.updatedAt = this.now().toISOString();
    return this.projectSummary(project);
  }

  async getProjectCollaboration(_projectId: string): Promise<{
    members: Contract.ProjectMemberSummary[];
    invitations: Contract.ProjectInvitationSummary[];
    auditEvents: Contract.ProjectAuditEventSummary[];
  }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-002 协作接口');
  }
  async createProjectInvitation(
    _input: Contract.CreateProjectInvitationCommand,
    _idempotencyKey: string,
  ): Promise<Contract.ProjectInvitationSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-002 协作接口');
  }
  async respondProjectInvitation(
    _input: Contract.RespondProjectInvitationCommand,
    _idempotencyKey: string,
  ): Promise<Contract.ProjectInvitationSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-002 协作接口');
  }
  async revokeProjectInvitation(
    _invitationId: string,
    _idempotencyKey: string,
  ): Promise<Contract.ProjectInvitationSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-002 协作接口');
  }
  async removeProjectMember(
    _input: Contract.RemoveProjectMemberCommand,
    _idempotencyKey: string,
  ): Promise<void> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-002 协作接口');
  }
  async listReceivedProjectInvitations(): Promise<
    Contract.ProjectInvitationSummary[]
  > {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-002 协作接口');
  }
  async createEngineering(
    _input: Contract.CreateEngineeringCommand,
    _idempotencyKey: string,
  ): Promise<Contract.EngineeringDetail> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-003 工程接口');
  }
  async listEngineerings(
    _projectId: string,
    _includeArchived = true,
  ): Promise<Contract.EngineeringSummary[]> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-003 工程接口');
  }
  async getEngineering(
    _engineeringId: string,
  ): Promise<Contract.EngineeringDetail> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-003 工程接口');
  }
  async updateEngineering(
    _input: Contract.UpdateEngineeringCommand,
    _idempotencyKey: string,
  ): Promise<Contract.EngineeringDetail> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-003 工程接口');
  }
  async setEngineeringArchived(
    _engineeringId: string,
    _archived: boolean,
    _idempotencyKey: string,
  ): Promise<Contract.EngineeringSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-003 工程接口');
  }
  async deleteEngineering(
    _engineeringId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-003 工程接口');
  }
  async createEngineeringBindingTicket(
    _engineeringId: string,
  ): Promise<{ ticket: string; expiresAt: string }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-004 绑定接口');
  }
  async claimEngineeringBinding(
    _input: Contract.ClaimEngineeringBindingCommand,
  ): Promise<Contract.EngineeringBindingSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-004 绑定接口');
  }
  async listEngineeringBindings(
    _engineeringId: string,
  ): Promise<Contract.EngineeringBindingSummary[]> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 CTS-004 绑定接口');
  }

  async registerRunner(input: RegisterRunnerCommand) {
    const parsed = RegisterRunnerCommandSchema.parse(input);
    const runner: MemoryRunner = {
      id: parsed.runnerId,
      name: parsed.name,
      lastSeenAt: this.now().toISOString(),
    };
    this.runners.set(runner.id, runner);
    return this.runnerSummary(runner);
  }

  async heartbeatRunner(runnerId: string) {
    const runner = this.runners.get(runnerId);
    if (!runner) throw this.notFound('Agent 不存在');
    runner.lastSeenAt = this.now().toISOString();
    return this.runnerSummary(runner);
  }

  async setProjectDefaultRunner(projectId: string, runnerId: string) {
    const project = this.projects.get(projectId);
    if (!project) throw this.notFound('项目不存在');
    if (!this.runners.has(runnerId)) throw this.notFound('Agent 不存在');
    project.defaultRunnerId = runnerId;
    project.updatedAt = this.now().toISOString();
    return this.projectSummary(project);
  }

  async createBug(input: CreateBugCommand, idempotencyKey: string) {
    const parsed = CreateBugCommandSchema.parse(input);
    const previous = this.bugIdempotency.get(idempotencyKey);
    if (previous) return previous;
    if (!this.projects.has(parsed.projectId)) throw this.notFound('项目不存在');
    const now = this.now().toISOString();
    const id = randomUUID();
    const bug: MemoryBug = {
      id,
      shortId: `BUG-${String(this.bugs.size + 1).padStart(4, '0')}`,
      projectId: parsed.projectId,
      status: 'waiting_for_repair',
      repairState: null,
      repairDispatchId: null,
      deploymentBatchId: null,
      deploymentState: null,
      canReopenRepair: false,
      title: parsed.title,
      operationPath: parsed.operationPath,
      actualResult: parsed.actualResult,
      expectedResult: parsed.expectedResult,
      supplementalDescription: parsed.supplementalDescription ?? null,
      attachments: parsed.attachments.map((attachment) => ({
        id: randomUUID(),
        bugId: id,
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        createdAt: now,
        contentBase64: attachment.contentBase64,
      })),
      events: [
        { id: randomUUID(), bugId: id, type: 'bug.created', createdAt: now },
      ],
      repairAttempt: null,
      repairAttempts: [],
      verificationFeedbacks: [],
      createdAt: now,
      updatedAt: now,
    };
    this.bugs.set(id, bug);
    const detail = this.bugDetail(bug);
    this.bugIdempotency.set(idempotencyKey, detail);
    return detail;
  }

  async listBugs(projectId: string) {
    if (!this.projects.has(projectId)) throw this.notFound('项目不存在');
    return [...this.bugs.values()]
      .filter((bug) => bug.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(
        ({ attachments: _attachments, events: _events, ...summary }) => summary,
      );
  }

  async getBug(bugId: string) {
    const bug = this.bugs.get(bugId);
    if (!bug) throw this.notFound('Bug 不存在');
    return this.bugDetail(bug);
  }

  async getBugAttachment(attachmentId: string) {
    for (const bug of this.bugs.values()) {
      const attachment = bug.attachments.find(
        (item) => item.id === attachmentId,
      );
      if (attachment) {
        const { contentBase64, ...metadata } = attachment;
        return { attachment: metadata, contentBase64 };
      }
    }
    throw this.notFound('附件不存在');
  }

  async enqueueBugForRepair(bugId: string, _idempotencyKey: string) {
    this.closeExpiredDispatches();
    const bug = this.bugs.get(bugId);
    if (!bug) throw this.notFound('Bug 不存在');
    if (bug.status === 'repairing' && bug.repairDispatchId)
      return {
        bug: this.bugSummary(bug),
        dispatch: this.dispatchSummary(
          this.repairDispatches.get(bug.repairDispatchId)!,
        ),
      };
    if (bug.status !== 'waiting_for_repair')
      throw this.transitionInvalid('该 Bug 不能加入修复收集');
    const project = this.projects.get(bug.projectId);
    if (!project?.defaultRunnerId)
      throw this.transitionInvalid('项目尚未绑定默认 Agent');
    const now = this.now();
    let dispatch = [...this.repairDispatches.values()].find(
      (item) => item.projectId === bug.projectId && item.state === 'collecting',
    );
    if (!dispatch) {
      dispatch = {
        id: randomUUID(),
        projectId: bug.projectId,
        runnerId: project.defaultRunnerId,
        state: 'collecting',
        closesAt: new Date(
          now.getTime() + this.repairDispatchConfig.delayMs,
        ).toISOString(),
        config: { ...this.repairDispatchConfig },
        memberIds: [],
        createdAt: now.toISOString(),
        queuedAt: null,
        claimedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      };
      this.repairDispatches.set(dispatch.id, dispatch);
    }
    dispatch.memberIds.push(bugId);
    bug.status = 'repairing';
    bug.repairState = 'collecting';
    bug.repairDispatchId = dispatch.id;
    bug.updatedAt = now.toISOString();
    bug.events.push({
      id: randomUUID(),
      bugId,
      type: 'bug.repair_enqueued',
      createdAt: bug.updatedAt,
    });
    if (dispatch.memberIds.length >= dispatch.config.maxBugs)
      this.queueDispatch(dispatch, now.toISOString());
    return {
      bug: this.bugSummary(bug),
      dispatch: this.dispatchSummary(dispatch),
    };
  }

  async returnBugToWaiting(bugId: string, _idempotencyKey: string) {
    this.closeExpiredDispatches();
    const bug = this.bugs.get(bugId);
    if (!bug) throw this.notFound('Bug 不存在');
    if (bug.status === 'waiting_for_repair')
      return { bug: this.bugSummary(bug), dispatch: null };
    if (bug.status !== 'repairing' || !bug.repairDispatchId)
      throw this.transitionInvalid('该 Bug 不能移回待修复');
    const dispatch = this.repairDispatches.get(bug.repairDispatchId)!;
    if (!['collecting', 'queued'].includes(dispatch.state))
      throw this.transitionInvalid('已被 Agent 领取的 Bug 不能直接移回');
    dispatch.memberIds = dispatch.memberIds.filter((id) => id !== bugId);
    bug.status = 'waiting_for_repair';
    bug.repairState = null;
    bug.repairDispatchId = null;
    bug.updatedAt = this.now().toISOString();
    bug.events.push({
      id: randomUUID(),
      bugId,
      type: 'bug.repair_returned',
      createdAt: bug.updatedAt,
    });
    if (dispatch.memberIds.length === 0) dispatch.state = 'cancelled';
    return {
      bug: this.bugSummary(bug),
      dispatch:
        dispatch.state === 'cancelled' ? null : this.dispatchSummary(dispatch),
    };
  }

  async closeRepairDispatch(dispatchId: string, _idempotencyKey: string) {
    this.closeExpiredDispatches();
    const dispatch = this.repairDispatches.get(dispatchId);
    if (!dispatch || dispatch.state === 'cancelled')
      throw this.notFound('修复收集不存在');
    if (dispatch.state === 'collecting')
      this.queueDispatch(dispatch, this.now().toISOString());
    return this.dispatchSummary(dispatch);
  }

  async listRepairDispatches(projectId: string) {
    if (!this.projects.has(projectId)) throw this.notFound('项目不存在');
    this.closeExpiredDispatches();
    return [...this.repairDispatches.values()]
      .filter(
        (dispatch) =>
          dispatch.projectId === projectId && dispatch.state !== 'cancelled',
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((dispatch) => this.dispatchSummary(dispatch));
  }

  async claimRepairDispatch(runnerId: string) {
    if (!this.runners.has(runnerId)) throw this.notFound('Agent 不存在');
    this.closeExpiredDispatches();
    const existing = [...this.repairDispatches.values()].find(
      (dispatch) =>
        dispatch.runnerId === runnerId && dispatch.state === 'claimed',
    );
    if (existing) return this.dispatchSummary(existing);
    const queued = [...this.repairDispatches.values()]
      .filter(
        (dispatch) =>
          dispatch.runnerId === runnerId && dispatch.state === 'queued',
      )
      .sort((left, right) =>
        (left.queuedAt ?? '').localeCompare(right.queuedAt ?? ''),
      )[0];
    if (!queued) return null;
    queued.state = 'claimed';
    queued.claimedAt = this.now().toISOString();
    return this.dispatchSummary(queued);
  }

  async acquireRepairDispatch(
    _runnerId: string,
  ): Promise<RepairDispatchClaim | null> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-004 执行接口');
  }

  async renewRepairDispatchLease(_input: {
    runnerId: string;
    dispatchId: string;
    leaseToken: string;
  }): Promise<string> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-004 执行接口');
  }

  async startRepairAttempt(_input: {
    runnerId: string;
    dispatchId: string;
    attemptId: string;
    leaseToken: string;
  }): Promise<{ attempt: RepairAttemptSummary; bug: BugSummary }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-004 执行接口');
  }

  async finishRepairAttempt(_input: {
    runnerId: string;
    dispatchId: string;
    attemptId: string;
    leaseToken: string;
    outcome: RepairAttemptOutcome;
  }): Promise<{
    attempt: RepairAttemptSummary;
    bug: BugSummary;
    dispatchCompleted: boolean;
    retryItem: Contract.RepairWorkItem | null;
  }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-004 执行接口');
  }

  async continueBugRepair(
    _input: { bugId: string; feedback: string; reassign?: boolean },
    _idempotencyKey: string,
  ): Promise<{ bug: BugSummary; dispatch: RepairDispatchSummary }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async cancelRepairAttempt(
    _bugId: string,
    _idempotencyKey: string,
  ): Promise<{ attempt: RepairAttemptSummary; bug: BugSummary }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async repairAttemptControl(_input: {
    attemptId: string;
    runnerId: string;
  }): Promise<boolean> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async enqueueBugForDeployment(
    _bugId: string,
    _idempotencyKey: string,
  ): Promise<{ bug: BugSummary; batch: Contract.DeploymentBatchSummary }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async closeDeploymentBatch(
    _batchId: string,
    _idempotencyKey: string,
  ): Promise<Contract.DeploymentBatchSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async listDeploymentBatches(
    _projectId: string,
  ): Promise<Contract.DeploymentBatchSummary[]> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async acquireDeploymentBatch(
    _runnerId: string,
  ): Promise<Contract.DeploymentWorkClaim | null> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async renewDeploymentLease(_input: {
    runnerId: string;
    batchId: string;
    leaseToken: string;
  }): Promise<string> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async startDeploymentAttempt(_input: {
    runnerId: string;
    batchId: string;
    attemptId: string;
    leaseToken: string;
  }): Promise<Contract.DeploymentBatchSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async finishDeploymentAttempt(_input: {
    runnerId: string;
    batchId: string;
    attemptId: string;
    leaseToken: string;
    outcome:
      | {
          kind: 'result';
          sessionId: string | null;
          result: Contract.DeploymentResult;
        }
      | {
          kind: 'execution_failure' | 'cancelled';
          sessionId: string | null;
          message: string;
        };
  }): Promise<Contract.DeploymentBatchSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async continueDeploymentBatch(
    _input: { batchId: string; feedback: string },
    _idempotencyKey: string,
  ): Promise<Contract.DeploymentBatchSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async cancelDeploymentBatch(
    _batchId: string,
    _idempotencyKey: string,
  ): Promise<Contract.DeploymentBatchSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async deploymentAttemptControl(_input: {
    batchId: string;
    runnerId: string;
  }): Promise<boolean> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async verifyBugPassed(
    _bugId: string,
    _idempotencyKey: string,
  ): Promise<BugSummary> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async verifyBugFailed(
    _input: {
      bugId: string;
      feedback: string;
      attachments: CreateBugCommand['attachments'];
    },
    _idempotencyKey: string,
  ): Promise<{ bug: BugSummary; dispatch: RepairDispatchSummary }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async listPromptTemplates(): Promise<Contract.PromptTemplateSummary[]> {
    return Contract.PROMPT_TEMPLATES.map((item) => ({
      ...item,
      variables: [...item.variables],
      outputSchema: JSON.parse(JSON.stringify(item.outputSchema)),
    }));
  }
  async listCleanupTargets(
    _runnerId: string,
  ): Promise<Contract.CleanupTarget[]> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async getCleanupTarget(_input: {
    runnerId: string;
    kind: 'bug' | 'deployment';
    id: string;
  }): Promise<{
    target: Contract.CleanupTarget;
    prompt: Contract.RepairPrompt;
  }> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }
  async finishCleanup(
    _input: {
      runnerId: string;
      kind: 'bug' | 'deployment';
      id: string;
      success: boolean;
      summary: string;
      sessionId: string | null;
    },
    _idempotencyKey: string,
  ): Promise<Contract.CleanupTarget> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现 BR-005+ 接口');
  }

  async collaborativeCommand(
    _input: Contract.CollaborativeCommand,
    _idempotencyKey?: string,
  ): Promise<Contract.CollaborativeCommandResult> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现协作提测接口');
  }

  async collaborativeQuery(
    _input: Contract.CollaborativeQuery,
  ): Promise<Contract.CollaborativeQueryResult> {
    throw new Error('InMemoryControlPlaneAdapter 尚未实现协作提测接口');
  }

  private projectSummary(project: MemoryProject): ProjectSummary {
    const runner = project.defaultRunnerId
      ? this.runners.get(project.defaultRunnerId)
      : undefined;
    const defaultRunner = runner ? this.runnerSummary(runner) : null;
    return {
      id: project.id,
      slug: project.slug,
      title: project.title,
      defaultRunner,
      executable: defaultRunner?.availability === 'online',
      memberRole: 'OWNER',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  private runnerSummary(runner: MemoryRunner): RunnerSummary {
    return {
      id: runner.id,
      name: runner.name,
      availability:
        this.now().getTime() - new Date(runner.lastSeenAt).getTime() <=
        this.offlineAfterMs
          ? 'online'
          : 'offline',
      lastSeenAt: runner.lastSeenAt,
    };
  }

  private bugDetail(bug: MemoryBug): BugDetail {
    return {
      ...bug,
      attachments: bug.attachments.map(
        ({ contentBase64: _contentBase64, ...attachment }) => attachment,
      ),
    };
  }

  private bugSummary(bug: MemoryBug): BugSummary {
    return {
      id: bug.id,
      shortId: bug.shortId,
      projectId: bug.projectId,
      status: bug.status,
      repairState: bug.repairState,
      repairDispatchId: bug.repairDispatchId,
      deploymentBatchId: bug.deploymentBatchId,
      deploymentState: bug.deploymentState,
      title: bug.title,
      createdAt: bug.createdAt,
      updatedAt: bug.updatedAt,
    };
  }

  private dispatchSummary(
    dispatch: MemoryRepairDispatch,
  ): RepairDispatchSummary {
    if (dispatch.state === 'cancelled')
      throw this.transitionInvalid('修复收集已取消');
    return {
      id: dispatch.id,
      projectId: dispatch.projectId,
      runnerId: dispatch.runnerId,
      state: dispatch.state,
      closesAt: dispatch.closesAt,
      config: { ...dispatch.config },
      members: dispatch.memberIds.map((id) =>
        this.bugSummary(this.bugs.get(id)!),
      ),
      createdAt: dispatch.createdAt,
      queuedAt: dispatch.queuedAt,
      claimedAt: dispatch.claimedAt,
    };
  }

  private closeExpiredDispatches() {
    const now = this.now();
    for (const dispatch of this.repairDispatches.values()) {
      if (
        dispatch.state === 'collecting' &&
        new Date(dispatch.closesAt).getTime() <= now.getTime()
      )
        this.queueDispatch(dispatch, now.toISOString());
    }
  }

  private queueDispatch(dispatch: MemoryRepairDispatch, now: string) {
    dispatch.state = 'queued';
    dispatch.queuedAt = now;
    for (const bugId of dispatch.memberIds) {
      const bug = this.bugs.get(bugId)!;
      bug.repairState = 'queued';
      bug.updatedAt = now;
    }
  }

  private notFound(message: string) {
    return new ControlPlaneClientError(
      createAppError({
        code: ERROR_CODES.entityNotFound,
        category: 'not_found',
        message,
        retryable: false,
      }),
    );
  }

  private conflict(message: string) {
    return new ControlPlaneClientError(
      createAppError({
        code: ERROR_CODES.projectSlugConflict,
        category: 'conflict',
        message,
        retryable: false,
      }),
    );
  }

  private transitionInvalid(message: string) {
    return new ControlPlaneClientError(
      createAppError({
        code: ERROR_CODES.bugTransitionInvalid,
        category: 'conflict',
        message,
        retryable: false,
      }),
    );
  }
}
