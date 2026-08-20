import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Runner,
  RunnerAuthorizationClaimResponse,
  RunnerAuthorizationCreateRequest,
  RunnerAuthorizationIssue,
} from '@agent-party-time/runner-contract';
import type { Browser, Clock, Keychain } from '../platform/contracts';
import { NodeLocalFileSystem } from '../platform/files';
import { keychainAccount } from '../platform/macos/keychain';
import { xaptPaths } from '../platform/paths';
import { CONNECTION_STATE_SCHEMA_VERSION } from '../state/schemas';
import { LocalStateStore } from '../state/store';
import { ConnectionCoordinator } from './connection';
import { DaemonControlClient } from './control';
import type { RunnerAuthorizationHttp } from './runner-http';
import { DaemonRuntime } from './runtime';

const homes: string[] = [];
const runnerId = '00000000-0000-4000-8000-000000000001';
const credential = 'credential-secret-at-least-thirty-two-characters';
const now = new Date('2026-08-20T08:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('远程连接恢复阻塞时 control socket 仍先可用', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xapt-runtime-'));
  homes.push(home);
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  await state.saveConnection({
    schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
    serverUrl: 'http://10.10.96.169:3000',
    runnerId,
  });
  const keychain = new MemoryKeychain();
  await keychain.save(
    keychainAccount('http://10.10.96.169:3000', runnerId),
    credential,
  );
  const http = new BlockingAuthorizationHttp();
  const connection = new ConnectionCoordinator(
    state,
    keychain,
    new NoopBrowser(),
    http,
    new FixedClock(),
  );
  const runtime = new DaemonRuntime({
    paths,
    files,
    state,
    codex: { executable: '/opt/bin/codex', version: '0.146.0' },
    connection,
  });
  const control = new DaemonControlClient(paths.controlSocket, 200);
  const runtimeTask = runtime.run();
  await http.heartbeatStarted;

  try {
    expect(await control.status()).toMatchObject({
      service: 'RUNNING',
      serverOrigin: 'http://10.10.96.169:3000',
    });
  } finally {
    http.resolveHeartbeat(runner());
    await stopWhenReady(control);
    await runtimeTask;
  }
});

test('远程连接恢复失败时关闭已启动的 control socket', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xapt-runtime-'));
  homes.push(home);
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  await state.saveConnection({
    schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
    serverUrl: 'https://apt.example.com',
    runnerId,
  });
  const connection = new ConnectionCoordinator(
    state,
    new RejectingKeychain(),
    new NoopBrowser(),
    new BlockingAuthorizationHttp(),
    new FixedClock(),
  );
  const runtime = new DaemonRuntime({
    paths,
    files,
    state,
    codex: { executable: '/opt/bin/codex', version: '0.146.0' },
    connection,
  });
  const control = new DaemonControlClient(paths.controlSocket, 200);

  await expect(runtime.run()).rejects.toThrow('keychain unavailable');
  try {
    expect(await files.info(paths.controlSocket)).toBeNull();
  } finally {
    if (await files.info(paths.controlSocket)) await control.stop();
  }
});

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

class RejectingKeychain implements Keychain {
  async save(): Promise<void> {}

  async read(): Promise<string | null> {
    throw new Error('keychain unavailable');
  }

  async delete(): Promise<void> {}
}

class NoopBrowser implements Browser {
  async open(): Promise<void> {}
}

class FixedClock implements Clock {
  now(): Date {
    return now;
  }

  async sleep(): Promise<void> {}
}

class BlockingAuthorizationHttp implements RunnerAuthorizationHttp {
  private resolveStarted!: () => void;
  private resolveResponse!: (value: Runner) => void;
  readonly heartbeatStarted = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly heartbeatResponse = new Promise<Runner>((resolve) => {
    this.resolveResponse = resolve;
  });

  async createAuthorization(
    _serverOrigin: string,
    _input: RunnerAuthorizationCreateRequest,
  ): Promise<RunnerAuthorizationIssue> {
    throw new Error('not used');
  }

  async claimAuthorization(): Promise<RunnerAuthorizationClaimResponse> {
    throw new Error('not used');
  }

  async heartbeat(): Promise<Runner> {
    this.resolveStarted();
    return await this.heartbeatResponse;
  }

  async revokeSelf(): Promise<Runner> {
    throw new Error('not used');
  }

  resolveHeartbeat(value: Runner): void {
    this.resolveResponse(value);
  }
}

async function stopWhenReady(control: DaemonControlClient): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await control.stop();
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error('control socket 未能及时启动');
}

function runner(): Runner {
  return {
    id: runnerId,
    ownerUserId: 'user-1',
    name: '测试 Agent',
    version: 1,
    lastSeenAt: now.toISOString(),
    revokedAt: null,
    createdAt: now.toISOString(),
  };
}
