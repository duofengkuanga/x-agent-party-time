import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  CONTROL_PLANE_RESULT_SCHEMAS,
  CreateBugCommandSchema,
  EnqueueBugForRepairCommandSchema,
  ReturnBugToWaitingCommandSchema,
  CloseRepairDispatchCommandSchema,
  ListRepairDispatchesQuerySchema,
  ClaimRepairDispatchCommandSchema,
  AcquireRepairDispatchCommandSchema,
  RenewRepairDispatchLeaseCommandSchema,
  StartRepairAttemptCommandSchema,
  FinishRepairAttemptCommandSchema,
  ControlPlaneRequestEnvelopeSchema,
  ControlPlaneResponseEnvelopeSchema,
  ControlPlaneStatusQuerySchema,
  CreateProjectCommandSchema,
  ERROR_CODES,
  GetBugAttachmentQuerySchema,
  GetBugQuerySchema,
  GetProjectQuerySchema,
  HeartbeatRunnerCommandSchema,
  ListBugsQuerySchema,
  ListProjectsQuerySchema,
  RegisterRunnerCommandSchema,
  RenameProjectCommandSchema,
  SetProjectDefaultRunnerCommandSchema,
  createAppError,
  normalizeError,
  type AppError,
  type ControlPlaneOperation,
} from '@agent-party-time/shared';
import * as Contract from '@agent-party-time/shared';
import type { ControlPlaneStore } from './store.js';

export interface ControlPlaneServerOptions {
  host: string;
  port: number;
  store: ControlPlaneStore;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}

interface HandlerContext {
  idempotencyKey: string | null;
  actor: Contract.ControlPlaneActor;
  signal: AbortSignal;
}

type Handler = (payload: unknown, context: HandlerContext) => unknown;

export class ControlPlaneServer {
  private server: Server | null = null;
  private actualAddress: string | null = null;
  private readonly handlers = new Map<ControlPlaneOperation, Handler>();

  constructor(private readonly options: ControlPlaneServerOptions) {
    this.registerHandlers();
  }

