import { mutation } from '@/cooking/testing/project';
import { expectRowCount, testDatabases } from '@/testing/database';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  bindingForItem,
  createAndRequestBug,
  createBug,
  createTakeoverSubmission,
  lifecycleFixture,
  submissionRow,
} from './lifecycleFixture';

const setup = lifecycleFixture(testDatabases());
type Fixture = Awaited<ReturnType<typeof setup>>;

function availableActions(f: Fixture, userId = f.users.tester.id) {
  return f.submissions.getWorkspace(userId, f.submission.id).submission.availableActions;
}

function expectBlocked(f: Fixture, code: string, message: string) {
  const before = submissionRow(f.database, f.submission.id);
  const locks = f.database.all('SELECT * FROM cooking_submission_environment_lock');
  const eventCount = f.events.length;
  const input = mutation(before.version);
  expect(availableActions(f)).not.toContain('CLOSE');
  expect(() =>
    f.lifecycle.closeSubmission(f.users.tester.id, f.submission.id, input),
  ).toThrow(expect.objectContaining({ code, message }));
  expect(submissionRow(f.database, f.submission.id)).toEqual(before);
  expect(f.database.all('SELECT * FROM cooking_submission_environment_lock')).toEqual(
    locks,
  );
  expect(f.events).toHaveLength(eventCount);
  expectRowCount(f.database, 'cooking_cleanup').toBe(0);
  expectRowCount(f.database, 'cooking_mutation', { id: input.mutationId }).toBe(0);
}

