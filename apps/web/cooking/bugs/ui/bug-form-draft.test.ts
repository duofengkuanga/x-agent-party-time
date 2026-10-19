import { expect, test } from 'bun:test';
import {
  lifecycleFixture,
  createBug,
} from '@/cooking/lifecycle/server/lifecycle-fixture';
import { createCooking } from '@/cooking/runtime/create-cooking';
import { testDatabases } from '@/testing/database';
import { createBugFormDraft } from './bug-form-draft';

const setup = lifecycleFixture(testDatabases());

test('连续登记沿用明确选择的工程，草稿恢复保留附件和幂等标识', async () => {
  const f = await setup();
  const snapshot = createCooking(f.database, { now: f.clock.now }).workspace.getWorkspace(
    f.users.tester.id,
    f.submission.id,
  );
  const preferred = {
    submissionItemId: f.items[1]!.id,
    joint: true,
    frontItemId: f.items[0]!.id,
    backItemId: f.items[1]!.id,
  };
  const next = createBugFormDraft(null, snapshot, null, preferred);
  expect(next.submissionItemId).toBe(f.items[1]!.id);
  expect(next.joint).toBe(false);
  const file = new File(['evidence'], '证据.txt', { type: 'text/plain' });
  const saved = {
    ...next,
    title: '保留报告',
    actualResult: '实际结果',
    actualResultFiles: [file],
    joint: true,
  };
  const restored = createBugFormDraft(null, snapshot, saved, null);
  expect(restored.title).toBe('保留报告');
  expect(restored.actualResultFiles[0]).toBe(file);
  expect(restored.mutationId).toBe(saved.mutationId);
  expect(restored.joint).toBe(true);
  expect(
    createBugFormDraft(null, snapshot, { ...saved, submissionItemId: '' }, null)
      .submissionItemId,
  ).toBe('');
});

test('编辑草稿保持原版本，避免关闭后恢复时覆盖他人已经更新的资料', async () => {
  const f = await setup();
  const created = createBug(f, f.items[0]!.id, '原报告');
  const snapshot = createCooking(f.database, { now: f.clock.now }).workspace.getWorkspace(
    f.users.tester.id,
    f.submission.id,
  );
  const bug = snapshot.bugs.find(({ id }) => id === created.id)!;
  const saved = { ...createBugFormDraft(bug, snapshot, null, null), title: '未保存修改' };
  const restored = createBugFormDraft(
    { ...bug, version: bug.version + 1 },
    snapshot,
    saved,
    null,
  );
  expect(restored.expectedVersion).toBe(bug.version);
  expect(restored.title).toBe('未保存修改');
});
