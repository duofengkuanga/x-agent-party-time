import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  observationDigest,
  type ObservationBatch,
} from '@agent-party-time/execution-contract/observability';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { LocalStateStore } from '../state/store';
import { testDirectories } from '../testing/directories';
import { ObservationService } from './service';
import { ObservationStore } from './store';
import { ObservationDeliveryError, type ObservationTransport } from './transport';

const directory = testDirectories('xapt-observation-service-');
async function fixture(
  send: ObservationTransport['send'],
  files = new NodeLocalFileSystem(),
) {
  const home = await directory();
  const paths = xaptPaths(home);
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  const runnerId = randomUUID();
  const executionId = randomUUID();
  const session = {
    serverOrigin: 'https://observation.example',
    credential: 'synthetic-auth-only-in-memory',
  };
  await state.saveConnection({
    schemaVersion: 1,
    serverUrl: session.serverOrigin,
    runnerId,
  });
  let now = new Date('2026-10-15T00:00:00.000Z');
  const root = join(paths.state, 'observations');
  const service = new ObservationService(root, files, state, { send }, () => now);
  const store = new ObservationStore(root, files, () => now);
  const namespace = await observationDigest({ origin: session.serverOrigin, runnerId });
  return {
    files,
    state,
    root,
    service,
    store,
    namespace,
    runnerId,
    executionId,
    session,
    advance: () => {
      now = new Date(now.getTime() + 10_000);
    },
  };
}

test('全程结果独立持久化并补报，磁盘只保留安全结构化事实', async () => {
  const sent: ObservationBatch[] = [];
  const f = await fixture(async (_session, batch) => {
    sent.push(batch);
    return {
      accepted: true,
      duplicate: false,
      batchId: batch.batchId,
      digest: batch.digest,
    };
  });
  const recorder = f.service.receive(f.session, {
    id: f.executionId,
    runnerId: f.runnerId,
  });
  await recorder.phase('workspace', async () => 1);
  f.service.event(f.executionId, {
    name: 'delivery.accepted',
    source: 'server_response',
  });
  f.service.close(f.executionId);
  await f.service.flush(f.session);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.report?.envelopeQuality).toBe('complete');
  expect(sent[0]!.report?.totalMs).not.toBeNull();
  expect(await f.store.pending(f.namespace)).toEqual([]);
  const saved = await f.store.events(f.namespace, f.executionId);
  expect(saved.events.some((e) => e.name === 'phase.finished')).toBe(true);
  expect(JSON.stringify(saved)).not.toContain(f.session.credential);
  expect(JSON.stringify(saved)).not.toContain(f.root);
});

test('接受回执丢失后重试沿用同一不可变批次，不阻断业务', async () => {
  const sent: ObservationBatch[] = [];
  const f = await fixture(async (_session, batch) => {
    sent.push(batch);
    if (sent.length === 1) throw new Error('response lost');
    return {
      accepted: true,
      duplicate: true,
      batchId: batch.batchId,
      digest: batch.digest,
    };
  });
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  f.service.close(f.executionId);
  await expect(f.service.flush(f.session)).resolves.toBeUndefined();
  expect(await f.store.pending(f.namespace)).toHaveLength(1);
  f.advance();
  await f.service.flush(f.session);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(await f.store.pending(f.namespace)).toEqual([]);
});

test('错误回执和明确拒绝留下丢失原因，不被当作成功确认', async () => {
  const f = await fixture(async (_session, batch) => ({
    accepted: true,
    duplicate: false,
    batchId: randomUUID(),
    digest: batch.digest,
  }));
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  f.service.close(f.executionId);
  await f.service.flush(f.session);
  expect(f.service.degraded).toBe(true);
  expect((await f.store.events(f.namespace, f.executionId)).incomplete).toBe(true);
});

test('重新连接到别的账号/Agent不投递旧来源队列', async () => {
  let sends = 0;
  const f = await fixture(async () => {
    sends++;
    throw new ObservationDeliveryError(503);
  });
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  f.service.close(f.executionId);
  await f.service.flush(f.session);
  expect(sends).toBe(1);
  await f.state.saveConnection({
    schemaVersion: 1,
    serverUrl: f.session.serverOrigin,
    runnerId: randomUUID(),
  });
  f.advance();
  await f.service.flush({
    ...f.session,
    credential: 'different-synthetic-authorization',
  });
  expect(sends).toBe(1);
  expect(await f.store.pending(f.namespace)).toHaveLength(1);
});

