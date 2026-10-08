import { testDirectories } from '../testing/directories';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  serializeDeterministicJson,
  type ClaimedExecution,
  type CompleteExecutionRequest,
  type Execution,
  type ExecutionResultAssertion,
  type ExecutionRenewResponse,
  type ExecutionStartRequest,
  type JsonObject,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { LocalStateStore } from '../state/store';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/server-http';
import type { AttachmentMaterializer } from './attachments';
import type {
  CodexExecutionInput,
  CodexExecutor,
  StartedCodexExecution,
} from '../codex/contract';
import { ExecutionService } from './service';
import type {
  ExecutionResultVerificationError,
  ExecutionResultVerifier,
} from './result-verification';
import type { SkillBundleManager } from '../skills/manager';
import type { ExecutionWorkspaceManager } from './workspaces';

const createTestDirectory = testDirectories('xapt-execution-');
export const executionId = '00000000-0000-4000-8000-000000000301';
export const bindingId = '00000000-0000-4000-8000-000000000302';
const runnerId = '00000000-0000-4000-8000-000000000303';
export const leaseToken = 'lease-token-at-least-thirty-two-characters';
export const skillBinding = {
  skillName: 'agent-party-time-repair-bug' as const,
  bundleHash: 'a'.repeat(64),
  sourceRevision: 'b'.repeat(40),
};
export const session: AuthenticatedRunnerSession = {
  serverOrigin: 'https://apt.example.com',
  credential: 'credential-secret-at-least-thirty-two-characters',
};

