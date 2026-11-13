import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { testDatabases } from '@/testing/database';
import { testRepairHandoff } from '@/testing/submissions/handoff';
import { testTestingScope } from '@/testing/submissions/testingScope';
import {
  completeSuccessfulExecution,
  testSkillBinding,
} from '@/testing/submissions/execution';
import { mutation } from '@/testing/submissions/project';
import { createSubmissionWorkflow } from '@/server/runtime/createSubmissionWorkflow';
import {
  updateFixture,
  completedUpdate,
  freezeUpdate,
  startExecution,
} from '@/server/submissions/update/updateFixture';
import {
  TestingScopeSchema,
  projectTestingScope,
} from '@/contracts/submissions/testingScope';
import { RepairExecutionResultSchema } from '@/contracts/submissions/repair';
import {
  TesterChecklist,
  testerChecklist,
  testInstructionLines,
} from './testerChecklist';
import { TesterAttachments } from './testerAttachments';
import type { StoredAttachment } from './attachments';

const setup = updateFixture(testDatabases());
const scope = (title: string, head = 'a'.repeat(40)) => ({
  ...testTestingScope(head),
  points: [
    {
      kind: 'ORIGINAL' as const,
      title,
      steps: '填写金额后提交订单。',
      expectedResult: '订单金额与填写金额一致。',
    },
    {
      kind: 'DERIVED' as const,
      title: `${title}的批量提交`,
      steps: '选择两个订单后批量提交。',
      expectedResult: '两个订单各自保留正确金额。',
      reason: '本次修复调整了单笔与批量提交共用的金额计算。',
      evidence: [
        {
          path: 'src/privatePayment.ts',
          note: '批量提交调用本次改动的金额函数。',
        },
      ],
    },
  ],
  limitations: ['尚未覆盖弱网下的重复提交。'],
});

async function repair(
  f: Awaited<ReturnType<typeof setup>>,
  title: string,
  commit = 'a'.repeat(40),
  existingBugId?: string,
) {
  const bug = existingBugId
    ? f.bugs
        .workspace(f.users.tester.id, f.submission.id)
        .bugs.find(({ id }) => id === existingBugId)!
    : f.createBug(title);
  const [claimed] = await f.executions.claim(f.runner.id, 1, 0);
  const started = {
    executionId: claimed!.id,
    leaseToken: claimed!.lease.token,
    sessionId: `scope-${bug.id}`,
  };
  f.executions.start(f.runner.id, started.executionId, {
    kind: 'STARTED',
    leaseToken: started.leaseToken,
    sessionId: started.sessionId,
    taskSkillBinding: testSkillBinding('XBugRepaire'),
  });
  const result = {
    outcome: 'COMPLETED',
    completionKind: 'CHANGES_COMMITTED',
    commits: [commit],
    changes: ['修正订单金额'],
    validations: [{ name: '修复及关联检查', status: 'PASSED', detail: '' }],
    warnings: [],
    manualOperations: [],
    handoff: testRepairHandoff(),
    testingScope: scope(title, commit),
  };
  expect(completeSuccessfulExecution(f, started, { result }).state).toBe(
    'SUCCEEDED',
  );
  return bug;
}

