import {
  CompleteExecutionRequestSchema,
  ExecutionClaimRequestSchema,
  ExecutionClaimResponseSchema,
  ExecutionMutationResponseSchema,
  ExecutionRenewRequestSchema,
  ExecutionRenewResponseSchema,
  ExecutionStartRequestSchema,
  OpenInteractionRequestSchema,
  OpenInteractionResponseSchema,
  WaitInteractionRequestSchema,
  WaitInteractionResponseSchema,
  type ClaimedExecution,
  type CompleteExecutionRequest,
  type Execution,
  type ExecutionInteraction,
  type ExecutionRenewResponse,
  type ExecutionStartRequest,
  type OpenInteractionRequest,
  type WaitInteractionResponse,
} from '@agent-party-time/execution-contract';
import {
  RunnerAuthorizationClaimResponseSchema,
  RunnerAuthorizationCreateRequestSchema,
  RunnerAuthorizationIssueSchema,
  RunnerBindingsResponseSchema,
  RunnerBindingWorkCompletionResponseSchema,
  RunnerBindingWorkCompletionSchema,
  RunnerBindingWorkResponseSchema,
  RunnerHeartbeatRequestSchema,
  RunnerHeartbeatResponseSchema,
  type Runner,
  type RunnerAuthorizationClaimResponse,
  type RunnerAuthorizationCreateRequest,
  type RunnerAuthorizationIssue,
  type RunnerBindingRef,
  type RunnerBindingWork,
  type RunnerBindingWorkCompletion,
} from '@agent-party-time/runner-contract';
import { z } from 'zod';