export async function createFixture(
  options: {
    taskId?: string;
    executorFailure?: Error;
    failOutcome?: boolean;
    deferredExecutor?: boolean;
    interactionExecutor?: boolean;
    readSessionId?: string;
    readSessionFailure?: Error;
    readResultAssertions?: ExecutionResultAssertion[];
    readOutputJsonSchema?: JsonObject;
    readResult?: JsonValue;
    workspaceResolveFailure?: Error;
    previousExecutionId?: string;
    capturedBaseline?: { gitHead: string } | null;
    owner?: ClaimedExecution['owner'];
    approvalPolicy?: ClaimedExecution['approvalPolicy'];
    workspace?: ClaimedExecution['workspace'];
    resultAssertions?: ExecutionResultAssertion[];
    resultValidationFailure?: ExecutionResultVerificationError;
  } = {},
) {
  const home = await createTestDirectory();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  const repositoryPath = join(home, 'repository');
  await mkdir(repositoryPath);
  await state.bind(bindingId, repositoryPath);
  const claimed = claimedExecution(
    options.taskId ?? null,
    executionId,
    bindingId,
    options.owner,
    options.approvalPolicy,
    options.workspace,
  );
  if (options.readSessionId)
    claimed.codexTurn = {
      kind: 'READ_SESSION',
      taskId: options.readSessionId,
      outputJsonSchema: options.readOutputJsonSchema ?? { type: 'object' },
      resultAssertions: options.readResultAssertions,
    };
  if (options.previousExecutionId)
    claimed.previousExecutionId = options.previousExecutionId;
  if (claimed.codexTurn && claimed.codexTurn.kind !== 'READ_SESSION')
    claimed.codexTurn.resultAssertions = options.resultAssertions;
  const http = new FakeExecutionHttp(claimed);
  http.failOutcome = options.failOutcome ?? false;
  const executor = new FakeCodexExecutor(
    options.executorFailure,
    options.deferredExecutor ?? false,
    options.interactionExecutor ?? false,
    options.readSessionFailure,
    options.readResult,
  );
  let now = new Date('2026-08-03T08:00:00.000Z');
  let nextId = 400;
  const verifiedBaselines: Array<{ gitHead: string } | null> = [];
  const skillAt = (identity: typeof skillBinding) => ({
    ...identity,
    path: join(home, 'skills', identity.bundleHash),
  });
  const build = () =>
    new ExecutionService(
      http,
      state,
      files,
      {
        materialize: async () => [],
        artifactsDirectory: (id: string) => join(paths.logs, id),
      } as unknown as AttachmentMaterializer,
      {
        prepare: async () => ({ kind: 'EXECUTE', cwd: repositoryPath }),
        resolve: async () => {
          if (options.workspaceResolveFailure)
            throw options.workspaceResolveFailure;
          return repositoryPath;
        },
      } as ExecutionWorkspaceManager,
      executor,
      {
        resolveCurrent: async () => skillAt(skillBinding),
        resolveBound: async (identity: typeof skillBinding) =>
          skillAt(identity),
      } as unknown as SkillBundleManager,
      {
        capture: async () => options.capturedBaseline ?? null,
        verify: async (_repositoryPath, _assertions, baseline) => {
          verifiedBaselines.push(baseline);
          if (options.resultValidationFailure)
            throw options.resultValidationFailure;
        },
      } as ExecutionResultVerifier,
      () => now,
      () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    );
  return {
    paths,
    files,
    state,
    repositoryPath,
    http,
    executor,
    verifiedBaselines,
    service: build(),
    restartedService: build,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

class FakeExecutionHttp implements RunnerExecutionHttp {
  async deleteBugs(): Promise<{
    deletedBugIds: string[];
    deletedExecutionIds: string[];
  }> {
    return { deletedBugIds: [], deletedExecutionIds: [] };
  }

  claimed: ClaimedExecution[];
  readonly claimSlots: number[] = [];
  readonly starts: ExecutionStartRequest[] = [];
  readonly outcomes: CompleteExecutionRequest[] = [];
  readonly events: string[] = [];
  failOutcome = false;
  interactionResolution: JsonValue = {};
  readonly openedInteractions: unknown[] = [];
  renewedExpiresAt = '2026-08-03T09:00:00.000Z';

  constructor(...executions: ClaimedExecution[]) {
    this.claimed = executions;
  }

  async claimExecutions(
    _origin: string,
    _credential: string,
    availableSlots: number,
  ): Promise<ClaimedExecution[]> {
    this.events.push('claim');
    this.claimSlots.push(availableSlots);
    return this.claimed.splice(0, availableSlots);
  }

  async startExecution(
    _origin: string,
    _credential: string,
    _executionId: string,
    request: ExecutionStartRequest,
  ): Promise<Execution> {
    this.events.push('start');
    this.starts.push(request);
    return {} as Execution;
  }

  async renewExecution(): Promise<ExecutionRenewResponse> {
    return {
      expiresAt: this.renewedExpiresAt,
      cancellationRequested: false,
    };
  }

  async completeExecution(
    _origin: string,
    _credential: string,
    _executionId: string,
    request: CompleteExecutionRequest,
  ): Promise<Execution> {
    this.events.push('complete');
    if (this.failOutcome) throw new Error('network');
    this.outcomes.push(request);
    return {} as Execution;
  }

  async openInteraction(
    _origin: string,
    _credential: string,
    executionId: string,
    request: unknown,
  ) {
    this.openedInteractions.push(request);
    return {
      id: '00000000-0000-4000-8000-000000000350',
      executionId,
      kind: 'USER_INPUT' as const,
      method: 'item/tool/requestUserInput',
      payload: {},
      state: 'PENDING' as const,
      resolution: null,
      createdAt: '2026-08-03T08:00:00.000Z',
      resolvedAt: null,
    };
  }

  async waitInteraction(
    _origin: string,
    _credential: string,
    executionId: string,
  ) {
    return {
      interaction: {
        id: '00000000-0000-4000-8000-000000000350',
        executionId,
        kind: 'USER_INPUT' as const,
        method: 'item/tool/requestUserInput',
        payload: {},
        state: 'RESOLVED' as const,
        resolution: this.interactionResolution,
        createdAt: '2026-08-03T08:00:00.000Z',
        resolvedAt: '2026-08-03T08:01:00.000Z',
      },
      laneAcquired: true,
    };
  }

  async downloadExecutionFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

class FakeCodexExecutor implements CodexExecutor {
  readonly inputs: CodexExecutionInput[] = [];
  private readonly resolvers: Array<(value: JsonValue) => void> = [];

  constructor(
    private readonly failure?: Error,
    private readonly deferred = false,
    private readonly interaction = false,
    private readonly readFailure?: Error,
    private readonly readResult: JsonValue = { summary: 'done' },
  ) {}

  async begin(input: CodexExecutionInput): Promise<StartedCodexExecution> {
    this.inputs.push(input);
    const completion = this.interaction
      ? new Promise<JsonValue>((resolve, reject) =>
          setTimeout(
            () =>
              input
                .onInteraction({
                  method: 'item/tool/requestUserInput',
                  payload: { questions: [{ id: 'question' }] },
                })
                .then(resolve, reject),
            0,
          ),
        )
      : this.deferred
        ? new Promise<JsonValue>((resolve) => this.resolvers.push(resolve))
        : this.failure
          ? new Promise<JsonValue>((_resolve, reject) =>
              setTimeout(() => reject(this.failure), 10),
            )
          : Promise.resolve({ summary: 'done' });
    return {
      sessionId: input.taskId ?? 'thread-new',
      completion,
    };
  }

  async readLastCompletedTurn() {
    if (this.readFailure) throw this.readFailure;
    return { turnId: 'turn-latest', result: this.readResult };
  }

  resolveNext(): void {
    this.resolvers.shift()?.({ summary: 'done' });
  }

  resolveAll(): void {
    while (this.resolvers.length) this.resolveNext();
  }
}

export function claimedExecution(
  taskId: string | null,
  id = executionId,
  localBindingId = bindingId,
  owner: ClaimedExecution['owner'] = {
    namespace: 'test',
    kind: 'task',
    id: 'task-1',
  },
  approvalPolicy: ClaimedExecution['approvalPolicy'] = 'on-request',
  workspace: ClaimedExecution['workspace'] = null,
): ClaimedExecution {
  return {
    id,
    owner,
    attempt: 1,
    previousExecutionId: null,
    runnerId,
    bindingId: localBindingId,
    priority: 0,
    approvalPolicy,
    state: 'CLAIMED',
    codexTurn: taskId ? continuationTurn(taskId) : initialTurn(),
    workspace,
    attachments: [],
    sessionId: null,
    lease: {
      token: leaseToken,
      expiresAt: '2026-08-03T09:00:00.000Z',
    },
    outcome: null,
    cancellationRequested: false,
    createdAt: '2026-08-03T07:00:00.000Z',
    claimedAt: '2026-08-03T08:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    recoveredInteraction: null,
  };
}

function initialTurn(): ClaimedExecution['codexTurn'] {
  const executionBrief = { instruction: '只返回 JSON' };
  return {
    kind: 'INITIAL',
    requiredSkillName: skillBinding.skillName,
    executionBrief,
    executionBriefHash: createHash('sha256')
      .update(serializeDeterministicJson(executionBrief))
      .digest('hex'),
    outputJsonSchema: { type: 'object' },
    taskSkillBinding: null,
  };
}

export function continuationTurn(
  taskId: string,
): ClaimedExecution['codexTurn'] {
  return {
    kind: 'CONTINUATION',
    taskId,
    taskSkillBinding: skillBinding,
    input: '继续完成上次未完成的任务。',
    outputJsonSchema: { type: 'object' },
  };
}
