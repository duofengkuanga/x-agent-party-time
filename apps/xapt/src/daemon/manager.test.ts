import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchAgent, UserEnvironment } from '../platform/contracts';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { SystemClock } from '../platform/system';
import { LocalStateStore } from '../state/store';
import { STATE_SCHEMA_VERSION } from '../state/schemas';
import type { CodexPreflight } from './codex';
import { DaemonControlClient } from './control';
import { DaemonManager } from './manager';
import { DaemonRuntime } from './runtime';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('daemon 首次启动、重复启动、状态、停止和重复停止保持幂等', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await files.writeAtomic(paths.currentExecutable, 'executable', 0o755);
  const launchAgent = new RuntimeLaunchAgent(
    () =>
      new DaemonRuntime({
        paths,
        files,
        state,
        codex: { executable: '/opt/bin/codex', version: '0.146.0' },
      }),
  );
  const manager = new DaemonManager({
    paths,
    files,
    state,
    launchAgent,
    codex: healthyCodex(),
    control: new DaemonControlClient(paths.controlSocket, 500),
    confirmation: { confirm: async () => true },
    clock: new SystemClock(),
    environment: macEnvironment(home),
    stableExecutable: paths.currentExecutable,
    startupTimeoutMs: 1_000,
  });

  expect(await manager.status()).toMatchObject({ service: 'STOPPED' });
  expect(await manager.start()).toMatchObject({
    alreadyRunning: false,
    snapshot: { service: 'RUNNING', connection: 'UNCONFIGURED' },
  });
  expect(await manager.start()).toMatchObject({ alreadyRunning: true });
  expect(await manager.status()).toMatchObject({
    service: 'RUNNING',
    codexVersion: '0.146.0',
  });
  expect((await stat(paths.launchAgentPlist)).mode & 0o777).toBe(0o644);
  const plist = await readFile(paths.launchAgentPlist, 'utf8');
  expect(plist).toContain(`<string>${paths.currentExecutable}</string>`);
  expect(plist).toContain('<string>internal-daemon</string>');
  expect(plist).toContain(`<key>HOME</key><string>${home}</string>`);
  expect(plist).toContain(
    `<string>${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`,
  );
  expect(plist).toContain('<integer>30</integer>');

  const outboxId = '00000000-0000-4000-8000-000000000101';
  await state.saveOutbox({
    schemaVersion: STATE_SCHEMA_VERSION,
    id: outboxId,
    kind: 'START',
    executionId: '00000000-0000-4000-8000-000000000102',
    request: {
      kind: 'START_FAILED',
      leaseToken: 'x'.repeat(32),
      failure: {
        code: 'CODEX_START_FAILED',
        message: '网络中断后待重放',
        retryable: true,
      },
    },
    createdAt: '2026-08-03T08:00:00.000Z',
  });
  await expect(manager.stop()).rejects.toMatchObject({ code: 'BUSY' });
  await state.removeOutbox(outboxId);

  expect(await manager.stop()).toEqual({ alreadyStopped: false });
  await launchAgent.waitForRuntime();
  expect(await manager.stop()).toEqual({ alreadyStopped: true });
  expect(await manager.status()).toMatchObject({ service: 'STOPPED' });
  expect(launchAgent.registerCount).toBe(1);
  expect(launchAgent.startCount).toBe(1);
});

test('未知 socket 文件、无响应状态与不支持平台有确定结果', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await files.writeAtomic(paths.currentExecutable, 'executable', 0o755);
  await files.writeAtomic(paths.controlSocket, 'unknown', 0o600);
  const manager = new DaemonManager({
    paths,
    files,
    state,
    launchAgent: new RuntimeLaunchAgent(() => {
      throw new Error('must not start');
    }),
    codex: healthyCodex(),
    control: new DaemonControlClient(paths.controlSocket, 20),
    confirmation: { confirm: async () => true },
    clock: new SystemClock(),
    environment: macEnvironment(home),
    stableExecutable: paths.currentExecutable,
  });

  expect(await manager.status()).toMatchObject({ service: 'UNRESPONSIVE' });
  await expect(manager.stop(true)).rejects.toMatchObject({
    code: 'TTY_REQUIRED',
  });
  await expect(manager.start()).rejects.toMatchObject({
    code: 'SOCKET_OCCUPIED',
  });
  await files.remove(paths.controlSocket);

  const unsupported = new DaemonManager({
    paths,
    files,
    state,
    launchAgent: new RuntimeLaunchAgent(() => {
      throw new Error('must not start');
    }),
    codex: healthyCodex(),
    control: new DaemonControlClient(paths.controlSocket, 20),
    confirmation: { confirm: async () => true },
    clock: new SystemClock(),
    environment: { ...macEnvironment(home), architecture: () => 'x64' },
    stableExecutable: paths.currentExecutable,
  });
  await expect(unsupported.start()).rejects.toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
  });
});

class RuntimeLaunchAgent implements LaunchAgent {
  registerCount = 0;
  startCount = 0;
  private runtimeTask: Promise<void> | null = null;

  constructor(private readonly createRuntime: () => DaemonRuntime) {}

  async register(): Promise<void> {
    this.registerCount += 1;
  }

  async start(): Promise<void> {
    this.startCount += 1;
    this.runtimeTask = this.createRuntime().run();
  }

  async stop(): Promise<void> {}

  async unregister(): Promise<void> {}

  async waitForRuntime(): Promise<void> {
    await this.runtimeTask;
  }
}

function healthyCodex(): CodexPreflight {
  return {
    check: async () => ({
      executable: '/opt/bin/codex',
      version: '0.146.0',
    }),
  };
}

function macEnvironment(home: string): UserEnvironment {
  return {
    homeDirectory: () => home,
    userId: () => 501,
    platform: () => 'darwin',
    architecture: () => 'arm64',
    isTerminal: () => false,
  };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'xapt-manager-'));
  homes.push(home);
  return home;
}