const BugsDeleteRequestSchema = z
  .object({
    bugIds: z.array(z.uuid()).min(1).optional(),
    all: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine((value) => (value.all ? !value.bugIds : value.bugIds !== undefined), {
    message: '必须指定 bugIds 或 all 之一',
  });

const BugsDeleteResponseSchema = z.object({
  deletedBugIds: z.array(z.uuid()),
  deletedExecutionIds: z.array(z.uuid()),
});

export type RunnerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type RunnerAuthorizationHttp = Pick<
  RunnerHttpClient,
  'createAuthorization' | 'claimAuthorization' | 'heartbeat' | 'revokeSelf'
>;

export type RunnerBindingHttp = Pick<
  RunnerHttpClient,
  'listBindings' | 'claimBindingWork' | 'completeBindingWork'
>;

export type RunnerExecutionHttp = Pick<
  RunnerHttpClient,
  | 'claimExecutions'
  | 'startExecution'
  | 'renewExecution'
  | 'completeExecution'
  | 'openInteraction'
  | 'waitInteraction'
  | 'deleteBugs'
  | 'downloadExecutionFile'
>;

export class RunnerHttpClient {
  constructor(
    private readonly fetchImplementation: RunnerFetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async createAuthorization(
    serverOrigin: string,
    input: RunnerAuthorizationCreateRequest,
  ): Promise<RunnerAuthorizationIssue> {
    const body = RunnerAuthorizationCreateRequestSchema.parse(input);
    return RunnerAuthorizationIssueSchema.parse(
      await requestJson(
        this.fetchImplementation,
        `${serverOrigin}/api/runner/authorizations`,
        { method: 'POST', body: JSON.stringify(body) },
        this.timeoutMs,
      ),
    );
  }

  async claimAuthorization(
    serverOrigin: string,
    requestId: string,
    verifier: string,
  ): Promise<RunnerAuthorizationClaimResponse> {
    return RunnerAuthorizationClaimResponseSchema.parse(
      await requestJson(
        this.fetchImplementation,
        `${serverOrigin}/api/runner/authorizations/${encodeURIComponent(requestId)}/claim`,
        { method: 'POST', body: JSON.stringify({ verifier }) },
        this.timeoutMs,
      ),
    );
  }

  async heartbeat(
    serverOrigin: string,
    credential: string,
    availableSlots: number,
  ): Promise<Runner> {
    const body = RunnerHeartbeatRequestSchema.parse({ availableSlots });
    return RunnerHeartbeatResponseSchema.parse(
      await requestJson(
        this.fetchImplementation,
        `${serverOrigin}/api/runner/heartbeat`,
        {
          headers: { authorization: `Bearer ${credential}` },
          method: 'POST',
          body: JSON.stringify(body),
        },
        this.timeoutMs,
      ),
    ).runner;
  }

  async revokeSelf(serverOrigin: string, credential: string): Promise<Runner> {
    return RunnerHeartbeatResponseSchema.parse(
      await requestJson(
        this.fetchImplementation,
        `${serverOrigin}/api/runner`,
        {
          headers: { authorization: `Bearer ${credential}` },
          method: 'DELETE',
        },
        this.timeoutMs,
      ),
    ).runner;
  }

  async listBindings(
    serverOrigin: string,
    credential: string,
  ): Promise<RunnerBindingRef[]> {
    return (
      await this.authorizedJson(
        serverOrigin,
        credential,
        '/api/runner/bindings',
        RunnerBindingsResponseSchema,
        undefined,
        'GET',
      )
    ).bindings;
  }

  async claimBindingWork(
    serverOrigin: string,
    credential: string,
  ): Promise<RunnerBindingWork | null> {
    return (
      await this.authorizedJson(
        serverOrigin,
        credential,
        '/api/runner/binding-requests',
        RunnerBindingWorkResponseSchema,
        undefined,
      )
    ).request;
  }

  async completeBindingWork(
    serverOrigin: string,
    credential: string,
    requestId: string,
    completionInput: RunnerBindingWorkCompletion,
  ): Promise<'SUCCEEDED' | 'FAILED'> {
    const completion = RunnerBindingWorkCompletionSchema.parse(completionInput);
    return (
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/binding-requests/${encodeURIComponent(requestId)}`,
        RunnerBindingWorkCompletionResponseSchema,
        completion,
      )
    ).state;
  }

  async claimExecutions(
    serverOrigin: string,
    credential: string,
    availableSlots: number,
    waitMs = 0,
  ): Promise<ClaimedExecution[]> {
    const body = ExecutionClaimRequestSchema.parse({ availableSlots, waitMs });
    return (
      await this.authorizedJson(
        serverOrigin,
        credential,
        '/api/runner/executions/claim',
        ExecutionClaimResponseSchema,
        body,
      )
    ).executions;
  }

  async startExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    requestInput: ExecutionStartRequest,
  ): Promise<Execution> {
    const body = ExecutionStartRequestSchema.parse(requestInput);
    return (
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/executions/${encodeURIComponent(executionId)}/start`,
        ExecutionMutationResponseSchema,
        body,
      )
    ).execution;
  }

  async renewExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    leaseToken: string,
  ): Promise<ExecutionRenewResponse> {
    const body = ExecutionRenewRequestSchema.parse({ leaseToken });
    return await this.authorizedJson(
      serverOrigin,
      credential,
      `/api/runner/executions/${encodeURIComponent(executionId)}/renew`,
      ExecutionRenewResponseSchema,
      body,
    );
  }

  async completeExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    requestInput: CompleteExecutionRequest,
  ): Promise<Execution> {
    const body = CompleteExecutionRequestSchema.parse(requestInput);
    return (
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/executions/${encodeURIComponent(executionId)}/complete`,
        ExecutionMutationResponseSchema,
        body,
      )
    ).execution;
  }

  async openInteraction(
    serverOrigin: string,
    credential: string,
    executionId: string,
    requestInput: OpenInteractionRequest,
  ): Promise<ExecutionInteraction> {
    const body = OpenInteractionRequestSchema.parse(requestInput);
    return (
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/executions/${encodeURIComponent(executionId)}/interactions/open`,
        OpenInteractionResponseSchema,
        body,
      )
    ).interaction;
  }

  async waitInteraction(
    serverOrigin: string,
    credential: string,
    executionId: string,
    interactionId: string,
    leaseToken: string,
    waitMs = 5_000,
  ): Promise<WaitInteractionResponse> {
    const body = WaitInteractionRequestSchema.parse({
      executionId,
      leaseToken,
      waitMs,
    });
    return await this.authorizedJson(
      serverOrigin,
      credential,
      `/api/runner/interactions/${encodeURIComponent(interactionId)}/wait`,
      WaitInteractionResponseSchema,
      body,
    );
  }

  async deleteBugs(
    serverOrigin: string,
    credential: string,
    input: { bugIds?: readonly string[]; all?: boolean; force?: boolean },
  ): Promise<{ deletedBugIds: string[]; deletedExecutionIds: string[] }> {
    const body = BugsDeleteRequestSchema.parse(input);
    return await this.authorizedJson(
      serverOrigin,
      credential,
      '/api/cooking/bugs/delete',
      BugsDeleteResponseSchema,
      body,
    );
  }

  async downloadExecutionFile(
    serverOrigin: string,
    credential: string,
    executionId: string,
    fileId: string,
    leaseToken: string,
  ): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${serverOrigin}/api/runner/executions/${encodeURIComponent(executionId)}/files/${encodeURIComponent(fileId)}`,
        {
          headers: {
            authorization: `Bearer ${credential}`,
            'x-execution-lease-token': leaseToken,
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new RunnerHttpError('NETWORK_ERROR', '无法下载任务附件', 0);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const record = asRecord(asRecord(body).error);
      throw new RunnerHttpError(
        typeof record.code === 'string' ? record.code : 'HTTP_ERROR',
        typeof record.message === 'string' ? record.message : '文件下载失败',
        response.status,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private async authorizedJson<T>(
    serverOrigin: string,
    credential: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    method = 'POST',
  ): Promise<T> {
    return schema.parse(
      await requestJson(
        this.fetchImplementation,
        serverOrigin + path,
        {
          method,
          headers: { authorization: `Bearer ${credential}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        this.timeoutMs,
      ),
    );
  }
}

async function requestJson(
  fetchImplementation: RunnerFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RunnerHttpError('NETWORK_ERROR', '无法连接服务', 0);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = asRecord(asRecord(body).error);
    throw new RunnerHttpError(
      typeof record.code === 'string' ? record.code : 'HTTP_ERROR',
      typeof record.message === 'string' ? record.message : '服务请求失败',
      response.status,
    );
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export class RunnerHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RunnerHttpError';
  }
}
