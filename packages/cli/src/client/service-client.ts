import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  API_VERSION,
  ApiRequestEnvelopeSchema,
  ApiResponseEnvelopeSchema,
  DEFAULTS,
  ENV_NAMES,
  ERROR_CODES,
  LOCAL_PATHS,
  LogsQuerySchema,
  ServiceEventStreamItemSchema,
  ServiceLogStreamItemSchema,
  createAppError,
  type AppError,
  type LogsQuery,
  type ServiceEventStreamItem,
  type ServiceLogStreamItem,
} from '@agent-party-time/shared';

export interface ServiceClientOptions {
  serverUrl?: string;
  homeDirectory?: string;
  capabilityFile?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  env?: Readonly<Record<string, string | undefined>>;
}
export const ServiceDiscoveryResultSchema = z.object({
  serverUrl: z.string().url(),
  capability: z.string().min(1),
  source: z.enum(['explicit', 'environment', 'discovery', 'default']),
});
export type ServiceDiscoveryResult = z.infer<
  typeof ServiceDiscoveryResultSchema
>;
export class ServiceClientError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message);
    this.name = 'ServiceClientError';
  }
}

export class ServiceClient {
  private discovery: ServiceDiscoveryResult | null = null;
  private closed = false;
  constructor(private readonly options: ServiceClientOptions = {}) {}
  async discover(): Promise<ServiceDiscoveryResult> {
    if (this.discovery) return this.discovery;
    const env = this.options.env ?? process.env;
    const home = resolve(
      this.options.homeDirectory ??
        env[ENV_NAMES.home] ??
        resolve(homedir(), LOCAL_PATHS.homeDirName),
    );
    const capabilityPath = resolve(
      this.options.capabilityFile ??
        env[ENV_NAMES.capabilityFile] ??
        resolve(home, LOCAL_PATHS.serviceCapabilityFile),
    );
    let capability: string;
    try {
      capability = (await readFile(capabilityPath, 'utf8')).trim();
    } catch {
      throw new ServiceClientError(
        createAppError({
          code: ERROR_CODES.capabilityInvalid,
          category: 'authentication',
          message: '找不到本地 service capability；服务可能未启动',
          retryable: false,
        }),
      );
    }
    const explicit = this.options.serverUrl;
    const environment = env[ENV_NAMES.serverUrl];
    this.discovery = ServiceDiscoveryResultSchema.parse({
      serverUrl:
        explicit ??
        environment ??
        `http://${DEFAULTS.localApiHost}:${DEFAULTS.localApiPort}`,
      capability,
      source: explicit ? 'explicit' : environment ? 'environment' : 'default',
    });
    return this.discovery;
  }
  async request<TInput, TOutput>(
    operation: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    input: TInput,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<TOutput> {
    if (this.closed) throw new Error('client closed');
    const parsedInput = inputSchema.parse(input);
    const payload = JSON.parse(JSON.stringify(parsedInput)) as unknown;
    const discovery = await this.discover();
    const requestId = randomUUID();
    const envelope = ApiRequestEnvelopeSchema.parse({
      apiVersion: API_VERSION,
      requestId,
      operation,
      ...(options?.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      payload,
    });
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(
        `${discovery.serverUrl}/api`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${discovery.capability}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(envelope),
          signal,
        },
      );
    } catch {
      const timedOut = timeout.aborted && !options?.signal?.aborted;
      throw new ServiceClientError(
        createAppError({
          code: timedOut
            ? ERROR_CODES.runnerTimedOut
            : ERROR_CODES.channelDisconnected,
          category: timedOut
            ? 'timeout'
            : options?.signal?.aborted
              ? 'cancelled'
              : 'transport',
          message: timedOut ? '本地 service 请求超时' : '无法连接本地 service',
          retryable: !options?.signal?.aborted,
        }),
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw this.invalidResponse();
    let parsed: z.infer<typeof ApiResponseEnvelopeSchema>;
    try {
      parsed = ApiResponseEnvelopeSchema.parse(await response.json());
    } catch {
      throw this.invalidResponse();
    }
    if (parsed.requestId !== requestId) throw this.invalidResponse();
    if (!parsed.ok) throw new ServiceClientError(parsed.error);
    return outputSchema.parse(parsed.data);
  }
  query<TInput, TOutput>(
    operation: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    input: TInput,
    options?: { signal?: AbortSignal },
  ) {
    return this.request(operation, inputSchema, outputSchema, input, options);
  }
  async health(): Promise<boolean> {
    try {
      const result = await this.discover();
      const response = await (this.options.fetch ?? globalThis.fetch)(
        `${result.serverUrl}/api`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${result.capability}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            apiVersion: API_VERSION,
            requestId: randomUUID(),
            operation: 'service.status',
            payload: {},
          }),
          signal: AbortSignal.timeout(
            Math.min(this.options.timeoutMs ?? 30_000, 1_000),
          ),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
  async waitUntilUnavailable(timeoutMs = this.options.timeoutMs ?? 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.health())) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new ServiceClientError(
      createAppError({
        code: ERROR_CODES.runnerTimedOut,
        category: 'timeout',
        message: '等待本地 service 停止超时',
        retryable: true,
      }),
    );
  }
  async subscribeEvents(
    cursor: string | null,
    onItem: (item: ServiceEventStreamItem) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const discovery = await this.discover();
    const url = new URL('/events', discovery.serverUrl);
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await (this.options.fetch ?? globalThis.fetch)(url, {
      headers: { authorization: `Bearer ${discovery.capability}` },
      signal,
    });
    if (!response.ok || !response.body)
      throw new ServiceClientError(
        createAppError({
          code: ERROR_CODES.channelDisconnected,
          category: 'transport',
          message: '无法订阅事件流',
          retryable: true,
        }),
      );
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = '';
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6);
        if (data)
          await onItem(ServiceEventStreamItemSchema.parse(JSON.parse(data)));
      }
    }
  }
  async subscribeLogs(
    cursor: string | null,
    raw: LogsQuery,
    onItem: (item: ServiceLogStreamItem) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let current = cursor;
    const input = LogsQuerySchema.parse(raw);
    while (!signal.aborted) {
      const result = await this.query(
        'logs.query',
        LogsQuerySchema,
        z.object({
          items: z.array(ServiceLogStreamItemSchema.shape.record),
          nextCursor: z.string().nullable(),
        }),
        { ...input, cursor: current ?? undefined },
        { signal },
      );
      for (const record of result.items) {
        current = result.nextCursor;
        await onItem(
          ServiceLogStreamItemSchema.parse({
            cursor: current ?? randomUUID(),
            record,
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  close(): void {
    this.closed = true;
  }
  private invalidResponse() {
    return new ServiceClientError(
      createAppError({
        code: ERROR_CODES.internalUnexpected,
        category: 'internal',
        message: '本地 service 返回了无效响应',
        retryable: false,
      }),
    );
  }
}
