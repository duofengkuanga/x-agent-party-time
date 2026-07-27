import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EnqueueExecutionInput,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { AuthService } from '@/platform/auth/service';
import type { AppDatabase } from '@/platform/database';
import { openDatabase } from '@/platform/database';
import {
  handleExecutionClaim,
  handleExecutionComplete,
  handleExecutionFile,
  handleExecutionRenew,
  handleExecutionStart,
  handleOpenInteraction,
  handleWaitInteraction,
} from '@/platform/execution/http';
import { ExecutionService } from '@/platform/execution/service';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { RunnerService } from '@/platform/runner/service';
import { handleRunnerHeartbeat } from '@/platform/runner/http';
import { AttachmentMaterializer } from '../../../../../packages/runner/src/attachments';
import type {
  CodexExecutionInput,
  CodexExecutor,
  StartedCodexExecution,
} from '../../../../../packages/runner/src/codex-app-server';
import { RunnerClient } from '../../../../../packages/runner/src/client';
import { ExecutionOutbox } from '../../../../../packages/runner/src/outbox';
import {
  RunnerStateStore,
  runnerLocalPaths,
} from '../../../../../packages/runner/src/state';
import { RunnerWorker } from '../../../../../packages/runner/src/worker';

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

  test('等待 Interaction 释放本机 Slot，同时 Server 保留原 Binding', async () => {
    const fixture = await setup();
    const firstBinding = bindingId(3);
    const secondBinding = bindingId(4);
    await fixture.state.bind(firstBinding, fixture.repository);
    await fixture.state.bind(secondBinding, fixture.repository);
    const first = fixture.executions.enqueue(
      input(fixture.paired.runner.id, firstBinding, 'interaction'),
    );
    await Bun.sleep(2);
    const second = fixture.executions.enqueue(
      input(fixture.paired.runner.id, secondBinding, 'parallel'),
    );
    let openedInteraction: string | undefined;
    const executor = new FakeCodexExecutor(async (codexInput) => {
      if (codexInput.prompt.includes('interaction')) {
        const resolution = await codexInput.onInteraction({
          method: 'item/tool/requestUserInput',
          payload: { question: '继续吗？' },
        });
        return { resolution };
      }
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
    await waitUntil(
      () => fixture.executions.get(second.id).state === 'SUCCEEDED',
    );
    fixture.executions.resolveInteraction(openedInteraction!, {
      answer: '继续',
    });
    await worker.waitForIdle();

    expect(fixture.executions.get(first.id).state).toBe('SUCCEEDED');
    expect(fixture.executions.get(second.id).state).toBe('SUCCEEDED');
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
): RunnerWorker {
  return new RunnerWorker(
    fixture.client,
    fixture.state,
    fixture.outbox,
    executor,
    new AttachmentMaterializer(fixture.client, fixture.paths),
    1,
    quietOutput,
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
