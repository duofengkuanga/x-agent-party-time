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
} from '@agent-party-time/execution-contract';
import {
  PairingCodeSchema,
  RunnerBindingConfirmationRequestSchema,
  RunnerBindingsResponseSchema,
  RunnerBindingConfirmationResponseSchema,
  RunnerHeartbeatResponseSchema,
  RunnerNameSchema,
  RunnerPairingResultSchema,
  type Runner,
  type RunnerBindingRef,
} from '@agent-party-time/runner-contract';
import { normalizeServerUrl } from './server-url';
import { RunnerStateStore } from './state';

export class RunnerClient {
  constructor(
    private readonly state: RunnerStateStore = new RunnerStateStore(),
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async pair(input: {
    serverUrl: string;
    code: string;
    name: string;
  }): Promise<Runner> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const response = await this.fetchImplementation(
      `${serverUrl}/api/runner/pair`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: PairingCodeSchema.parse(input.code),
          name: RunnerNameSchema.parse(input.name),
        }),
      },
    );
    const paired = RunnerPairingResultSchema.parse(
      await responseJson(response),
    );
    await this.state.saveConfig({
      serverUrl,
      runnerId: paired.runner.id,
      credential: paired.credential,
    });
    return paired.runner;
  }

  async heartbeat(): Promise<Runner> {
    const config = await this.state.loadConfig();
    const response = await this.fetchImplementation(
      `${config.serverUrl}/api/runner/heartbeat`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${config.credential}` },
      },
    );
    return RunnerHeartbeatResponseSchema.parse(await responseJson(response))
      .runner;
  }

  async listServerBindings(): Promise<RunnerBindingRef[]> {
    const config = await this.state.loadConfig();
    const response = await this.fetchImplementation(
      `${config.serverUrl}/api/runner/bindings`,
      { headers: { authorization: `Bearer ${config.credential}` } },
    );
    return RunnerBindingsResponseSchema.parse(await responseJson(response))
      .bindings;
  }

  async confirmBinding(
    bindingId: string,
    repositoryUrl: string,
  ): Promise<void> {
    const body = RunnerBindingConfirmationRequestSchema.parse({
      bindingId,
      repositoryUrl,
    });
    await this.authorizedJson('/api/runner/bindings', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((value) => RunnerBindingConfirmationResponseSchema.parse(value));
  }

  async claimExecutions(
    availableSlots: number,
    waitMs = 5_000,
  ): Promise<ClaimedExecution[]> {
    const body = ExecutionClaimRequestSchema.parse({
      availableSlots,
      waitMs,
    });
    return ExecutionClaimResponseSchema.parse(
      await this.authorizedJson('/api/runner/executions/claim', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ).executions;
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
  ): Promise<ExecutionInteraction> {
    const body = WaitInteractionRequestSchema.parse({
      executionId,
      leaseToken,
      waitMs,
    });
    return WaitInteractionResponseSchema.parse(
      await this.authorizedJson(
        `/api/runner/interactions/${interactionId}/wait`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    ).interaction;
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

  async downloadExecutionFile(
    executionId: string,
    fileId: string,
    leaseToken: string,
  ): Promise<Uint8Array> {
    const config = await this.state.loadConfig();
    const response = await this.fetchImplementation(
      `${config.serverUrl}/api/runner/executions/${executionId}/files/${fileId}`,
      {
        headers: {
          authorization: `Bearer ${config.credential}`,
          'x-execution-lease-token': leaseToken,
        },
      },
    );
    if (!response.ok) await throwResponseError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async authorizedJson(
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    const config = await this.state.loadConfig();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${config.credential}`);
    if (init.body) headers.set('content-type', 'application/json');
    const response = await this.fetchImplementation(
      `${config.serverUrl}${path}`,
      { ...init, headers },
    );
    return responseJson(response);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const body = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) throw protocolError(response.status, body);
  return body;
}

async function throwResponseError(response: Response): Promise<never> {
  let body: { error?: { code?: string; message?: string } } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {}
  throw protocolError(response.status, body);
}

function protocolError(
  status: number,
  body: { error?: { code?: string; message?: string } },
): RunnerProtocolError {
  return new RunnerProtocolError(
    body.error?.code ?? 'HTTP_ERROR',
    body.error?.message ?? `服务端请求失败（${status}）`,
    status,
  );
}

export class RunnerProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RunnerProtocolError';
  }
}
