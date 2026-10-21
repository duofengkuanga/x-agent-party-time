import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createCooking } from '@/cooking/runtime/createCooking';
import { testDatabases } from '@/testing/database';
import { bugFixture, createAssignedBug, createBug } from './bugFixture';

const setup = bugFixture(testDatabases());

for (const joint of [false, true]) {
  test(`${joint ? '双工程' : '单工程'}登记并修复原子入队，重复提交不重复执行`, async () => {
    const f = await setup();
    const { bugs } = createCooking(f.database);
    const file = await f.files.put({
      bytes: new TextEncoder().encode('修复证据'),
      originalName: '证据.txt',
      mediaType: 'text/plain',
      uploadedByUserId: f.users.tester.id,
    });
    const report = {
      mutationId: randomUUID(),
      title: '登记并修复',
      startRepair: true,
      actualResultAttachmentIds: [file.id],
      expectedResultAttachmentIds: [],
    };
    const create = () =>
      joint
        ? bugs.createLinkedBugs(f.users.tester.id, f.submission.id, {
            ...report,
            submissionItemIds: [f.items.front, f.items.back],
          })
        : bugs.createBug(f.users.tester.id, f.submission.id, {
            ...report,
            submissionItemId: f.items.front,
          });
    const result = create();
    expect(create()).toEqual(result);
    const view = bugs.workspace(f.users.tester.id, f.submission.id);
    expect(view.bugs).toHaveLength(joint ? 2 : 1);
    for (const bug of view.bugs) {
      expect(bug.stage).toBe('REPAIRING');
      expect(bug.reportLockedAt).not.toBeNull();
      expect(bug.report.actualResultAttachments.map(({ id }) => id)).toEqual([file.id]);
      expect(bug.relatedBugs).toHaveLength(joint ? 1 : 0);
      expect(
        f.database.all('SELECT id FROM cooking_repair_attempt WHERE bug_id = ?', bug.id),
      ).toHaveLength(1);
      expect(
        f.database.all(
          'SELECT bug_id FROM cooking_bug_deployment WHERE bug_id = ?',
          bug.id,
        ),
      ).toHaveLength(1);
    }
    expect(f.database.all('SELECT id FROM platform_execution')).toHaveLength(
      joint ? 2 : 1,
    );
    expect(
      f.database.all('SELECT id FROM cooking_mutation WHERE id = ?', report.mutationId),
    ).toHaveLength(1);
  });

  test(`${joint ? '第二工程' : '单工程'}入队失败回滚登记、附件和执行，并允许原请求重试`, async () => {
    const f = await setup();
    let calls = 0;
    let fail = true;
    const { bugs } = createCooking(f.database, {
      ids: {
        repair: () => {
          if (fail && ++calls === (joint ? 3 : 1)) throw new Error('模拟入队失败');
          return randomUUID();
        },
      },
    });
    const file = await f.files.put({
      bytes: new TextEncoder().encode('保留附件'),
      originalName: '证据.txt',
      mediaType: 'text/plain',
      uploadedByUserId: f.users.tester.id,
    });
    const report = {
      mutationId: randomUUID(),
      title: '失败可重试',
      startRepair: true,
      actualResultAttachmentIds: [file.id],
      expectedResultAttachmentIds: [],
    };
    const create = () =>
      joint
        ? bugs.createLinkedBugs(f.users.tester.id, f.submission.id, {
            ...report,
            submissionItemIds: [f.items.front, f.items.back],
          })
        : bugs.createBug(f.users.tester.id, f.submission.id, {
            ...report,
            submissionItemId: f.items.front,
          });
    const before = bugs.workspace(f.users.tester.id, f.submission.id);
    expect(create).toThrow('模拟入队失败');
    expect(bugs.workspace(f.users.tester.id, f.submission.id)).toEqual(before);
    for (const table of [
      'cooking_bug',
      'cooking_bug_attachment',
      'cooking_repair_attempt',
      'cooking_bug_deployment',
      'platform_execution',
    ])
      expect(f.database.all(`SELECT * FROM ${table}`)).toHaveLength(0);
    expect(
      f.database.all('SELECT id FROM cooking_mutation WHERE id = ?', report.mutationId),
    ).toHaveLength(0);
    expect((await f.files.read(file.id)).bytes.length).toBeGreaterThan(0);
    fail = false;
    create();
    expect(bugs.workspace(f.users.tester.id, f.submission.id).bugs).toHaveLength(
      joint ? 2 : 1,
    );
  });
}

