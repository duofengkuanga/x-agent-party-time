import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimedExecution } from '@agent-party-time/execution-contract';
import { NodeLocalFileSystem, type LocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import {
  BINDING_STATE_SCHEMA_VERSION,
  CONNECTION_STATE_SCHEMA_VERSION,
  EXECUTION_STATE_SCHEMA_VERSION,
  INSTALL_STATE_SCHEMA_VERSION,
  OUTBOX_STATE_SCHEMA_VERSION,
} from './schemas';
import { BindingStateError, LocalStateError, LocalStateStore } from './store';

const homes: string[] = [];
const runnerId = '00000000-0000-4000-8000-000000000001';
const bindingId = '00000000-0000-4000-8000-000000000002';
const executionId = '00000000-0000-4000-8000-000000000003';
const outboxId = '00000000-0000-4000-8000-000000000004';

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test('各类持久化状态独立演进 Schema', () => {
  expect(CONNECTION_STATE_SCHEMA_VERSION).toBe(1);
  expect(BINDING_STATE_SCHEMA_VERSION).toBe(1);
  expect(INSTALL_STATE_SCHEMA_VERSION).toBe(1);
  expect(EXECUTION_STATE_SCHEMA_VERSION).toBe(2);
  expect(OUTBOX_STATE_SCHEMA_VERSION).toBe(2);
});

test('全新 Home 初始化权限并且不读取或修改旧 Runner 目录', async () => {
  const home = await temporaryHome();
  const legacyMarker = join(home, '.agent-party-time', 'runner', 'marker');
  await new NodeLocalFileSystem().writeAtomic(legacyMarker, 'legacy', 0o600);
  const paths = xaptPaths(home);
  const store = new LocalStateStore(paths, new NodeLocalFileSystem());

  await store.initialize();

  for (const path of [
    paths.applicationSupport,
    paths.state,
    paths.outbox,
    paths.executions,
    paths.workspaces,
    paths.caches,
    paths.logs,
  ])
    expect((await stat(path)).mode & 0o777).toBe(0o700);
  expect(await readFile(legacyMarker, 'utf8')).toBe('legacy');
  expect(await store.loadConnection()).toBeNull();
  expect(await store.loadBindings()).toEqual({
    schemaVersion: BINDING_STATE_SCHEMA_VERSION,
    bindings: {},
  });
});

test('初始化只清理 xapt 原子写入遗留的临时文件', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  await files.ensureDirectory(paths.applicationSupport, 0o700);
  await writeFile(
    join(
      paths.applicationSupport,
      'connection.json.00000000-0000-4000-8000-000000000001.tmp',
    ),
    'temporary',
  );
  await writeFile(join(paths.applicationSupport, 'unknown.tmp'), 'keep');

  await new LocalStateStore(paths, files).initialize();

  expect(await files.list(paths.applicationSupport)).toEqual([
    'run',
    'state',
    'unknown.tmp',
  ]);
});

test('Binding 映射可重启恢复、重复写入幂等且冲突不覆盖', async () => {
  const { paths, store } = await initializedStore();
  const repositoryPath = join(paths.applicationSupport, 'repository');
  await store.bind(bindingId, repositoryPath);
  await store.bind(bindingId, repositoryPath);

  await expect(
    store.bind(bindingId, join(paths.applicationSupport, 'other')),
  ).rejects.toBeInstanceOf(BindingStateError);
  expect(
    await new LocalStateStore(paths, new NodeLocalFileSystem()).loadBindings(),
  ).toMatchObject({
    bindings: {
      [bindingId]: { bindingId, repositoryPath },
    },
  });
  expect(await store.pruneBindings([bindingId])).toEqual([]);
  expect(await store.pruneBindings([])).toEqual([bindingId]);
  expect(await store.removeBinding(bindingId)).toBe(false);
});

