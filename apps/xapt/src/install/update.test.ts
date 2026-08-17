import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, CommandRunner } from '../platform/contracts';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { INSTALL_STATE_SCHEMA_VERSION } from '../state/schemas';
import { LocalStateStore } from '../state/store';
import { stoppedSnapshot, type DaemonSnapshot } from '../daemon/status';
import { UpdateManager } from './update';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('已是最新版本时不下载、不停止 daemon', async () => {
  const fixture = await createFixture('0.2.0');

  expect(await fixture.manager.update()).toEqual({
    updated: false,
    version: '0.2.0',
    daemonRestarted: false,
  });
  expect(fixture.events).toEqual(['release']);
});

test('Release 来源可替换以执行真实候选版本验收', async () => {
  const fixture = await createFixture('0.2.0', false, {
    apiBaseUrl: 'http://127.0.0.1:18765',
    repository: 'test/xapt',
  });

  await fixture.manager.update();

  expect(fixture.requests[0]).toBe(
    'http://127.0.0.1:18765/repos/test/xapt/releases/latest',
  );
});

test('目标 xapt 生成自身版本的安装状态', async () => {
  const fixture = await createFixture('0.3.4');

  expect(
    JSON.parse(
      fixture.manager.renderInstallState('0.3.4', '2026-08-01T00:00:00.000Z'),
    ),
  ).toEqual({
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    currentVersion: '0.4.0',
    previousVersion: '0.3.4',
    installedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  });
});

test('校验资产并原子切换版本，只保留当前和上一成功版本', async () => {
  const fixture = await createFixture('0.1.0');
  await fixture.files.ensureDirectory(
    fixture.paths.versionExecutable('0.0.9').replace(/\/xapt$/u, ''),
    0o700,
  );

  expect(await fixture.manager.update()).toEqual({
    updated: true,
    version: '0.2.0',
    daemonRestarted: false,
  });
  expect(await readlink(fixture.paths.currentLink)).toBe('versions/0.2.0');
  expect(await fixture.state.loadInstall()).toMatchObject({
    currentVersion: '0.2.0',
    previousVersion: '0.1.0',
  });
  expect(
    await fixture.files.info(fixture.paths.versionExecutable('0.0.9')),
  ).toBeNull();
  expect(fixture.events).toContain('codesign');
  expect(fixture.events.slice(-2)).toEqual(['start', 'stop']);
});

test('新 daemon 健康检查失败时回退二进制、状态和运行状态', async () => {
  const fixture = await createFixture('0.1.0', true);
  let starts = 0;
  fixture.daemon.start = async () => {
    fixture.events.push('start');
    starts += 1;
    if (starts === 1) throw new Error('new daemon unhealthy');
    return { snapshot: fixture.daemonSnapshot, alreadyRunning: false };
  };

  await expect(fixture.manager.update()).rejects.toMatchObject({
    code: 'ROLLBACK_COMPLETED',
  });
  expect(await readlink(fixture.paths.currentLink)).toBe('versions/0.1.0');
  expect(await fixture.state.loadInstall()).toMatchObject({
    currentVersion: '0.1.0',
    previousVersion: null,
  });
  expect(fixture.events).toContain('stop');
  expect(fixture.events.filter((event) => event === 'start')).toHaveLength(2);
});

test('daemon 忙碌时在查询 Release 前拒绝更新', async () => {
  const fixture = await createFixture('0.1.0', true);
  fixture.daemonSnapshot.activity = 'BUSY';

  await expect(fixture.manager.update()).rejects.toMatchObject({
    code: 'DAEMON_BUSY',
  });
  expect(fixture.events).toEqual([]);
});

test('旧 daemon 也无法恢复时不谎报回退完成', async () => {
  const fixture = await createFixture('0.1.0', true);
  fixture.daemon.start = async () => {
    fixture.events.push('start');
    throw new Error('daemon unhealthy');
  };

  await expect(fixture.manager.update()).rejects.toMatchObject({
    code: 'ROLLBACK_FAILED',
  });
});

async function createFixture(
  currentVersion: string,
  running = false,
  source?: { apiBaseUrl: string; repository: string },
) {
  const home = await mkdtemp(join(tmpdir(), 'xapt-update-'));
  homes.push(home);
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  await files.ensureDirectory(
    paths.versionExecutable(currentVersion).replace(/\/xapt$/u, ''),
    0o700,
  );
  await files.writeAtomic(
    paths.versionExecutable(currentVersion),
    'old executable',
    0o755,
  );
  await symlink(`versions/${currentVersion}`, paths.currentLink);
  await state.saveInstall({
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    currentVersion,
    previousVersion: null,
    installedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });

  const events: string[] = [];
  const requests: string[] = [];
  const archive = new TextEncoder().encode('fixture archive');
  const checksum = createHash('sha256').update(archive).digest('hex');
  const fixture = {
    releaseVersion: '0.2.0',
    daemonSnapshot: {
      ...stoppedSnapshot(currentVersion),
      service: running ? ('RUNNING' as const) : ('STOPPED' as const),
    } satisfies DaemonSnapshot,
  };
  const fetchImplementation = (async (input: URL | RequestInfo) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/releases/latest')) {
      events.push('release');
      return Response.json({
        tag_name: `v${fixture.releaseVersion}`,
        draft: false,
        prerelease: false,
        assets: [
          {
            name: 'xapt-darwin-arm64.tar.gz',
            browser_download_url: 'https://release.test/asset',
          },
          {
            name: 'xapt-darwin-arm64.tar.gz.sha256',
            browser_download_url: 'https://release.test/checksum',
          },
        ],
      });
    }
    if (url.endsWith('/asset')) return new Response(archive);
    if (url.endsWith('/checksum'))
      return new Response(`${checksum}  xapt-darwin-arm64.tar.gz\n`);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const commands: CommandRunner = {
    run: async (executable, args) => {
      if (executable === '/usr/bin/tar') {
        const unpack = args[args.indexOf('-C') + 1]!;
        await files.writeAtomic(join(unpack, 'xapt'), 'new executable', 0o755);
        events.push('tar');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (executable === '/usr/bin/codesign') {
        events.push('codesign');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: `xapt ${fixture.releaseVersion}\n最低 Codex 版本 0.145.0\n`,
        stderr: '',
      };
    },
  };
  const clock: Clock = {
    now: () => new Date('2026-08-03T00:00:00.000Z'),
    sleep: async () => undefined,
  };
  const daemon = {
    status: async () => fixture.daemonSnapshot,
    stop: async () => {
      events.push('stop');
      return { alreadyStopped: false };
    },
    start: async () => {
      events.push('start');
      return { snapshot: fixture.daemonSnapshot, alreadyRunning: false };
    },
  };
  const manager = new UpdateManager(
    paths,
    files,
    state,
    daemon,
    { check: async () => ({ executable: '/opt/codex', version: '0.146.0' }) },
    commands,
    clock,
    fetchImplementation,
    source,
  );
  return {
    ...fixture,
    home,
    paths,
    files,
    state,
    events,
    requests,
    daemon,
    manager,
  };
}