test('清单从修复预览冻结到最终部署，按 Bug 分流并在返修后失效', async () => {
  const f = await setup();
  const first = await repair(f, '单笔付款');
  const second = await repair(f, '另一个缺陷', 'b'.repeat(40));
  const workspace = createSubmissionWorkflow(f.database, {
    now: f.clock.now,
  }).workspace;
  const read = () => workspace.getWorkspace(f.users.tester.id, f.submission.id);
  let snapshot = read();
  let bug = snapshot.bugs.find(({ id }) => id === first.id)!;
  expect(testerChecklist(bug, snapshot).preview).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('src/privatePayment.ts');
  const frozen = freezeUpdate(f);
  const original = f.updates.batchView(f.users.developer.id, frozen.batchId)
    .entries[0]!.repairHandoffs![0]!.testingScope;
  expect(original).toEqual(scope('单笔付款'));
  const started = await startExecution(f, frozen.executionId, 'scope-update');
  const completed = completedUpdate([0, 1]);
  completed.result.testingScopes[0]!.testingScope = scope('最终单笔付款');
  completed.result.testingScopes[1]!.testingScope = scope('另一个缺陷');
  expect(completeSuccessfulExecution(f, started, completed).state).toBe(
    'SUCCEEDED',
  );
  snapshot = read();
  bug = snapshot.bugs.find(({ id }) => id === first.id)!;
  expect(testerChecklist(bug, snapshot).preview).toBe(false);
  const markup = renderToStaticMarkup(
    <TesterChecklist bug={bug} snapshot={snapshot} />,
  );
  expect(markup).toContain('最终单笔付款');
  expect(markup).toContain('衍生回归');
  expect(markup).not.toContain('尚未覆盖');
  expect(markup).not.toContain('role="tab"');
  expect(markup.match(/class="collab-tester-checklist__panel"/g)).toHaveLength(
    2,
  );
  expect(markup.match(/hidden=""/g)).toHaveLength(1);
  expect(markup).toContain('操作步骤');
  expect(markup).toContain('预期结果');
  expect(markup).toContain('关联原因');
  expect(
    [...markup.matchAll(/<h3 id="[^"]+">([^<]+)<\/h3>/g)].map(
      (match) => match[1],
    ),
  ).toEqual(['最终单笔付款的批量提交', '最终单笔付款']);
  expect(markup).not.toContain('另一个缺陷');
  expect(markup).not.toContain('src/privatePayment.ts');
  expect(JSON.stringify(snapshot)).not.toContain('headCommit');
  expect(
    f.updates.batchView(f.users.developer.id, frozen.batchId).entries[0]!
      .repairHandoffs![0]!.testingScope,
  ).toEqual(original);
  expect(
    testerChecklist(
      snapshot.bugs.find(({ id }) => id === second.id)!,
      snapshot,
    ).scopes[0]!.points[0]!.title,
  ).toBe('另一个缺陷');
  f.lifecycle.verifyBug(f.users.tester.id, first.id, {
    ...mutation(bug.version),
    result: 'FAILED',
    feedback: '仍有金额错误',
    attachmentIds: [],
  });
  snapshot = read();
  expect(
    testerChecklist(
      snapshot.bugs.find(({ id }) => id === first.id)!,
      snapshot,
    ).scopes,
  ).toEqual([]);
  await repair(f, '第二轮单笔付款', 'c'.repeat(40), first.id);
  const secondBatch = freezeUpdate(f);
  expect(
    f.updates.batchView(f.users.tester.id, secondBatch.batchId).frozenAt,
  ).toBe(f.updates.batchView(f.users.tester.id, frozen.batchId).frozenAt);
  const secondUpdate = await startExecution(
    f,
    secondBatch.executionId,
    'scope-update-second',
  );
  const secondResult = completedUpdate();
  secondResult.result.testingScopes[0]!.testingScope =
    scope('第二轮最终单笔付款');
  completeSuccessfulExecution(f, secondUpdate, secondResult);
  snapshot = read();
  expect(
    testerChecklist(
      snapshot.bugs.find(({ id }) => id === first.id)!,
      snapshot,
    ).scopes[0]!.points[0]!.title,
  ).toBe('第二轮最终单笔付款');
});

test('关联缺陷的全部测试项进入轮播，衍生回归前置且同类顺序保留', async () => {
  const f = await setup();
  const first = await repair(f, '前端保存');
  const second = await repair(f, '后端保存', 'b'.repeat(40));
  const snapshot = createSubmissionWorkflow(f.database, {
    now: f.clock.now,
  }).workspace.getWorkspace(f.users.tester.id, f.submission.id);
  const markup = renderToStaticMarkup(
    <TesterChecklist
      bug={snapshot.bugs.find(({ id }) => id === first.id)!}
      relatedBug={snapshot.bugs.find(({ id }) => id === second.id)!}
      snapshot={snapshot}
    />,
  );
  expect(markup.match(/class="collab-tester-checklist__panel"/g)).toHaveLength(
    4,
  );
  expect(markup.match(/hidden=""/g)).toHaveLength(3);
  expect(
    [...markup.matchAll(/<h3 id="[^"]+">([^<]+)<\/h3>/g)].map(
      (match) => match[1],
    ),
  ).toEqual([
    '前端保存的批量提交',
    '后端保存的批量提交',
    '前端保存',
    '后端保存',
  ]);
});

test.each([
  [
    '打开详情。点击编辑；取消后返回。',
    ['打开详情。', '点击编辑；', '取消后返回。'],
  ],
  [
    '1. 打开详情\n2. 点击编辑\n- 检查列表',
    ['打开详情', '点击编辑', '检查列表'],
  ],
  [
    '金额 1.5，访问 https://example.com/a?x=1.5',
    ['金额 1.5，访问 https://example.com/a?x=1.5'],
  ],
  ['\r\n 保存内容。\r\n\r\n刷新。 ', ['保存内容。', '刷新。']],
] as const)('测试指引分段保留原文含义：%s', (text, expected) => {
  expect(testInstructionLines(text)).toEqual(expected);
});

