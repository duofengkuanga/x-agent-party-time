import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  API_VERSION,
  ApiRequestEnvelopeSchema,
  ApiResponseEnvelopeSchema,
  SERVICE_RESULT_SCHEMAS,
  ListAgentsQuerySchema,
  GetAgentQuerySchema,
  ListChannelsQuerySchema,
  GetChannelQuerySchema,
  ListRunsQuerySchema,
  ShowRunQuerySchema,
  CancelRunCommandSchema,
  RetryRunCommandSchema,
  ListSessionsQuerySchema,
  ShowSessionQuerySchema,
  InvalidateSessionCommandSchema,
  ListTasksQuerySchema,
  GetTaskQuerySchema,
  LogsQuerySchema,
  ShutdownServiceCommandSchema,
  BindEngineeringCommandSchema,
  BindProjectCommandSchema,
  ListEngineeringBindingsLocalQuerySchema,
  ListProjectBindingsQuerySchema,
  createAppError,
  ERROR_CODES,
  normalizeError,
  type ApiRequestEnvelope,
  type AppError,
  type ServiceHeartbeat,
  type StateStore,
} from '@agent-party-time/shared';
import type { ChannelManager } from '../channels/channel-manager.js';
import type { ConfigService } from '../config/config-service.js';
import type { EventJournal } from '../events/event-journal.js';
import type { Logger, LogQueryService } from '../logging/logger.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { TaskService } from '../tasks/task-service.js';
import type { TeamCoordinator } from '../teams/team-coordinator.js';
import type { ProjectBindingService } from '../control-plane/project-binding-service.js';
import type { EngineeringBindingService } from '../control-plane/engineering-binding-service.js';

export interface ServiceStatusProvider {
  status():
    | Promise<{ instance: ServiceHeartbeat; configRevision: number }>
    | { instance: ServiceHeartbeat; configRevision: number };
  shutdown(reason: string): void;
}
export interface LocalApiServerOptions {
  host: string;
  port: number;
  capability: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  services: {
    config: ConfigService;
    channels: ChannelManager;
    scheduler: Scheduler;
    sessions: SessionManager;
    tasks: TaskService;
    teams: TeamCoordinator;
    logs: LogQueryService;
    events: EventJournal;
    state: StateStore;
    status: ServiceStatusProvider;
    projectBindings: ProjectBindingService;
    engineeringBindings: EngineeringBindingService;
  };
  logger: Logger;
}
interface HandlerContext {
  requestId: string;
  idempotencyKey: string | null;
  signal: AbortSignal;
}
type Handler = (payload: unknown, context: HandlerContext) => Promise<unknown>;