  async start() {
    if (this.actualAddress) return this.actualAddress;
    if (!['127.0.0.1', '::1', 'localhost'].includes(this.options.host))
      throw createAppError({
        code: ERROR_CODES.configInvalid,
        category: 'permission',
        message: 'Control Plane V1 只允许绑定 loopback 地址',
        retryable: false,
      });
    this.server = createServer(
      (request, response) => void this.handle(request, response),
    );
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, this.options.host, resolve);
    });
    const address = this.server.address();
    const port =
      typeof address === 'object' && address ? address.port : this.options.port;
    this.actualAddress = `http://${this.options.host}:${port}`;
    return this.actualAddress;
  }

  address() {
    if (!this.actualAddress) throw new Error('Control Plane 尚未启动');
    return this.actualAddress;
  }

  async close() {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
    this.server = null;
    this.actualAddress = null;
  }

  private registerHandlers() {
    this.handlers.set('control.status', (payload) => {
      ControlPlaneStatusQuerySchema.parse(payload);
      return this.options.store.status();
    });
    this.handlers.set('project.create', (payload, context) => {
      if (!context.idempotencyKey)
        throw createAppError({
          code: ERROR_CODES.configInvalid,
          category: 'validation',
          message: 'project.create 必须提供 idempotencyKey',
          retryable: false,
        });
      return {
        project: this.options.store.createProject(
          CreateProjectCommandSchema.parse(payload),
          context.idempotencyKey,
          context.actor,
        ),
      };
    });
    this.handlers.set('project.list', (payload, context) => {
      ListProjectsQuerySchema.parse(payload);
      return { items: this.options.store.listProjects(context.actor) };
    });
    this.handlers.set('project.get', (payload, context) => ({
      project: this.options.store.getProject(
        GetProjectQuerySchema.parse(payload).project,
        context.actor,
      ),
    }));
    this.handlers.set('project.rename', (payload, context) => {
      const input = RenameProjectCommandSchema.parse(payload);
      return {
        project: this.options.store.renameProject(
          input.projectId,
          input.title,
          context.actor,
        ),
      };
    });
    this.handlers.set('project.collaboration.get', (payload, context) => {
      const input = Contract.GetProjectCollaborationQuerySchema.parse(payload);
      return this.options.store.getProjectCollaboration(
        input.projectId,
        context.actor,
      );
    });
    this.handlers.set('project.invitation.create', (payload, context) => ({
      invitation: this.options.store.createProjectInvitation(
        Contract.CreateProjectInvitationCommandSchema.parse(payload),
        this.requireIdempotencyKey(context, 'project.invitation.create'),
        context.actor,
      ),
    }));
    this.handlers.set('project.invitation.respond', (payload, context) => ({
      invitation: this.options.store.respondProjectInvitation(
        Contract.RespondProjectInvitationCommandSchema.parse(payload),
        this.requireIdempotencyKey(context, 'project.invitation.respond'),
        context.actor,
      ),
    }));
    this.handlers.set('project.invitation.revoke', (payload, context) => ({
      invitation: this.options.store.revokeProjectInvitation(
        Contract.RevokeProjectInvitationCommandSchema.parse(payload),
        this.requireIdempotencyKey(context, 'project.invitation.revoke'),
        context.actor,
      ),
    }));
    this.handlers.set('project.member.remove', (payload, context) => ({
      removed: this.options.store.removeProjectMember(
        Contract.RemoveProjectMemberCommandSchema.parse(payload),
        this.requireIdempotencyKey(context, 'project.member.remove'),
        context.actor,
      ),
    }));
    this.handlers.set(
      'project.invitation.list_received',
      (payload, context) => {
        Contract.ListReceivedProjectInvitationsQuerySchema.parse(payload);
        return {
          items: this.options.store.listReceivedProjectInvitations(
            context.actor,
          ),
        };
      },
    );
    this.handlers.set('engineering.create', (payload, context) => ({
      engineering: this.options.store.createEngineering(
        Contract.CreateEngineeringCommandSchema.parse(payload),
        this.requireIdempotencyKey(context, 'engineering.create'),
        context.actor,
      ),
    }));
    this.handlers.set('engineering.list', (payload, context) => {
      const input = Contract.ListEngineeringsQuerySchema.parse(payload);
      return {
        items: this.options.store.listEngineerings(
          input.projectId,
          input.includeArchived,
          context.actor,
        ),
      };
    });
    this.handlers.set('engineering.get', (payload, context) => ({
      engineering: this.options.store.getEngineering(
        Contract.GetEngineeringQuerySchema.parse(payload).engineeringId,
        context.actor,
      ),
    }));
    this.handlers.set('engineering.update', (payload, context) => ({
      engineering: this.options.store.updateEngineering(
        Contract.UpdateEngineeringCommandSchema.parse(payload),
        this.requireIdempotencyKey(context, 'engineering.update'),
        context.actor,
      ),
    }));
    this.handlers.set('engineering.archive', (payload, context) => {
      const input = Contract.SetEngineeringArchiveCommandSchema.parse(payload);
      return {
        engineering: this.options.store.setEngineeringArchived(
          input.engineeringId,
          input.archived,
          this.requireIdempotencyKey(context, 'engineering.archive'),
          context.actor,
        ),
      };
    });
    this.handlers.set('engineering.delete', (payload, context) => ({
      deleted: this.options.store.deleteEngineering(
        Contract.DeleteEngineeringCommandSchema.parse(payload).engineeringId,
        this.requireIdempotencyKey(context, 'engineering.delete'),
        context.actor,
      ),
    }));
    this.handlers.set('engineering.binding.ticket.create', (payload, context) =>
      this.options.store.createEngineeringBindingTicket(
        Contract.CreateEngineeringBindingTicketCommandSchema.parse(payload)
          .engineeringId,
        context.actor,
      ),
    );
    this.handlers.set('engineering.binding.claim', (payload) => ({
      binding: this.options.store.claimEngineeringBinding(
        Contract.ClaimEngineeringBindingCommandSchema.parse(payload),
      ),
    }));
    this.handlers.set('engineering.binding.list', (payload, context) => ({
      items: this.options.store.listEngineeringBindings(
        Contract.ListEngineeringBindingsQuerySchema.parse(payload)
          .engineeringId,
        context.actor,
      ),
    }));
    this.handlers.set('runner.register', (payload) => ({
      runner: this.options.store.registerRunner(
        RegisterRunnerCommandSchema.parse(payload),
      ),
    }));
    this.handlers.set('runner.heartbeat', (payload) => ({
      runner: this.options.store.heartbeatRunner(
        HeartbeatRunnerCommandSchema.parse(payload).runnerId,
      ),
    }));
    this.handlers.set('project.set_default_runner', (payload, context) => {
      const input = SetProjectDefaultRunnerCommandSchema.parse(payload);
      return {
        project: this.options.store.setProjectDefaultRunner(
          input.projectId,
          input.runnerId,
          context.actor,
        ),
      };
    });
    this.handlers.set('collaborative.command', (payload, context) =>
      this.options.store.collaborativeCommand(
        Contract.CollaborativeCommandSchema.parse(payload),
        context.actor,
      ),
    );
    this.handlers.set('collaborative.query', (payload, context) =>
      this.options.store.collaborativeQuery(
        Contract.CollaborativeQuerySchema.parse(payload),
        context.actor,
      ),
    );
    this.handlers.set('bug.create', async (payload, context) => {
      if (!context.idempotencyKey)
        throw createAppError({
          code: ERROR_CODES.configInvalid,
          category: 'validation',
          message: 'bug.create 必须提供 idempotencyKey',
          retryable: false,
        });
      return {
        bug: await this.options.store.createBug(
          CreateBugCommandSchema.parse(payload),
          context.idempotencyKey,
        ),
      };
    });
    this.handlers.set('bug.list', (payload) => ({
      items: this.options.store.listBugs(
        ListBugsQuerySchema.parse(payload).projectId,
      ),
    }));
    this.handlers.set('bug.get', (payload) => ({
      bug: this.options.store.getBug(GetBugQuerySchema.parse(payload).bugId),
    }));
    this.handlers.set('bug.attachment.get', async (payload) =>
      this.options.store.getBugAttachment(
        GetBugAttachmentQuerySchema.parse(payload).attachmentId,
      ),
    );
    this.handlers.set('bug.repair.enqueue', (payload, context) => {
      const idempotencyKey = this.requireIdempotencyKey(
        context,
        'bug.repair.enqueue',
      );
      const input = EnqueueBugForRepairCommandSchema.parse(payload);
      return this.options.store.enqueueBugForRepair(
        input.bugId,
        idempotencyKey,
      );
    });
    this.handlers.set('bug.repair.return', (payload, context) => {
      const idempotencyKey = this.requireIdempotencyKey(
        context,
        'bug.repair.return',
      );
      const input = ReturnBugToWaitingCommandSchema.parse(payload);
      return this.options.store.returnBugToWaiting(input.bugId, idempotencyKey);
    });
    this.handlers.set('repair_dispatch.close', (payload, context) => {
      const idempotencyKey = this.requireIdempotencyKey(
        context,
        'repair_dispatch.close',
      );
      const input = CloseRepairDispatchCommandSchema.parse(payload);
      return {
        dispatch: this.options.store.closeRepairDispatch(
          input.dispatchId,
          idempotencyKey,
        ),
      };
    });
    this.handlers.set('repair_dispatch.list', (payload) => ({
      items: this.options.store.listRepairDispatches(
        ListRepairDispatchesQuerySchema.parse(payload).projectId,
      ),
    }));
    this.handlers.set('repair_dispatch.claim', (payload) => ({
      dispatch: this.options.store.claimRepairDispatch(
        ClaimRepairDispatchCommandSchema.parse(payload).runnerId,
      ),
    }));
    this.handlers.set('repair_dispatch.acquire', (payload) => ({
      claim: this.options.store.acquireRepairDispatch(
        AcquireRepairDispatchCommandSchema.parse(payload).runnerId,
      ),
    }));
    this.handlers.set('repair_dispatch.renew', (payload) => ({
      leaseExpiresAt: this.options.store.renewRepairDispatchLease(
        RenewRepairDispatchLeaseCommandSchema.parse(payload),
      ),
    }));
    this.handlers.set('repair_attempt.start', (payload) =>
      this.options.store.startRepairAttempt(
        StartRepairAttemptCommandSchema.parse(payload),
      ),
    );
    this.handlers.set('repair_attempt.finish', (payload) =>
      this.options.store.finishRepairAttempt(
        FinishRepairAttemptCommandSchema.parse(payload),
      ),
    );
    this.handlers.set('bug.repair.continue', (payload, context) => {
      const input = Contract.ContinueBugRepairCommandSchema.parse(payload);
      return this.options.store.continueBugRepair(
        input,
        this.requireIdempotencyKey(context, 'bug.repair.continue'),
      );
    });
    this.handlers.set('repair_attempt.cancel', (payload, context) => {
      const input = Contract.CancelRepairAttemptCommandSchema.parse(payload);
      return this.options.store.cancelRepairAttempt(
        input.bugId,
        this.requireIdempotencyKey(context, 'repair_attempt.cancel'),
      );
    });
    this.handlers.set('repair_attempt.control', (payload) =>
      this.options.store.repairAttemptControl(
        Contract.RepairAttemptControlQuerySchema.parse(payload),
      ),
    );
    this.handlers.set('bug.deployment.enqueue', (payload, context) => {
      const input =
        Contract.EnqueueBugForDeploymentCommandSchema.parse(payload);
      return this.options.store.enqueueBugForDeployment(
        input.bugId,
        this.requireIdempotencyKey(context, 'bug.deployment.enqueue'),
      );
    });
    this.handlers.set('deployment_batch.close', (payload, context) => {
      const input = Contract.CloseDeploymentBatchCommandSchema.parse(payload);
      return {
        batch: this.options.store.closeDeploymentBatch(
          input.batchId,
          this.requireIdempotencyKey(context, 'deployment_batch.close'),
        ),
      };
    });
    this.handlers.set('deployment_batch.list', (payload) => ({
      items: this.options.store.listDeploymentBatches(
        Contract.ListDeploymentBatchesQuerySchema.parse(payload).projectId,
      ),
    }));
    this.handlers.set('deployment_batch.acquire', (payload) => ({
      claim: this.options.store.acquireDeploymentBatch(
        Contract.AcquireDeploymentBatchCommandSchema.parse(payload).runnerId,
      ),
    }));
    this.handlers.set('deployment_batch.renew', (payload) => ({
      leaseExpiresAt: this.options.store.renewDeploymentLease(
        Contract.RenewDeploymentLeaseCommandSchema.parse(payload),
      ),
    }));
    this.handlers.set('deployment_attempt.start', (payload) =>
      this.options.store.startDeploymentAttempt(
        Contract.StartDeploymentAttemptCommandSchema.parse(payload),
      ),
    );
    this.handlers.set('deployment_attempt.finish', (payload) =>
      this.options.store.finishDeploymentAttempt(
        Contract.FinishDeploymentAttemptCommandSchema.parse(payload),
      ),
    );
    this.handlers.set('deployment_batch.continue', (payload, context) => {
      const input =
        Contract.ContinueDeploymentBatchCommandSchema.parse(payload);
      return {
        batch: this.options.store.continueDeploymentBatch(
          input,
          this.requireIdempotencyKey(context, 'deployment_batch.continue'),
        ),
      };
    });
    this.handlers.set('deployment_batch.cancel', (payload, context) => {
      const input = Contract.CancelDeploymentBatchCommandSchema.parse(payload);
      return {
        batch: this.options.store.cancelDeploymentBatch(
          input.batchId,
          this.requireIdempotencyKey(context, 'deployment_batch.cancel'),
        ),
      };
    });
    this.handlers.set('deployment_attempt.control', (payload) =>
      this.options.store.deploymentAttemptControl(
        Contract.DeploymentAttemptControlQuerySchema.parse(payload),
      ),
    );
    this.handlers.set('bug.verify.pass', (payload, context) => {
      const input = Contract.VerifyBugPassedCommandSchema.parse(payload);
      return {
        bug: this.options.store.verifyBugPassed(
          input.bugId,
          this.requireIdempotencyKey(context, 'bug.verify.pass'),
        ),
      };
    });
    this.handlers.set('bug.verify.fail', (payload, context) =>
      this.options.store.verifyBugFailed(
        Contract.VerifyBugFailedCommandSchema.parse(payload),
        this.requireIdempotencyKey(context, 'bug.verify.fail'),
      ),
    );
    this.handlers.set('prompt_template.list', (payload) => {
      Contract.ListPromptTemplatesQuerySchema.parse(payload);
      return { items: this.options.store.listPromptTemplates() };
    });
    this.handlers.set('cleanup_target.list', (payload) => ({
      items: this.options.store.listCleanupTargets(
        Contract.ListCleanupTargetsQuerySchema.parse(payload).runnerId,
      ),
    }));
    this.handlers.set('cleanup_target.get', (payload) =>
      this.options.store.getCleanupTarget(
        Contract.GetCleanupTargetQuerySchema.parse(payload),
      ),
    );
    this.handlers.set('cleanup.finish', (payload, context) => ({
      target: this.options.store.finishCleanup(
        Contract.FinishCleanupCommandSchema.parse(payload),
        this.requireIdempotencyKey(context, 'cleanup.finish'),
      ),
    }));
  }

  private requireIdempotencyKey(context: HandlerContext, operation: string) {
    if (context.idempotencyKey) return context.idempotencyKey;
    throw createAppError({
      code: ERROR_CODES.configInvalid,
      category: 'validation',
      message: `${operation} 必须提供 idempotencyKey`,
      retryable: false,
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== 'POST' || request.url !== '/api')
      return this.writeJson(response, 404, {
        ok: false,
        requestId: 'not-found',
        error: createAppError({
          code: ERROR_CODES.entityNotFound,
          category: 'not_found',
          message: 'Control Plane endpoint 不存在',
          retryable: false,
        }),
      });

    let requestId = 'invalid-request';
    try {
      if (!request.headers['content-type']?.includes('application/json'))
        throw createAppError({
          code: ERROR_CODES.configInvalid,
          category: 'validation',
          message: '请求必须使用 application/json',
          retryable: false,
        });
      const raw = await this.readBody(request);
      const envelope = ControlPlaneRequestEnvelopeSchema.parse(JSON.parse(raw));
      requestId = envelope.requestId;
      const operation = envelope.operation as ControlPlaneOperation;
      const handler = this.handlers.get(operation);
      if (!handler)
        throw createAppError({
          code: ERROR_CODES.entityNotFound,
          category: 'not_found',
          message: `未知 operation ${envelope.operation}`,
          retryable: false,
        });
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.options.requestTimeoutMs ?? 30_000,
      );
      try {
        const data = await handler(envelope.payload, {
          idempotencyKey: envelope.idempotencyKey ?? null,
          actor: envelope.actor ?? { kind: 'system' },
          signal: controller.signal,
        });
        const parsed = CONTROL_PLANE_RESULT_SCHEMAS[operation].parse(data);
        return this.writeJson(
          response,
          200,
          ControlPlaneResponseEnvelopeSchema.parse({
            ok: true,
            requestId,
            data: parsed,
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const appError = normalizeError(error);
      return this.writeJson(
        response,
        this.statusCode(appError),
        ControlPlaneResponseEnvelopeSchema.parse({
          ok: false,
          requestId,
          error: appError,
        }),
      );
    }
  }

  private async readBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const value = Buffer.from(chunk);
      length += value.length;
      if (length > (this.options.maxBodyBytes ?? 80_000_000))
        throw createAppError({
          code: ERROR_CODES.configInvalid,
          category: 'validation',
          message: '请求体过大',
          retryable: false,
        });
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private writeJson(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value));
  }

  private statusCode(error: AppError) {
    return {
      validation: 400,
      authentication: 401,
      permission: 403,
      not_found: 404,
      conflict: 409,
      timeout: 504,
      cancelled: 409,
      transport: 502,
      runner: 502,
      invariant: 500,
      internal: 500,
    }[error.category];
  }
}
