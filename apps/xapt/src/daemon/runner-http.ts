import {
  RunnerAuthorizationClaimResponseSchema,
  RunnerAuthorizationCreateRequestSchema,
  RunnerAuthorizationIssueSchema,
  RunnerHeartbeatResponseSchema,
  RunnerHeartbeatRequestSchema,
  RunnerBindingsResponseSchema,
  RunnerBindingWorkCompletionResponseSchema,
  RunnerBindingWorkCompletionSchema,
  RunnerBindingWorkResponseSchema,
  type Runner,
  type RunnerAuthorizationClaimResponse,
  type RunnerAuthorizationCreateRequest,
  type RunnerAuthorizationIssue,
  type RunnerBindingRef,
  type RunnerBindingWork,
  type RunnerBindingWorkCompletion,
} from '@agent-party-time/runner-contract';
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
  type ExecutionRenewResponse,
  type ExecutionStartRequest,
  type ExecutionInteraction,
  type OpenInteractionRequest,
  type WaitInteractionResponse,
} from '@agent-party-time/execution-contract';
import type { ExecutionFileHttp } from '../execution/attachments';

export type RunnerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RunnerAuthorizationHttp {
  createAuthorization(
    serverOrigin: string,
    input: RunnerAuthorizationCreateRequest,
  ): Promise<RunnerAuthorizationIssue>;
  claimAuthorization(
    serverOrigin: string,
    requestId: string,
    verifier: string,
  ): Promise<RunnerAuthorizationClaimResponse>;
  heartbeat(
    serverOrigin: string,
    credential: string,
    availableSlots: number,
  ): Promise<Runner>;
  revokeSelf(serverOrigin: string, credential: string): Promise<Runner>;
}

export interface RunnerBindingHttp {
  listBindings(
    serverOrigin: string,
    credential: string,
  ): Promise<RunnerBindingRef[]>;
  claimBindingWork(
    serverOrigin: string,
    credential: string,
  ): Promise<RunnerBindingWork | null>;
  completeBindingWork(
    serverOrigin: string,
    credential: string,
    requestId: string,
    completion: RunnerBindingWorkCompletion,
  ): Promise<'SUCCEEDED' | 'FAILED'>;
}

export interface RunnerExecutionHttp extends ExecutionFileHttp {
  claimExecutions(
    serverOrigin: string,
    credential: string,
    availableSlots: number,
    waitMs?: number,
  ): Promise<ClaimedExecution[]>;
  startExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    request: ExecutionStartRequest,
  ): Promise<Execution>;
  renewExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    leaseToken: string,
  ): Promise<ExecutionRenewResponse>;
  completeExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    request: CompleteExecutionRequest,
  ): Promise<Execution>;
  openInteraction(
    serverOrigin: string,
    credential: string,
    executionId: string,
    request: OpenInteractionRequest,
  ): Promise<ExecutionInteraction>;
  waitInteraction(
    serverOrigin: string,
    credential: string,
    executionId: string,
    interactionId: string,
    leaseToken: string,
    waitMs?: number,
  ): Promise<WaitInteractionResponse>;
}

export class RunnerHttpClient
  implements RunnerAuthorizationHttp, RunnerBindingHttp, RunnerExecutionHttp
{
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
    return RunnerBindingsResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        '/api/runner/bindings',
        {
          method: 'GET',
        },
      ),
    ).bindings;
  }

  async claimBindingWork(
    serverOrigin: string,
    credential: string,
  ): Promise<RunnerBindingWork | null> {
    return RunnerBindingWorkResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        '/api/runner/binding-requests',
        { method: 'POST' },
      ),
    ).request;
  }

  async completeBindingWork(
    serverOrigin: string,
    credential: string,
    requestId: string,
    completionInput: RunnerBindingWorkCompletion,
  ): Promise<'SUCCEEDED' | 'FAILED'> {
    const completion = RunnerBindingWorkCompletionSchema.parse(completionInput);
    return RunnerBindingWorkCompletionResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/binding-requests/${encodeURIComponent(requestId)}`,
        { method: 'POST', body: JSON.stringify(completion) },
      ),
    ).state;
  }

  async claimExecutions(
    serverOrigin: string,
    credential: string,
    availableSlots: number,
    waitMs = 0,
  ): Promise<ClaimedExecution[]> {
    const body = ExecutionClaimRequestSchema.parse({ availableSlots, waitMs });
    return ExecutionClaimResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        '/api/runner/executions/claim',
        { method: 'POST', body: JSON.stringify(body) },
      ),
    ).executions;
  }

  async startExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    requestInput: ExecutionStartRequest,
  ): Promise<Execution> {
    const body = ExecutionStartRequestSchema.parse(requestInput);
    return ExecutionMutationResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/executions/${encodeURIComponent(executionId)}/start`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    ).execution;
  }

  async renewExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    leaseToken: string,
  ): Promise<ExecutionRenewResponse> {
    const body = ExecutionRenewRequestSchema.parse({ leaseToken });
    return ExecutionRenewResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/executions/${encodeURIComponent(executionId)}/renew`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    );
  }

  async completeExecution(
    serverOrigin: string,
    credential: string,
    executionId: string,
    requestInput: CompleteExecutionRequest,
  ): Promise<Execution> {
    const body = CompleteExecutionRequestSchema.parse(requestInput);
    return ExecutionMutationResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/executions/${encodeURIComponent(executionId)}/complete`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    ).execution;
  }

  async openInteraction(
    serverOrigin: string,
    credential: string,
    executionId: string,
    requestInput: OpenInteractionRequest,
  ): Promise<ExecutionInteraction> {
    const body = OpenInteractionRequestSchema.parse(requestInput);
    return OpenInteractionResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/executions/${encodeURIComponent(executionId)}/interactions/open`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
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
    return WaitInteractionResponseSchema.parse(
      await this.authorizedJson(
        serverOrigin,
        credential,
        `/api/runner/interactions/${encodeURIComponent(interactionId)}/wait`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
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
      throw new RunnerHttpError('NETWORK_ERROR', '无法下载 Execution 文件', 0);
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

  private async authorizedJson(
    serverOrigin: string,
    credential: string,
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    return await requestJson(
      this.fetchImplementation,
      `${serverOrigin}${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          authorization: `Bearer ${credential}`,
        },
      },
      this.timeoutMs,
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
    throw new RunnerHttpError('NETWORK_ERROR', '无法连接 Server', 0);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = asRecord(asRecord(body).error);
    throw new RunnerHttpError(
      typeof record.code === 'string' ? record.code : 'HTTP_ERROR',
      typeof record.message === 'string' ? record.message : 'Server 请求失败',
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
