import { createHash } from 'node:crypto';
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
  type ExecutionOutcome,
  type ExecutionRenewResponse,
  type ExecutionStartRequest,
  type OpenInteractionRequest,
  type WaitInteractionResponse,
} from '@agent-party-time/execution-contract';
import {
  RunnerAuthorizationClaimResponseSchema,
  RunnerAuthorizationCreateRequestSchema,
  RunnerAuthorizationIssueSchema,
  RunnerAuthorizationVerifierSchema,
  RunnerBindingConfirmationRequestSchema,
  RunnerBindingConfirmationResponseSchema,
  RunnerBindingWorkCompletionResponseSchema,
  RunnerBindingWorkCompletionSchema,
  RunnerBindingWorkResponseSchema,
  RunnerBindingsResponseSchema,
  RunnerHeartbeatResponseSchema,
  RunnerHeartbeatRequestSchema,
  type Runner,
  type RunnerAuthorizationClaimResponse,
  type RunnerAuthorizationIssue,
  type RunnerBindingRef,
  type RunnerBindingWork,
  type RunnerBindingWorkCompletion,
} from '@agent-party-time/runner-contract';

export interface ProtocolAgentOptions {
  serverUrl: string;
  fetch: ProtocolFetch;
  credential?: string;
}

export type ProtocolFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ProtocolAgent {
  private readonly serverUrl: string;
  private credential: string | undefined;

  constructor(private readonly options: ProtocolAgentOptions) {
    this.serverUrl = normalizeServerOrigin(options.serverUrl);
    this.credential = options.credential;
  }

  async createAuthorization(input: {
    verifier: string;
    fingerprint: string;
    suggestedName: string;
  }): Promise<RunnerAuthorizationIssue> {
    const verifier = RunnerAuthorizationVerifierSchema.parse(input.verifier);
    const body = RunnerAuthorizationCreateRequestSchema.parse({
      verifierHash: createHash('sha256').update(verifier).digest('hex'),
      fingerprint: input.fingerprint,
      suggestedName: input.suggestedName,
    });
    return RunnerAuthorizationIssueSchema.parse(
      await this.requestJson('/api/runner/authorizations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  }

  async claimAuthorization(
    requestId: string,
    verifierInput: string,
  ): Promise<RunnerAuthorizationClaimResponse> {
    const verifier = RunnerAuthorizationVerifierSchema.parse(verifierInput);
    const result = RunnerAuthorizationClaimResponseSchema.parse(
      await this.requestJson(
        `/api/runner/authorizations/${encodeURIComponent(requestId)}/claim`,
        { method: 'POST', body: JSON.stringify({ verifier }) },
      ),
    );
    if (result.state === 'AUTHORIZED') this.credential = result.credential;
    return result;
  }

  useCredential(credential: string | undefined): void {
    this.credential = credential;
  }

  async heartbeat(availableSlots = 3): Promise<Runner> {
    const body = RunnerHeartbeatRequestSchema.parse({ availableSlots });
    return RunnerHeartbeatResponseSchema.parse(
      await this.authorizedJson('/api/runner/heartbeat', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ).runner;
  }

  async listBindings(): Promise<RunnerBindingRef[]> {
    return RunnerBindingsResponseSchema.parse(
      await this.authorizedJson('/api/runner/bindings'),
    ).bindings;
  }

  async confirmBinding(
    bindingId: string,
    repositoryUrl: string,
  ): Promise<{ bindingId: string; repositoryUrl: string }> {
    const body = RunnerBindingConfirmationRequestSchema.parse({
      bindingId,
      repositoryUrl,
    });
    return RunnerBindingConfirmationResponseSchema.parse(
      await this.authorizedJson('/api/runner/bindings', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  }

  async claimBindingWork(): Promise<RunnerBindingWork | null> {
    return RunnerBindingWorkResponseSchema.parse(
      await this.authorizedJson('/api/runner/binding-requests', {
        method: 'POST',
      }),
    ).request;
  }

  async completeBindingWork(
    requestId: string,
    input: RunnerBindingWorkCompletion,
  ): Promise<'SUCCEEDED' | 'FAILED'> {
    const body = RunnerBindingWorkCompletionSchema.parse(input);
    return RunnerBindingWorkCompletionResponseSchema.parse(
      await this.authorizedJson(
        `/api/runner/binding-requests/${encodeURIComponent(requestId)}`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    ).state;
  }

  async claimExecutions(
    availableSlots: number,
    waitMs = 5_000,
  ): Promise<ClaimedExecution[]> {
    const body = ExecutionClaimRequestSchema.parse({ availableSlots, waitMs });
    return ExecutionClaimResponseSchema.parse(
      await this.authorizedJson('/api/runner/executions/claim', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ).executions;
  }

  async waitForExecution(
    options: { timeoutMs?: number; waitMs?: number } = {},
  ): Promise<ClaimedExecution> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    do {
      const executions = await this.claimExecutions(
        1,
        Math.min(options.waitMs ?? 500, Math.max(0, deadline - Date.now())),
      );
      if (executions[0]) return executions[0];
    } while (Date.now() < deadline);
    throw new ProtocolTimeoutError('等待 Execution 超时');
  }

  async startExecution(
    executionId: string,
    input: ExecutionStartRequest,
  ): Promise<Execution> {
    const body = ExecutionStartRequestSchema.parse(input);
    return ExecutionMutationResponseSchema.parse(
      await this.authorizedJson(`/api/runner/executions/${executionId}/start`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ).execution;
  }

  async renewExecution(
    executionId: string,
    leaseToken: string,
  ): Promise<ExecutionRenewResponse> {
    const body = ExecutionRenewRequestSchema.parse({ leaseToken });
    return ExecutionRenewResponseSchema.parse(
      await this.authorizedJson(`/api/runner/executions/${executionId}/renew`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  }

  async openInteraction(
    executionId: string,
    input: OpenInteractionRequest,
  ): Promise<ExecutionInteraction> {
    const body = OpenInteractionRequestSchema.parse(input);
    return OpenInteractionResponseSchema.parse(
      await this.authorizedJson(
        `/api/runner/executions/${executionId}/interactions/open`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    ).interaction;
  }

  async waitInteraction(
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
        `/api/runner/interactions/${encodeURIComponent(interactionId)}/wait`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    );
  }

  async completeExecution(
    executionId: string,
    input: CompleteExecutionRequest,
  ): Promise<Execution> {
    const body = CompleteExecutionRequestSchema.parse(input);
    return ExecutionMutationResponseSchema.parse(
      await this.authorizedJson(
        `/api/runner/executions/${executionId}/complete`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    ).execution;
  }

  async runNext(
    execute: (execution: ClaimedExecution) => Promise<ExecutionOutcome>,
    options: {
      sessionId?: (execution: ClaimedExecution) => string;
    } = {},
  ): Promise<Execution | null> {
    const claimed = (await this.claimExecutions(1, 0))[0];
    if (!claimed) return null;
    const sessionId =
      options.sessionId?.(claimed) ??
      (claimed.codexTurn?.kind === 'CONTINUATION'
        ? claimed.codexTurn.taskId
        : null) ??
      `conformance-${claimed.id}`;
    await this.startExecution(claimed.id, {
      kind: 'STARTED',
      leaseToken: claimed.lease.token,
      sessionId,
      taskSkillBinding:
        claimed.codexTurn?.kind === 'CONTINUATION'
          ? claimed.codexTurn.taskSkillBinding
          : claimed.codexTurn?.kind === 'INITIAL'
            ? {
                skillName: claimed.codexTurn.requiredSkillName,
                bundleHash: 'a'.repeat(64),
                sourceRevision: 'b'.repeat(40),
              }
            : null,
    });
    const outcome = await execute(claimed);
    return await this.completeExecution(claimed.id, {
      leaseToken: claimed.lease.token,
      sessionId,
      outcome,
    });
  }

  async downloadExecutionFile(
    executionId: string,
    fileId: string,
    leaseToken: string,
  ): Promise<Uint8Array> {
    const response = await this.authorizedRequest(
      `/api/runner/executions/${executionId}/files/${fileId}`,
      { headers: { 'x-execution-lease-token': leaseToken } },
    );
    if (!response.ok) throw await responseError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async authorizedJson(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.authorizedRequest(path, init);
    return await parseJsonResponse(response);
  }

  private async authorizedRequest(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.credential)
      headers.set('authorization', `Bearer ${this.credential}`);
    if (init.body) headers.set('content-type', 'application/json');
    return await this.options.fetch(`${this.serverUrl}${path}`, {
      ...init,
      headers,
    });
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    return await parseJsonResponse(
      await this.options.fetch(`${this.serverUrl}${path}`, {
        ...init,
        headers,
      }),
    );
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw protocolError(response.status, body);
  return body;
}

async function responseError(response: Response): Promise<ProtocolError> {
  const body = await response.json().catch(() => ({}));
  return protocolError(response.status, body);
}

function protocolError(status: number, body: unknown): ProtocolError {
  const error = jsonRecord(jsonRecord(body).error);
  return new ProtocolError(
    typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
    typeof error.message === 'string'
      ? error.message
      : `Server 请求失败（${status}）`,
    status,
  );
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeServerOrigin(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Server URL 必须使用 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('Server URL 不得包含凭据');
  return url.origin;
}

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class ProtocolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolTimeoutError';
  }
}
