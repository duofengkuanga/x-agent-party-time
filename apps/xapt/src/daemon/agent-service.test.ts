import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RunnerBindingRef,
  RunnerBindingWork,
  RunnerBindingWorkCompletion,
} from '@agent-party-time/runner-contract';
import type { Clock } from '../platform/contracts';
import { NodeLocalFileSystem } from '../platform/files';
import type { DirectorySelector } from '../platform/macos/directory-selector';
import { xaptPaths } from '../platform/paths';
import type { LocalRepositoryInspector } from '../platform/repository';
import { LocalStateStore } from '../state/store';
import { OUTBOX_STATE_SCHEMA_VERSION } from '../state/schemas';
import type { ExecutionService } from '../execution/service';
import { AgentService } from './agent-service';
import type {
  AuthenticatedRunnerSession,
  ConnectionCoordinator,
} from './connection';
import type { RunnerBindingHttp } from './runner-http';

const homes: string[] = [];
const bindingId = '00000000-0000-4000-8000-000000000201';
const requestId = '00000000-0000-4000-8000-000000000202';

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('合法 Binding 先持久化本机映射，再只向 Server 发送仓库 Origin', async () => {
  const fixture = await createFixture('/private/local/repository');

  expect(await fixture.service.cycle()).toBe(true);

  expect(fixture.http.completions).toEqual([
    {
      outcome: 'SUCCEEDED',
      repositoryUrl: 'https://github.com/team/repository.git',
    },
  ]);
  expect(JSON.stringify(fixture.http.completions)).not.toContain(
    '/private/local/repository',
  );
  expect(await fixture.state.loadBindings()).toMatchObject({
    bindings: {
      [bindingId]: {
        bindingId,
        repositoryPath: '/private/local/repository',
      },
    },
  });
  expect(fixture.service.projection.bindingActive).toBe(false);
});

test('目录取消不上报路径、不创建本机半条目', async () => {
  const fixture = await createFixture(null);

  await fixture.service.cycle();

  expect(fixture.http.completions).toEqual([
    {
      outcome: 'FAILED',
      code: 'CANCELLED',
      message: '已取消选择仓库目录',
    },
  ]);
  expect((await fixture.state.loadBindings()).bindings).toEqual({});
});

test('Server 拒绝 Origin 时回滚本机 Binding 映射', async () => {
  const fixture = await createFixture('/private/local/repository');
  fixture.http.completionState = 'FAILED';

  await fixture.service.cycle();

  expect((await fixture.state.loadBindings()).bindings).toEqual({});
});

test('恢复记录优先于 Binding 工作，并向 Server 报告零可用槽位', async () => {
  const events: string[] = [];
  const execution = {
    projection: {
      activeExecutionCount: 0,
      waitingInteractionCount: 0,
      recoveryRequired: true,
    },
    cycle: async () => {
      events.push('execution');
      return true;
    },
    hasRecoveryRecords: async () => true,
    waitForIdle: async () => {},
    forceStop: () => {},
  } as unknown as ExecutionService;
  const fixture = await createFixture('/private/local/repository', execution);
  await fixture.state.saveOutbox({
    schemaVersion: OUTBOX_STATE_SCHEMA_VERSION,
    id: '00000000-0000-4000-8000-000000000203',
    kind: 'START',
    executionId: '00000000-0000-4000-8000-000000000204',
    request: {
      kind: 'START_FAILED',
      leaseToken: 'x'.repeat(32),
      failure: {
        code: 'CODEX_START_FAILED',
        message: '等待重放',
        retryable: true,
      },
    },
    createdAt: '2026-08-03T08:00:00.000Z',
  });

  expect(await fixture.service.cycle()).toBe(true);
  expect(fixture.heartbeatSlots).toEqual([0]);
  expect(events).toEqual(['execution']);
  expect(fixture.http.claimCalls).toBe(0);
});

test('当前进程持有的 Execution 状态不占用恢复期零槽保护', async () => {
  const execution = {
    projection: {
      activeExecutionCount: 1,
      waitingInteractionCount: 0,
      recoveryRequired: false,
    },
    cycle: async () => true,
    hasRecoveryRecords: async () => false,
    waitForIdle: async () => {},
    forceStop: () => {},
  } as unknown as ExecutionService;
  const fixture = await createFixture('/private/local/repository', execution);

  await fixture.service.cycle();

  expect(fixture.heartbeatSlots).toEqual([2]);
  expect(fixture.http.claimCalls).toBe(0);
});

async function createFixture(
  repositoryPath: string | null,
  executions?: ExecutionService,
) {
  const home = await mkdtemp(join(tmpdir(), 'xapt-agent-service-'));
  homes.push(home);
  const state = new LocalStateStore(xaptPaths(home), new NodeLocalFileSystem());
  await state.initialize();
  const session: AuthenticatedRunnerSession = {
    serverOrigin: 'https://apt.example.com',
    credential: 'credential-secret-at-least-thirty-two-characters',
  };
  const heartbeatSlots: number[] = [];
  const connection = {
    heartbeat: async (slots: number) => {
      heartbeatSlots.push(slots);
      return session;
    },
    reportConnectionError: () => {},
  } as unknown as ConnectionCoordinator;
  const http = new FakeBindingHttp();
  const selector: DirectorySelector = {
    selectDirectory: async () => repositoryPath,
  };
  const repositories = {
    origin: async () => 'https://github.com/team/repository.git',
  } as unknown as LocalRepositoryInspector;
  const clock: Clock = { now: () => new Date(), sleep: async () => {} };
  return {
    state,
    http,
    heartbeatSlots,
    service: new AgentService(
      connection,
      http,
      state,
      selector,
      repositories,
      clock,
      executions,
    ),
  };
}

class FakeBindingHttp implements RunnerBindingHttp {
  readonly completions: RunnerBindingWorkCompletion[] = [];
  claimCalls = 0;
  completionState: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED';

  async listBindings(): Promise<RunnerBindingRef[]> {
    return [];
  }

  async claimBindingWork(): Promise<RunnerBindingWork | null> {
    this.claimCalls += 1;
    return {
      requestId,
      bindingId,
      expiresAt: '2026-08-03T09:00:00.000Z',
    };
  }

  async completeBindingWork(
    _origin: string,
    _credential: string,
    _requestId: string,
    completion: RunnerBindingWorkCompletion,
  ): Promise<'SUCCEEDED' | 'FAILED'> {
    this.completions.push(completion);
    return this.completionState;
  }
}
