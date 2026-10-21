import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createCooking } from '@/cooking/runtime/createCooking';
import {
  lifecycleFixture,
  createBug,
  createAndRequestBug,
  completeNextRepair,
  completeUpdate,
  createTakeoverSubmission,
} from '@/cooking/lifecycle/server/lifecycleFixture';
import { mutation } from '@/cooking/testing/project';
import { testDatabases } from '@/testing/database';
import { testerBugStatus, latestTesterFeedback } from './testerDetailModel';
import { BugBoard } from './bugBoard';

const setup = lifecycleFixture(testDatabases());

test('同工程下一批待更新倒计时只显示在待更新缺陷卡片上', async () => {
  const fixture = await setup();
  const itemId = fixture.items[1]!.id;
  const updating = createAndRequestBug(fixture, itemId, '正在更新的缺陷');
  await completeNextRepair(fixture, 'updating-repair', ['a'.repeat(40)]);
  await completeUpdate(fixture, itemId, {
    outcome: 'PUSHED',
    summary: '等待外部部署结果',
  });
  const waiting = createAndRequestBug(fixture, itemId, '下一批待更新的缺陷');
  await completeNextRepair(fixture, 'waiting-repair', ['b'.repeat(40)]);
  const repairing = createAndRequestBug(fixture, itemId, '仍在修复的缺陷');
  const workspace = createCooking(fixture.database, {
    now: fixture.clock.now,
  }).workspace;
  const snapshot = workspace.getWorkspace(
    fixture.users.tester.id,
    fixture.submission.id,
  );
  expect(snapshot.pendingDeliveries).toHaveLength(1);
  expect(snapshot.bugs.find(({ id }) => id === updating.id)?.stage).toBe(
    'UPDATING',
  );
  expect(snapshot.bugs.find(({ id }) => id === waiting.id)?.stage).toBe(
    'WAITING_FOR_UPDATE',
  );
  expect(snapshot.bugs.find(({ id }) => id === repairing.id)?.stage).toBe(
    'REPAIRING',
  );
  const board = renderToStaticMarkup(
    <BugBoard snapshot={snapshot} onChanged={() => {}} syncLabel="已同步" />,
  );
  const cards = board.match(
    /<article class="collab-bug-card[^]*?<\/article>/g,
  )!;
  for (const title of ['正在更新的缺陷', '仍在修复的缺陷']) {
    const card = cards.find((card) => card.includes(`<h3>${title}</h3>`));
    expect(card).toBeDefined();
    expect(card).not.toContain('collab-bug-card__countdown');
  }
  expect(
    cards.find((card) => card.includes('<h3>下一批待更新的缺陷</h3>')),
  ).toContain('collab-bug-card__countdown');
});

test('测试详情全流程区分等待修复、等待更新、更新中、可复测和已验收', async () => {
  const fixture = await setup();
  const workspace = createCooking(fixture.database, {
    now: fixture.clock.now,
  }).workspace;
  const bug = createBug(fixture, fixture.items[1]!.id, '内容丢失');
  const read = () => {
    const snapshot = workspace.getWorkspace(
      fixture.users.tester.id,
      fixture.submission.id,
    );
    const current = snapshot.bugs.find(({ id }) => id === bug.id)!;
    return {
      snapshot,
      bug: current,
      message: testerBugStatus(current, snapshot),
    };
  };
  expect(read().message).toContain('确认后可以开始修复');
  fixture.bugs.requestRepair(
    fixture.users.tester.id,
    bug.id,
    mutation(bug.version),
  );
  expect(read().message).toContain('已提交修复');
  await completeNextRepair(fixture, 'private-repair-session', ['a'.repeat(40)]);
  expect(read().message).toContain('测试环境更新后才能复测');
  const batch = await completeUpdate(fixture, fixture.items[1]!.id, {
    outcome: 'PUSHED',
    summary: '已推送',
  });
  expect(read().bug.stage).toBe('UPDATING');
  expect(read().message).toContain('请稍后复测');
  const board = renderToStaticMarkup(
    <BugBoard
      snapshot={read().snapshot}
      onChanged={() => {}}
      syncLabel="已同步"
    />,
  );
  expect(board).toContain('内容丢失');
  expect(board).not.toContain('collab-update-batch-card');
  fixture.updates.reportExternalDeployment(
    fixture.users.developer.id,
    batch.id,
    {
      ...mutation(batch.version),
      outcome: 'SUCCEEDED',
      attachmentIds: [],
    },
  );
  expect(read().message).toBe('可以在持续集成环境复测。');
  fixture.lifecycle.verifyBug(fixture.users.tester.id, bug.id, {
    ...mutation(read().bug.version),
    result: 'PASSED',
    attachmentIds: [],
  });
  expect(read().message).toBe('已验收通过，确认问题解决。');
  expect(read().message).not.toContain('private-repair-session');
});

