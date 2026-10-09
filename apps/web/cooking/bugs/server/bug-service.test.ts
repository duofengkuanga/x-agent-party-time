import { mutation } from '@/cooking/testing/project';
import { expectRowCount, testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { BugRepairContextService } from './repair-context';
import { bugFixture, createBug, createAssignedBug } from './bug-fixture';

const setup = bugFixture(testDatabases());

describe('BugService', () => {
  test('Repair Context 按报告角色投影附件与执行来源', async () => {
    const fixture = await setup();
    const actual = await fixture.files.put({
      bytes: new TextEncoder().encode('实际结果'),
      originalName: '实际.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    const expected = await fixture.files.put({
      bytes: new TextEncoder().encode('预期结果'),
      originalName: '预期.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    const bug = fixture.service.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        submissionItemId: fixture.items.front,
        title: '角色化报告',
        operationPath: '打开结算页',
        actualResult: '按钮无响应',
        expectedResult: '显示成功提示',
        actualResultAttachmentIds: [actual.id],
        expectedResultAttachmentIds: [expected.id],
      },
    ).bug;

    expect(new BugRepairContextService(fixture.database).get(bug.id)).toMatchObject({
      bugId: bug.id,
      submissionTitle: '双工程提测',
      engineeringName: '前端工程',
      targetBranch: 'feature/front',
      report: {
        title: '角色化报告',
        operationPath: '打开结算页',
        actualResult: '按钮无响应',
        expectedResult: '显示成功提示',
        attachments: {
          actualResult: [{ id: actual.id, originalName: '实际.txt' }],
          expectedResult: [{ id: expected.id, originalName: '预期.txt' }],
        },
      },
      feedback: [],
    });
  });

  test('只有 Tester 可创建，空白可选字段不保存且附件按实际与预期结果分组', async () => {
    const fixture = await setup();
    expect(() =>
      createBug(fixture, fixture.users.member.id, {
        title: '普通成员不能创建',
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() =>
      createBug(fixture, fixture.users.tester.id, {
        title: '附件过多',
        actualResultAttachmentIds: Array.from({ length: 6 }, () => randomUUID()),
      }),
    ).toThrow();
    const file = await fixture.files.put({
      bytes: new TextEncoder().encode('复现记录'),
      originalName: '复现.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    const expectedFile = await fixture.files.put({
      bytes: new TextEncoder().encode('预期界面'),
      originalName: '预期.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    expect(() =>
      createBug(fixture, fixture.users.tester.id, {
        title: '附件不能跨结果重复使用',
        actualResultAttachmentIds: [file.id],
        expectedResultAttachmentIds: [file.id],
      }),
    ).toThrow(ZodError);
    expect(() =>
      createBug(fixture, fixture.users.tester.id, {
        title: '同一结果不能重复添加附件',
        actualResultAttachmentIds: [file.id, file.id],
      }),
    ).toThrow(ZodError);
    const result = createBug(fixture, fixture.users.tester.id, {
      title: '  结算按钮无响应  ',
      operationPath: '   ',
      actualResultAttachmentIds: [file.id],
      expectedResultAttachmentIds: [expectedFile.id],
    });
    expect(result.bug).toMatchObject({
      shortId: 1,
      submissionItemId: null,
      stage: 'WAITING_FOR_REPAIR',
      report: {
        title: '结算按钮无响应',
        actualResultAttachmentIds: [file.id],
        expectedResultAttachmentIds: [expectedFile.id],
      },
      version: 1,
    });
    expect(result.bug.report).not.toHaveProperty('operationPath');
    expect(() =>
      fixture.service.requestRepair(
        fixture.users.tester.id,
        result.bug.id,
        mutation(result.bug.version),
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(result.revision).toBe(2);
    expect(fixture.events).toEqual([
      { submissionId: fixture.submission.id, revision: 2 },
    ]);
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id).bugs[0]
        ?.report.actualResultAttachments[0],
    ).toMatchObject({ id: file.id, originalName: '复现.txt' });
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id).bugs[0]
        ?.report.expectedResultAttachments[0],
    ).toMatchObject({ id: expectedFile.id, originalName: '预期.txt' });
    expect(() =>
      fixture.service.requireAttachmentAccess(fixture.users.member.id, file.id),
    ).not.toThrow();
    expect(() =>
      fixture.service.requireAttachmentAccess(fixture.users.outsider.id, file.id),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const updated = fixture.service.updateReport(fixture.users.tester.id, result.bug.id, {
      ...mutation(result.bug.version),
      submissionItemId: null,
      title: result.bug.report.title,
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    });
    expect(updated.unboundAttachmentIds).toEqual([file.id, expectedFile.id]);
    expect(await fixture.files.deleteUnbound(file.id, fixture.users.tester.id)).toBe(
      true,
    );
    expect(
      await fixture.files.deleteUnbound(expectedFile.id, fixture.users.tester.id),
    ).toBe(true);
  });

  test('分诊后仅测试负责人可开始修复且报告永久锁定', async () => {
    const fixture = await setup();
    const created = createBug(fixture, fixture.users.tester.id, {
      title: '待分诊缺陷',
    }).bug;
    const assigned = fixture.service.assignBug(fixture.users.developerB.id, created.id, {
      ...mutation(1),
      submissionItemId: fixture.items.front,
    }).bug;
    expect(assigned.submissionItemId).toBe(fixture.items.front);
    const assignedView = fixture.service
      .workspace(fixture.users.developerA.id, fixture.submission.id)
      .bugs.find(({ id }) => id === assigned.id);
    expect(assignedView?.assignment).toMatchObject({
      engineeringName: '前端工程',
      engineeringType: 'FRONTEND',
      engineeringIdentifier: 'web',
    });
    expect(assignedView?.presentation.assignmentLabel).toBe('前端工程（web）');
    expect(
      fixture.database
        .all<{ name: string }>('PRAGMA table_info(cooking_bug)')
        .map(({ name }) => name)
        .filter((name) => name.startsWith('engineering_')),
    ).toEqual([]);
    expect(() =>
      fixture.service.requestRepair(fixture.users.developerB.id, assigned.id, {
        ...mutation(assigned.version),
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const repairing = fixture.service.requestRepair(
      fixture.users.tester.id,
      assigned.id,
      {
        ...mutation(assigned.version),
      },
    ).bug;
    expect(repairing).toMatchObject({
      stage: 'REPAIRING',
      version: 3,
      reportLockedAt: '2026-07-27T03:00:00.000Z',
    });
    expect(() =>
      fixture.service.updateReport(fixture.users.tester.id, repairing.id, {
        ...mutation(repairing.version),
        submissionItemId: fixture.items.front,
        title: '不能覆盖',
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id),
    ).not.toHaveProperty('repairQueue');
  });

  test('不同工程直接提交自动修复且不再暴露全局队列或人工顺序', async () => {
    const fixture = await setup();
    const first = createAssignedBug(fixture, '前端问题', fixture.items.front);
    const second = createAssignedBug(fixture, '后端问题', fixture.items.back);
    const firstQueued = fixture.service.requestRepair(
      fixture.users.tester.id,
      first.id,
      mutation(first.version),
    ).bug;
    fixture.service.requestRepair(
      fixture.users.tester.id,
      second.id,
      mutation(second.version),
    );
    const workspace = fixture.service.workspace(
      fixture.users.developerA.id,
      fixture.submission.id,
    );
    expect(workspace).not.toHaveProperty('repairQueue');
    expect(workspace.bugs.map(({ id, stage }) => ({ id, stage }))).toEqual([
      { id: first.id, stage: 'REPAIRING' },
      { id: second.id, stage: 'REPAIRING' },
    ]);
    expect(JSON.stringify(workspace)).not.toMatch(/queuePosition|REORDER|全局修复队列/u);
    expect(firstQueued.reportLockedAt).not.toBeNull();
  });

  test('Workspace 返回服务端动作并隐藏 Binding，锁定后不再提供通用反馈', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '反馈缺陷', fixture.items.front);
    const waitingView = fixture.service.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).bugs[0]!;
    expect(waitingView.availableActions).toEqual([
      'EDIT_REPORT',
      'ASSIGN',
      'REQUEST_REPAIR',
      'CANCEL',
    ]);
    const repairing = fixture.service.requestRepair(
      fixture.users.tester.id,
      bug.id,
      mutation(bug.version),
    ).bug;
    const developerView = fixture.service.workspace(
      fixture.users.developerA.id,
      fixture.submission.id,
    );
    expect(developerView.bugs[0]?.availableActions).toEqual([]);
    expect(JSON.stringify(developerView)).not.toMatch(
      /binding|runner|repository|branch|commit|prompt|feedback/iu,
    );
    expect(repairing.version).toBe(bug.version + 1);
    expect(() =>
      fixture.service.workspace(fixture.users.outsider.id, fixture.submission.id),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('重复 Mutation 不重复写 Audit、Revision 或实时失效通知', async () => {
    const fixture = await setup();
    const mutationId = randomUUID();
    const input = {
      mutationId,
      submissionItemId: null,
      title: '幂等登记',
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    };
    const first = fixture.service.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      input,
    );
    const replay = fixture.service.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      input,
    );
    expect(replay).toEqual(first);
    expect(fixture.events).toEqual([
      { submissionId: fixture.submission.id, revision: first.revision },
    ]);
    expectRowCount(fixture.database, 'cooking_audit_event', {
      target_id: first.bug.id,
      action: 'BUG_CREATED',
    }).toBe(1);
    expect(
      fixture.service.workspace(fixture.users.tester.id, fixture.submission.id).bugs,
    ).toHaveLength(1);
  });
});
