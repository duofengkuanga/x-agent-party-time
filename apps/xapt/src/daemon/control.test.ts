import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { DaemonControlClient, DaemonControlServer } from './control';
import type { DaemonSnapshot } from './status';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('私有 Unix control socket 完成握手、状态与安全停止', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const server = new DaemonControlServer({
    socketPath: paths.controlSocket,
    files,
    snapshot: async () => runningSnapshot(),
  });
  await server.start();
  const client = new DaemonControlClient(paths.controlSocket, 500);

  expect(await client.status()).toEqual(runningSnapshot());
  expect(await files.info(paths.controlSocket)).toMatchObject({
    type: 'socket',
    mode: 0o600,
  });
  expect(await files.info(paths.run)).toMatchObject({
    type: 'directory',
    mode: 0o700,
  });

  await client.stop();
  await server.done;
  expect(await files.info(paths.controlSocket)).toBeNull();
});

test('control socket 位置的未知文件不会被删除', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  await files.writeAtomic(paths.controlSocket, 'unknown', 0o600);
  const server = new DaemonControlServer({
    socketPath: paths.controlSocket,
    files,
    snapshot: async () => runningSnapshot(),
  });

  await expect(server.start()).rejects.toMatchObject({
    code: 'SOCKET_OCCUPIED',
  });
  expect(
    new TextDecoder().decode((await files.read(paths.controlSocket))!),
  ).toBe('unknown');
});

test('普通 stop 在 daemon 忙碌时拒绝且保留运行状态', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const server = new DaemonControlServer({
    socketPath: paths.controlSocket,
    files,
    snapshot: async () => ({ ...runningSnapshot(), activity: 'BUSY' }),
  });
  await server.start();
  const client = new DaemonControlClient(paths.controlSocket, 500);

  await expect(client.stop()).rejects.toMatchObject({ code: 'DAEMON_BUSY' });
  expect(await client.status()).toMatchObject({
    service: 'RUNNING',
    activity: 'BUSY',
  });
  await server.close();
});

test('force stop 在忙碌时触发尽力持久化钩子并关闭控制通道', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  let forced = false;
  const server = new DaemonControlServer({
    socketPath: paths.controlSocket,
    files,
    snapshot: async () => ({ ...runningSnapshot(), activity: 'BUSY' }),
    forceStop: async () => {
      forced = true;
    },
  });
  await server.start();

  await new DaemonControlClient(paths.controlSocket, 500).stop(true);
  await server.done;

  expect(forced).toBe(true);
  expect(await files.info(paths.controlSocket)).toBeNull();
});

test('connect 在同一控制请求上先流式报告进度再返回最终状态', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  let connected = false;
  const server = new DaemonControlServer({
    socketPath: paths.controlSocket,
    files,
    snapshot: async () => ({
      ...runningSnapshot(),
      connection: connected ? 'CONNECTED' : 'UNCONFIGURED',
    }),
    connect: async (_serverUrl, progress) => {
      progress({
        authorizationUrl:
          'https://apt.example.com/cooking/agents/connect?request=req_1',
        fingerprint: 'ABCD-EF12-3456',
        browserOpened: false,
      });
      connected = true;
    },
  });
  await server.start();
  const progress: unknown[] = [];

  const snapshot = await new DaemonControlClient(
    paths.controlSocket,
    500,
  ).connect('https://apt.example.com', (value) => progress.push(value), 500);

  expect(progress).toEqual([
    {
      authorizationUrl:
        'https://apt.example.com/cooking/agents/connect?request=req_1',
      fingerprint: 'ABCD-EF12-3456',
      browserOpened: false,
    },
  ]);
  expect(snapshot.connection).toBe('CONNECTED');
  await server.close();
});

function runningSnapshot(): DaemonSnapshot {
  return {
    service: 'RUNNING',
    connection: 'UNCONFIGURED',
    activity: 'IDLE',
    version: '0.1.0',
    codexVersion: '0.146.0',
    serverOrigin: null,
    agentName: null,
    lastHeartbeatAt: null,
    activeSlots: 0,
    totalSlots: 3,
    waitingInteractions: 0,
    outboxCount: 0,
    bindingCount: 0,
    bindingActive: false,
  };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'xapt-control-'));
  homes.push(home);
  return home;
}
