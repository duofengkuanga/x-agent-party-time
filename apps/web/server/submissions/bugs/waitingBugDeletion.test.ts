import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { testDatabases, expectRowCount } from '@/testing/database';
import { createSubmissionWorkflow } from '@/server/runtime/createSubmissionWorkflow';
import { bugFixture, createBug, createAssignedBug } from './bugFixture';

const setup = bugFixture(testDatabases());

describe('删除待修复缺陷', () => {
  test.each([
    ['tester', false],
    ['developerA', false],
    ['developerB', false],
    ['tester', true],
    ['developerA', true],
    ['developerB', true],
  ] as const)(
    '%s 可以删除已分配或未分配的待修复缺陷（已分配：%s），重试幂等且保留审计',
    async (role, assigned) => {
      const f = await setup();
      const { bug, revision } = createBug(f, f.users.tester.id, {
        description: '误报缺陷',
        submissionItemId: assigned ? f.items.front : null,
      });
      const input = { mutationId: randomUUID(), expectedVersion: bug.version };
      expect(
        f.service.workspace(f.users[role].id, f.submission.id).bugs[0]!.availableActions,
      ).toContain('DELETE');
      const result = f.service.deleteWaitingBug(f.users[role].id, bug.id, input);
      expect(result).toMatchObject({
        deletedBugId: bug.id,
        submissionId: f.submission.id,
        revision: revision + 1,
      });
      expect(f.service.workspace(f.users[role].id, f.submission.id).bugs).toEqual([]);
      expectRowCount(f.database, 'submission_bug', { id: bug.id }).toBe(0);
      expectRowCount(f.database, 'platform_audit_event', {
        action: 'BUG_DELETED',
        target_id: bug.id,
        actor_user_id: f.users[role].id,
      }).toBe(1);
      const eventCount = f.events.length;
      expect(f.service.deleteWaitingBug(f.users[role].id, bug.id, input)).toEqual(result);
      expect(f.events).toHaveLength(eventCount);
      expect(f.events.at(-1)).toEqual({
        submissionId: f.submission.id,
        revision: result.revision,
      });
    },
  );

  test.each(['owner', 'member', 'outsider'] as const)('%s 无删除权限', async (role) => {
    const f = await setup();
    const { bug } = createBug(f, f.users.tester.id, { description: '保留缺陷' });
    if (role !== 'outsider')
      expect(
        f.service.workspace(f.users[role].id, f.submission.id).bugs[0]!.availableActions,
      ).not.toContain('DELETE');
    expect(() =>
      f.service.deleteWaitingBug(f.users[role].id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      }),
    ).toThrow(
      expect.objectContaining({
        code: role === 'outsider' ? 'NOT_FOUND' : 'PERMISSION_DENIED',
      }),
    );
    expectRowCount(f.database, 'submission_bug', { id: bug.id }).toBe(1);
  });

  test('关闭提测不允许删除已分配或未分配缺陷', async () => {
    const f = await setup();
    const assigned = createAssignedBug(f, '已分配', f.items.front);
    const unassigned = createBug(f, f.users.tester.id, { description: '未分配' }).bug;
    const attempt = (bug: typeof assigned) =>
      f.service.deleteWaitingBug(f.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      });
    f.database.run("UPDATE test_submission SET status = 'CLOSED' WHERE id = ?", [
      f.submission.id,
    ]);
    expect(() => attempt(assigned)).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
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
    ["stage = 'WAITING_FOR_UPDATE'"],
    ["stage = 'UPDATING'"],
    ["stage = 'WAITING_FOR_VERIFICATION'"],
    ["stage = 'CANCELLED'"],
    ["report_locked_at = '2026-10-14T00:00:00.000Z'"],
    [
      "stage = 'DONE', archived_at = '2026-10-14T00:00:00.000Z', archived_by_user_id = created_by_user_id",
    ],
  ])('受保护状态不显示删除入口且服务端拒绝：%s', async (state) => {
    const f = await setup();
    const { bug } = createBug(f, f.users.tester.id, { description: '状态保护' });
    f.database.run(`UPDATE submission_bug SET ${state} WHERE id = ?`, [bug.id]);
    expect(
      f.service.workspace(f.users.tester.id, f.submission.id).bugs[0]!.availableActions,
    ).not.toContain('DELETE');
    expect(() =>
      f.service.deleteWaitingBug(f.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expectRowCount(f.database, 'submission_bug', { id: bug.id }).toBe(1);
  });

  test('确认后被分配时拒绝旧版本删除，并保留缺陷', async () => {
    const f = await setup();
    const { bug } = createBug(f, f.users.tester.id, { description: '并发分配' });
    f.service.assignBug(f.users.developerA.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: bug.version,
      submissionItemId: f.items.front,
    });
    expect(() =>
      f.service.deleteWaitingBug(f.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: bug.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expectRowCount(f.database, 'submission_bug', { id: bug.id }).toBe(1);
  });

  test('确认后已提交修复时拒绝删除，保留排队中的修复执行', async () => {
    const f = await setup();
    const bug = createAssignedBug(f, '并发修复', f.items.front);
    const { bugs } = createSubmissionWorkflow(f.database);
    const repairing = bugs.requestRepair(f.users.tester.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: bug.version,
    }).bug;
    for (const expectedVersion of [bug.version, repairing.version]) {
      expect(() =>
        f.service.deleteWaitingBug(f.users.developerA.id, bug.id, {
          mutationId: randomUUID(),
          expectedVersion,
        }),
      ).toThrow(
        expect.objectContaining({
          code:
            expectedVersion === bug.version ? 'RESOURCE_CONFLICT' : 'INVALID_TRANSITION',
        }),
      );
    }
    expectRowCount(f.database, 'submission_bug', { id: bug.id }).toBe(1);
    expectRowCount(f.database, 'submission_repair_attempt', { bug_id: bug.id }).toBe(1);
    expectRowCount(f.database, 'platform_execution', { state: 'QUEUED' }).toBe(1);
  });

  test('删除前后端关联卡片只移除当前缺陷，保留另一张卡片及共享附件', async () => {
    const f = await setup();
    const file = await f.files.put({
      bytes: new TextEncoder().encode('shared proof'),
      originalName: 'shared.txt',
      mediaType: 'text/plain',
      uploadedByUserId: f.users.tester.id,
    });
    const result = f.service.createLinkedBugs(f.users.tester.id, f.submission.id, {
      mutationId: randomUUID(),
      submissionItemIds: [f.items.front, f.items.back],
      description: '前后端误报',
      attachmentIds: [file.id],
    });
    const [first, second] = result.bugs;
    expect(first!.collaborationLocked).toBe(true);
    f.service.deleteWaitingBug(f.users.developerA.id, first!.id, {
      mutationId: randomUUID(),
      expectedVersion: first!.version,
    });
    const remaining = f.service.workspace(f.users.tester.id, f.submission.id).bugs;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(second!.id);
    expect(remaining[0]!.relatedBugs).toMatchObject([
      { id: null, kind: 'JOINT', stageLabel: '已删除' },
    ]);
    expect(remaining[0]!.availableActions).toContain('DELETE');
    expect(remaining[0]!.report.attachments.map(({ id }) => id)).toEqual([file.id]);
    expect(() =>
      f.service.requireAttachmentAccess(f.users.tester.id, file.id),
    ).not.toThrow();
    expect(f.database.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  test('同一操作标识不能删除另一条缺陷', async () => {
    const f = await setup();
    const first = createBug(f, f.users.tester.id, { description: '第一条' }).bug;
    const second = createBug(f, f.users.tester.id, { description: '第二条' }).bug;
    const input = { mutationId: randomUUID(), expectedVersion: first.version };
    f.service.deleteWaitingBug(f.users.tester.id, first.id, input);
    expect(() => f.service.deleteWaitingBug(f.users.tester.id, second.id, input)).toThrow(
      expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
    );
    expectRowCount(f.database, 'submission_bug', { id: second.id }).toBe(1);
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
      description: '有附件的误报',
      attachmentIds: [file.id],
    });
    const result = f.service.deleteWaitingBug(f.users.developerA.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: bug.version,
    });
    expect(result.unboundAttachmentIds).toEqual([file.id]);
    expectRowCount(f.database, 'submission_bug_attachment', { bug_id: bug.id }).toBe(0);
    expect(() => f.service.requireAttachmentAccess(f.users.tester.id, file.id)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
