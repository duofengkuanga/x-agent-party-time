import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Runner,
  RunnerAuthorizationClaimResponse,
  RunnerAuthorizationCreateRequest,
} from '@agent-party-time/runner-contract';
import type { Browser, Clock, Keychain } from '../platform/contracts';
import { NodeLocalFileSystem } from '../platform/files';
import { keychainAccount } from '../platform/macos/keychain';
import { xaptPaths } from '../platform/paths';
import { CONNECTION_STATE_SCHEMA_VERSION } from '../state/schemas';
import { LocalStateStore } from '../state/store';
import { ConnectionCoordinator } from './connection';
import { RunnerHttpError, type RunnerAuthorizationHttp } from './runner-http';

const homes: string[] = [];
const now = new Date('2026-08-03T08:00:00.000Z');
const oldRunnerId = '00000000-0000-4000-8000-000000000001';
const newRunnerId = '00000000-0000-4000-8000-000000000002';
const credential = 'credential-secret-at-least-thirty-two-characters';

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('授权成功只把 Credential 写入 Keychain 并报告浏览器进度', async () => {
  const fixture = await createFixture();
  const progress: unknown[] = [];

  await fixture.connection.connect('https://apt.example.com/path', (value) =>
    progress.push(value),
  );

  expect(progress).toEqual([
    {
      authorizationUrl: expect.stringContaining(
        'https://apt.example.com/cooking/agents/connect?request=',
      ),
      fingerprint: expect.stringMatching(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/),
      browserOpened: true,
    },
  ]);
  expect(await fixture.state.loadConnection()).toEqual({
    schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
    serverUrl: 'https://apt.example.com',
    runnerId: newRunnerId,
  });
  expect(
    await fixture.keychain.read(
      keychainAccount('https://apt.example.com', newRunnerId),
    ),
  ).toBe(credential);
  expect(JSON.stringify(await fixture.state.loadConnection())).not.toContain(
    credential,
  );
  expect(fixture.connection.projection).toMatchObject({
    status: 'CONNECTED',
    activity: 'IDLE',
    serverOrigin: 'https://apt.example.com',
    agentName: '测试 Agent',
  });
});

test('浏览器打开失败仍立即给出可复制 URL，授权可继续完成', async () => {
  const fixture = await createFixture({ browserFails: true });
  const progress: Array<{ browserOpened: boolean; authorizationUrl: string }> =
    [];

  await fixture.connection.connect('https://apt.example.com', (value) =>
    progress.push(value),
  );

  expect(progress).toHaveLength(1);
  expect(progress[0]).toMatchObject({
    browserOpened: false,
    authorizationUrl: expect.stringContaining('/cooking/agents/connect'),
  });
  expect(fixture.connection.projection.status).toBe('CONNECTED');
});

test('健康的同 Server 连接幂等返回，不创建新授权', async () => {
  const fixture = await createFixture();
  await fixture.connection.connect('https://apt.example.com', () => {});
  const issued = fixture.http.created.length;

  await fixture.connection.connect('https://apt.example.com/other', () => {});

  expect(fixture.http.created).toHaveLength(issued);
  expect(fixture.http.heartbeats).toHaveLength(1);
});

test('删除连接状态后重新授权仍使用同一安装身份', async () => {
  const fixture = await createFixture();
  await fixture.connection.connect('https://apt.example.com', () => {});
  const firstInstallationId = fixture.http.created[0]?.installationId;

  await fixture.state.removeConnection();
  await fixture.connection.connect('https://apt.example.com', () => {});

  expect(firstInstallationId).toBeString();
  expect(
    fixture.http.created.map(({ installationId }) => installationId),
  ).toEqual([firstInstallationId, firstInstallationId]);
});

