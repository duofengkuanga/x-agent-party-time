import { testDatabases } from '@/testing/database';
import { testSkillBinding } from '@/cooking/testing/execution';
import { expect, test } from 'bun:test';
import {
  completeNextRepair,
  completedUpdate,
  freezeUpdate,
  startExecution,
  updateFixture,
} from './update-fixture';
import { RepairExecutionResultSchema } from '@/cooking/repair/contract';
import { completeRepairExecution } from '@/cooking/testing/execution';

const setup = updateFixture(testDatabases());

const handoff = {
  validationCommands: [
    {
      validationIndex: 0,
      command: 'bun test payment.test.ts',
      workingDirectory: '.',
      runtime: 'Bun 1.3',
      conditions: '使用仓库锁定的依赖',
    },
  ],
  environmentNotes: [
    {
      issue: '默认脚本缺少测试环境参数',
      resolution: '使用仓库提供的测试入口',
      appliesWhen: '本机测试环境',
    },
  ],
  impact: [{ path: 'src/payment.ts', note: '付款入口' }],
  remainingWork: ['最终组合尚未构建'],
  limitations: ['未验证外部部署'],
};

test('成功修复的交接随候选冻结，更新只获得必要上下文', async () => {
  const f = await setup();
  const bug = f.createBug('交接付款修复');
  const [repair] = await f.executions.claim(f.runner.id, 1, 0);
  f.executions.start(f.runner.id, repair!.id, {
    kind: 'STARTED',
    leaseToken: repair!.lease.token,
    sessionId: 'handoff-repair',
    taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
  });
  const result = {
    outcome: 'COMPLETED',
    completionKind: 'CHANGES_COMMITTED',
    changes: ['修正付款入口'],
    validations: [{ name: '付款测试', status: 'PASSED', detail: '' }],
    warnings: [],
    commits: ['a'.repeat(40)],
    manualOperations: [],
    handoff,
  };
  const completed = f.executions.complete(f.runner.id, repair!.id, {
    leaseToken: repair!.lease.token,
    sessionId: 'handoff-repair',
    outcome: { kind: 'SUCCEEDED', result: { result } },
  });
  expect(completed.state).toBe('SUCCEEDED');
  const frozen = freezeUpdate(f);
  const update = f.executions.get(frozen.executionId);
  expect(update.codexTurn?.kind).toBe('INITIAL');
  if (update.codexTurn?.kind !== 'INITIAL') throw new Error('需要首次更新');
  expect(update.codexTurn.executionBrief.frozenCandidates).toEqual([
    {
      position: 0,
      bugTitle: '交接付款修复',
      commits: result.commits,
      repairHandoffs: [
        {
          commits: result.commits,
          changes: result.changes,
          validations: result.validations,
          warnings: [],
          handoff,
        },
      ],
    },
  ]);
  expect(JSON.stringify(update.codexTurn.executionBrief)).not.toContain(repair!.id);
  expect(JSON.stringify(f.repairs.repairView(f.users.tester.id, bug.id))).not.toContain(
    'bun test payment.test.ts',
  );
});

test('同一缺陷多次成功修复保留各自交接，冻结后不随来源记录改变', async () => {
  const f = await setup();
  const bug = f.createBug('多轮候选');
  await completeNextRepair(f, 'first-repair', ['a'.repeat(40)]);
  const continuation = f.repairs.createContinuationExecution(bug.id, '补齐修复');
  const [claimed] = await f.executions.claim(f.runner.id, 1, 0);
  expect(claimed!.id).toBe(continuation);
  completeRepairExecution(f, continuation, claimed!.lease.token, 'first-repair', [
    'b'.repeat(40),
  ]);
  const frozen = freezeUpdate(f);
  const before = f.executions.get(frozen.executionId).codexTurn;
  expect(before?.kind).toBe('INITIAL');
  if (before?.kind !== 'INITIAL') throw new Error('需要首次更新');
  expect(before.executionBrief.frozenCandidates).toMatchObject([
    {
      commits: ['a'.repeat(40), 'b'.repeat(40)],
      repairHandoffs: [{ commits: ['a'.repeat(40)] }, { commits: ['b'.repeat(40)] }],
    },
  ]);
  // Simulate out-of-band damage after freezing; execution must use its snapshot.
  f.database.run("UPDATE cooking_repair_attempt SET outcome_json='{}' WHERE bug_id=?", [
    bug.id,
  ]);
  expect(f.executions.get(frozen.executionId).codexTurn).toEqual(before);
});

