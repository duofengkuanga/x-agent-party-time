import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { LinkedReviewCard } from './bugCard';
import { linkedReviewPairFor } from './testerDetailModel';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSubmissionWorkflow } from '@/server/runtime/createSubmissionWorkflow';
import {
  lifecycleFixture,
  createBug,
  createAndRequestBug,
  completeNextRepair,
  completeUpdate,
  createTakeoverSubmission,
} from '@/server/submissions/lifecycle/lifecycleFixture';
import { mutation } from '@/testing/submissions/project';
import { testDatabases } from '@/testing/database';
import { testerBugStatus, latestTesterFeedback } from './testerDetailModel';
import { BugBoard } from './bugBoard';
import { pendingDeliveryFor } from './boardModel';

const setup = lifecycleFixture(testDatabases());

test('冻结等待启动不重复倒计时，启动失败向测试者显示负责人的下一步', async () => {
  const f = await setup();
  const flow = createSubmissionWorkflow(f.database, { now: f.clock.now });
  const bug = createAndRequestBug(f, f.items[1]!.id, '等待启动');
  await completeNextRepair(f, 'queued-repair', ['a'.repeat(40)]);
  const batch = flow.updates.freezeNow(f.users.developer.id, f.items[1]!.id, {
    mutationId: randomUUID(),
  });
  const claim = (await flow.executions.claim(f.runner.id, 1, 0))[0]!;
  const later = createAndRequestBug(f, f.items[1]!.id, '下一批');
  await completeNextRepair(f, 'later-repair', ['b'.repeat(40)]);
  const queued = flow.workspace.getWorkspace(
    f.users.tester.id,
    f.submission.id,
  );
  const waiting = queued.bugs.find((entry) => entry.id === bug.id)!;
  expect(waiting.stage).toBe('WAITING_FOR_UPDATE');
  expect(testerBugStatus(waiting, queued)).toContain('更新已排队');
  expect(pendingDeliveryFor(waiting, queued)).toBeUndefined();
  expect(
    pendingDeliveryFor(
      queued.bugs.find((entry) => entry.id === later.id)!,
      queued,
    ),
  ).toBeDefined();
  flow.executions.start(f.runner.id, batch.executionId, {
    kind: 'START_FAILED',
    leaseToken: claim.lease.token,
    failure: {
      code: 'CODEX_START_FAILED',
      message: '启动失败',
      retryable: true,
    },
  });
  const failed = flow.workspace.getWorkspace(
    f.users.tester.id,
    f.submission.id,
  );
  expect(
    testerBugStatus(
      failed.bugs.find((entry) => entry.id === bug.id)!,
      failed,
    ),
  ).toContain('环境更新启动未完成');
});

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
  const workspace = createSubmissionWorkflow(fixture.database, {
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
  const workspace = createSubmissionWorkflow(fixture.database, {
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
  const workspace = createSubmissionWorkflow(fixture.database, {
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
  const workspace = createSubmissionWorkflow(fixture.database, {
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
  const workspace = createSubmissionWorkflow(fixture.database, {
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

test('测试视角在双方就绪后只显示一组通过和还有问题，未就绪时说明另一端进度', async () => {
  const fixture = await setup();
  const created = fixture.bugs.createLinkedBugs(
    fixture.users.tester.id,
    fixture.submission.id,
    {
      mutationId: randomUUID(),
      submissionItemIds: [fixture.items[0]!.id, fixture.items[1]!.id],
      title: '共同问题',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    },
  );
  const [front, back] = created.bugs;
  fixture.database.run(
    "UPDATE submission_bug SET stage = 'WAITING_FOR_VERIFICATION' WHERE id = ?",
    front!.id,
  );
  fixture.database.run(
    "UPDATE submission_bug SET stage = 'REPAIRING' WHERE id = ?",
    back!.id,
  );
  const readPair = () => {
    const bugs = fixture.bugs.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).bugs;
    return linkedReviewPairFor(bugs[0]!, bugs)!;
  };
  let pair = readPair();
  expect(pair.ready).toBe(false);
  expect(pair.frontend.linkedReview?.blockedReason).toContain(
    '后端缺陷仍在修复中',
  );

  fixture.database.run(
    "UPDATE submission_bug SET stage = 'DONE' WHERE id = ?",
    back!.id,
  );
  pair = readPair();
  expect(pair.ready).toBe(true);
  expect(pair.column).toBe('WAITING_FOR_VERIFICATION');
  const renderPair = () =>
    renderToStaticMarkup(
      <LinkedReviewCard
        frontend={pair.frontend}
        backend={pair.backend}
        onArchive={() => {}}
        onOpen={() => {}}
        onIssue={() => {}}
        onVerifyPass={() => {}}
        pending={false}
      />,
    );
  const html = renderPair();
  expect(html).toContain('前端');
  expect(html).toContain('后端');
  expect(html.match(/>通过</g)).toHaveLength(1);
  expect(html.match(/>还有问题</g)).toHaveLength(1);
  expect(html).not.toContain('统一验收');

  fixture.database.run(
    'UPDATE submission_environment_lock SET deployment_confirmed = 0 WHERE submission_item_id = ?',
    fixture.items[0]!.id,
  );
  pair = readPair();
  expect(pair.ready).toBe(false);
  expect(pair.column).toBe('WAITING_FOR_VERIFICATION');
  expect(renderPair()).toContain('确认当前提测版本已部署');
  expect(renderPair()).not.toContain('>通过<');
  expect(renderPair()).not.toContain('>还有问题<');

  fixture.database.run(
    "UPDATE submission_bug SET stage = 'DONE' WHERE id = ?",
    front!.id,
  );
  pair = readPair();
  expect(pair.column).toBe('DONE');
  const completed = renderPair();
  expect(completed).toContain('重新打开');
  expect(completed).toContain('归档');
  expect(completed).not.toContain('>通过<');
  fixture.database.run(
    "UPDATE test_submission SET status = 'CLOSED' WHERE id = ?",
    fixture.submission.id,
  );
  pair = readPair();
  expect(renderPair()).toContain('已关闭提测单不能操作');
  expect(renderPair()).not.toContain('>重新打开<');
  expect(renderPair()).not.toContain('>归档<');
});