export class LocalApiServer {
  private server: Server | null = null;
  private actualAddress: string | null = null;
  private accepting = true;
  private readonly handlers = new Map<string, Handler>();
  constructor(private readonly options: LocalApiServerOptions) {
    this.registerHandlers();
  }
  async start(): Promise<string> {
    if (this.actualAddress) return this.actualAddress;
    if (!['127.0.0.1', '::1', 'localhost'].includes(this.options.host))
      throw createAppError({
        code: ERROR_CODES.configInvalid,
        category: 'permission',
        message: '本地 API 只允许绑定 loopback 地址',
        retryable: false,
      });
    this.accepting = true;
    this.server = createServer(
      (request, response) => void this.handle(request, response),
    );
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, this.options.host, () =>
        resolve(),
      );
    });
    const address = this.server.address();
    const port =
      typeof address === 'object' && address ? address.port : this.options.port;
    this.actualAddress = `http://${this.options.host}:${port}`;
    return this.actualAddress;
  }
  address(): string {
    if (!this.actualAddress) throw new Error('API server not started');
    return this.actualAddress;
  }
  stopAccepting(): void {
    this.accepting = false;
  }
  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
    this.server = null;
    this.actualAddress = null;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.accepting)
      return this.writeJson(response, 503, {
        ok: false,
        requestId: 'unavailable',
        error: createAppError({
          code: ERROR_CODES.internalUnexpected,
          category: 'internal',
          message: '服务正在关闭',
          retryable: true,
        }),
      });
    if (!this.authenticate(request))
      return this.writeJson(response, 401, {
        ok: false,
        requestId: 'unauthorized',
        error: createAppError({
          code: ERROR_CODES.capabilityInvalid,
          category: 'authentication',
          message: '本地 capability 无效',
          retryable: false,
        }),
      });
    if (request.method === 'GET' && request.url?.startsWith('/events'))
      return this.streamEvents(request, response);
    if (request.method !== 'POST' || request.url !== '/api')
      return this.writeJson(response, 404, {
        ok: false,
        requestId: 'not-found',
        error: createAppError({
          code: ERROR_CODES.entityNotFound,
          category: 'not_found',
          message: 'API endpoint 不存在',
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
      const envelope = ApiRequestEnvelopeSchema.parse(
        JSON.parse(raw),
      ) as ApiRequestEnvelope;
      requestId = envelope.requestId;
      if (
        [
          'agent.add',
          'channel.add',
          'run.retry',
          'task.create',
          'task.create_from_message',
          'project.bind',
        ].includes(envelope.operation) &&
        !envelope.idempotencyKey
      )
        throw createAppError({
          code: ERROR_CODES.configInvalid,
          category: 'validation',
          message: `${envelope.operation} 必须提供 idempotencyKey`,
          retryable: false,
        });
      const handler = this.handlers.get(envelope.operation);
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
          requestId,
          idempotencyKey: envelope.idempotencyKey ?? null,
          signal: controller.signal,
        });
        const schema =
          SERVICE_RESULT_SCHEMAS[
            envelope.operation as keyof typeof SERVICE_RESULT_SCHEMAS
          ];
        const parsed = schema.parse(data);
        return this.writeJson(
          response,
          200,
          ApiResponseEnvelopeSchema.parse({
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
      this.options.logger.error(
        'api.request_failed',
        'API 请求失败',
        appError,
        { requestId },
      );
      return this.writeJson(
        response,
        this.statusCode(appError),
        ApiResponseEnvelopeSchema.parse({
          ok: false,
          requestId,
          error: appError,
        }),
      );
    }
  }
  private registerHandlers(): void {
    const add = (operation: string, handler: Handler) =>
      this.handlers.set(operation, handler);
    add('service.status', async () => {
      const value = await this.options.services.status.status();
      const channels = this.options.services.channels.health();
      const scheduler = this.options.services.scheduler.summary();
      const outbox = await this.options.services.state.outbox.countByState();
      return {
        instance: value.instance,
        apiAddress: this.address(),
        configRevision: value.configRevision,
        channels: {
          connected: channels.connected,
          degraded: channels.degraded,
          disconnected: channels.disconnected + channels.connecting,
        },
        scheduler: { queued: scheduler.queued, active: scheduler.activeRuns },
        outbox: {
          pending: outbox.pending + outbox.retry_wait,
          failed: outbox.failed,
        },
      };
    });
    add('service.shutdown', async (payload) => {
      const input = ShutdownServiceCommandSchema.parse(payload);
      setTimeout(() => this.options.services.status.shutdown(input.reason), 25);
      return { accepted: true };
    });
    add('agent.list', async (payload) => {
      const input = ListAgentsQuerySchema.parse(payload);
      return this.options.services.config.listAgents(input, input);
    });
    add('agent.get', async (payload) =>
      this.options.services.config.getAgent(
        GetAgentQuerySchema.parse(payload).id,
      ),
    );
    for (const operation of [
      'agent.add',
      'agent.update',
      'agent.enable',
      'agent.disable',
    ] as const)
      add(operation, async (payload) => {
        const method =
          operation === 'agent.add'
            ? 'addAgent'
            : operation === 'agent.update'
              ? 'updateAgent'
              : operation === 'agent.enable'
                ? 'enableAgent'
                : 'disableAgent';
        const result = await this.options.services.config[method](payload);
        return { agent: result.value, configRevision: result.configRevision };
      });
    add('channel.list', async (payload) => {
      const input = ListChannelsQuerySchema.parse(payload);
      const result = await this.options.services.config.listChannels(
        input,
        input,
      );
      return {
        items: result.items.map((subscription) => ({
          subscription: this.channelSummary(subscription),
          health: this.options.services.channels.getHealth(subscription.id),
        })),
        nextCursor: result.nextCursor,
        configRevision: result.configRevision,
      };
    });
    add('channel.get', async (payload) => {
      const input = GetChannelQuerySchema.parse(payload);
      const result = await this.options.services.config.getChannel(input.id);
      return {
        subscription: this.channelSummary(result.subscription),
        cursor: await this.options.services.state.cursors.get(
          result.subscription.id,
        ),
        health: this.options.services.channels.getHealth(
          result.subscription.id,
        ),
        configRevision: result.configRevision,
      };
    });
    for (const operation of [
      'channel.add',
      'channel.update',
      'channel.enable',
      'channel.disable',
    ] as const)
      add(operation, async (payload) => {
        const method =
          operation === 'channel.add'
            ? 'addChannel'
            : operation === 'channel.update'
              ? 'updateChannel'
              : operation === 'channel.enable'
                ? 'enableChannel'
                : 'disableChannel';
        const result = await this.options.services.config[method](payload);
        await this.options.services.channels.applyConfig(
          await this.options.services.config.getConfig(),
        );
        return {
          subscription: this.channelSummary(result.value),
          configRevision: result.configRevision,
        };
      });
    add('channel.remove', async (payload) => {
      const result = await this.options.services.config.removeChannel(payload);
      await this.options.services.channels.applyConfig(
        await this.options.services.config.getConfig(),
      );
      return result;
    });
    add('run.list', async (payload) => {
      const input = ListRunsQuerySchema.parse(payload);
      return this.options.services.state.runs.list(input, input);
    });
    add('run.show', async (payload) => {
      const input = ShowRunQuerySchema.parse(payload);
      const run = await this.options.services.state.runs.get(input.runId);
      if (!run) throw this.notFound('run');
      const job = await this.options.services.state.jobs.get(run.jobId);
      if (!job) throw this.notFound('job');
      return {
        run,
        job,
        session: await this.options.services.state.sessions.get(job.sessionKey),
        outbox: await this.options.services.state.outbox.listByRun(run.id),
      };
    });
    add('run.cancel', async (payload) =>
      this.options.services.scheduler.cancel(
        CancelRunCommandSchema.parse(payload),
      ),
    );
    add('run.retry', async (payload) =>
      this.options.services.scheduler.retry(
        RetryRunCommandSchema.parse(payload).jobId,
      ),
    );
    add('session.list', async (payload) => {
      const input = ListSessionsQuerySchema.parse(payload);
      return this.options.services.sessions.list(input, input);
    });
    add('session.show', async (payload) => {
      const input = ShowSessionQuerySchema.parse(payload);
      const session = await this.options.services.sessions.get(
        input.sessionKey,
      );
      if (!session || session.generation !== input.generation)
        throw this.notFound('session');
      return { session };
    });
    add('session.invalidate', async (payload) => {
      const input = InvalidateSessionCommandSchema.parse(payload);
      return {
        session: await this.options.services.sessions.invalidate(
          input.sessionKey,
          input.generation,
          input.expectedRevision,
          input.reason,
        ),
      };
    });
    add('task.list', async (payload) => {
      const input = ListTasksQuerySchema.parse(payload);
      return this.options.services.tasks.list(input, input);
    });
    add('task.get', async (payload) => ({
      task: await this.options.services.tasks.get(
        GetTaskQuerySchema.parse(payload).taskId,
      ),
    }));
    add('task.create', async (payload) => ({
      task: await this.options.services.tasks.create(payload as never),
    }));
    add('task.create_from_message', async (payload) => ({
      task: await this.options.services.tasks.createFromMessage(
        payload as never,
      ),
    }));
    add('task.assign', async (payload) => ({
      task: await this.options.services.tasks.assign(payload as never),
    }));
    add('task.claim', async (payload) => ({
      task: await this.options.services.tasks.claim(payload as never),
    }));
    add('task.change_state', async (payload) => ({
      task: await this.options.services.tasks.changeState(payload as never),
    }));
    add('task.submit_completion', async (payload) => ({
      task: await this.options.services.tasks.submitCompletion(
        payload as never,
      ),
    }));
    add('task.review_completion', async (payload) => ({
      task: await this.options.services.tasks.reviewCompletion(
        payload as never,
      ),
    }));
    add('logs.query', async (payload) =>
      this.options.services.logs.query(LogsQuerySchema.parse(payload)),
    );
    add('project.binding.list', async (payload) => {
      ListProjectBindingsQuerySchema.parse(payload);
      return this.options.services.projectBindings.list();
    });
    add('project.bind', async (payload) =>
      this.options.services.projectBindings.bind(
        BindProjectCommandSchema.parse(payload),
      ),
    );
    add('engineering.binding.list', async (payload) => {
      ListEngineeringBindingsLocalQuerySchema.parse(payload);
      return this.options.services.engineeringBindings.list();
    });
    add('engineering.bind', async (payload) =>
      this.options.services.engineeringBindings.bind(
        BindEngineeringCommandSchema.parse(payload),
      ),
    );
  }
  private async streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const url = new URL(request.url!, this.actualAddress ?? 'http://localhost');
    const controller = new AbortController();
    request.once('close', () => controller.abort());
    await this.options.services.events
      .subscribe(
        url.searchParams.get('cursor'),
        (item) => {
          response.write(
            `id: ${item.cursor}\ndata: ${JSON.stringify({ cursor: item.cursor, event: item.event })}\n\n`,
          );
        },
        controller.signal,
      )
      .catch((error) =>
        this.options.logger.error(
          'api.event_stream_failed',
          '事件流失败',
          error,
        ),
      );
    response.end();
  }
  private authenticate(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.options.capability);
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  }
  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const value = Buffer.from(chunk);
      length += value.length;
      if (length > (this.options.maxBodyBytes ?? 1_000_000))
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
  private channelSummary(
    subscription: { tokenRef?: string } & Record<string, unknown>,
  ) {
    const { tokenRef, ...safe } = subscription;
    return {
      ...safe,
      tokenRefSummary: tokenRef
        ? tokenRef.startsWith('env:')
          ? tokenRef
          : `${tokenRef.split(':')[0]}:[hidden]`
        : null,
    };
  }
  private notFound(entity: string) {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message: `${entity} 不存在`,
      retryable: false,
    });
  }
}
