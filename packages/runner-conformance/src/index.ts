import { createHash } from 'node:crypto';
import type {
  ClaimedExecution,
  CompleteExecutionRequest,
  Execution,
  ExecutionOutcome,
  ExecutionStartRequest,
  OpenInteractionRequest,
} from '@agent-party-time/execution-contract';
import {
  RunnerAuthorizationVerifierSchema,
  type RunnerBindingWorkCompletion,
} from '@agent-party-time/runner-contract';
import {
  RunnerHttpClient,
  type RunnerFetch,
} from '@agent-party-time/runner-contract/http-client';

export interface ProtocolAgentOptions {
  serverUrl: string;
  fetch: RunnerFetch;
  credential?: string;
}

export class ProtocolAgent {
  private readonly serverUrl: string;
  private readonly http: RunnerHttpClient;
  private credential: string | undefined;

  constructor(options: ProtocolAgentOptions) {
    this.serverUrl = normalizeServerOrigin(options.serverUrl);
    this.credential = options.credential;
    this.http = new RunnerHttpClient(options.fetch, null);
  }

  async createAuthorization(input: {
    installationId: string;
    verifier: string;
    fingerprint: string;
    suggestedName: string;
  }) {
    const verifier = RunnerAuthorizationVerifierSchema.parse(input.verifier);
    return this.http.createAuthorization(this.serverUrl, {
      installationId: input.installationId,
      verifierHash: createHash('sha256').update(verifier).digest('hex'),
      fingerprint: input.fingerprint,
      suggestedName: input.suggestedName,
    });
  }

  async claimAuthorization(requestId: string, verifierInput: string) {
    const verifier = RunnerAuthorizationVerifierSchema.parse(verifierInput);
    const result = await this.http.claimAuthorization(
      this.serverUrl,
      requestId,
      verifier,
    );
    if (result.state === 'AUTHORIZED') this.credential = result.credential;
    return result;
  }

  useCredential(credential: string | undefined): void {
    this.credential = credential;
  }

  heartbeat(availableSlots = 3) {
    return this.http.heartbeat(this.serverUrl, this.credential, availableSlots);
  }

  listBindings() {
    return this.http.listBindings(this.serverUrl, this.credential);
  }

  confirmBinding(bindingId: string, repositoryUrl: string) {
    return this.http.confirmBinding(
      this.serverUrl,
      this.credential,
      bindingId,
      repositoryUrl,
    );
  }

  claimBindingWork() {
    return this.http.claimBindingWork(this.serverUrl, this.credential);
  }

  completeBindingWork(requestId: string, input: RunnerBindingWorkCompletion) {
    return this.http.completeBindingWork(
      this.serverUrl,
      this.credential,
      requestId,
      input,
    );
  }

  claimExecutions(availableSlots: number, waitMs = 5_000) {
    return this.http.claimExecutions(
      this.serverUrl,
      this.credential,
      availableSlots,
      waitMs,
    );
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

  startExecution(executionId: string, input: ExecutionStartRequest) {
    return this.http.startExecution(
      this.serverUrl,
      this.credential,
      executionId,
      input,
    );
  }

  renewExecution(executionId: string, leaseToken: string) {
    return this.http.renewExecution(
      this.serverUrl,
      this.credential,
      executionId,
      leaseToken,
    );
  }

  openInteraction(executionId: string, input: OpenInteractionRequest) {
    return this.http.openInteraction(
      this.serverUrl,
      this.credential,
      executionId,
      input,
    );
  }

  waitInteraction(
    executionId: string,
    interactionId: string,
    leaseToken: string,
    waitMs = 5_000,
  ) {
    return this.http.waitInteraction(
      this.serverUrl,
      this.credential,
      executionId,
      interactionId,
      leaseToken,
      waitMs,
    );
  }

  completeExecution(executionId: string, input: CompleteExecutionRequest) {
    return this.http.completeExecution(
      this.serverUrl,
      this.credential,
      executionId,
      input,
    );
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

  downloadExecutionFile(
    executionId: string,
    fileId: string,
    leaseToken: string,
  ) {
    return this.http.downloadExecutionFile(
      this.serverUrl,
      this.credential,
      executionId,
      fileId,
      leaseToken,
    );
  }
}

function normalizeServerOrigin(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Server URL 必须使用 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('Server URL 不得包含凭据');
  return url.origin;
}

export class ProtocolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolTimeoutError';
  }
}
