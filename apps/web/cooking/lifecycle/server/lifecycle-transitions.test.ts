import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  completeClaimedRepair,
  completeNextRepair,
  completeUpdate,
  createAndRequestBug,
  currentBug,
  lifecycleFixture,
  submissionRow,
} from './lifecycle-fixture';

const setup = lifecycleFixture(testDatabases());

describe('LifecycleService', () => {
  test('仅测试负责人可取消恢复与归档，且取消只允许待修复', async () => {
    const fixture = await setup();
    const waiting = fixture.bugs.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        submissionItemId: fixture.items[0]!.id,
        title: '可取消缺陷',
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      },
    ).bug;
    expect(() =>
      fixture.lifecycle.cancelBug(fixture.users.developer.id, waiting.id, {
        mutationId: randomUUID(),
        expectedVersion: waiting.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const cancelled = fixture.lifecycle.cancelBug(
      fixture.users.tester.id,
      waiting.id,
      {
        mutationId: randomUUID(),
        expectedVersion: waiting.version,
      },
    );
    expect(currentBug(fixture.database, waiting.id).stage).toBe('CANCELLED');
    const restored = fixture.lifecycle.restoreBug(
      fixture.users.tester.id,
      waiting.id,
      {
        mutationId: randomUUID(),
        expectedVersion: cancelled.bugVersion,
      },
    );
    expect(currentBug(fixture.database, waiting.id).stage).toBe(
      'WAITING_FOR_REPAIR',
    );
    expect(
      fixture.lifecycle.workspace(
        fixture.users.tester.id,
        fixture.submission.id,
      ).transitionsByBug[waiting.id],
    ).toMatchObject([{ kind: 'CANCELLED' }, { kind: 'RESTORED' }]);

    const repairing = fixture.bugs.requestRepair(
      fixture.users.tester.id,
      waiting.id,
      {
        mutationId: randomUUID(),
        expectedVersion: restored.bugVersion,
      },
    ).bug;
    expect(() =>
      fixture.lifecycle.cancelBug(fixture.users.tester.id, waiting.id, {
        mutationId: randomUUID(),
        expectedVersion: repairing.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    await completeNextRepair(fixture, 'repair-archive', ['6666666']);
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '归档前部署完成',
    });
    fixture.lifecycle.verifyBug(fixture.users.tester.id, waiting.id, {
      mutationId: randomUUID(),
      expectedVersion: currentBug(fixture.database, waiting.id).version,
      result: 'PASSED',
      attachmentIds: [],
    });
    const archived = fixture.lifecycle.archiveBug(
      fixture.users.tester.id,
      waiting.id,
      {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, waiting.id).version,
      },
    );
    expect(currentBug(fixture.database, waiting.id)).toMatchObject({
      stage: 'DONE',
      archived_at: '2026-07-27T12:00:00.000Z',
    });
    fixture.lifecycle.unarchiveBug(fixture.users.tester.id, waiting.id, {
      mutationId: randomUUID(),
      expectedVersion: archived.bugVersion,
    });
    expect(currentBug(fixture.database, waiting.id)).toMatchObject({
      stage: 'DONE',
      archived_at: null,
    });
  });

  test('DONE 可在活动期重开，关闭后所有 Lifecycle 写操作只读', async () => {
    const fixture = await setup();
    const bug = createAndRequestBug(fixture, fixture.items[0]!.id, '重开缺陷');
    await completeNextRepair(fixture, 'repair-reopen', ['4444444']);
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '部署完成',
    });
    fixture.lifecycle.verifyBug(fixture.users.tester.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: currentBug(fixture.database, bug.id).version,
      result: 'PASSED',
      attachmentIds: [],
    });
    const reopened = fixture.lifecycle.reopenBug(
      fixture.users.tester.id,
      bug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, bug.id).version,
        feedback: '回归时发现新证据',
        attachmentIds: [],
      },
    );
    expect(currentBug(fixture.database, bug.id).stage).toBe('REPAIRING');
    expect(
      fixture.executions.get(reopened.executionId!).codexTurn,
    ).toMatchObject({ kind: 'CONTINUATION', taskId: 'repair-reopen' });
    expect(
      fixture.lifecycle.workspace(
        fixture.users.tester.id,
        fixture.submission.id,
      ).reopensByBug[bug.id]?.[0],
    ).toMatchObject({
      feedback: '回归时发现新证据',
      repairAttempt: 2,
    });
    await completeClaimedRepair(
      fixture,
      reopened.executionId!,
      'repair-reopen',
      ['5555555'],
    );
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '重开后部署完成',
    });
    fixture.lifecycle.verifyBug(fixture.users.tester.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: currentBug(fixture.database, bug.id).version,
      result: 'PASSED',
      attachmentIds: [],
    });
    const other = fixture.bugs.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        submissionItemId: fixture.items[1]!.id,
        title: '取消缺陷',
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      },
    ).bug;
    fixture.lifecycle.cancelBug(fixture.users.tester.id, other.id, {
      mutationId: randomUUID(),
      expectedVersion: other.version,
    });
    expect(currentBug(fixture.database, other.id).stage).toBe('CANCELLED');
    const beforeClose = submissionRow(fixture.database, fixture.submission.id);
    fixture.lifecycle.closeSubmission(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        expectedVersion: beforeClose.version,
      },
    );
    expect(() =>
      fixture.lifecycle.reopenBug(fixture.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, bug.id).version,
        feedback: '关闭后不允许',
        attachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(() =>
      fixture.bugs.createBug(fixture.users.tester.id, fixture.submission.id, {
        mutationId: randomUUID(),
        submissionItemId: fixture.items[0]!.id,
        title: '关闭后新增',
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });
});
