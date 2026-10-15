import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  calculateObservationReport,
  observationDigest,
  type ObservationBatch,
  type ObservationEvent,
  type ObservationReport,
} from '@agent-party-time/execution-contract/observability';
import { testDatabases } from '@/testing/database';
import {
  repairFixture,
  startLatest,
  repairProtocolFetch,
} from '@/cooking/repair/server/repair-fixture';
import { completeClaimedExecution } from '@/cooking/testing/execution';
import { cookingObservationAccess } from '@/cooking/runtime/observation-access';
import { ExecutionObservations } from './observations';
import { handleObservationRead } from '@/cooking/runtime/observation-read';

const setup = repairFixture(testDatabases());
async function fixture() {
  const f = await setup();
  const started = await startLatest(f, 'observation-session');
  completeClaimedExecution(f, started, {
    kind: 'FAILED',
    failure: { code: 'CODEX_EXECUTION_FAILED', message: '受控失败', retryable: true },
  });
  let now = new Date('2026-10-15T00:00:00.000Z');
  const observations = new ExecutionObservations(
    f.database,
    cookingObservationAccess(f.database),
    () => now,
  );
  const segmentId = randomUUID();
  const events: ObservationEvent[] = [
    'execution.received',
    'item.started',
    'item.finished',
    'delivery.accepted',
  ].map((name, i) => ({
    schemaVersion: 1,
    eventId: randomUUID(),
    executionId: started.executionId,
    segmentId,
    sequence: i + 1,
    name: name as ObservationEvent['name'],
    source: 'xapt',
    observedAt: now.toISOString(),
    observedElapsedMs: i * 10,
    ...(i === 1 || i === 2
      ? {
          correlation: { sourceItemId: 'build' },
          activity: 'build' as const,
          status: i === 2 ? ('succeeded' as const) : ('running' as const),
        }
      : {}),
  }));
  const report = calculateObservationReport(events, {
    executionId: started.executionId,
    reportId: randomUUID(),
    revision: 1,
    parentReportId: null,
    inputDigest: await observationDigest(events),
    calculatedAt: now.toISOString(),
  });
  async function batch(
    replacementReport: ObservationReport | null = report,
    replacementEvents = events,
  ): Promise<ObservationBatch> {
    const payload = {
      schemaVersion: 1 as const,
      batchId: randomUUID(),
      executionId: started.executionId,
      events: replacementEvents,
      report: replacementReport,
    };
    return { ...payload, digest: await observationDigest(payload) };
  }
  return {
    ...f,
    started,
    observations,
    events,
    report,
    batch,
    setNow: (time: string) => {
      now = new Date(time);
    },
  };
}

test('已结束且租约失效的真实归属执行可补报，幂等且不改业务版本', async () => {
  const f = await fixture();
  const before = f.database.get(
    'SELECT version,updated_at FROM cooking_bug WHERE id=?',
    f.requested.bug.id,
  );
  const payload = await f.batch();
  expect((await f.observations.accept(f.runner.id, payload)).duplicate).toBe(false);
  expect((await f.observations.accept(f.runner.id, payload)).duplicate).toBe(true);
  expect(f.database.get('SELECT count(*) count FROM platform_observation_event')).toEqual(
    { count: 4 },
  );
  expect(
    f.database.get(
      'SELECT version,updated_at FROM cooking_bug WHERE id=?',
      f.requested.bug.id,
    ),
  ).toEqual(before);
  expect(f.executions.get(f.started.executionId).state).toBe('FAILED');
  expect(
    f.observations.read(f.users.developer.id, f.started.executionId)?.report.totalMs,
  ).toBe(30);
});

test('项目 OWNER/tester 不因角色得到技术归因，当前负责人变化即时生效', async () => {
  const f = await fixture();
  await f.observations.accept(f.runner.id, await f.batch());
  for (const user of [f.users.owner, f.users.tester])
    expect(() => f.observations.metadata(user.id, f.started.executionId)).toThrow();
  expect(
    f.observations.metadata(f.users.developer.id, f.started.executionId).available,
  ).toBe(true);
  f.database.run(
    'UPDATE cooking_submission_item SET responsible_user_id=? WHERE id=(SELECT submission_item_id FROM cooking_bug WHERE id=?)',
    [f.users.owner.id, f.requested.bug.id],
  );
  expect(() =>
    f.observations.metadata(f.users.developer.id, f.started.executionId),
  ).toThrow();
  expect(f.observations.metadata(f.users.owner.id, f.started.executionId).available).toBe(
    true,
  );
});