test('观测来源冲突只降级诊断，不向执行路径抛错', async () => {
  const f = await fixture(async (_session, batch) => ({
    accepted: true,
    duplicate: false,
    batchId: batch.batchId,
    digest: batch.digest,
  }));
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  expect(() =>
    f.service.receive(f.session, { id: f.executionId, runnerId: randomUUID() }),
  ).not.toThrow();
  expect(f.service.degraded).toBe(true);
  f.service.close(f.executionId);
  await f.service.flush(f.session);
});

test('写入新 head 瞬时失败后恢复同一持久批次，其他执行仍能投递', async () => {
  let rejectHead = false;
  let affected = '';
  const files = new NodeLocalFileSystem({
    beforeRename: async (_temporary, target) => {
      if (rejectHead && target.endsWith('/head.json') && target.includes(affected)) {
        throw new Error('synthetic disk failure');
      }
    },
  });
  const sent: ObservationBatch[] = [];
  const f = await fixture(async (_session, batch) => {
    sent.push(batch);
    return {
      accepted: true,
      duplicate: false,
      batchId: batch.batchId,
      digest: batch.digest,
    };
  }, files);
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  await f.service.flush();
  affected = f.executionId;
  rejectHead = true;
  f.service.event(f.executionId, {
    name: 'activity.observed',
    source: 'xapt',
    activity: 'read',
  });
  const other = randomUUID();
  f.service.receive(f.session, { id: other, runnerId: f.runnerId });
  f.service.close(other);
  await f.service.flush();
  expect(sent.some((batch) => batch.executionId === other)).toBe(true);
  expect(sent.filter((batch) => batch.executionId === f.executionId)).toHaveLength(1);
  rejectHead = false;
  await f.service.flush();
  const reports = sent
    .filter((batch) => batch.executionId === f.executionId)
    .map((batch) => batch.report!);
  expect(reports.map((report) => report.revision)).toEqual([1, 2]);
  expect(reports[1]!.parentReportId).toBe(reports[0]!.reportId);
  expect(await f.store.pending(f.namespace)).toEqual([]);
  f.service.close(f.executionId);
  await f.service.flush();
});

test('旧执行坏队列被隔离，新执行可完成归因与补报', async () => {
  const sent: ObservationBatch[] = [];
  const f = await fixture(async (_session, batch) => {
    sent.push(batch);
    return {
      accepted: true,
      duplicate: false,
      batchId: batch.batchId,
      digest: batch.digest,
    };
  });
  const oldId = randomUUID();
  await f.files.ensureDirectory(join(f.root, f.namespace, oldId), 0o700);
  await f.files.writeAtomic(
    join(f.root, f.namespace, oldId, `pending-${randomUUID()}.json`),
    'broken',
    0o600,
  );
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  f.service.close(f.executionId);
  await f.service.flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.executionId).toBe(f.executionId);
  expect((await f.store.events(f.namespace, oldId)).incomplete).toBe(true);
  expect(f.service.degraded).toBe(true);
});

test('正常退出保存尚未到定时刷盘的尾部，不等待补报网络', async () => {
  let sends = 0;
  const f = await fixture(async () => {
    sends++;
    throw new Error('must not await network during shutdown');
  });
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  f.service.event(f.executionId, {
    name: 'delivery.accepted',
    source: 'server_response',
  });
  f.service.close(f.executionId);
  await f.service.shutdown();
  expect(sends).toBe(0);
  const saved = await f.store.events(f.namespace, f.executionId);
  expect(saved.events.some((event) => event.name === 'delivery.accepted')).toBe(true);
  expect(saved.events.some((event) => event.name === 'segment.closed')).toBe(true);
  expect(await f.store.pending(f.namespace)).toHaveLength(1);
});

for (const status of [401, 403])
  test(`认证拒绝${status}暂停原来源，合法重授权才继续同批次`, async () => {
    let sends = 0;
    const f = await fixture(async (_session, batch) => {
      sends++;
      if (sends === 1) throw new ObservationDeliveryError(status);
      return {
        accepted: true,
        duplicate: false,
        batchId: batch.batchId,
        digest: batch.digest,
      };
    });
    f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
    f.service.close(f.executionId);
    await f.service.flush();
    f.advance();
    await f.service.flush();
    expect(sends).toBe(1);
    await f.service.flush({ ...f.session, credential: 'new-synthetic-authorization' });
    expect(sends).toBe(2);
    expect(await f.store.pending(f.namespace)).toEqual([]);
  });

