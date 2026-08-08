import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ClaimedExecution,
  CompleteExecutionRequest,
  Execution,
  ExecutionRenewResponse,
  ExecutionStartRequest,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { LocalStateStore } from '../state/store';
import { STATE_SCHEMA_VERSION } from '../state/schemas';
import type { AuthenticatedRunnerSession } from '../daemon/connection';
import type { RunnerExecutionHttp } from '../daemon/runner-http';
import type { AttachmentMaterializer } from './attachments';
import type {
  CodexExecutionInput,
  CodexExecutor,
  StartedCodexExecution,
} from './codex-app-server';
import { CodexAppServerError } from './codex-app-server';
import { ExecutionService } from './service';
import type {
  ExecutionWorkspaceManager,
  PreparedExecutionWorkspace,
} from './workspaces';

const homes: string[] = [];
const executionId = '00000000-0000-4000-8000-000000000301';
const bindingId = '00000000-0000-4000-8000-000000000302';
const runnerId = '00000000-0000-4000-8000-000000000303';
const leaseToken = 'lease-token-at-least-thirty-two-characters';
const session: AuthenticatedRunnerSession = {
  serverOrigin: 'https://apt.example.com',
  credential: 'credential-secret-at-least-thirty-two-characters',
};

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('单槽完成领取、Codex Session、START 与结构化 Outcome happy path', async () => {
  const fixture = await createFixture();

  expect(await fixture.service.cycle(session)).toBe(true);
  await fixture.service.waitForIdle();

  expect(fixture.http.claimSlots).toEqual([3]);
  expect(fixture.http.starts).toEqual([
    {
      kind: 'STARTED',
      leaseToken,
      sessionId: 'thread-new',
    },
  ]);
  expect(fixture.http.outcomes).toEqual([
    {
      leaseToken,
      sessionId: 'thread-new',
      outcome: { kind: 'SUCCEEDED', result: { summary: 'done' } },
    },
  ]);
  expect(fixture.executor.inputs[0]).toMatchObject({
    repositoryPath: fixture.repositoryPath,
    prompt: '只返回 JSON',
    resumeSessionId: null,
  });
  expect(await fixture.state.loadExecutions()).toEqual([]);
  expect(await fixture.state.loadOutbox()).toEqual([]);
  expect(fixture.service.projection.activeExecutionCount).toBe(0);
});

test('已有 Session 通过 resumeSessionId 继续原 Thread', async () => {
  const fixture = await createFixture({ resumeSessionId: 'thread-existing' });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.executor.inputs[0]?.resumeSessionId).toBe('thread-existing');
});

test('Codex 结构化结果失败只收敛当前 Execution，不退出服务', async () => {
  const fixture = await createFixture({
    executorFailure: new CodexAppServerError(
      'Codex Turn 返回的结构化结果无效',
      'thread-failed',
    ),
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.outcomes[0]).toMatchObject({
    outcome: {
      kind: 'FAILED',
      failure: {
        code: 'CODEX_EXECUTION_FAILED',
        message: 'Codex Turn 返回的结构化结果无效',
      },
    },
  });
  expect(await fixture.state.loadExecutions()).toEqual([]);
});

test('Outcome 网络失败进入 Outbox，重启后先重放再尝试领取', async () => {
  const fixture = await createFixture({ failOutcome: true });
  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();
  expect(await fixture.state.loadOutbox()).toHaveLength(1);
  expect(await fixture.state.loadExecutions()).toHaveLength(1);

  fixture.http.failOutcome = false;
  fixture.http.claimed = [];
  fixture.http.events.length = 0;
  const restarted = fixture.restartedService();
  expect(await restarted.cycle(session)).toBe(false);

  expect(fixture.http.events).toEqual(['complete', 'claim']);
  expect(await fixture.state.loadOutbox()).toEqual([]);
  expect(await fixture.state.loadExecutions()).toEqual([]);
});

test('固定三槽并发，第四条等待空闲槽位', async () => {
  const fixture = await createFixture({ deferredExecutor: true });
  const executions = [0, 1, 2, 3].map((index) =>
    claimedExecution(
      null,
      `00000000-0000-4000-8000-${String(310 + index).padStart(12, '0')}`,
      `00000000-0000-4000-8000-${String(320 + index).padStart(12, '0')}`,
    ),
  );
  for (const execution of executions)
    await fixture.state.bind(execution.bindingId, fixture.repositoryPath);
  fixture.http.claimed = executions;

  await fixture.service.cycle(session);
  await waitUntil(() => fixture.executor.inputs.length === 3);
  expect(fixture.service.projection.activeExecutionCount).toBe(3);
  expect(await fixture.service.cycle(session)).toBe(false);
  expect(fixture.executor.inputs).toHaveLength(3);

  fixture.executor.resolveAll();
  await fixture.service.waitForIdle();
  expect(await fixture.service.cycle(session)).toBe(true);
  await waitUntil(() => fixture.executor.inputs.length === 4);
  fixture.executor.resolveAll();
  await fixture.service.waitForIdle();
});

test('同一 Binding 的第二条 Execution 在第一条收敛后才启动', async () => {
  const fixture = await createFixture({ deferredExecutor: true });
  fixture.http.claimed = [
    claimedExecution(null),
    claimedExecution(null, '00000000-0000-4000-8000-000000000311', bindingId),
  ];

  await fixture.service.cycle(session);
  await waitUntil(() => fixture.executor.inputs.length === 1);
  expect(fixture.service.projection.activeExecutionCount).toBe(1);
  fixture.executor.resolveNext();
  await waitUntil(() => fixture.executor.inputs.length === 2);
  fixture.executor.resolveNext();
  await fixture.service.waitForIdle();
});

test('Codex Interaction 经 Server 解决后继续原 Session', async () => {
  const fixture = await createFixture({ interactionExecutor: true });
  fixture.http.interactionResolution = {
    answers: { question: { answers: ['ok'] } },
  };

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.openedInteractions).toHaveLength(1);
  expect(fixture.http.outcomes[0]).toMatchObject({
    sessionId: 'thread-new',
    outcome: {
      kind: 'SUCCEEDED',
      result: fixture.http.interactionResolution,
    },
  });
  expect(fixture.service.projection.waitingInteractionCount).toBe(0);
});

