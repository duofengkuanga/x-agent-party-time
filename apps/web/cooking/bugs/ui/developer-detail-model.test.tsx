import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  lifecycleFixture,
  createAndRequestBug,
  completeNextRepair,
  completeUpdate,
} from '@/cooking/lifecycle/server/lifecycle-fixture';
import { createCooking } from '@/cooking/runtime/create-cooking';
import { mutation } from '@/cooking/testing/project';
import { testDatabases } from '@/testing/database';
import {
  developerTimeline,
  executionRoundProgress,
  type RepairRound,
} from './developer-detail-model';
import { RepairAttemptDetails } from './repair-timeline';
import { UpdateAttemptDetails } from './update-details';

const setup = lifecycleFixture(testDatabases());

test('两个缺陷保留各自修复轮次，同时指向同一个批次和更新会话', async () => {
  const fixture = await setup();
  const workspace = createCooking(fixture.database, {
    now: fixture.clock.now,
  }).workspace;
  const first = createAndRequestBug(fixture, fixture.items[1]!.id, '甲缺陷');
  await completeNextRepair(fixture, 'repair-first', ['a'.repeat(40)]);
  fixture.clock.set('2026-07-27T12:01:00.000Z');
  const second = createAndRequestBug(fixture, fixture.items[1]!.id, '乙缺陷');
  await completeNextRepair(fixture, 'repair-second', ['b'.repeat(40)]);
  fixture.clock.set('2026-07-27T12:02:00.000Z');
  const batch = await completeUpdate(fixture, fixture.items[1]!.id, {
    outcome: 'PUSHED',
    summary: '已推送',
  });
  const before = workspace.getWorkspace(
    fixture.users.developer.id,
    fixture.submission.id,
  );
  const serialized = JSON.stringify(before);
  const firstEntries = developerTimeline(first.id, before);
  const secondEntries = developerTimeline(second.id, before);
  const update = firstEntries.find((entry) => entry.kind === 'update')!;
  expect(firstEntries.filter((entry) => entry.kind === 'repair')).toHaveLength(
    1,
  );
  expect(secondEntries.filter((entry) => entry.kind === 'repair')).toHaveLength(
    1,
  );
  expect(
    firstEntries.find((entry) => entry.kind === 'repair')?.node.sessionId,
  ).toBe('repair-first');
  expect(
    secondEntries.find((entry) => entry.kind === 'repair')?.node.sessionId,
  ).toBe('repair-second');
  expect(secondEntries.find((entry) => entry.kind === 'update')?.id).toBe(
    update.id,
  );
  expect(update.batch.entries).toHaveLength(2);
  expect(JSON.stringify(before)).toBe(serialized);
  const render = (currentBatch: typeof update.batch) =>
    renderToStaticMarkup(
      <UpdateAttemptDetails
        batch={currentBatch}
        node={update.node}
        round={1}
        latest
        current
        pending={false}
        run={() => {}}
        currentSessionId={update.node.sessionId}
      />,
    );
  expect(render(update.batch).match(/<dt>/g)).toHaveLength(4);
  expect(render(update.batch)).toContain('全部 2 条缺陷');
  fixture.clock.set('2026-07-27T12:03:00.000Z');
  fixture.updates.reportExternalDeployment(
    fixture.users.developer.id,
    batch.id,
    { ...mutation(batch.version), outcome: 'SUCCEEDED', attachmentIds: [] },
  );
  const after = workspace.getWorkspace(
    fixture.users.developer.id,
    fixture.submission.id,
  );
  expect(
    after.bugs.filter((bug) => bug.stage === 'WAITING_FOR_VERIFICATION'),
  ).toHaveLength(2);
  const updatedBatch = after.updateBatches.find(
    (item) => item.id === batch.id,
  )!;
  expect(render(updatedBatch)).toContain(
    '本轮已推送；环境更新结果以后续确认记录为准',
  );
  expect(render(updatedBatch)).not.toContain('本轮已完成推送和环境更新');
  expect(developerTimeline(first.id, after)[0]!.kind).toBe('report');
});

test('新修复轮次不会继承上一轮检查结果，也不会臆造当前执行的命令', async () => {
  const fixture = await setup();
  const created = createAndRequestBug(
    fixture,
    fixture.items[0]!.id,
    '独立检查',
  );
  await completeNextRepair(fixture, 'same-session', ['a'.repeat(40)]);
  const workspace = createCooking(fixture.database, {
    now: fixture.clock.now,
  }).workspace;
  const snapshot = workspace.getWorkspace(
    fixture.users.developer.id,
    fixture.submission.id,
  );
  const original = developerTimeline(created.id, snapshot).find(
    (entry) => entry.kind === 'repair',
  )!.node;
  const running: RepairRound = {
    ...original,
    id: crypto.randomUUID(),
    attempt: 2,
    result: null,
    finishedAt: null,
    executionState: 'RUNNING',
  };
  const html = renderToStaticMarkup(
    <RepairAttemptDetails
      bug={snapshot.bugs[0]!}
      node={running}
      repair={snapshot.repairByBug[created.id]!}
      latest
      current
      pending={false}
      run={() => {}}
      currentSessionId="same-session"
    />,
  );
  expect(html.match(/<dt>/g)).toHaveLength(4);
  expect(html).toContain('本轮尚未收到检查结果');
  expect(html).not.toContain('定向测试');
  expect(html).not.toContain('a'.repeat(40));
  expect(executionRoundProgress(running)).toBe(
    'Agent 正在执行，尚未回传步骤明细。',
  );
  expect(
    executionRoundProgress({ ...running, executionState: 'WAITING_TO_RESUME' }),
  ).toContain('等待恢复');
  expect(executionRoundProgress(original)).toBe('本轮执行已完成。');
});

test('检查存在失败项时直接可见，其余检查明细按需展开', async () => {
  const fixture = await setup();
  const created = createAndRequestBug(
    fixture,
    fixture.items[0]!.id,
    '失败检查',
  );
  await completeNextRepair(fixture, 'checks-session', ['a'.repeat(40)]);
  const snapshot = createCooking(fixture.database, {
    now: fixture.clock.now,
  }).workspace.getWorkspace(fixture.users.developer.id, fixture.submission.id);
  const node = developerTimeline(created.id, snapshot).find(
    (entry) => entry.kind === 'repair',
  )!.node;
  if (node.result?.outcome !== 'COMPLETED') throw new Error('需要已完成修复');
  node.result.validations = [
    { name: '回归检查', status: 'FAILED', detail: '保存后刷新仍然失败' },
  ];
  const html = renderToStaticMarkup(
    <RepairAttemptDetails
      bug={snapshot.bugs[0]!}
      node={node}
      repair={snapshot.repairByBug[created.id]!}
      latest
      current
      pending={false}
      run={() => {}}
      currentSessionId={node.sessionId}
    />,
  );
  expect(html).toContain('1 项失败');
  expect(html).toContain('失败项');
  expect(html).toContain('保存后刷新仍然失败');
  expect(html).toContain('查看检查明细');
});
