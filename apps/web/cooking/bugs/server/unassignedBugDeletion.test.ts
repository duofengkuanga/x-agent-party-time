import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { testDatabases, expectRowCount } from '@/testing/database';
import { bugFixture, createBug, createAssignedBug } from './bugFixture';

const setup = bugFixture(testDatabases());

describe('删除待分配缺陷', () => {
  test.each(['tester', 'developerA', 'developerB'] as const)(
    '%s 可以删除，重试不重复推进版本且保留删除审计',
    async (role) => {
      const f = await setup();
      const { bug, revision } = createBug(f, f.users.tester.id, { title: '误报缺陷' });
      const input = { mutationId: randomUUID(), expectedVersion: bug.version };
      expect(
        f.service.workspace(f.users[role].id, f.submission.id).bugs[0]!.availableActions,
      ).toContain('DELETE');
      const result = f.service.deleteUnassignedBug(f.users[role].id, bug.id, input);
      expect(result).toMatchObject({
        deletedBugId: bug.id,
        submissionId: f.submission.id,
        revision: revision + 1,
      });
      expect(f.service.workspace(f.users[role].id, f.submission.id).bugs).toEqual([]);
      expectRowCount(f.database, 'cooking_bug', { id: bug.id }).toBe(0);
      expectRowCount(f.database, 'cooking_audit_event', {
        action: 'BUG_DELETED',
        target_id: bug.id,
        actor_user_id: f.users[role].id,
      }).toBe(1);
      const eventCount = f.events.length;
      expect(f.service.deleteUnassignedBug(f.users[role].id, bug.id, input)).toEqual(
        result,
      );
      expect(f.events).toHaveLength(eventCount);
      expect(f.events.at(-1)).toEqual({
        submissionId: f.submission.id,
        revision: result.revision,
      });
    },
  );

  test.each(['owner', 'member', 'outsider'] as const)('%s 无删除权限', async (role) => {
    const f = await setup();
    const { bug } = createBug(f, f.users.tester.id, { title: '保留缺陷' });
    if (role !== 'outsider')
      expect(
        f.service.workspace(f.users[role].id, f.submission.id).bugs[0]!.availableActions,
      ).not.toContain('DELETE');
    expect(() =>
      f.service.deleteUnassignedBug(f.users[role].id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      }),
    ).toThrow(
      expect.objectContaining({
        code: role === 'outsider' ? 'NOT_FOUND' : 'PERMISSION_DENIED',
      }),
    );
    expectRowCount(f.database, 'cooking_bug', { id: bug.id }).toBe(1);
  });

  test('已分配或关闭提测不允许删除', async () => {
    const f = await setup();
    const assigned = createAssignedBug(f, '已分配', f.items.front);
    const unassigned = createBug(f, f.users.tester.id, { title: '未分配' }).bug;
    const attempt = (bug: typeof assigned) =>
      f.service.deleteUnassignedBug(f.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      });
    expect(() => attempt(assigned)).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
    f.database.run("UPDATE cooking_test_submission SET status = 'CLOSED' WHERE id = ?", [
      f.submission.id,
    ]);
    expect(() => attempt(unassigned)).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
    expect(
      f.service
        .workspace(f.users.tester.id, f.submission.id)
        .bugs.every((bug) => !bug.availableActions.includes('DELETE')),
    ).toBe(true);
    expect(f.service.workspace(f.users.tester.id, f.submission.id).bugs).toHaveLength(2);
  });

  test.each([
    ["stage = 'REPAIRING'"],
    ["stage = 'CANCELLED'"],
    ["report_locked_at = '2026-10-14T00:00:00.000Z'"],
    ['collaboration_locked = 1'],
    [
      "stage = 'DONE', archived_at = '2026-10-14T00:00:00.000Z', archived_by_user_id = created_by_user_id",
    ],
  ])('受保护状态不显示删除入口且服务端拒绝：%s', async (state) => {
    const f = await setup();
    const { bug } = createBug(f, f.users.tester.id, { title: '状态保护' });
    f.database.run(`UPDATE cooking_bug SET ${state} WHERE id = ?`, [bug.id]);
    expect(
      f.service.workspace(f.users.tester.id, f.submission.id).bugs[0]!.availableActions,
    ).not.toContain('DELETE');
    expect(() =>
      f.service.deleteUnassignedBug(f.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expectRowCount(f.database, 'cooking_bug', { id: bug.id }).toBe(1);
  });

  test('确认后被分配时拒绝旧版本删除，并保留缺陷', async () => {
    const f = await setup();
    const { bug } = createBug(f, f.users.tester.id, { title: '并发分配' });
    f.service.assignBug(f.users.developerA.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: bug.version,
      submissionItemId: f.items.front,
    });
    expect(() =>
      f.service.deleteUnassignedBug(f.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expectRowCount(f.database, 'cooking_bug', { id: bug.id }).toBe(1);
  });

  test('同一操作标识不能删除另一条缺陷', async () => {
    const f = await setup();
    const first = createBug(f, f.users.tester.id, { title: '第一条' }).bug;
    const second = createBug(f, f.users.tester.id, { title: '第二条' }).bug;
    const input = { mutationId: randomUUID(), expectedVersion: first.version };
    f.service.deleteUnassignedBug(f.users.tester.id, first.id, input);
    expect(() =>
      f.service.deleteUnassignedBug(f.users.tester.id, second.id, input),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expectRowCount(f.database, 'cooking_bug', { id: second.id }).toBe(1);
  });

  test('删除解除附件引用，并返回待清理附件', async () => {
    const f = await setup();
    const file = await f.files.put({
      bytes: new TextEncoder().encode('proof'),
      originalName: 'proof.txt',
      mediaType: 'text/plain',
      uploadedByUserId: f.users.tester.id,
    });
    const { bug } = createBug(f, f.users.tester.id, {
      title: '有附件的误报',
      actualResultAttachmentIds: [file.id],
    });
    const result = f.service.deleteUnassignedBug(f.users.developerA.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: bug.version,
    });
    expect(result.unboundAttachmentIds).toEqual([file.id]);
    expectRowCount(f.database, 'cooking_bug_attachment', { bug_id: bug.id }).toBe(0);
    expect(() => f.service.requireAttachmentAccess(f.users.tester.id, file.id)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