test('恢复后的已解决 Interaction 直接回填给恢复的 Codex Session', async () => {
  const fixture = await createFixture({ interactionExecutor: true });
  const resolution = {
    answers: { question: { answers: ['恢复答案'] } },
  };
  fixture.http.claimed[0] = {
    ...fixture.http.claimed[0]!,
    resumeSessionId: 'thread-recovered',
    recoveredInteraction: {
      method: 'item/tool/requestUserInput',
      payload: { questions: [{ id: 'question' }] },
      resolution,
    },
  };

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.executor.inputs[0]?.resumeSessionId).toBe('thread-recovered');
  expect(fixture.http.openedInteractions).toEqual([]);
  expect(fixture.http.outcomes[0]).toMatchObject({
    outcome: { kind: 'SUCCEEDED', result: resolution },
  });
});

test('重启保留本地执行记录至 Server Lease 收敛后再领取', async () => {
  const fixture = await createFixture();
  const execution = claimedExecution(null);
  fixture.http.claimed = [];
  await fixture.state.saveExecution({
    schemaVersion: STATE_SCHEMA_VERSION,
    executionId: execution.id,
    bindingId: execution.bindingId,
    phase: 'RUNNING',
    sessionId: 'thread-interrupted',
    claimedExecution: execution,
    updatedAt: '2026-08-03T08:00:00.000Z',
  });

  const restarted = fixture.restartedService();
  expect(await restarted.cycle(session)).toBe(true);

  expect(fixture.http.events).toEqual([]);
  expect(fixture.http.outcomes).toEqual([]);
  expect(await fixture.state.loadExecutions()).toHaveLength(1);
  expect(restarted.projection.recoveryRequired).toBe(true);

  fixture.setNow('2026-08-03T10:00:00.000Z');
  const afterLeaseExpiry = fixture.restartedService();
  expect(await afterLeaseExpiry.cycle(session)).toBe(true);
  expect(await fixture.state.loadExecutions()).toEqual([]);
  expect(afterLeaseExpiry.projection.recoveryRequired).toBe(true);
});

test('续租将最新 Lease 过期时间写入崩溃恢复记录', async () => {
  const fixture = await createFixture();
  const execution = claimedExecution(null);
  await fixture.state.saveExecution({
    schemaVersion: STATE_SCHEMA_VERSION,
    executionId: execution.id,
    bindingId: execution.bindingId,
    phase: 'RUNNING',
    sessionId: 'thread-interrupted',
    claimedExecution: execution,
    updatedAt: '2026-08-03T08:00:00.000Z',
  });

  await (
    fixture.service as unknown as {
      persistRenewedLease: (
        execution: ClaimedExecution,
        expiresAt: string,
      ) => Promise<void>;
    }
  ).persistRenewedLease(execution, '2026-08-03T10:00:00.000Z');
  fixture.setNow('2026-08-03T09:30:00.000Z');

  const restarted = fixture.restartedService();
  expect(await restarted.cycle(session)).toBe(true);
  expect(await fixture.state.loadExecutions()).toHaveLength(1);
  expect(restarted.projection.recoveryRequired).toBe(true);
});

async function createFixture(
  options: {
    resumeSessionId?: string;
    executorFailure?: Error;
    failOutcome?: boolean;
    deferredExecutor?: boolean;
    interactionExecutor?: boolean;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'xapt-execution-'));
  homes.push(home);
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  const repositoryPath = join(home, 'repository');
  await mkdir(repositoryPath);
  await state.bind(bindingId, repositoryPath);
  const http = new FakeExecutionHttp(
    claimedExecution(options.resumeSessionId ?? null),
  );
  http.failOutcome = options.failOutcome ?? false;
  const executor = new FakeCodexExecutor(
    options.executorFailure,
    options.deferredExecutor ?? false,
    options.interactionExecutor ?? false,
  );
  let now = new Date('2026-08-03T08:00:00.000Z');
  let nextId = 400;
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
      } as ExecutionWorkspaceManager,
      executor,
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
      expiresAt: '2026-08-03T09:00:00.000Z',
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
      sessionId: input.resumeSessionId ?? 'thread-new',
      completion,
    };
  }

  resolveNext(): void {
    this.resolvers.shift()?.({ summary: 'done' });
  }

  resolveAll(): void {
    for (;;) {
      const resolve = this.resolvers.shift();
      if (!resolve) return;
      resolve({ summary: 'done' });
    }
  }
}

function claimedExecution(
  resumeSessionId: string | null,
  id = executionId,
  localBindingId = bindingId,
): ClaimedExecution {
  return {
    id,
    owner: { namespace: 'test', kind: 'task', id: 'task-1' },
    attempt: 1,
    previousExecutionId: null,
    runnerId,
    bindingId: localBindingId,
    priority: 0,
    state: 'CLAIMED',
    promptKind: 'test',
    promptVersion: 1,
    renderedPrompt: '只返回 JSON',
    renderedPromptHash: 'a'.repeat(64),
    outputJsonSchema: { type: 'object' },
    workspace: null,
    attachments: [],
    resumeSessionId,
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

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
