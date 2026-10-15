import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  observationDigest,
  type ObservationBatch,
  type ObservationEvent,
} from '@agent-party-time/execution-contract/observability';
import { NodeLocalFileSystem } from '../platform/files';
import { testDirectories } from '../testing/directories';
import { ObservationStore } from './store';

const directory = testDirectories('xapt-observation-store-');
async function fixture() {
  const root = await directory();
  const files = new NodeLocalFileSystem();
  let now = new Date('2026-10-15T00:00:00.000Z');
  const store = new ObservationStore(root, files, () => now);
  const namespace = 'a'.repeat(64);
  const executionId = randomUUID();
  const event: ObservationEvent = {
    schemaVersion: 1,
    eventId: randomUUID(),
    executionId,
    segmentId: randomUUID(),
    sequence: 1,
    name: 'execution.received',
    source: 'xapt',
    observedAt: now.toISOString(),
    observedElapsedMs: 0,
  };
  const payload = {
    schemaVersion: 1 as const,
    batchId: randomUUID(),
    executionId,
    events: [event],
    report: null,
  };
  const batch: ObservationBatch = {
    ...payload,
    digest: await observationDigest(payload),
  };
  return {
    root,
    files,
    store,
    namespace,
    executionId,
    event,
    batch,
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
}

test('待报批次和事件可恢复，确认只删除对应待报项', async () => {
  const f = await fixture();
  await f.store.append(f.namespace, f.executionId, randomUUID(), [f.event]);
  await f.store.enqueue(f.namespace, f.executionId, f.batch);
  const restored = new ObservationStore(f.root, f.files);
  expect((await restored.events(f.namespace, f.executionId)).events).toEqual([f.event]);
  expect((await restored.pending(f.namespace))[0]?.batch).toEqual(f.batch);
  await restored.acknowledge(f.namespace, f.batch);
  expect(await restored.pending(f.namespace)).toEqual([]);
  expect((await restored.events(f.namespace, f.executionId)).events).toHaveLength(1);
});

test('封存块和待报批次不可用同身份覆盖成另一份内容', async () => {
  const f = await fixture();
  const chunkId = randomUUID();
  await f.store.append(f.namespace, f.executionId, chunkId, [f.event]);
  await f.store.append(f.namespace, f.executionId, chunkId, [f.event]);
  await expect(
    f.store.append(f.namespace, f.executionId, chunkId, [
      { ...f.event, observedElapsedMs: 9 },
    ]),
  ).rejects.toThrow();
  await f.store.enqueue(f.namespace, f.executionId, f.batch);
  await expect(
    f.store.enqueue(f.namespace, f.executionId, { ...f.batch, digest: 'b'.repeat(64) }),
  ).rejects.toThrow();
});

test('到期清理保留明确丢失标记，不把清理当成已经上传', async () => {
  const f = await fixture();
  await f.store.append(f.namespace, f.executionId, randomUUID(), [f.event]);
  await f.store.enqueue(f.namespace, f.executionId, f.batch);
  f.setNow('2026-11-16T00:00:00.000Z');
  await f.store.prune();
  expect(await f.store.pending(f.namespace)).toEqual([]);
  const retained = await f.store.events(f.namespace, f.executionId);
  expect(retained.events).toHaveLength(0);
  expect(retained.incomplete).toBe(true);
});

test('损坏隔离到当前块，安全命名空间与私有权限不可绕过', async () => {
  const f = await fixture();
  await f.store.append(f.namespace, f.executionId, randomUUID(), [f.event]);
  await writeFile(
    join(f.root, f.namespace, f.executionId, `events-${randomUUID()}.json`),
    'broken',
    { mode: 0o600 },
  );
  const result = await f.store.events(f.namespace, f.executionId);
  expect(result.events).toHaveLength(1);
  expect(result.incomplete).toBe(true);
  expect((await f.store.events('b'.repeat(64), f.executionId)).events).toHaveLength(0);
  await expect(f.store.events('../outside', f.executionId)).rejects.toThrow();
});

test('崩溃遗留原子临时文件在新进程恢复时清理，仅保留已提交块并标缺口', async () => {
  const f = await fixture();
  await f.store.append(f.namespace, f.executionId, randomUUID(), [f.event]);
  const temporary = join(
    f.root,
    f.namespace,
    f.executionId,
    `events-${randomUUID()}.json.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, '{"incomplete":', { mode: 0o600 });
  const restored = new ObservationStore(f.root, f.files);
  const result = await restored.events(f.namespace, f.executionId);
  expect(result.events).toEqual([f.event]);
  expect(result.incomplete).toBe(true);
  expect(await f.files.info(temporary)).toBeNull();
  expect(restored.degraded).toBe(true);
});

test('单执行明细预算耗尽仍可保存关键边界和缺口，不把容量丢失算已上传', async () => {
  const root = await directory();
  class PressureFiles extends NodeLocalFileSystem {
    override async info(path: string) {
      const value = await super.info(path);
      return value && path.endsWith('/pressure.bin')
        ? { ...value, size: 50 * 1024 * 1024 }
        : value;
    }
  }
  const files = new PressureFiles();
  const store = new ObservationStore(root, files);
  const namespace = 'a'.repeat(64);
  const executionId = randomUUID();
  const location = join(root, namespace, executionId);
  await files.ensureDirectory(location, 0o700);
  await files.writeAtomic(join(location, 'pressure.bin'), '', 0o600);
  const base: ObservationEvent = {
    schemaVersion: 1,
    eventId: randomUUID(),
    executionId,
    segmentId: randomUUID(),
    sequence: 1,
    source: 'xapt',
    observedAt: new Date().toISOString(),
    observedElapsedMs: 0,
    name: 'activity.observed',
  };
  await expect(
    store.append(namespace, executionId, randomUUID(), [base]),
  ).rejects.toThrow('容量');
  await store.append(namespace, executionId, randomUUID(), [
    { ...base, name: 'delivery.accepted' },
    { ...base, eventId: randomUUID(), sequence: 2, name: 'gap', reason: 'budget' },
  ]);
  const result = await store.events(namespace, executionId);
  expect(result.incomplete).toBe(true);
  expect(result.events.some((event) => event.name === 'delivery.accepted')).toBe(true);
  expect(await store.pending(namespace)).toEqual([]);
});

test('安装级配额跨来源统计观测和清理状态，优先淘汰非活动对象并保留丢失标记', async () => {
  const data = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const files: import('../platform/files').LocalFileSystem = {
    ensureDirectory: async (path) => {
      const parts = path.split('/');
      for (let n = 2; n <= parts.length; n++)
        directories.add(parts.slice(0, n).join('/'));
    },
    read: async (path) => data.get(path) ?? null,
    writeAtomic: async (path, value) => {
      data.set(path, typeof value === 'string' ? new TextEncoder().encode(value) : value);
    },
    list: async (path) => [
      ...new Set(
        [...directories, ...data.keys()]
          .filter((entry) => entry.startsWith(path + '/'))
          .map((entry) => entry.slice(path.length + 1).split('/')[0]!),
      ),
    ],
    info: async (path) =>
      directories.has(path)
        ? { type: 'directory', mode: 0o700, size: 0 }
        : data.has(path)
          ? {
              type: 'file',
              mode: 0o600,
              size: path.includes('/events-') ? 256 * 1024 : data.get(path)!.byteLength,
            }
          : null,
    setMode: async () => {},
    remove: async (path) => {
      data.delete(path);
      directories.delete(path);
    },
  };
  const root = '/observations';
  const now = new Date('2026-10-15T00:00:00.000Z');
  const activeId = randomUUID();
  const activeNamespace = 'a'.repeat(64);
  for (let group = 0; group < 25; group++) {
    const namespace = group % 2 ? 'b'.repeat(64) : activeNamespace;
    const executionId = group === 0 ? activeId : randomUUID();
    const segmentId = randomUUID();
    const location = join(root, namespace, executionId);
    await files.ensureDirectory(location, 0o700);
    for (let n = 0; n < 200; n++) {
      const event: ObservationEvent = {
        schemaVersion: 1,
        eventId: randomUUID(),
        executionId,
        segmentId,
        sequence: n + 1,
        name: 'activity.observed',
        source: 'xapt',
        observedAt: now.toISOString(),
        observedElapsedMs: n,
      };
      await files.writeAtomic(
        join(location, `events-${randomUUID()}.json`),
        JSON.stringify({
          createdAt: now.toISOString(),
          events: [event],
          digest: await observationDigest({
            createdAt: now.toISOString(),
            events: [event],
          }),
        }),
        0o600,
      );
    }
  }
  const store = new ObservationStore(root, files, () => now);
  await store.prune(new Set([activeId]));
  let bytes = 0;
  for (const path of data.keys()) bytes += (await files.info(path))!.size;
  expect(bytes).toBeLessThanOrEqual(1024 * 1024 * 1024);
  expect(
    [...data.keys()].filter((path) => path.includes(`/${activeId}/events-`)),
  ).toHaveLength(200);
  expect([...data.keys()].some((path) => path.endsWith('/loss.json'))).toBe(true);
  expect(store.degraded).toBe(true);
});

test('格式仍合法但内容摘要不匹配的块和批次单独隔离', async () => {
  const f = await fixture();
  const chunkId = randomUUID();
  await f.store.append(f.namespace, f.executionId, chunkId, [f.event]);
  const good = { ...f.event, eventId: randomUUID(), sequence: 2 };
  await f.store.append(f.namespace, f.executionId, randomUUID(), [good]);
  const location = join(f.root, f.namespace, f.executionId);
  const path = join(location, `events-${chunkId}.json`);
  const chunk = JSON.parse(new TextDecoder().decode((await f.files.read(path))!));
  chunk.events[0].observedElapsedMs = 99;
  await f.files.writeAtomic(path, JSON.stringify(chunk), 0o600);
  const recovered = await f.store.events(f.namespace, f.executionId);
  expect(recovered.events).toEqual([good]);
  expect(recovered.incomplete).toBe(true);
  await f.store.enqueue(f.namespace, f.executionId, f.batch);
  const queuePath = join(location, `pending-${f.batch.batchId}.json`);
  const queue = JSON.parse(new TextDecoder().decode((await f.files.read(queuePath))!));
  queue.batch.events[0].observedElapsedMs = 99;
  await f.files.writeAtomic(queuePath, JSON.stringify(queue), 0o600);
  expect(await f.store.pending(f.namespace)).toEqual([]);
  expect(await f.files.info(queuePath)).toBeNull();
});