test('连接、Binding、Execution、Outbox 与安装状态可重启读取且不保存 Credential', async () => {
  const { paths, store } = await initializedStore();
  const now = '2026-08-03T08:00:00.000Z';
  await store.saveConnection({
    schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
    serverUrl: 'https://apt.example.com',
    runnerId,
  });
  await store.saveBindings({
    schemaVersion: BINDING_STATE_SCHEMA_VERSION,
    bindings: {
      [bindingId]: {
        bindingId,
        repositoryPath: '/tmp/repositories/project',
        updatedAt: now,
      },
    },
  });
  await store.saveExecution({
    schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
    executionId,
    bindingId,
    phase: 'RUNNING',
    sessionId: 'session-one',
    claimedExecution: recoveryExecution(now),
    updatedAt: now,
  });
  await store.saveOutbox({
    schemaVersion: OUTBOX_STATE_SCHEMA_VERSION,
    id: outboxId,
    kind: 'START',
    executionId,
    request: {
      kind: 'STARTED',
      leaseToken: `lease-${'x'.repeat(32)}`,
      sessionId: 'session-one',
      taskSkillBinding: {
        skillName: 'agent-party-time-repair-bug',
        bundleHash: 'a'.repeat(64),
        sourceRevision: 'b'.repeat(40),
      },
    },
    createdAt: now,
  });
  await store.saveInstall({
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    currentVersion: '0.1.0',
    previousVersion: null,
    installedAt: now,
    updatedAt: now,
  });

  const restarted = new LocalStateStore(paths, new NodeLocalFileSystem());
  await restarted.preflight();
  expect(await restarted.loadConnection()).toEqual({
    schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
    serverUrl: 'https://apt.example.com',
    runnerId,
  });
  expect(await restarted.loadExecutions()).toHaveLength(1);
  expect(await restarted.loadOutbox()).toHaveLength(1);
  expect(await restarted.loadInstall()).toMatchObject({
    currentVersion: '0.1.0',
  });

  const persisted = await Promise.all(
    [
      paths.connection,
      paths.bindings,
      join(paths.executions, `${executionId}.json`),
      join(paths.outbox, `${outboxId}.json`),
      paths.installState,
    ].map((path) => readFile(path, 'utf8')),
  );
  expect(persisted.join('\n')).not.toMatch(/credential|secret/i);
  for (const path of [
    paths.connection,
    paths.bindings,
    join(paths.executions, `${executionId}.json`),
    join(paths.outbox, `${outboxId}.json`),
    paths.installState,
  ])
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test('删除全部 Cache 不影响长期状态或恢复状态', async () => {
  const { paths, store } = await initializedStore();
  await store.saveConnection({
    schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
    serverUrl: 'https://apt.example.com',
    runnerId,
  });
  await store.saveBindings({
    schemaVersion: BINDING_STATE_SCHEMA_VERSION,
    bindings: {},
  });
  await rm(paths.caches, { recursive: true, force: true });

  expect(await store.loadConnection()).not.toBeNull();
  expect(await store.loadBindings()).toEqual({
    schemaVersion: BINDING_STATE_SCHEMA_VERSION,
    bindings: {},
  });
});

describe('状态失败关闭', () => {
  test.each([
    ['CORRUPT_STATE', '{not-json'],
    ['UNSUPPORTED_SCHEMA', '{"schemaVersion":2}'],
  ] as const)('%s 时说明状态和下一步', async (code, content) => {
    const { paths, store } = await initializedStore();
    await writeFile(paths.connection, content, { mode: 0o600 });

    const error = await captureError(() => store.loadConnection());
    expect(error).toBeInstanceOf(LocalStateError);
    expect((error as LocalStateError).code).toBe(code);
    expect(error.message).toContain('connection.json');
    expect(error.message).toContain('下一步');
    expect(error.message).not.toContain(paths.home);
  });

  test('错误权限拒绝读取而不泄露内容', async () => {
    const { paths, store } = await initializedStore();
    await writeFile(
      paths.connection,
      `${JSON.stringify({
        schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
        serverUrl: 'https://apt.example.com',
        runnerId,
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(paths.connection, 0o644);

    const error = await captureError(() => store.loadConnection());
    expect((error as LocalStateError).code).toBe('INSECURE_PERMISSIONS');
    expect(error.message).not.toContain(runnerId);
  });

  test('只读预检拒绝权限错误的受管状态目录', async () => {
    const { paths, store } = await initializedStore();
    await chmod(paths.state, 0o755);

    const error = await captureError(() => store.preflight());
    expect((error as LocalStateError).code).toBe('INSECURE_PERMISSIONS');
    expect(error.message).not.toContain(paths.home);
  });

  test('只读 Adapter 写入失败时转换为安全状态错误', async () => {
    const { paths } = await initializedStore();
    const files = new RejectingWriteFileSystem(new NodeLocalFileSystem());
    const store = new LocalStateStore(paths, files);

    const error = await captureError(() =>
      store.saveConnection({
        schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
        serverUrl: 'https://apt.example.com',
        runnerId,
      }),
    );
    expect((error as LocalStateError).code).toBe('WRITE_FAILED');
    expect(error.message).not.toContain(paths.home);
  });

  test('严格 Schema 拒绝 Credential 字段且不会写入 JSON', async () => {
    const { paths, store } = await initializedStore();
    await expect(
      store.saveConnection({
        schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
        serverUrl: 'https://apt.example.com',
        runnerId,
        credential: 'credential-secret',
      } as never),
    ).rejects.toThrow();
    expect(await new NodeLocalFileSystem().read(paths.connection)).toBeNull();
  });

  test('Binding Schema 拒绝相对仓库路径', async () => {
    const { paths, store } = await initializedStore();
    await expect(
      store.saveBindings({
        schemaVersion: BINDING_STATE_SCHEMA_VERSION,
        bindings: {
          [bindingId]: {
            bindingId,
            repositoryPath: 'relative/repository',
            updatedAt: '2026-08-03T08:00:00.000Z',
          },
        },
      }),
    ).rejects.toThrow('仓库路径必须是本机绝对路径');
    expect(await new NodeLocalFileSystem().read(paths.bindings)).toBeNull();
  });
});

class RejectingWriteFileSystem implements LocalFileSystem {
  constructor(private readonly delegate: LocalFileSystem) {}

  ensureDirectory(path: string, mode: number): Promise<void> {
    return this.delegate.ensureDirectory(path, mode);
  }

  read(path: string): Promise<Uint8Array | null> {
    return this.delegate.read(path);
  }

  async writeAtomic(): Promise<void> {
    throw new Error('read only');
  }

  list(path: string): Promise<string[]> {
    return this.delegate.list(path);
  }

  info(path: string) {
    return this.delegate.info(path);
  }

  setMode(path: string, mode: number): Promise<void> {
    return this.delegate.setMode(path, mode);
  }

  remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.delegate.remove(path, options);
  }
}

async function initializedStore() {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const store = new LocalStateStore(paths, new NodeLocalFileSystem());
  await store.initialize();
  return { paths, store };
}

function recoveryExecution(now: string): ClaimedExecution {
  return {
    id: executionId,
    owner: { namespace: 'test', kind: 'task', id: 'task-1' },
    attempt: 1,
    previousExecutionId: null,
    runnerId,
    bindingId,
    priority: 0,
    approvalPolicy: 'on-request',
    state: 'RUNNING',
    codexTurn: {
      kind: 'CONTINUATION',
      taskId: 'session-one',
      taskSkillBinding: {
        skillName: 'agent-party-time-repair-bug',
        bundleHash: 'a'.repeat(64),
        sourceRevision: 'b'.repeat(40),
      },
      input: '继续完成上次未完成的任务。',
      outputJsonSchema: { type: 'object' },
    },
    workspace: null,
    attachments: [],
    sessionId: 'session-one',
    lease: {
      token: `lease-${'x'.repeat(32)}`,
      expiresAt: '2026-08-03T09:00:00.000Z',
    },
    outcome: null,
    cancellationRequested: false,
    createdAt: now,
    claimedAt: now,
    startedAt: now,
    finishedAt: null,
    recoveredInteraction: null,
  };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'xapt-state-'));
  homes.push(home);
  return home;
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('Expected operation to fail');
}