test.each(['missing', 'different-commit'])(
  '损坏的来源 %s 阻止冻结且不留下更新执行',
  async (damage) => {
    const f = await setup();
    const bug = f.createBug('损坏的交接');
    await completeNextRepair(f, 'damaged-repair', ['a'.repeat(40)]);
    // A corrupted persisted source is an external storage failure, not a user command.
    f.database.run(
      damage === 'missing'
        ? "UPDATE cooking_repair_attempt SET outcome_json=json_remove(outcome_json, '$.handoff') WHERE bug_id=?"
        : "UPDATE cooking_repair_attempt SET outcome_json=json_set(outcome_json, '$.commits[0]', ?) WHERE bug_id=?",
      damage === 'missing' ? [bug.id] : ['c'.repeat(40), bug.id],
    );
    const before = f.updates.workspace(f.users.developer.id, f.submission.id);
    expect(() => freezeUpdate(f)).toThrow('修复交接缺失或与候选提交不一致');
    expect(f.updates.workspace(f.users.developer.id, f.submission.id)).toEqual(before);
    expect(await f.executions.claim(f.runner.id, 1, 0)).toEqual([]);
  },
);

test('交接契约拒绝旧格式、短提交、无效验证引用、本机路径和凭据', () => {
  const valid = {
    outcome: 'COMPLETED',
    completionKind: 'CHANGES_COMMITTED',
    changes: [],
    validations: [{ name: '测试', status: 'PASSED', detail: '' }],
    warnings: [],
    commits: ['a'.repeat(40)],
    manualOperations: [],
    handoff,
  };
  expect(RepairExecutionResultSchema.safeParse({ result: valid }).success).toBe(true);
  const { handoff: _handoff, ...old } = valid;
  const invalid = [
    old,
    { ...valid, commits: ['abcdef0'] },
    {
      ...valid,
      handoff: {
        ...handoff,
        validationCommands: [{ ...handoff.validationCommands[0], validationIndex: 4 }],
      },
    },
    {
      ...valid,
      handoff: { ...handoff, remainingWork: ['使用 /Users/example/private/bin/tool'] },
    },
    { ...valid, handoff: { ...handoff, limitations: ['TOKEN=fixture-credential'] } },
  ];
  for (const result of invalid)
    expect(RepairExecutionResultSchema.safeParse({ result }).success).toBe(false);
});

test('更新解释交接采用和重查依据，响应只向负责人返回技术字段及来源', async () => {
  const f = await setup();
  f.createBug('解释交接');
  await completeNextRepair(f, 'explained-repair', ['a'.repeat(40)]);
  const frozen = freezeUpdate(f);
  const started = await startExecution(f, frozen.executionId, 'explained-update');
  const handoffUse = {
    adopted: ['沿用修复的隔离测试入口'],
    rechecked: [{ context: '工具链', reason: '版本发生变化，重新确认参数' }],
    validationCommands: [
      {
        validationIndex: 0,
        command: 'bun run check:delivery',
        workingDirectory: '.',
        reason: '该入口实际包含测试与构建',
      },
    ],
  };
  const result = f.executions.complete(f.runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    sessionId: started.sessionId,
    outcome: {
      kind: 'SUCCEEDED',
      result: { result: { ...completedUpdate().result, handoffUse } },
    },
  });
  expect(result.state).toBe('SUCCEEDED');
  const owner = f.updates.batchView(f.users.developer.id, frozen.batchId);
  expect(owner.timeline.at(-1)).toMatchObject({ result: { handoffUse } });
  expect(owner.entries[0]).toMatchObject({
    repairHandoffs: [{ commits: ['a'.repeat(40)], attemptId: expect.any(String) }],
  });
  const tester = f.updates.batchView(f.users.tester.id, frozen.batchId);
  expect(tester.timeline.at(-1)).toMatchObject({ result: { handoffUse: null } });
  expect(tester.entries[0]).toMatchObject({ repairHandoffs: null });
  expect(JSON.stringify(tester)).not.toContain('check:delivery');
  expect(JSON.stringify(tester)).not.toContain('attemptId');
});
