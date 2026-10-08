import { mutation } from '@/cooking/testing/project';
import { CookingWorkspaceService } from '@/cooking/workspace/server/workspace-service';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import {
  completeNextRepair,
  completeUpdate,
  createAndRequestBug,
  createBug,
  currentBug,
  lifecycleFixture,
} from './lifecycle-fixture';

const setup = lifecycleFixture(testDatabases());

describe('LifecycleService', () => {
  test('Workspace 将修复、批次、验证和取消恢复投影为同一条旧到新时间线', async () => {
    const fixture = await setup();
    const bug = createAndRequestBug(
      fixture,
      fixture.items[0]!.id,
      '统一时间线缺陷',
    );
    await completeNextRepair(fixture, 'timeline-repair', ['1111111']);
    fixture.clock.set('2026-07-27T12:01:00.000Z');
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '统一更新完成',
    });
    fixture.clock.set('2026-07-27T12:02:00.000Z');
    fixture.lifecycle.verifyBug(fixture.users.tester.id, bug.id, {
      ...mutation(currentBug(fixture.database, bug.id).version),
      result: 'FAILED',
      feedback: '边界条件仍可复现',
      attachmentIds: [],
    });

    const workspace = new CookingWorkspaceService(
      fixture.submissions,
      fixture.bugs,
      fixture.repairs,
      fixture.updates,
      fixture.lifecycle,
    ).getWorkspace(fixture.users.tester.id, fixture.submission.id);
    expect(workspace.progressByBug[bug.id]?.map(({ kind }) => kind)).toEqual([
      'BUG_REGISTERED',
      'REPAIR_ATTEMPT',
      'UPDATE_BATCH',
      'VERIFICATION',
      'REPAIR_ATTEMPT',
    ]);
    expect(
      workspace.progressByBug[bug.id]?.find(
        (node) => node.kind === 'VERIFICATION',
      ),
    ).toMatchObject({
      result: 'FAILED',
      comment: '边界条件仍可复现',
      repairAttempt: 2,
    });

    fixture.clock.set('2026-07-27T12:03:00.000Z');
    const stored = createBug(fixture, fixture.items[1]!.id, '取消恢复时间线');
    fixture.clock.set('2026-07-27T12:04:00.000Z');
    const cancelled = fixture.lifecycle.cancelBug(
      fixture.users.tester.id,
      stored.id,
      mutation(stored.version),
    );
    fixture.clock.set('2026-07-27T12:05:00.000Z');
    fixture.lifecycle.restoreBug(
      fixture.users.tester.id,
      stored.id,
      mutation(cancelled.bugVersion),
    );
    const restoredWorkspace = new CookingWorkspaceService(
      fixture.submissions,
      fixture.bugs,
      fixture.repairs,
      fixture.updates,
      fixture.lifecycle,
    ).getWorkspace(fixture.users.tester.id, fixture.submission.id);
    expect(
      restoredWorkspace.progressByBug[stored.id]?.map(({ kind }) => kind),
    ).toEqual(['BUG_REGISTERED', 'CANCELLED', 'RESTORED']);
  });
});