test('环境被占用后待验证详情不能继续宣称可以复测', async () => {
  const fixture = await setup();
  const workspace = createCooking(fixture.database, {
    now: fixture.clock.now,
  }).workspace;
  const bug = createBug(fixture, fixture.items[0]!.id, '环境校验');
  fixture.bugs.requestRepair(
    fixture.users.tester.id,
    bug.id,
    mutation(bug.version),
  );
  await completeNextRepair(fixture, 'repair-environment', ['a'.repeat(40)]);
  await completeUpdate(fixture, fixture.items[0]!.id, {
    outcome: 'COMPLETED',
    summary: '已更新',
  });
  createTakeoverSubmission(fixture, '另一张提测', '需要同一个环境');
  const snapshot = workspace.getWorkspace(
    fixture.users.tester.id,
    fixture.submission.id,
  );
  const current = snapshot.bugs.find(({ id }) => id === bug.id)!;
  expect(current.stage).toBe('WAITING_FOR_VERIFICATION');
  expect(current.availableActions).not.toContain('VERIFY_PASS');
  expect(testerBugStatus(current, snapshot)).toContain('当前暂不可复测');
  expect(testerBugStatus(current, snapshot)).not.toContain('可以在');
});

test('测试的异常提示不直接复用含技术信息的执行文案，转交关闭不宣称通过', async () => {
  const fixture = await setup();
  const workspace = createCooking(fixture.database, {
    now: fixture.clock.now,
  }).workspace;
  const created = createBug(fixture, fixture.items[0]!.id, '异常提示');
  const snapshot = workspace.getWorkspace(
    fixture.users.tester.id,
    fixture.submission.id,
  );
  const bug = snapshot.bugs[0]!;
  bug.stage = 'REPAIRING';
  for (const visual of [
    { state: 'FAILED', symbol: '×' },
    { state: 'NEEDS_INPUT', symbol: '?' },
    { state: 'NEEDS_APPROVAL', symbol: '!' },
    { state: 'WAITING_TO_RESUME', symbol: 'Ⅱ' },
  ] as const) {
    snapshot.visualByBug[created.id] = {
      ...visual,
      label: '技术命令：git reset；内部会话',
    };
    expect(testerBugStatus(bug, snapshot)).toContain('工程负责人');
    expect(testerBugStatus(bug, snapshot)).not.toMatch(/git|内部会话|技术命令/);
  }
  bug.transferredAt = new Date().toISOString();
  expect(testerBugStatus(bug, snapshot)).toContain('此关闭不代表验收通过');
});

test('最近一次复测反馈按发生时间选择，保留附件并排除验收通过记录', async () => {
  const fixture = await setup();
  const workspace = createCooking(fixture.database, {
    now: fixture.clock.now,
  }).workspace;
  const created = createBug(fixture, fixture.items[0]!.id, '反馈顺序');
  const snapshot = workspace.getWorkspace(
    fixture.users.tester.id,
    fixture.submission.id,
  );
  const base = {
    id: crypto.randomUUID(),
    bugId: created.id,
    round: 1,
    repairAttempt: 1,
    attachments: [],
  };
  snapshot.verificationsByBug[created.id] = [
    {
      ...base,
      result: 'FAILED',
      comment: '首次反馈',
      createdAt: '2026-10-13T08:00:00.000Z',
    },
    {
      ...base,
      result: 'PASSED',
      comment: null,
      createdAt: '2026-10-13T09:00:00.000Z',
    },
  ];
  snapshot.reopensByBug[created.id] = [
    { ...base, feedback: '再次出现', createdAt: '2026-10-13T10:00:00.000Z' },
  ];
  expect(latestTesterFeedback(created.id, snapshot)?.text).toBe('再次出现');
  expect(latestTesterFeedback('missing', snapshot)).toBeUndefined();
});