test('错误 Agent、篡改摘要与复用事件身份不同内容均拒绝且不部分写入', async () => {
  const f = await fixture();
  const payload = await f.batch();
  await expect(f.observations.accept(f.otherRunner.id, payload)).rejects.toThrow();
  await expect(
    f.observations.accept(f.runner.id, { ...payload, digest: 'b'.repeat(64) }),
  ).rejects.toThrow();
  expect(f.database.get('SELECT count(*) count FROM platform_observation_event')).toEqual(
    { count: 0 },
  );
  await f.observations.accept(f.runner.id, payload);
  const conflict = await f.batch(null, [{ ...f.events[0]!, observedElapsedMs: 9 }]);
  await expect(f.observations.accept(f.runner.id, conflict)).rejects.toThrow('身份冲突');
  expect(f.database.get('SELECT count(*) count FROM platform_observation_event')).toEqual(
    { count: 4 },
  );
});

test('乱序报告保留事实，父版本补齐后前进且旧版本不能倒退当前视图', async () => {
  const f = await fixture();
  const second = {
    ...f.report,
    reportId: randomUUID(),
    revision: 2,
    parentReportId: f.report.reportId,
  };
  await f.observations.accept(f.runner.id, await f.batch(second, []));
  expect(
    f.observations.metadata(f.users.developer.id, f.started.executionId).available,
  ).toBe(false);
  await f.observations.accept(f.runner.id, await f.batch());
  expect(
    f.observations.metadata(f.users.developer.id, f.started.executionId).revision,
  ).toBe(2);
  await f.observations.accept(f.runner.id, await f.batch());
  expect(
    f.observations.metadata(f.users.developer.id, f.started.executionId).revision,
  ).toBe(2);
});

test('明细30天到期后物理清除，摘要180天内仍可读且不会带回旧时间线', async () => {
  const f = await fixture();
  await f.observations.accept(f.runner.id, await f.batch());
  expect(
    f.observations.read(f.users.developer.id, f.started.executionId)?.report.intervals,
  ).toHaveLength(1);
  f.setNow('2026-11-16T00:00:00.000Z');
  f.observations.prune();
  const read = f.observations.read(f.users.developer.id, f.started.executionId);
  expect(read?.detailAvailable).toBe(false);
  expect(read?.report.totalMs).toBe(30);
  expect(read?.report.intervals).toEqual([]);
  expect(f.database.get('SELECT detail_json FROM platform_observation_report')).toEqual({
    detail_json: null,
  });
  expect(
    f.database.get<{ content_json: string }>(
      'SELECT content_json FROM platform_observation_report',
    )?.content_json,
  ).not.toContain('sourceItemId');
  f.setNow('2027-05-01T00:00:00.000Z');
  f.observations.prune();
  expect(f.observations.read(f.users.developer.id, f.started.executionId)).toBeNull();
});

test('实际 runner 路由使用认证与安全 Schema，拒绝原始命令或输出', async () => {
  const f = await fixture();
  const fetcher = repairProtocolFetch(f);
  const payload = await f.batch();
  const endpoint = `https://apt.example/api/runner/executions/${f.started.executionId}/observations`;
  const request = (value: unknown, authenticated = true) =>
    fetcher(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated
          ? { authorization: `Bearer ${f.pairedRunner.credential}` }
          : {}),
      },
      body: JSON.stringify(value),
    });
  expect((await request(payload, false)).status).toBe(401);
  const unsafe = {
    ...payload,
    events: [
      { ...payload.events[0], command: 'SYNTHETIC_SECRET', output: 'SYNTHETIC_SECRET' },
    ],
  };
  const rejected = await request(unsafe);
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).not.toContain('SYNTHETIC_SECRET');
  expect((await request(payload)).status).toBe(200);
});

test('JSON和阅读版导出绑定所见旧版本，版本更新不静默替换内容', async () => {
  const f = await fixture();
  await f.observations.accept(f.runner.id, await f.batch());
  const second = {
    ...f.report,
    reportId: randomUUID(),
    revision: 2,
    parentReportId: f.report.reportId,
  };
  await f.observations.accept(f.runner.id, await f.batch(second, []));
  const endpoint = `https://apt.example/api/cooking/executions/${f.started.executionId}/observations`;
  const json = handleObservationRead(
    new Request(`${endpoint}?format=json&reportId=${f.report.reportId}`),
    f.users.developer.id,
    f.started.executionId,
    f.observations,
  );
  expect(json.status).toBe(200);
  expect(json.headers.get('cache-control')).toBe('private, no-store');
  expect(json.headers.get('content-disposition')).toContain(f.report.reportId);
  const data = await json.json();
  expect(data.report.revision).toBe(1);
  expect(data.report.totalMs).toBe(30);
  const markdown = handleObservationRead(
    new Request(`${endpoint}?format=md&reportId=${f.report.reportId}`),
    f.users.developer.id,
    f.started.executionId,
    f.observations,
  );
  const text = await markdown.text();
  expect(text).toContain('# 本轮耗时分析');
  expect(text).toContain('30 毫秒');
  expect(text).not.toContain(second.reportId);
  expect(text).not.toContain(f.directory);
});

