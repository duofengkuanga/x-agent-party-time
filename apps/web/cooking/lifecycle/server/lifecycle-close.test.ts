import { LocalFileStore } from '@/platform/files/local-file-store';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  bindingForItem,
  completeClaimedRepair,
  completeCleanup,
  completeNextRepair,
  completeUpdate,
  createAndRequestBug,
  currentBug,
  latestBatch,
  lifecycleFixture,
  submissionRow,
} from './lifecycle-fixture';

const setup = lifecycleFixture(testDatabases());

describe('LifecycleService', () => {
  test('验证失败自动沿用 Repair Session，再次更新通过后关闭并异步清理', async () => {
    const fixture = await setup();
    const localBug = createAndRequestBug(
      fixture,
      fixture.items[0]!.id,
      '本地缺陷',
    );
    await completeNextRepair(fixture, 'repair-local', ['1111111']);
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '本地部署完成',
    });
    const ciBug = createAndRequestBug(
      fixture,
      fixture.items[1]!.id,
      '持续集成缺陷',
    );
    await completeNextRepair(fixture, 'repair-ci', ['2222222']);
    const ciBatch = await completeUpdate(fixture, fixture.items[1]!.id, {
      outcome: 'PUSHED',
      summary: '已普通 Push',
    });
    fixture.updates.reportExternalDeployment(
      fixture.users.developer.id,
      ciBatch.id,
      {
        mutationId: randomUUID(),
        expectedVersion: latestBatch(fixture.database, fixture.items[1]!.id)
          .version,
        outcome: 'SUCCEEDED',
        summary: '外部部署成功',
        attachmentIds: [],
      },
    );
    expect(currentBug(fixture.database, localBug.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    expect(currentBug(fixture.database, ciBug.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );

    const files = new LocalFileStore(
      fixture.database,
      join(fixture.directory, 'files'),
      fixture.clock.now,
    );
    const evidence = await files.put({
      bytes: new TextEncoder().encode('still broken'),
      originalName: 'verification.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    expect(() =>
      fixture.lifecycle.verifyBug(fixture.users.developer.id, localBug.id, {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, localBug.id).version,
        result: 'FAILED',
        feedback: '仍可复现',
        attachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const failed = fixture.lifecycle.verifyBug(
      fixture.users.tester.id,
      localBug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, localBug.id).version,
        result: 'FAILED',
        feedback: '仍可复现，请检查边界条件',
        attachmentIds: [evidence.id],
      },
    );
    expect(currentBug(fixture.database, localBug.id).stage).toBe('REPAIRING');
    const continued = fixture.executions.get(failed.executionId!);
    expect(continued.codexTurn).toMatchObject({
      kind: 'CONTINUATION',
      taskId: 'repair-local',
    });
    expect(continued.priority).toBe(0);
    expect(
      continued.codexTurn?.kind === 'CONTINUATION'
        ? continued.codexTurn.input
        : '',
    ).toContain('第 1 轮验证未通过');
    expect(
      fixture.database.all(
        `SELECT file_id FROM platform_execution_attachment
           WHERE execution_id = ?`,
        failed.executionId!,
      ),
    ).toEqual([{ file_id: evidence.id }]);
    expect(
      fixture.lifecycle.workspace(
        fixture.users.tester.id,
        fixture.submission.id,
      ).verificationsByBug[localBug.id]?.[0],
    ).toMatchObject({
      result: 'FAILED',
      comment: '仍可复现，请检查边界条件',
      repairAttempt: 2,
      attachments: [{ id: evidence.id }],
    });

    await completeClaimedRepair(fixture, failed.executionId!, 'repair-local', [
      '3333333',
    ]);
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '再次部署完成',
    });
    const passed = fixture.lifecycle.verifyBug(
      fixture.users.tester.id,
      localBug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, localBug.id).version,
        result: 'PASSED',
        comment: '边界场景已通过',
        attachmentIds: [],
      },
    );
    expect(passed.executionId).toBeNull();
    expect(currentBug(fixture.database, localBug.id).stage).toBe('DONE');
    fixture.lifecycle.verifyBug(fixture.users.tester.id, ciBug.id, {
      mutationId: randomUUID(),
      expectedVersion: currentBug(fixture.database, ciBug.id).version,
      result: 'PASSED',
      attachmentIds: [],
    });
    expect(currentBug(fixture.database, ciBug.id).stage).toBe('DONE');

    const beforeClose = submissionRow(fixture.database, fixture.submission.id);
    const closed = fixture.lifecycle.closeSubmission(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        expectedVersion: beforeClose.version,
      },
    );
    expect(closed.cleanupExecutionIds).toHaveLength(2);
    for (const executionId of closed.cleanupExecutionIds)
      expect(fixture.executions.get(executionId).approvalPolicy).toBe('never');
    expect(
      submissionRow(fixture.database, fixture.submission.id),
    ).toMatchObject({
      status: 'CLOSED',
      version: beforeClose.version + 1,
    });
    expect(
      fixture.database.get(
        `SELECT COUNT(*) count FROM cooking_submission_environment_lock
           WHERE submission_id = ?`,
        fixture.submission.id,
      ),
    ).toEqual({ count: 0 });
    const replacement = fixture.submissions.createSubmission(
      fixture.users.owner.id,
      fixture.project.id,
      {
        mutationId: randomUUID(),
        title: '环境复用提测',
        requirementDescription: '关闭后环境可以再次占用',
        testerUserId: fixture.users.tester.id,
        items: fixture.items.map((item, index) => ({
          engineeringId:
            index === 0
              ? fixture.localEngineering.id
              : fixture.ciEngineering.id,
          responsibleUserId: fixture.users.developer.id,
          bindingId:
            index === 0
              ? bindingForItem(fixture.database, fixture.items[0]!.id)
              : bindingForItem(fixture.database, fixture.items[1]!.id),
          targetBranch: 'main',
          environmentId: item.environment_id,
        })),
      },
    );
    expect(replacement.status).toBe('ACTIVE');

    const cleanupExecutions = closed.cleanupExecutionIds;
    const claimedCleanup = (
      await fixture.executions.claim(fixture.runner.id, 1, 0)
    ).find(({ id }) => id === cleanupExecutions[0]);
    if (!claimedCleanup) throw new Error('未领取到首个清理执行');
    fixture.executions.start(fixture.runner.id, claimedCleanup.id, {
      kind: 'STARTED',
      leaseToken: claimedCleanup.lease.token,
      sessionId: 'cleanup-session',
      taskSkillBinding: null,
    });
    const cleanupInteraction = fixture.executions.openInteraction(
      fixture.runner.id,
      claimedCleanup.id,
      {
        leaseToken: claimedCleanup.lease.token,
        kind: 'APPROVAL',
        method: 'item/commandExecution/requestApproval',
        payload: {
          cwd: '/Users/example/private-repository',
          command: 'rm -rf /Users/example/private-repository/worktree',
          reason: '清理提测临时资源',
        },
      },
    );
    const testerCleanupInteraction = fixture.lifecycle.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).cleanupInteractions[0]!;
    const developerWorkspace = fixture.lifecycle.workspace(
      fixture.users.developer.id,
      fixture.submission.id,
    );
    const developerCleanupInteraction =
      developerWorkspace.cleanupInteractions[0]!;
    const runningCleanup = developerWorkspace.cleanups.find(
      ({ id }) => id === developerCleanupInteraction.cleanupId,
    )!;
    expect(testerCleanupInteraction).toMatchObject({
      method: null,
      payload: null,
      canResolve: false,
    });
    expect(developerCleanupInteraction).toMatchObject({
      method: 'item/commandExecution/requestApproval',
      payload: {
        command: 'rm -rf 本机路径已隐藏',
        reason: '清理提测临时资源',
      },
      canResolve: true,
    });
    expect(JSON.stringify(developerCleanupInteraction)).not.toContain(
      '/Users/example',
    );
    expect(() =>
      fixture.lifecycle.resolveCleanupInteraction(
        fixture.users.owner.id,
        cleanupInteraction.id,
        {
          mutationId: randomUUID(),
          expectedVersion: runningCleanup.version,
          resolution: { decision: 'decline' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const resolvedCleanupInteraction =
      fixture.lifecycle.resolveCleanupInteraction(
        fixture.users.developer.id,
        cleanupInteraction.id,
        {
          mutationId: randomUUID(),
          expectedVersion: runningCleanup.version,
          resolution: { decision: 'decline' },
        },
      );
    expect(resolvedCleanupInteraction.cleanupVersion).toBe(
      runningCleanup.version + 1,
    );
    expect(
      fixture.database.get(
        'SELECT state FROM platform_execution_interaction WHERE id = ?',
        cleanupInteraction.id,
      ),
    ).toEqual({ state: 'RESOLVED' });
    const eventsBeforeResume = fixture.events.length;
    const revisionBeforeResume = fixture.events.at(-1)!.revision;
    expect(
      await fixture.executions.waitInteraction(
        fixture.runner.id,
        claimedCleanup.id,
        cleanupInteraction.id,
        claimedCleanup.lease.token,
        0,
      ),
    ).toMatchObject({ laneAcquired: true });
    expect(fixture.events).toHaveLength(eventsBeforeResume + 1);
    expect(fixture.events.at(-1)).toEqual({
      submissionId: fixture.submission.id,
      revision: revisionBeforeResume + 1,
    });
    fixture.executions.complete(fixture.runner.id, claimedCleanup.id, {
      leaseToken: claimedCleanup.lease.token,
      sessionId: 'cleanup-session',
      outcome: {
        kind: 'SUCCEEDED',
        result: { outcome: 'FAILED', summary: 'Worktree 被占用' },
      },
    });
    const failedCleanup = fixture.database.get(
      `SELECT cleanup.id cleanupId, cleanup.state
         FROM cooking_cleanup_attempt attempt
         JOIN cooking_cleanup cleanup ON cleanup.id = attempt.cleanup_id
         WHERE attempt.execution_id = ?`,
      claimedCleanup.id,
    ) as { cleanupId: string; state: string };
    await completeCleanup(
      fixture,
      cleanupExecutions[1]!,
      'cleanup-ci-session',
      { outcome: 'COMPLETED', summary: '资源不存在，幂等完成' },
    );
    expect(submissionRow(fixture.database, fixture.submission.id).status).toBe(
      'CLOSED',
    );
    const cleanup = fixture.lifecycle
      .workspace(fixture.users.developer.id, fixture.submission.id)
      .cleanups.find(({ id }) => id === failedCleanup.cleanupId)!;
    expect(cleanup.subjectId).toBe(fixture.submission.id);
    expect(cleanup.state).toBe('FAILED');
    expect(cleanup.availableActions).toEqual(['RETRY_CLEANUP']);
    const retried = fixture.lifecycle.retryCleanup(
      fixture.users.developer.id,
      cleanup.id,
      {
        mutationId: randomUUID(),
        expectedVersion: cleanup.version,
      },
    );
    expect(fixture.executions.get(retried.executionId)).toMatchObject({
      approvalPolicy: 'never',
      codexTurn: null,
    });
    await completeCleanup(fixture, retried.executionId, 'cleanup-session', {
      outcome: 'COMPLETED',
      summary: '重试完成',
    });
    expect(
      fixture.lifecycle
        .workspace(fixture.users.developer.id, fixture.submission.id)
        .cleanups.find(({ id }) => id === cleanup.id)?.state,
    ).toBe('COMPLETED');
    expect(
      fixture.lifecycle.workspace(
        fixture.users.tester.id,
        fixture.submission.id,
      ).timeline,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '提测单已关闭' }),
        expect.objectContaining({ kind: 'VERIFICATION' }),
        expect.objectContaining({ kind: 'EXTERNAL_DEPLOYMENT' }),
      ]),
    );
  });
});