function insertBatch(f: Fixture, state: string): string {
  const id = randomUUID();
  const now = f.clock.now().toISOString();
  f.database.run(
    `INSERT INTO cooking_update_batch(
      id, submission_id, submission_item_id, state, version,
      deployment_json, frozen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      id,
      f.submission.id,
      f.items[0]!.id,
      state,
      JSON.stringify({ kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' }),
      now,
      now,
      now,
    ],
  );
  return id;
}

test.each([
  'WAITING_FOR_REPAIR',
  'REPAIRING',
  'WAITING_FOR_UPDATE',
  'UPDATING',
  'WAITING_FOR_VERIFICATION',
])('缺陷处于 %s 时，工作区与关闭命令一致阻止关闭', async (stage) => {
  const f = await setup();
  const bug = createBug(f, f.items[0]!.id, '未完成的缺陷');
  f.database.run('UPDATE cooking_bug SET stage = ? WHERE id = ?', [stage, bug.id]);
  expectBlocked(f, 'INVALID_TRANSITION', '仍有未完成缺陷，不能关闭提测单');
});

test.each(['READY', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED'])(
  '更新批次处于 %s 时，即使没有未完成缺陷也不能关闭',
  async (state) => {
    const f = await setup();
    insertBatch(f, state);
    expectBlocked(f, 'INVALID_TRANSITION', '仍有未完成更新批次，不能关闭提测单');
  },
);

for (const kind of ['BUG_REPAIR', 'UPDATE_BATCH'] as const) {
  test.each([
    'QUEUED',
    'CLAIMED',
    'RUNNING',
    'WAITING_FOR_INTERACTION',
    'WAITING_TO_RESUME',
    'CANCEL_REQUESTED',
  ])(`${kind} 执行处于 %s 时，终态业务记录也不能绕过执行检查`, async (state) => {
    const f = await setup();
    const ownerId =
      kind === 'BUG_REPAIR'
        ? createBug(f, f.items[0]!.id, '遗留执行的缺陷').id
        : insertBatch(f, 'COMPLETED');
    if (kind === 'BUG_REPAIR')
      f.database.run("UPDATE cooking_bug SET stage = 'CANCELLED' WHERE id = ?", [
        ownerId,
      ]);
    const execution = f.executions.enqueue({
      owner: { namespace: 'cooking', kind, id: ownerId },
      attempt: 1,
      previousExecutionId: null,
      runnerId: f.runner.id,
      bindingId: bindingForItem(f.database, f.items[0]!.id),
      priority: 0,
      approvalPolicy: 'never',
      codexTurn: null,
      workspace: null,
      attachmentIds: [],
    });
    if (kind === 'BUG_REPAIR')
      f.database.run(
        `INSERT INTO cooking_repair_attempt(id, bug_id, execution_id, attempt, created_at)
         VALUES (?, ?, ?, 1, ?)`,
        [randomUUID(), ownerId, execution.id, f.clock.now().toISOString()],
      );
    else
      f.database.run(
        `INSERT INTO cooking_update_attempt(id, batch_id, execution_id, attempt, created_at)
         VALUES (?, ?, ?, 1, ?)`,
        [randomUUID(), ownerId, execution.id, f.clock.now().toISOString()],
      );
    f.database.run('UPDATE platform_execution SET state = ? WHERE id = ?', [
      state,
      execution.id,
    ]);
    expectBlocked(f, 'RESOURCE_CONFLICT', '仍有修复或更新执行未结束，不能关闭提测单');
    f.database.run("UPDATE platform_execution SET state = 'CANCELLED' WHERE id = ?", [
      execution.id,
    ]);
    expect(availableActions(f)).toContain('CLOSE');
  });
}

test('已完成和已取消缺陷、已完成批次允许关闭，关闭后工作区不再提供关闭操作', async () => {
  const f = await setup();
  for (const stage of ['DONE', 'CANCELLED']) {
    const bug = createBug(f, f.items[0]!.id, stage);
    f.database.run('UPDATE cooking_bug SET stage = ? WHERE id = ?', [stage, bug.id]);
  }
  insertBatch(f, 'COMPLETED');
  expect(availableActions(f)).toContain('CLOSE');
  f.lifecycle.closeSubmission(
    f.users.tester.id,
    f.submission.id,
    mutation(f.submission.version),
  );
  expect(submissionRow(f.database, f.submission.id).status).toBe('CLOSED');
  expect(availableActions(f)).not.toContain('CLOSE');
  expectRowCount(f.database, 'cooking_submission_environment_lock', {
    submission_id: f.submission.id,
  }).toBe(0);
});

test('关闭前仍先检查测试负责人和版本，再判断业务是否结束', async () => {
  const f = await setup();
  createBug(f, f.items[0]!.id, '尚未完成');
  for (const actor of [f.users.owner, f.users.developer]) {
    expect(availableActions(f, actor.id)).not.toContain('CLOSE');
    expect(() =>
      f.lifecycle.closeSubmission(
        actor.id,
        f.submission.id,
        mutation(f.submission.version),
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  }
  expect(() =>
    f.lifecycle.closeSubmission(
      f.users.tester.id,
      f.submission.id,
      mutation(f.submission.version + 1),
    ),
  ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
  expectBlocked(f, 'INVALID_TRANSITION', '仍有未完成缺陷，不能关闭提测单');
});

test('多项阻断同时存在时，保持缺陷、活跃执行、未完成批次的错误优先级', async () => {
  const f = await setup();
  const bug = createAndRequestBug(f, f.items[0]!.id, '仍在处理的缺陷');
  const batchId = insertBatch(f, 'FAILED');
  expectBlocked(f, 'INVALID_TRANSITION', '仍有未完成缺陷，不能关闭提测单');
  f.database.run("UPDATE cooking_bug SET stage = 'CANCELLED' WHERE id = ?", [bug.id]);
  expectBlocked(f, 'RESOURCE_CONFLICT', '仍有修复或更新执行未结束，不能关闭提测单');
  const attempt = f.database.get<{ execution_id: string }>(
    'SELECT execution_id FROM cooking_repair_attempt WHERE bug_id = ?',
    bug.id,
  )!;
  f.executions.requestCancellation(attempt.execution_id);
  expectBlocked(f, 'INVALID_TRANSITION', '仍有未完成更新批次，不能关闭提测单');
  f.database.run("UPDATE cooking_update_batch SET state = 'COMPLETED' WHERE id = ?", [
    batchId,
  ]);
  expect(availableActions(f)).toContain('CLOSE');
});

test('另一提测单的未完成缺陷不会阻止当前提测关闭，也不会释放对方的环境', async () => {
  const f = await setup();
  const { next } = createTakeoverSubmission(f, '另一提测单', '隔离关闭条件');
  f.bugs.createBug(f.users.tester.id, next.id, {
    mutationId: randomUUID(),
    submissionItemId: null,
    title: '另一提测单仍有问题',
    actualResultAttachmentIds: [],
    expectedResultAttachmentIds: [],
  });
  expect(availableActions(f)).toContain('CLOSE');
  f.lifecycle.closeSubmission(
    f.users.tester.id,
    f.submission.id,
    mutation(f.submission.version),
  );
  expect(submissionRow(f.database, next.id).status).toBe('ACTIVE');
  expectRowCount(f.database, 'cooking_submission_environment_lock', {
    submission_id: next.id,
  }).toBe(1);
});
