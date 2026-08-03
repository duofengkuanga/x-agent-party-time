import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Keychain, UserEnvironment } from '../platform/contracts';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { LocalStateStore } from '../state/store';
import { stoppedSnapshot, type DaemonSnapshot } from '../daemon/status';
import { UninstallManager } from './uninstall';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('安全卸载先撤销远程 Credential，并只删除 xapt 自有资源', async () => {
  const fixture = await createFixture();
  await fixture.files.writeAtomic(fixture.paths.commandLink, 'link', 0o755);
  await fixture.files.writeAtomic(
    join(fixture.home, '.codex', 'auth.json'),
    'preserve',
    0o600,
  );

  const result = await fixture.manager.uninstall(false);

  expect(result).toEqual({ remoteRevoked: true, warnings: [] });
  expect(fixture.events).toEqual(['start', 'revoke', 'stop:false:false']);
  expect(await fixture.files.info(fixture.paths.applicationSupport)).toBeNull();
  expect(await fixture.files.info(fixture.paths.installRoot)).toBeNull();
  expect(await fixture.files.info(fixture.paths.commandLink)).toBeNull();
  expect(
    await fixture.files.read(join(fixture.home, '.codex', 'auth.json')),
  ).not.toBeNull();
});

test('普通卸载在 Outbox 未收敛时不启动、不撤销也不删除', async () => {
  const fixture = await createFixture();
  await fixture.state.saveOutbox({
    schemaVersion: 1,
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'START',
    executionId: '00000000-0000-4000-8000-000000000002',
    request: {
      kind: 'STARTED',
      leaseToken: 'lease-token-000000000000000000000000',
      sessionId: 'session-1',
    },
    createdAt: '2026-08-03T00:00:00.000Z',
  });

  await expect(fixture.manager.uninstall(false)).rejects.toMatchObject({
    code: 'UNSETTLED_STATE',
  });
  expect(fixture.events).toEqual([]);
  expect(
    await fixture.files.info(fixture.paths.applicationSupport),
  ).not.toBeNull();
});

test('只含空 Workspace 索引时允许安全卸载', async () => {
  const fixture = await createFixture();
  await fixture.files.writeAtomic(
    join(fixture.paths.workspaces, 'state.json'),
    '{"workspaces":{}}\n',
    0o600,
  );

  expect(await fixture.manager.uninstall(false)).toMatchObject({
    remoteRevoked: true,
  });
});

test('强制卸载在任何副作用前要求真实 TTY 且允许取消', async () => {
  const noTty = await createFixture({ terminal: false, confirmed: true });
  await expect(noTty.manager.uninstall(true)).rejects.toMatchObject({
    code: 'TTY_REQUIRED',
  });
  expect(noTty.events).toEqual([]);

  const cancelled = await createFixture({ terminal: true, confirmed: false });
  await expect(cancelled.manager.uninstall(true)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  expect(cancelled.events).toEqual(['confirm']);
  expect(
    await cancelled.files.info(cancelled.paths.applicationSupport),
  ).not.toBeNull();
});

test('强制离线卸载仍删除可定位的本机 Keychain Credential', async () => {
  const fixture = await createFixture({ terminal: true, confirmed: true });
  await fixture.state.saveConnection({
    schemaVersion: 1,
    serverUrl: 'https://apt.example.com',
    runnerId: '00000000-0000-4000-8000-000000000009',
  });

  const result = await fixture.manager.uninstall(true);

  expect(result).toEqual({
    remoteRevoked: false,
    warnings: ['Server 离线，远程 Credential 状态未知'],
  });
  expect(fixture.events).toEqual([
    'confirm',
    'stop:true:true',
    'keychain-delete',
  ]);
});

async function createFixture(
  options: { terminal?: boolean; confirmed?: boolean } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'xapt-uninstall-'));
  homes.push(home);
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  const events: string[] = [];
  let snapshot: DaemonSnapshot = stoppedSnapshot('0.1.0');
  const daemon = {
    status: async () => snapshot,
    start: async () => {
      events.push('start');
      snapshot = { ...snapshot, service: 'RUNNING' };
      return { snapshot, alreadyRunning: false };
    },
    stop: async (force = false, confirmed = false) => {
      events.push(`stop:${force}:${confirmed}`);
      snapshot = stoppedSnapshot('0.1.0');
      return { alreadyStopped: false };
    },
  };
  const environment: UserEnvironment = {
    homeDirectory: () => home,
    userId: () => 501,
    platform: () => 'darwin',
    architecture: () => 'arm64',
    isTerminal: () => options.terminal ?? true,
  };
  const manager = new UninstallManager(
    paths,
    files,
    state,
    daemon,
    {
      revoke: async () => {
        events.push('revoke');
        return snapshot;
      },
    },
    {
      confirm: async () => {
        events.push('confirm');
        return options.confirmed ?? true;
      },
    },
    environment,
    new RecordingKeychain(events),
  );
  return { home, paths, files, state, events, manager };
}

class RecordingKeychain implements Keychain {
  constructor(private readonly events: string[]) {}

  async save(): Promise<void> {}

  async read(): Promise<string | null> {
    return null;
  }

  async delete(): Promise<void> {
    this.events.push('keychain-delete');
  }
}
