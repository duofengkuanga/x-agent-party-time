import { expect, test } from 'bun:test';
import { testDatabases } from '@/testing/database';
import {
  completeSuccessfulExecution,
  testSkillBinding,
} from '@/testing/submissions/execution';
import { testRepairHandoff } from '@/testing/submissions/handoff';
import {
  batchEntries,
  completeNextRepair,
  completedUpdate,
  currentBug,
  freezeUpdate,
  latestBatch,
  pending,
  startExecution,
  updateFixture,
} from './updateFixture';

const setup = updateFixture(testDatabases());

test('最后完成的修复重置五分钟；到期更新与仍在修复的任务并行', async () => {
  const f = await setup();
  const first = f.createBug('第一项');
  await completeNextRepair(f, 'first', ['a'.repeat(40)]);
  expect(pending(f.database, f.item.id)?.eligible_at).toBe('2026-07-27T10:05:00.000Z');
  f.clock.set('2026-07-27T10:04:00.000Z');
  const second = f.createBug('第二项');
  await completeNextRepair(f, 'second', ['b'.repeat(40)]);
  expect(pending(f.database, f.item.id)?.eligible_at).toBe('2026-07-27T10:09:00.000Z');
  f.clock.set('2026-07-27T10:08:59.000Z');
  expect(f.updates.prepareDueExecutions()).toEqual([]);
  const late = f.createBug('尚未完成');
  const repair = (await f.executions.claim(f.runner.id, 1, 0))[0]!;
  f.executions.start(f.runner.id, repair.id, {
    kind: 'STARTED',
    leaseToken: repair.lease.token,
    sessionId: 'late',
    taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
  });
  f.clock.set('2026-07-27T10:09:00.000Z');
  const [updateId] = f.updates.prepareDueExecutions();
  expect(updateId).toBeDefined();
  expect(currentBug(f.database, first.id).stage).toBe('WAITING_FOR_UPDATE');
  expect(currentBug(f.database, second.id).stage).toBe('WAITING_FOR_UPDATE');
  const batch = latestBatch(f.database, f.item.id);
  expect(batchEntries(f.database, batch.id).map((entry) => entry.bug_id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(pending(f.database, f.item.id)).toBeNull();
  const update = await startExecution(f, updateId!, 'update');
  expect(currentBug(f.database, first.id).stage).toBe('UPDATING');
  expect(f.executions.get(repair.id).state).toBe('RUNNING');
  completeSuccessfulExecution(
    f,
    { executionId: repair.id, leaseToken: repair.lease.token, sessionId: 'late' },
    {
      result: {
        outcome: 'COMPLETED',
        completionKind: 'CHANGES_COMMITTED',
        handoff: testRepairHandoff(),
        changes: ['完成修复'],
        validations: [],
        warnings: [],
        commits: ['c'.repeat(40)],
        manualOperations: [],
      },
    },
  );
  expect(currentBug(f.database, late.id).stage).toBe('WAITING_FOR_UPDATE');
  expect(pending(f.database, f.item.id)?.eligible_at).toBe('2026-07-27T10:14:00.000Z');
  expect(batchEntries(f.database, batch.id)).toHaveLength(2);
  completeSuccessfulExecution(f, update, completedUpdate());
  f.clock.set('2026-07-27T10:14:00.000Z');
  expect(f.updates.prepareDueExecutions()).toHaveLength(1);
  expect(
    batchEntries(f.database, latestBatch(f.database, f.item.id).id).map(
      (entry) => entry.bug_id,
    ),
  ).toEqual([late.id]);
});

test('不同 Binding 同一仓库目标分支的更新互斥，完成后下一批才可冻结', async () => {
  const f = await setup({ secondItem: true });
  f.database.run(
    'UPDATE submission_item SET repository_url = (SELECT repository_url FROM submission_item WHERE id = ?) WHERE id = ?',
    [f.item.id, f.secondItem!.id],
  );
  f.createBug('第一工程');
  await completeNextRepair(f, 'first', ['a'.repeat(40)]);
  f.createBugFor(f.secondItem!.id, '第二工程');
  await completeNextRepair(f, 'second', ['b'.repeat(40)]);
  const frozen = freezeUpdate(f);
  expect(() => freezeUpdate(f, f.secondItem!.id)).toThrow('当前没有可以冻结');
  expect(
    f.updates
      .workspace(f.users.developer.id, f.submission.id)
      .pendingDeliveries.find((entry) => entry.submissionItemId === f.secondItem!.id)
      ?.availableActions,
  ).toEqual([]);
  const started = await startExecution(f, frozen.executionId, 'first-update');
  completeSuccessfulExecution(f, started, completedUpdate());
  expect(freezeUpdate(f, f.secondItem!.id).executionId).toBeDefined();
});