test('限流遵循Retry-After，等待期间不忙重试', async () => {
  let sends = 0;
  const f = await fixture(async (_session, batch) => {
    sends++;
    if (sends === 1) throw new ObservationDeliveryError(429, 25_000);
    return {
      accepted: true,
      duplicate: false,
      batchId: batch.batchId,
      digest: batch.digest,
    };
  });
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  f.service.close(f.executionId);
  await f.service.flush();
  f.advance();
  await f.service.flush();
  expect(sends).toBe(1);
  f.advance();
  f.advance();
  await f.service.flush();
  expect(sends).toBe(2);
});

test('磁盘head提交失败后进程重启，无业务恢复记录也能补齐原报告链', async () => {
  let blocked = false;
  const files = new NodeLocalFileSystem({
    beforeRename: async (_temporary, target) => {
      if (blocked && target.endsWith('/head.json'))
        throw new Error('synthetic persistence failure');
    },
  });
  const sent: ObservationBatch[] = [];
  const send: ObservationTransport['send'] = async (_session, batch) => {
    sent.push(batch);
    return {
      accepted: true,
      duplicate: false,
      batchId: batch.batchId,
      digest: batch.digest,
    };
  };
  const f = await fixture(send, files);
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  await f.service.flush();
  blocked = true;
  f.service.event(f.executionId, {
    name: 'delivery.accepted',
    source: 'server_response',
  });
  f.service.close(f.executionId);
  await f.service.flush();
  await f.service.shutdown();
  expect(sent).toHaveLength(1);
  expect(await f.state.loadExecutions()).toEqual([]);
  blocked = false;
  const restarted = new ObservationService(f.root, files, f.state, { send });
  await restarted.flush(f.session);
  await restarted.shutdown();
  expect(sent.map((batch) => batch.report?.revision)).toEqual([1, 2]);
  expect(sent[1]!.report?.parentReportId).toBe(sent[0]!.report?.reportId);
  expect(await f.store.pending(f.namespace)).toEqual([]);
});

test('退出时取消在途归因请求，未确认批次留在独立队列', async () => {
  let dispatched!: () => void;
  const ready = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const f = await fixture(async (_session, _batch, signal) => {
    dispatched();
    return new Promise((_, reject) =>
      signal!.addEventListener('abort', () => reject(new Error('cancelled')), {
        once: true,
      }),
    );
  });
  f.service.receive(f.session, { id: f.executionId, runnerId: f.runnerId });
  f.service.close(f.executionId);
  const flushing = f.service.flush();
  await ready;
  await f.service.shutdown();
  await flushing;
  expect(await f.store.pending(f.namespace)).toHaveLength(1);
});

test('内存压力下关键接受端点优先保留，异步写盘不误消费新入队事件', async () => {
  let inject: (() => void) | undefined;
  const files = new NodeLocalFileSystem({
    beforeRename: async (_temporary, target) => {
      if (inject && target.includes('/events-')) {
        const call = inject;
        inject = undefined;
        call();
      }
    },
  });
  const sent: ObservationBatch[] = [];
  const f = await fixture(async (_session, batch) => {
    sent.push(batch);
    return {
      accepted: true,
      duplicate: false,
      batchId: batch.batchId,
      digest: batch.digest,
    };
  }, files);
  const recorder = f.service.receive(f.session, {
    id: f.executionId,
    runnerId: f.runnerId,
  });
  const value = 'a'.repeat(200);
  for (let i = 0; i < 3000; i++)
    recorder.record({
      name: 'activity.observed',
      source: 'xapt',
      correlation: {
        sessionId: value,
        turnId: value,
        sourceItemId: value,
        callId: value,
        requestId: value,
        intervalId: value,
        parentIntervalId: value,
      },
      configuration: {
        xaptVersion: value,
        codexVersion: value,
        requestedModel: value,
        effectiveModel: value,
      },
    });
  inject = () => {
    f.service.event(f.executionId, {
      name: 'delivery.accepted',
      source: 'server_response',
    });
    f.service.close(f.executionId);
  };
  await f.service.flush();
  for (
    let attempt = 0;
    attempt < 50 && (await f.store.pending(f.namespace)).length;
    attempt++
  )
    await f.service.flush();
  expect(await f.store.pending(f.namespace)).toEqual([]);
  await f.service.shutdown();
  expect(sent.at(-1)?.report?.totalMs).not.toBeNull();
  expect(sent.at(-1)?.report?.sealed).toBe(true);
  expect(sent.at(-1)?.report?.issues).toContain('budget');
  expect(
    sent
      .flatMap((batch) => batch.events)
      .filter((event) => event.name === 'delivery.accepted'),
  ).toHaveLength(1);
});
