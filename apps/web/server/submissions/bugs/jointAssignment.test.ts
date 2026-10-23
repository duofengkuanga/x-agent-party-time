import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { testDatabases } from '@/testing/database';
import { bugFixture, createBug } from './bugFixture';

const setup = bugFixture(testDatabases());

test('负责人将未分诊缺陷调整为前端后端，原 ID 和附件保留，重复请求不重复拆单', async () => {
  const f = await setup();
  const file = await f.files.put({
    bytes: new TextEncoder().encode('原始附件'),
    originalName: 'report.txt',
    mediaType: 'text/plain',
    uploadedByUserId: f.users.tester.id,
  });
  const source = createBug(f, f.users.tester.id, {
    title: '跨工程问题',
    expectedResultAttachmentIds: [file.id],
  }).bug;
  const input = {
    mutationId: randomUUID(),
    expectedVersion: source.version,
    submissionItemId: f.items.front,
    additionalSubmissionItemId: f.items.back,
  };
  const result = f.service.assignBug(f.users.developerA.id, source.id, input);
  expect(f.service.assignBug(f.users.developerA.id, source.id, input)).toEqual(result);
  expect(result.bug.id).toBe(source.id);
  expect(result.bug.report).toEqual(source.report);
  const bugs = f.service.workspace(f.users.tester.id, f.submission.id).bugs;
  expect(bugs).toHaveLength(2);
  expect(
    bugs.every(
      (bug) =>
        bug.stage === 'WAITING_FOR_REPAIR' &&
        bug.collaborationLocked &&
        !bug.reportLockedAt,
    ),
  ).toBe(true);
  expect(bugs.map((bug) => bug.submissionItemId).sort()).toEqual(
    [f.items.front, f.items.back].sort(),
  );
  expect(
    bugs.every((bug) => bug.report.expectedResultAttachments[0]?.id === file.id),
  ).toBe(true);
  expect(bugs.every((bug) => bug.relatedBugs.length === 1)).toBe(true);
  expect(f.database.all('SELECT * FROM submission_repair_attempt')).toHaveLength(0);
});

test('编辑报告时可以同步补建关联单，新单使用保存后的资料和附件', async () => {
  const f = await setup();
  const source = createBug(f, f.users.tester.id, {
    title: '待补充',
    submissionItemId: f.items.back,
  }).bug;
  const file = await f.files.put({
    bytes: new TextEncoder().encode('补充截图'),
    originalName: 'new.txt',
    mediaType: 'text/plain',
    uploadedByUserId: f.users.tester.id,
  });
  const result = f.service.updateReport(f.users.tester.id, source.id, {
    mutationId: randomUUID(),
    expectedVersion: source.version,
    submissionItemId: f.items.back,
    additionalSubmissionItemId: f.items.front,
    title: '完整问题',
    expectedResult: '前后端共同完成',
    actualResultAttachmentIds: [],
    expectedResultAttachmentIds: [file.id],
  });
  expect(result.bug.submissionItemId).toBe(f.items.back);
  const bugs = f.service.workspace(f.users.tester.id, f.submission.id).bugs;
  expect(bugs).toHaveLength(2);
  expect(
    bugs.every(
      (bug) =>
        bug.report.title === '完整问题' && bug.report.expectedResult === '前后端共同完成',
    ),
  ).toBe(true);
  expect(
    bugs.every((bug) => bug.report.expectedResultAttachments[0]?.id === file.id),
  ).toBe(true);
});

test('无权、重复工程、非当前提测工程和已修复缺陷不能拆单，失败保留原单', async () => {
  const f = await setup();
  const source = createBug(f, f.users.tester.id, { title: '不能错误拆单' }).bug;
  const input = {
    mutationId: randomUUID(),
    expectedVersion: source.version,
    submissionItemId: f.items.front,
    additionalSubmissionItemId: f.items.back,
  };
  expect(() => f.service.assignBug(f.users.member.id, source.id, input)).toThrow(
    '当前成员不能分诊',
  );
  expect(() =>
    f.service.assignBug(f.users.tester.id, source.id, {
      ...input,
      additionalSubmissionItemId: f.items.front,
    }),
  ).toThrow('请选择一个前端工程和一个后端工程');
  expect(() =>
    f.service.assignBug(f.users.tester.id, source.id, {
      ...input,
      additionalSubmissionItemId: randomUUID(),
    }),
  ).toThrow();
  expect(() =>
    f.service.assignBug(f.users.tester.id, source.id, {
      ...input,
      submissionItemId: null,
    }),
  ).toThrow('请选择一个前端工程和一个后端工程');
  expect(f.service.workspace(f.users.tester.id, f.submission.id).bugs).toHaveLength(1);
  expect(
    f.database.get<{ version: number; submission_item_id: string | null }>(
      'SELECT version, submission_item_id FROM submission_bug WHERE id = ?',
      source.id,
    ),
  ).toEqual({ version: source.version, submission_item_id: null });
  f.database.run('UPDATE submission_bug SET report_locked_at = ? WHERE id = ?', [
    new Date().toISOString(),
    source.id,
  ]);
  expect(() => f.service.assignBug(f.users.tester.id, source.id, input)).toThrow(
    '首次修复后',
  );
});

test('已形成双工程关联后不能再次补建，后续请求不会增加第三张单', async () => {
  const f = await setup();
  const source = createBug(f, f.users.tester.id, { title: '一次关联' }).bug;
  const input = {
    mutationId: randomUUID(),
    expectedVersion: source.version,
    submissionItemId: f.items.front,
    additionalSubmissionItemId: f.items.back,
  };
  const result = f.service.assignBug(f.users.owner.id, source.id, input);
  expect(() =>
    f.service.assignBug(f.users.owner.id, source.id, {
      ...input,
      mutationId: randomUUID(),
      expectedVersion: result.bug.version,
    }),
  ).toThrow('前后端关联单不能调整');
  expect(f.service.workspace(f.users.tester.id, f.submission.id).bugs).toHaveLength(2);
});

test('关联写入失败时回滚原单归属、新单与附件关联', async () => {
  const f = await setup();
  const source = createBug(f, f.users.tester.id, { title: '原子归属调整' }).bug;
  f.database.exec(
    "CREATE TRIGGER reject_joint BEFORE INSERT ON submission_bug_relation BEGIN SELECT RAISE(ABORT, '模拟关联写入失败'); END",
  );
  expect(() =>
    f.service.assignBug(f.users.tester.id, source.id, {
      mutationId: randomUUID(),
      expectedVersion: source.version,
      submissionItemId: f.items.front,
      additionalSubmissionItemId: f.items.back,
    }),
  ).toThrow('模拟关联写入失败');
  expect(f.service.workspace(f.users.tester.id, f.submission.id).bugs).toHaveLength(1);
  expect(
    f.database.get(
      'SELECT submission_item_id, collaboration_locked, version FROM submission_bug WHERE id = ?',
      source.id,
    ),
  ).toEqual({
    submission_item_id: null,
    collaboration_locked: 0,
    version: source.version,
  });
});
