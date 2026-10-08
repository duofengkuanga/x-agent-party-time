import { expectRowCount, testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createSubmission,
  item,
  submissionFixture,
} from './submission-fixture';

const setup = submissionFixture(testDatabases());

describe('环境使用权切换', () => {
  test('多工程原子切换、幂等回放、只暂停目标提测项并通知双方', async () => {
    const fixture = await setup();
    const front = item(fixture, 'front', 'developerA', 'frontA', 'main');
    const back = item(fixture, 'back', 'developerB', 'backB', 'main');
    const original = createSubmission(fixture, [front, back]);
    const input = {
      mutationId: randomUUID(),
      title: '优先提测',
      requirementDescription: '优先验收前端',
      testerUserId: fixture.users.tester.id,
      items: [front],
    };
    expect(() =>
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        input,
      ),
    ).toThrow('所选环境');
    const conflicts = fixture.service.environmentConflicts(
      fixture.users.owner.id,
      fixture.project.id,
      input,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      submissionId: original.id,
      blockedReason: null,
    });
    const confirmed = { ...input, environmentTakeovers: conflicts };
    fixture.events.length = 0;
    const next = fixture.service.createSubmission(
      fixture.users.owner.id,
      fixture.project.id,
      confirmed,
    );
    expect(
      fixture.events.map(({ submissionId }) => submissionId).sort(),
    ).toEqual([next.id, original.id].sort());
    const oldItems = fixture.service.getWorkspace(
      fixture.users.owner.id,
      original.id,
    ).submission.items;
    expect(oldItems[0]!.environmentAccess.owned).toBe(false);
    expect(oldItems[1]!.environmentAccess.owned).toBe(true);
    const nextItem = fixture.service.getWorkspace(
      fixture.users.developerA.id,
      next.id,
    ).submission.items[0]!;
    expect(nextItem.environmentAccess).toMatchObject({
      owned: true,
      deploymentConfirmed: false,
      canConfirmDeployment: true,
    });
    const eventCount = fixture.events.length;
    expect(
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        confirmed,
      ).id,
    ).toBe(next.id);
    expect(fixture.events).toHaveLength(eventCount);
    expectRowCount(
      fixture.database,
      'cooking_submission_environment_lock',
    ).toBe(2);
    const competing = { ...confirmed, mutationId: randomUUID() };
    expect(() =>
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        competing,
      ),
    ).toThrow('环境使用情况已变化');
    expectRowCount(fixture.database, 'cooking_test_submission').toBe(2);
    expect(() =>
      fixture.service.changeEnvironment(fixture.users.tester.id, nextItem.id, {
        mutationId: randomUUID(),
        expectedRevision: next.workspaceRevision,
        action: 'CONFIRM_DEPLOYMENT',
      }),
    ).toThrow('只有对应工程负责人');
    fixture.service.changeEnvironment(
      fixture.users.developerA.id,
      nextItem.id,
      {
        mutationId: randomUUID(),
        expectedRevision: next.workspaceRevision,
        action: 'CONFIRM_DEPLOYMENT',
      },
    );
    expect(
      fixture.service.getWorkspace(fixture.users.tester.id, next.id).submission
        .items[0]!.environmentAccess.deploymentConfirmed,
    ).toBe(true);
  });

  test('第二个环境确认过期时全部回滚；同一原提测单的多个环境可以一起转移', async () => {
    const fixture = await setup();
    const items = [
      item(fixture, 'front', 'developerA', 'frontA', 'main'),
      item(fixture, 'back', 'developerB', 'backB', 'main'),
    ];
    const original = createSubmission(fixture, items);
    const input = {
      mutationId: randomUUID(),
      title: '多环境接手',
      requirementDescription: '原子切换',
      testerUserId: fixture.users.tester.id,
      items,
    };
    const conflicts = fixture.service.environmentConflicts(
      fixture.users.owner.id,
      fixture.project.id,
      input,
    );
    const invalid = conflicts.map((entry, index) => ({
      ...entry,
      expectedRevision: entry.expectedRevision + index,
    }));
    const eventCount = fixture.events.length;
    expect(() =>
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        { ...input, environmentTakeovers: invalid },
      ),
    ).toThrow('环境使用情况已变化');
    expect(fixture.events).toHaveLength(eventCount);
    expectRowCount(fixture.database, 'cooking_test_submission').toBe(1);
    expect(
      fixture.service
        .getWorkspace(fixture.users.owner.id, original.id)
        .submission.items.every((entry) => entry.environmentAccess.owned),
    ).toBe(true);
    const next = fixture.service.createSubmission(
      fixture.users.owner.id,
      fixture.project.id,
      { ...input, environmentTakeovers: conflicts },
    );
    expect(
      fixture.service
        .getWorkspace(fixture.users.owner.id, next.id)
        .submission.items.every((entry) => entry.environmentAccess.owned),
    ).toBe(true);
  });

  test('普通成员不能抢占，项目外用户不能读取占用详情', async () => {
    const fixture = await setup();
    const items = [item(fixture, 'front', 'developerA', 'frontA', 'main')];
    createSubmission(fixture, items);
    const input = {
      mutationId: randomUUID(),
      title: '无权抢占',
      requirementDescription: '权限检查',
      testerUserId: fixture.users.tester.id,
      items,
    };
    const conflicts = fixture.service.environmentConflicts(
      fixture.users.member.id,
      fixture.project.id,
      input,
    );
    expect(conflicts[0]!.blockedReason).toContain('只有项目所有者');
    expect(() =>
      fixture.service.createSubmission(
        fixture.users.member.id,
        fixture.project.id,
        { ...input, environmentTakeovers: conflicts },
      ),
    ).toThrow('只有项目所有者');
    expect(() =>
      fixture.service.environmentConflicts(
        fixture.users.outsider.id,
        fixture.project.id,
        input,
      ),
    ).toThrow('项目不存在或无权访问');
    expectRowCount(fixture.database, 'cooking_test_submission').toBe(1);
  });
});