test('未确定工程、越权和已关闭提测不能登记并修复', async () => {
  const f = await setup();
  const input = {
    mutationId: randomUUID(),
    title: '不能修复',
    startRepair: true,
    submissionItemId: null,
    actualResultAttachmentIds: [],
    expectedResultAttachmentIds: [],
  };
  expect(() => f.service.createBug(f.users.tester.id, f.submission.id, input)).toThrow(
    '请先确定',
  );
  expect(() =>
    f.service.createBug(f.users.member.id, f.submission.id, {
      ...input,
      submissionItemId: f.items.front,
    }),
  ).toThrow('只有测试负责人');
  f.database.run("UPDATE cooking_test_submission SET status = 'CLOSED' WHERE id = ?", [
    f.submission.id,
  ]);
  expect(() =>
    f.service.createBug(f.users.tester.id, f.submission.id, {
      ...input,
      submissionItemId: f.items.front,
    }),
  ).toThrow('已关闭');
  expect(f.database.all('SELECT id FROM cooking_bug')).toHaveLength(0);
});

test('普通成员作为提测创建人可在归属调整后请求修复，其他角色不会因此获得权限', async () => {
  const f = await setup();
  f.database.run(
    'UPDATE cooking_test_submission SET created_by_user_id = ? WHERE id = ?',
    [f.users.member.id, f.submission.id],
  );
  const creatorId = f.users.member.id;
  const unassigned = createBug(f, f.users.tester.id, { title: '等待分诊' }).bug;
  const actions = (userId: string) =>
    f.service.workspace(userId, f.submission.id).bugs[0]!.availableActions;
  expect(actions(creatorId)).not.toContain('REQUEST_REPAIR');
  expect(() =>
    f.service.requestRepair(creatorId, unassigned.id, {
      mutationId: randomUUID(),
      expectedVersion: unassigned.version,
    }),
  ).toThrow('请先确定');
  const assigned = f.service.assignBug(f.users.tester.id, unassigned.id, {
    mutationId: randomUUID(),
    expectedVersion: unassigned.version,
    submissionItemId: f.items.front,
  }).bug;
  expect(actions(creatorId)).toEqual(['REQUEST_REPAIR']);
  for (const userId of [f.users.owner.id, f.users.developerA.id, f.users.developerB.id]) {
    expect(actions(userId)).not.toContain('REQUEST_REPAIR');
    expect(() =>
      f.service.requestRepair(userId, assigned.id, {
        mutationId: randomUUID(),
        expectedVersion: assigned.version,
      }),
    ).toThrow('只有测试负责人或提测单创建人');
  }
  expect(() =>
    f.service.requestRepair(f.users.outsider.id, assigned.id, {
      mutationId: randomUUID(),
      expectedVersion: assigned.version,
    }),
  ).toThrow('无权访问');
  expect(() =>
    f.service.requestRepair(creatorId, assigned.id, {
      mutationId: randomUUID(),
      expectedVersion: unassigned.version,
    }),
  ).toThrow();
  const command = { mutationId: randomUUID(), expectedVersion: assigned.version };
  const repairing = f.service.requestRepair(creatorId, assigned.id, command);
  expect(repairing.bug.stage).toBe('REPAIRING');
  expect(f.service.requestRepair(creatorId, assigned.id, command)).toEqual(repairing);
  expect(actions(creatorId)).not.toContain('REQUEST_REPAIR');
  const waiting = createAssignedBug(f, '关闭后禁止', f.items.front);
  f.database.run("UPDATE cooking_test_submission SET status = 'CLOSED' WHERE id = ?", [
    f.submission.id,
  ]);
  expect(
    f.service
      .workspace(creatorId, f.submission.id)
      .bugs.every((bug) => !bug.availableActions.includes('REQUEST_REPAIR')),
  ).toBe(true);
  expect(() =>
    f.service.requestRepair(creatorId, waiting.id, {
      mutationId: randomUUID(),
      expectedVersion: waiting.version,
    }),
  ).toThrow('已关闭');
});
