import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  completeNextRepair,
  completeUpdate,
  createAndRequestBug,
  createTakeoverSubmission,
  currentBug,
  lifecycleFixture,
} from './lifecycle-fixture';

const setup = lifecycleFixture(testDatabases());

describe('环境切换与验证、关闭', () => {
  test('暂停和重新取得环境后都不能误验证，确认部署后恢复；关闭暂停单不释放别人的环境', async () => {
    const fixture = await setup();
    const originalItem = fixture.items[0]!;
    const bug = createAndRequestBug(fixture, originalItem.id, '环境切换验证');
    await completeNextRepair(fixture, 'switch-repair', ['1111111']);
    await completeUpdate(fixture, originalItem.id, {
      outcome: 'COMPLETED',
      summary: '部署完成',
    });
    const { next } = createTakeoverSubmission(fixture, '优先提测', '切换验证');
    const verify = () =>
      fixture.lifecycle.verifyBug(fixture.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, bug.id).version,
        result: 'PASSED',
        attachmentIds: [],
      });
    expect(verify).toThrow('已暂停使用环境');
    expect(
      fixture.bugs
        .workspace(fixture.users.tester.id, fixture.submission.id)
        .bugs.find((entry) => entry.id === bug.id)!.availableActions,
    ).not.toContain('VERIFY_PASS');
    const paused = fixture.submissions.getWorkspace(
      fixture.users.owner.id,
      fixture.submission.id,
    );
    const restored = fixture.submissions.changeEnvironment(
      fixture.users.owner.id,
      originalItem.id,
      {
        mutationId: randomUUID(),
        expectedRevision: paused.revision,
        action: 'ACQUIRE',
        takeover: paused.submission.items[0]!.environmentAccess.conflict!,
      },
    );
    expect(verify).toThrow('先确认当前提测版本已部署');
    fixture.submissions.changeEnvironment(
      fixture.users.developer.id,
      originalItem.id,
      {
        mutationId: randomUUID(),
        expectedRevision: restored.workspaceRevision,
        action: 'CONFIRM_DEPLOYMENT',
      },
    );
    verify();
    fixture.lifecycle.closeSubmission(fixture.users.tester.id, next.id, {
      mutationId: randomUUID(),
      expectedVersion: next.version,
    });
    expect(
      fixture.submissions.getWorkspace(
        fixture.users.owner.id,
        fixture.submission.id,
      ).submission.items[0]!.environmentAccess.owned,
    ).toBe(true);
  });
});

test('占用单关闭后暂停单收到新版本，可重新取得空闲环境且仍需确认部署', async () => {
  const fixture = await setup();
  const { next, item } = createTakeoverSubmission(
    fixture,
    '短期占用环境',
    '关闭后重新取得',
  );
  const pausedRevision = fixture.submissions.getWorkspace(
    fixture.users.owner.id,
    fixture.submission.id,
  ).revision;
  fixture.lifecycle.closeSubmission(fixture.users.tester.id, next.id, {
    mutationId: randomUUID(),
    expectedVersion: next.version,
  });
  const available = fixture.submissions.getWorkspace(
    fixture.users.developer.id,
    fixture.submission.id,
  );
  expect(available.revision).toBeGreaterThan(pausedRevision);
  expect(available.submission.items[0]!.environmentAccess).toMatchObject({
    owned: false,
    conflict: null,
    canAcquire: true,
  });
  fixture.submissions.changeEnvironment(fixture.users.developer.id, item.id, {
    mutationId: randomUUID(),
    expectedRevision: available.revision,
    action: 'ACQUIRE',
  });
  expect(
    fixture.submissions.getWorkspace(
      fixture.users.developer.id,
      fixture.submission.id,
    ).submission.items[0]!.environmentAccess,
  ).toMatchObject({ owned: true, deploymentConfirmed: false });
});