test('不同 Server 被拒绝且不改变已有状态或 Credential', async () => {
  const fixture = await createFixture();
  await fixture.connection.connect('https://apt.example.com', () => {});

  await expect(
    fixture.connection.connect('https://other.example.com', () => {}),
  ).rejects.toMatchObject({ code: 'DIFFERENT_SERVER' });
  expect(await fixture.state.loadConnection()).toMatchObject({
    serverUrl: 'https://apt.example.com',
    runnerId: newRunnerId,
  });
  expect(fixture.http.created).toHaveLength(1);
});

test('Credential 撤销后重授权，持久化新身份再删除旧 Keychain 项', async () => {
  const fixture = await createFixture({ heartbeatRevoked: true });
  await fixture.state.saveConnection({
    schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
    serverUrl: 'https://apt.example.com',
    runnerId: oldRunnerId,
  });
  const oldAccount = keychainAccount('https://apt.example.com', oldRunnerId);
  await fixture.keychain.save(oldAccount, `${credential}-old`);

  await fixture.connection.connect('https://apt.example.com', () => {});

  expect(await fixture.keychain.read(oldAccount)).toBeNull();
  expect(await fixture.state.loadConnection()).toMatchObject({
    runnerId: newRunnerId,
  });
  expect(fixture.connection.projection.status).toBe('CONNECTED');
});

test('恢复时缺少 Credential 明确进入 REVOKED', async () => {
  const fixture = await createFixture();
  await fixture.state.saveConnection({
    schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
    serverUrl: 'https://apt.example.com',
    runnerId: oldRunnerId,
  });

  await fixture.connection.restore();

  expect(fixture.connection.projection).toMatchObject({
    status: 'REVOKED',
    serverOrigin: 'https://apt.example.com',
  });
});

async function createFixture(
  options: { browserFails?: boolean; heartbeatRevoked?: boolean } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'xapt-connection-'));
  homes.push(home);
  const state = new LocalStateStore(xaptPaths(home), new NodeLocalFileSystem());
  await state.initialize();
  const keychain = new MemoryKeychain();
  const http = new FakeAuthorizationHttp(options.heartbeatRevoked ?? false);
  const browser = new FakeBrowser(options.browserFails ?? false);
  const clock: Clock = {
    now: () => now,
    sleep: async () => {},
  };
  return {
    state,
    keychain,
    http,
    browser,
    connection: new ConnectionCoordinator(
      state,
      keychain,
      browser,
      http,
      clock,
      () => 'v'.repeat(43),
      () => '测试 Agent',
    ),
  };
}

class MemoryKeychain implements Keychain {
  private readonly values = new Map<string, string>();

  async save(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async read(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

class FakeBrowser implements Browser {
  constructor(private readonly fails: boolean) {}

  async open(): Promise<void> {
    if (this.fails) throw new Error('browser unavailable');
  }
}

class FakeAuthorizationHttp implements RunnerAuthorizationHttp {
  readonly created: RunnerAuthorizationCreateRequest[] = [];
  readonly heartbeats: string[] = [];

  constructor(private readonly heartbeatRevoked: boolean) {}

  async createAuthorization(
    _serverOrigin: string,
    input: RunnerAuthorizationCreateRequest,
  ) {
    this.created.push(input);
    return {
      requestId: 'request_identifier_that_is_long_enough_001',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
  }

  async claimAuthorization(): Promise<RunnerAuthorizationClaimResponse> {
    return {
      state: 'AUTHORIZED',
      runner: runner(newRunnerId),
      credential,
    };
  }

  async heartbeat(_serverOrigin: string, value: string): Promise<Runner> {
    this.heartbeats.push(value);
    if (this.heartbeatRevoked)
      throw new RunnerHttpError('NOT_AUTHENTICATED', 'revoked', 401);
    return runner(newRunnerId);
  }

  async revokeSelf(): Promise<Runner> {
    return { ...runner(newRunnerId), revokedAt: now.toISOString() };
  }
}

function runner(id: string): Runner {
  return {
    id,
    ownerUserId: 'user-1',
    name: '测试 Agent',
    version: 1,
    lastSeenAt: now.toISOString(),
    revokedAt: null,
    createdAt: now.toISOString(),
  };
}
