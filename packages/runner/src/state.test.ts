import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerStateStore, runnerLocalPaths } from './state';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('Runner 配置与 Binding 使用私有权限并可在重启后恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-party-time-runner-state-'));
  directories.push(root);
  const paths = runnerLocalPaths({ AGENT_PARTY_TIME_RUNNER_HOME: root });
  const store = new RunnerStateStore(
    paths,
    () => new Date('2026-07-26T12:00:00Z'),
  );
  const config = {
    serverUrl: 'http://localhost:3000/',
    runnerId: '00000000-0000-4000-8000-000000000001',
    credential: 'credential-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  };
  await store.saveConfig(config);
  const bindingId = '00000000-0000-4000-8000-000000000002';
  await store.bind(bindingId, '/tmp/workspaces/project-one');

  expect(await store.loadConfig()).toEqual({
    ...config,
    serverUrl: 'http://localhost:3000',
  });
  expect(await store.resolveBinding(bindingId)).toBe(
    '/tmp/workspaces/project-one',
  );
  expect(await store.fileModes()).toEqual({
    config: 0o600,
    bindings: 0o600,
    root: 0o700,
  });

  const restarted = new RunnerStateStore(paths, () => new Date());
  expect(await restarted.resolveBinding(bindingId)).toBe(
    '/tmp/workspaces/project-one',
  );
  await restarted.bind(bindingId, '/tmp/workspaces/project-two');
  expect(await store.resolveBinding(bindingId)).toBe(
    '/tmp/workspaces/project-two',
  );
  expect(await readFile(paths.config, 'utf8')).toContain(config.credential);
  expect(await restarted.hasConfig()).toBe(true);
  await restarted.clearConfig();
  expect(await restarted.hasConfig()).toBe(false);
});

describe('Runner Binding 路径校验', () => {
  test('拒绝相对路径且不会写入状态', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'agent-party-time-runner-state-'),
    );
    directories.push(root);
    const store = new RunnerStateStore(
      runnerLocalPaths({ AGENT_PARTY_TIME_RUNNER_HOME: root }),
    );
    await expect(
      store.bind('00000000-0000-4000-8000-000000000003', 'relative/project'),
    ).rejects.toThrow('仓库路径必须是本机绝对路径');
    expect(await store.listBindings()).toEqual([]);
  });

  test('服务端列表可清理孤儿映射并支持显式移除', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'agent-party-time-runner-state-'),
    );
    directories.push(root);
    const store = new RunnerStateStore(
      runnerLocalPaths({ AGENT_PARTY_TIME_RUNNER_HOME: root }),
    );
    const kept = '00000000-0000-4000-8000-000000000004';
    const removed = '00000000-0000-4000-8000-000000000005';
    await store.bind(kept, '/tmp/workspaces/kept');
    await store.bind(removed, '/tmp/workspaces/removed');
    expect(await store.pruneBindings([kept])).toEqual([removed]);
    expect(await store.resolveBinding(removed)).toBeNull();
    expect(await store.removeBinding(kept)).toBe(true);
    expect(await store.removeBinding(kept)).toBe(false);
  });
});
