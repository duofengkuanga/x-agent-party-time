import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EnqueueExecutionInput,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import {
  handleExecutionClaim,
  handleExecutionComplete,
  handleExecutionFile,
  handleExecutionRenew,
  handleExecutionStart,
  handleOpenInteraction,
  handleWaitInteraction,
} from '@/server/execution/http';
import { ExecutionService } from '@/server/execution/service';
import { LocalFileStore } from '@/server/files/local-file-store';
import { RunnerService } from '@/server/runner/service';
import { handleRunnerHeartbeat } from '@/server/runner/http';
import { AttachmentMaterializer } from '../../../../packages/runner/src/attachments';
import type {
  CodexExecutionInput,
  CodexExecutor,
  StartedCodexExecution,
} from '../../../../packages/runner/src/codex-app-server';
import { CodexAppServerError } from '../../../../packages/runner/src/codex-app-server';
import { RunnerClient } from '../../../../packages/runner/src/client';
import { ExecutionOutbox } from '../../../../packages/runner/src/outbox';
import type { ExecutionWorkspaceManager } from '../../../../packages/runner/src/execution-workspaces';
import {
  RunnerStateStore,
  runnerLocalPaths,
} from '../../../../packages/runner/src/state';
import { RunnerWorker } from '../../../../packages/runner/src/worker';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'runner-worker-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const user = await new AuthService(database).seedUser({
    id: 'worker-user',
    username: 'worker-user',
    displayName: 'Worker 用户',
    password: 'password',
  });
  const runners = new RunnerService(database);
  const paired = runners.pair(
    runners.issuePairingCode(user.id).code,
    'Worker Runner',
  );
  const executions = new ExecutionService(database);
  const files = new LocalFileStore(database, join(directory, 'server-files'));
  const paths = runnerLocalPaths({
    AGENT_PARTY_TIME_RUNNER_HOME: join(directory, 'runner-home'),
  });
  const state = new RunnerStateStore(paths);
  await state.saveConfig({
    serverUrl: 'http://server.test',
    runnerId: paired.runner.id,
    credential: paired.credential,
  });
  const repository = join(directory, 'repository');
  await Bun.write(join(repository, '.keep'), '');
  const dispatch = protocolFetch(runners, executions, files);
  const client = new RunnerClient(state, dispatch);
  const outbox = new ExecutionOutbox(paths);
  return {
    client,
    database,
    executions,
    files,
    outbox,
    paired,
    paths,
    repository,
    runners,
    state,
    user,
    dispatch,
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('generic Runner worker', () => {
  test('Execution 真实穿过 HTTP、附件物化、Fake Codex 和 Outcome Persistence', async () => {
    const fixture = await setup();
    const binding = bindingId(1);
    await fixture.state.bind(binding, fixture.repository);
    const file = await fixture.files.put({
      bytes: new TextEncoder().encode('fixture attachment'),
      originalName: 'fixture.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.user.id,
    });
    const execution = fixture.executions.enqueue({
      ...input(fixture.paired.runner.id, binding, 'end-to-end'),
      attachmentIds: [file.id],
    });
    const executor = new FakeCodexExecutor(async (codexInput) => ({
      attachment: await readFile(codexInput.attachments[0]!.path, 'utf8'),
    }));
    const worker = workerFor(fixture, executor);

    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();

    expect(fixture.executions.get(execution.id)).toMatchObject({
      state: 'SUCCEEDED',
      sessionId: `session-${execution.id}`,
      outcome: {
        kind: 'SUCCEEDED',
        result: { attachment: 'fixture attachment' },
      },
    });
    expect(await fixture.outbox.list()).toEqual([]);
  });

  test('Codex 执行失败保留 App Server 返回的具体失败摘要', async () => {
    const fixture = await setup();
    const binding = bindingId(2);
    await fixture.state.bind(binding, fixture.repository);
    const execution = fixture.executions.enqueue(
      input(fixture.paired.runner.id, binding, 'rate-limited'),
    );
    const failureSummary =
      'Codex 请求过多：429 Too Many Requests，已超过重试次数。';
    const worker = workerFor(
      fixture,
      new FakeCodexExecutor(async () => {
        await Bun.sleep(5);
        throw new CodexAppServerError(failureSummary, 'rate-limited-session');
      }),
    );

    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();

    expect(fixture.executions.get(execution.id)).toMatchObject({
      state: 'FAILED',
      outcome: {
        kind: 'FAILED',
        failure: {
          code: 'CODEX_EXECUTION_FAILED',
          message: failureSummary,
          retryable: true,
        },
      },
    });
  });

  test('Codex 启动失败保留 App Server 返回的具体失败摘要', async () => {
    const fixture = await setup();
    const binding = bindingId(3);
    await fixture.state.bind(binding, fixture.repository);
    const execution = fixture.executions.enqueue(
      input(fixture.paired.runner.id, binding, 'start-rate-limited'),
    );
    const failureSummary =
      'Codex 请求过多：429 Too Many Requests，已超过重试次数。';
    const worker = workerFor(fixture, {
      begin: async () => {
        throw new CodexAppServerError(failureSummary, null);
      },
    });

    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();

    expect(fixture.executions.get(execution.id)).toMatchObject({
      state: 'FAILED',
      sessionId: null,
      outcome: {
        kind: 'FAILED',
        failure: {
          code: 'CODEX_START_FAILED',
          message: failureSummary,
          retryable: true,
        },
      },
    });
  });

  test('Outcome 网络失败进入私有 Outbox，重启后先重放且只应用一次', async () => {
    const fixture = await setup();
    const binding = bindingId(2);
    await fixture.state.bind(binding, fixture.repository);
    const execution = fixture.executions.enqueue(
      input(fixture.paired.runner.id, binding, 'outbox'),
    );
    let failCompletion = true;
    const flakyFetch: typeof fetch = async (request, init) => {
      if (
        failCompletion &&
        String(request).endsWith(`/executions/${execution.id}/complete`)
      ) {
        failCompletion = false;
        return Response.json(
          { error: { code: 'INTERNAL_ERROR', message: '暂时不可用' } },
          { status: 503 },
        );
      }
      return fixture.dispatch(request, init);
    };
    const flakyClient = new RunnerClient(fixture.state, flakyFetch);
    const firstWorker = new RunnerWorker(
      flakyClient,
      fixture.state,
      fixture.outbox,
      new FakeCodexExecutor(async () => ({ persisted: true })),
      new AttachmentMaterializer(flakyClient, fixture.paths),
      1,
      quietOutput,
    );
    await firstWorker.cycle(0);
    await firstWorker.waitForIdle();
    expect(await fixture.outbox.list()).toHaveLength(1);
    expect(fixture.executions.get(execution.id).state).toBe('RUNNING');

    const restarted = workerFor(
      fixture,
      new FakeCodexExecutor(async () => {
        throw new Error('不应再次执行 Codex');
      }),
    );
    expect(await restarted.cycle(0)).toBe(0);
    expect(await fixture.outbox.list()).toEqual([]);
    expect(fixture.executions.get(execution.id).state).toBe('SUCCEEDED');
    expect(await restarted.replayOutbox()).toBe(true);
    expect(fixture.executions.get(execution.id).state).toBe('SUCCEEDED');
  });

  test('同 Binding 等待 Interaction 释放工程通道，处理后等待当前任务结束再恢复', async () => {
    const fixture = await setup();
    const sharedBinding = bindingId(3);
    await fixture.state.bind(sharedBinding, fixture.repository);
    const first = fixture.executions.enqueue(
      input(fixture.paired.runner.id, sharedBinding, 'interaction'),
    );
    await Bun.sleep(2);
    const second = fixture.executions.enqueue(
      input(fixture.paired.runner.id, sharedBinding, 'parallel'),
    );
    let openedInteraction: string | undefined;
    let secondStarted = false;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const executor = new FakeCodexExecutor(async (codexInput) => {
      if (codexInput.prompt.includes('interaction')) {
        const resolution = await codexInput.onInteraction({
          method: 'item/tool/requestUserInput',
          payload: {
            questions: [
              {
                id: 'continue',
                header: '继续处理',
                question: '继续吗？',
                options: [],
              },
            ],
          },
        });
        return { resolution };
      }
      secondStarted = true;
      await secondGate;
      return { parallel: true };
    });
    const originalOpen = fixture.client.openInteraction.bind(fixture.client);
    fixture.client.openInteraction = async (...args) => {
      const interaction = await originalOpen(...args);
      openedInteraction = interaction.id;
      return interaction;
    };
    const worker = workerFor(fixture, executor);

    await worker.cycle(0);
    await waitUntil(() => Boolean(openedInteraction));
    expect(fixture.executions.get(first.id).state).toBe(
      'WAITING_FOR_INTERACTION',
    );
    expect(await worker.cycle(0)).toBe(1);
    await waitUntil(() => secondStarted);
    fixture.executions.resolveInteraction(openedInteraction!, {
      answers: { continue: { answers: ['继续'] } },
    });
    await waitUntil(
      () => fixture.executions.get(first.id).state === 'WAITING_TO_RESUME',
    );
    expect(fixture.executions.get(second.id).state).toBe('RUNNING');
    releaseSecond();
    await waitUntil(
      () => fixture.executions.get(second.id).state === 'SUCCEEDED',
    );
    await worker.waitForIdle();

    expect(fixture.executions.get(first.id).state).toBe('SUCCEEDED');
    expect(fixture.executions.get(second.id).state).toBe('SUCCEEDED');
  });

  test('Runner 内部完成 Worktree Cleanup，不在主绑定仓库启动 Codex', async () => {
    const fixture = await setup();
    const binding = bindingId(4);
    await fixture.state.bind(binding, fixture.repository);
    const execution = fixture.executions.enqueue({
      ...input(fixture.paired.runner.id, binding, 'cleanup'),
      workspace: {
        key: 'cleanup:fixture',
        isolation: 'CLEANUP_WORKTREES',
        workspaceKeys: ['bug-repair:fixture'],
        completionResult: {
          outcome: 'COMPLETED',
          summary: '本机临时工作区已安全清理。',
        },
      },
    });
    let executorCalls = 0;
    const worker = workerFor(
      fixture,
      new FakeCodexExecutor(async () => {
        executorCalls += 1;
        return { unexpected: true };
      }),
      {
        prepare: async () => ({
          kind: 'COMPLETED',
          result: {
            outcome: 'COMPLETED',
            summary: '本机临时工作区已安全清理。',
          },
        }),
      },
    );

    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();

    expect(executorCalls).toBe(0);
    expect(fixture.executions.get(execution.id)).toMatchObject({
      state: 'SUCCEEDED',
      sessionId: `runner-workspace:${execution.id}`,
      outcome: {
        kind: 'SUCCEEDED',
        result: {
          outcome: 'COMPLETED',
          summary: '本机临时工作区已安全清理。',
        },
      },
    });
  });

  test('Agent 重启后不以新 Prompt 模拟恢复已中断的原生 Interaction', async () => {
    const fixture = await setup();
    const binding = bindingId(5);
    const execution = fixture.executions.enqueue(
      input(fixture.paired.runner.id, binding, 'orphaned-interaction'),
    );
    const firstClaim = (
      await fixture.executions.claim(fixture.paired.runner.id, 1, 0)
    )[0]!;
    fixture.executions.start(fixture.paired.runner.id, execution.id, {
      kind: 'STARTED',
      leaseToken: firstClaim.lease.token,
      sessionId: 'interrupted-native-turn',
    });
    const interaction = fixture.executions.openInteraction(
      fixture.paired.runner.id,
      execution.id,
      {
        leaseToken: firstClaim.lease.token,
        kind: 'APPROVAL',
        method: 'item/commandExecution/requestApproval',
        payload: { command: 'bun test' },
      },
    );
    fixture.database
      .prepare(
        `UPDATE platform_execution
         SET lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`,
      )
      .run(execution.id);
    fixture.executions.activityForRunner(fixture.paired.runner.id);
    fixture.executions.resolveInteraction(interaction.id, {
      decision: 'accept',
    });

    let executorCalls = 0;
    const worker = workerFor(
      fixture,
      new FakeCodexExecutor(async () => {
        executorCalls += 1;
        return { unexpected: true };
      }),
    );
    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();

    expect(executorCalls).toBe(0);
    expect(fixture.executions.get(execution.id)).toMatchObject({
      state: 'FAILED',
      outcome: {
        kind: 'FAILED',
        failure: {
          code: 'CODEX_START_FAILED',
          retryable: true,
        },
      },
    });
  });

  test('防御性 cancelled claim 不准备工作区、物化附件或启动 Codex', async () => {
    const fixture = await setup();
    const binding = bindingId(6);
    const execution = fixture.executions.enqueue({
      ...input(fixture.paired.runner.id, binding, 'defensive-cancel'),
      workspace: {
        key: 'bug-repair:defensive-cancel',
        isolation: 'BRANCH_WORKTREE',
        baseRef: 'origin/main',
        branch: 'apt/repair/defensive-cancel',
      },
    });
    const originalClaim = fixture.client.claimExecutions.bind(fixture.client);
    fixture.client.claimExecutions = async (...args) =>
      (await originalClaim(...args)).map((claimed) => ({
        ...claimed,
        cancellationRequested: true,
      }));
    let workspaceCalls = 0;
    let materializerCalls = 0;
    let executorCalls = 0;
    const materializer = new AttachmentMaterializer(
      fixture.client,
      fixture.paths,
    );
    materializer.materialize = async () => {
      materializerCalls += 1;
      return [];
    };
    const worker = new RunnerWorker(
      fixture.client,
      fixture.state,
      fixture.outbox,
      new FakeCodexExecutor(async () => {
        executorCalls += 1;
        return { unexpected: true };
      }),
      materializer,
      1,
      quietOutput,
      {
        prepare: async () => {
          workspaceCalls += 1;
          throw new Error('不应准备工作区');
        },
      },
    );

    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();

    expect(workspaceCalls).toBe(0);
    expect(materializerCalls).toBe(0);
    expect(executorCalls).toBe(0);
    expect(fixture.executions.get(execution.id)).toMatchObject({
      state: 'FAILED',
      outcome: {
        kind: 'FAILED',
        failure: {
          code: 'CANCELLED_BY_REQUEST',
          retryable: false,
        },
      },
    });
  });
});

class FakeCodexExecutor implements CodexExecutor {
  constructor(
    private readonly result: (input: CodexExecutionInput) => Promise<JsonValue>,
  ) {}

  async begin(
    input: CodexExecutionInput,
    _signal: AbortSignal,
  ): Promise<StartedCodexExecution> {
    return {
      sessionId: input.resumeSessionId ?? `session-${input.executionId}`,
      completion: this.result(input),
    };
  }
}

function workerFor(
  fixture: Awaited<ReturnType<typeof setup>>,
  executor: CodexExecutor,
  workspaces?: ExecutionWorkspaceManager,
): RunnerWorker {
  return new RunnerWorker(
    fixture.client,
    fixture.state,
    fixture.outbox,
    executor,
    new AttachmentMaterializer(fixture.client, fixture.paths),
    1,
    quietOutput,
    workspaces,
  );
}

function protocolFetch(
  runners: RunnerService,
  executions: ExecutionService,
  files: LocalFileStore,
): typeof fetch {
  return async (inputValue, init) => {
    const request =
      inputValue instanceof Request
        ? inputValue
        : new Request(String(inputValue), init);
    const path = new URL(request.url).pathname;
    if (path === '/api/runner/heartbeat')
      return handleRunnerHeartbeat(request, runners);
    if (path === '/api/runner/executions/claim')
      return handleExecutionClaim(request, runners, executions);
    const executionMatch =
      /^\/api\/runner\/executions\/([^/]+)\/([^/]+)$/u.exec(path);
    if (executionMatch) {
      const [, executionId, operation] = executionMatch;
      if (operation === 'start')
        return handleExecutionStart(request, executionId!, runners, executions);
      if (operation === 'renew')
        return handleExecutionRenew(request, executionId!, runners, executions);
      if (operation === 'complete')
        return handleExecutionComplete(
          request,
          executionId!,
          runners,
          executions,
        );
    }
    const openMatch =
      /^\/api\/runner\/executions\/([^/]+)\/interactions\/open$/u.exec(path);
    if (openMatch)
      return handleOpenInteraction(request, openMatch[1]!, runners, executions);
    const waitMatch = /^\/api\/runner\/interactions\/([^/]+)\/wait$/u.exec(
      path,
    );
    if (waitMatch)
      return handleWaitInteraction(request, waitMatch[1]!, runners, executions);
    const fileMatch =
      /^\/api\/runner\/executions\/([^/]+)\/files\/([^/]+)$/u.exec(path);
    if (fileMatch)
      return handleExecutionFile(
        request,
        fileMatch[1]!,
        fileMatch[2]!,
        runners,
        executions,
        files,
      );
    return Response.json(
      { error: { code: 'NOT_FOUND', message: '未找到' } },
      { status: 404 },
    );
  };
}

function input(
  runnerId: string,
  localBindingId: string,
  ownerId: string,
): EnqueueExecutionInput {
  const prompt = `fixture ${ownerId}`;
  return {
    owner: { namespace: 'fixture', kind: 'generic', id: ownerId },
    attempt: 1,
    previousExecutionId: null,
    runnerId,
    bindingId: localBindingId,
    promptKind: 'fixture.generic',
    promptVersion: 1,
    renderedPrompt: prompt,
    renderedPromptHash: createHash('sha256').update(prompt).digest('hex'),
    outputJsonSchema: { type: 'object' },
    attachmentIds: [],
    resumeSessionId: null,
  };
}

function bindingId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('等待条件超时');
}

const quietOutput = {
  log: () => undefined,
  error: () => undefined,
};