test.each(['缺项', '重复', '错误版本', '错误工程', '错误位置'] as const)(
  '拒绝%s的最终测试范围，不把 Bug 推进待验证',
  async (problem) => {
    const f = await setup();
    const bug = await repair(f, '范围校验');
    const frozen = freezeUpdate(f);
    const started = await startExecution(
      f,
      frozen.executionId,
      'invalid-scope-update',
    );
    const completed = completedUpdate();
    if (problem === '缺项') completed.result.testingScopes = [];
    if (problem === '重复')
      completed.result.testingScopes.push(completed.result.testingScopes[0]!);
    if (problem === '错误版本')
      completed.result.testingScopes[0]!.testingScope.review.headCommit =
        'c'.repeat(40);
    if (problem === '错误工程')
      completed.result.testingScopes[0]!.engineeringAlias = 'repo-2';
    if (problem === '错误位置')
      completed.result.testingScopes[0]!.candidatePosition = 1;
    completeSuccessfulExecution(f, started, completed);
    expect(
      f.updates.batchView(f.users.developer.id, frozen.batchId).state,
    ).toBe('FAILED');
    expect(
      f.bugs
        .workspace(f.users.tester.id, f.submission.id)
        .bugs.find(({ id }) => id === bug.id)!.stage,
    ).toBe('UPDATING');
  },
);

test('衍生项需要原因与本次变更证据，公共投影只留下业务内容', () => {
  const original = scope('付款');
  expect(TestingScopeSchema.safeParse(original).success).toBe(true);
  expect(
    TestingScopeSchema.safeParse({
      ...original,
      points: [{ ...original.points[1], evidence: [] }],
    }).success,
  ).toBe(false);
  expect(
    TestingScopeSchema.safeParse({
      ...original,
      points: [{ ...original.points[1], reason: '' }],
    }).success,
  ).toBe(false);
  const publicText = JSON.stringify(projectTestingScope(original));
  expect(publicText).not.toContain('evidence');
  expect(publicText).not.toContain('baseCommit');
  expect(publicText).toContain('金额计算');
});

test('无改动修复仍要求同一版本的范围，缺失清单不能报告成功', () => {
  const result = {
    outcome: 'COMPLETED',
    completionKind: 'TARGET_ALREADY_FIXED',
    changes: [],
    commits: [],
    manualOperations: [],
    validations: [{ name: '复测', status: 'PASSED', detail: '' }],
    warnings: [],
    testingScope: testTestingScope('a'.repeat(40), 'a'.repeat(40)),
  };
  expect(RepairExecutionResultSchema.safeParse({ result }).success).toBe(true);
  expect(
    RepairExecutionResultSchema.safeParse({
      result: { ...result, testingScope: undefined },
    }).success,
  ).toBe(false);
  expect(
    RepairExecutionResultSchema.safeParse({
      result: {
        ...result,
        testingScope: testTestingScope('a'.repeat(40), 'b'.repeat(40)),
      },
    }).success,
  ).toBe(false);
});

test('截图直接展示且提供放大入口，多图可轮播，普通附件仍可下载', () => {
  const attachments: StoredAttachment[] = [
    {
      id: 'first',
      originalName: '第一张.png',
      mediaType: 'image/png',
      sizeBytes: 100,
      createdAt: '2026-11-05T00:00:00.000Z',
    },
    {
      id: 'second',
      originalName: '第二张.png',
      mediaType: 'image/png',
      sizeBytes: 100,
      createdAt: '2026-11-05T00:00:00.000Z',
    },
    {
      id: 'file',
      originalName: '说明.txt',
      mediaType: 'text/plain',
      sizeBytes: 100,
      createdAt: '2026-11-05T00:00:00.000Z',
    },
  ];
  const markup = renderToStaticMarkup(
    <TesterAttachments attachments={attachments} />,
  );
  expect(markup).toContain('<img');
  expect(markup).toContain('1 / 2');
  expect(markup).toContain('下一张截图');
  expect(markup).toContain('aria-label="放大截图 第一张.png"');
  expect(markup).toContain('正在加载截图');
  expect(markup).toContain('/api/submissions/attachments/file');
  expect(markup).not.toContain('role="dialog"');
  expect(markup).not.toContain('查看图片');
});