test('报告导出也重新鉴权，摘要模式明确省略时间线，过期版本不回退到最新版', async () => {
  const f = await fixture();
  await f.observations.accept(f.runner.id, await f.batch());
  const endpoint = `https://apt.example/api/cooking/executions/${f.started.executionId}/observations?format=json&reportId=${f.report.reportId}`;
  for (const user of [f.users.owner, f.users.tester]) {
    const denied = handleObservationRead(
      new Request(endpoint),
      user.id,
      f.started.executionId,
      f.observations,
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(f.report.inputDigest);
  }
  const summary = handleObservationRead(
    new Request(`${endpoint}&summary=1`),
    f.users.developer.id,
    f.started.executionId,
    f.observations,
  );
  const data = await summary.json();
  expect(data.summaryOnly).toBe(true);
  expect(data.report.intervals).toEqual([]);
  expect(data.report.eventCount).toBe(4);
  const missing = handleObservationRead(
    new Request(endpoint.replace(f.report.reportId, randomUUID())),
    f.users.developer.id,
    f.started.executionId,
    f.observations,
  );
  expect(missing.status).toBe(404);
});

test('明细容量用尽原子拒绝新增事实，但允许有界摘要继续报告缺口', async () => {
  const f = await fixture();
  await f.observations.accept(f.runner.id, await f.batch());
  // Inject storage pressure directly; this value is never accepted as a source event.
  f.database.run('INSERT INTO platform_observation_event VALUES(?,?,?,?,?,?)', [
    f.started.executionId,
    randomUUID(),
    randomUUID(),
    1,
    JSON.stringify({ pressure: 'x'.repeat(50 * 1024 * 1024) }),
    '2026-10-15T00:00:00.000Z',
  ]);
  const count = f.database.get<{ count: number }>(
    'SELECT COUNT(*) count FROM platform_observation_event',
  )!.count;
  const newEvent = { ...f.events[0]!, eventId: randomUUID(), sequence: 99 };
  await expect(
    f.observations.accept(f.runner.id, await f.batch(null, [newEvent])),
  ).rejects.toThrow('容量上限');
  expect(
    f.database.get<{ count: number }>(
      'SELECT COUNT(*) count FROM platform_observation_event',
    )!.count,
  ).toBe(count);
  const report = {
    ...f.report,
    reportId: randomUUID(),
    revision: 2,
    parentReportId: f.report.reportId,
    intervals: [],
    unplaced: [],
    incompleteActivities: [],
    issues: ['budget' as const],
  };
  expect(
    (await f.observations.accept(f.runner.id, await f.batch(report, []))).accepted,
  ).toBe(true);
  expect(
    f.observations.metadata(f.users.developer.id, f.started.executionId).revision,
  ).toBe(2);
});

test('业务删除清除安全内容并拒绝迟到补报，撤销Agent也不能重建记录', async () => {
  const f = await fixture();
  const payload = await f.batch();
  await f.observations.accept(f.runner.id, payload);
  f.database.run('DELETE FROM cooking_repair_attempt WHERE execution_id=?', [
    f.started.executionId,
  ]);
  f.database.run('DELETE FROM platform_execution WHERE id=?', [f.started.executionId]);
  expect(
    f.database.get<{ count: number }>(
      'SELECT COUNT(*) count FROM platform_observation_report',
    )!.count,
  ).toBe(0);
  expect(
    f.database.get<{ count: number }>(
      'SELECT COUNT(*) count FROM platform_observation_tombstone',
    )!.count,
  ).toBe(1);
  await expect(f.observations.accept(f.runner.id, payload)).rejects.toThrow();
  const other = await fixture();
  other.database.run('UPDATE platform_runner SET revoked_at=? WHERE id=?', [
    '2026-10-15T00:00:00.000Z',
    other.runner.id,
  ]);
  await expect(
    other.observations.accept(other.runner.id, await other.batch()),
  ).rejects.toThrow();
});
