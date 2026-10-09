import { mutation } from '@/cooking/testing/project';
import {
  completeSuccessfulExecution,
  testSkillBinding,
} from '@/cooking/testing/execution';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  batchEntries,
  completeNextRepair,
  completedUpdate,
  currentBug,
  failedUpdate,
  latestBatch,
  pendingCommits,
  startCandidateUpdate,
  startExecution,
  updateFixture,
} from './update-fixture';

const setup = updateFixture(testDatabases());

describe('UpdateService', () => {
  test('活动失败 Batch 隔离后续候选，完成后下一轮独立冻结', async () => {
    const fixture = await setup();
    const { bug: first, started: running } = await startCandidateUpdate(
      fixture,
      '首批候选',
      'repair-one',
      ['aaaaaaa'],
      'first-batch-session',
    );
    completeSuccessfulExecution(fixture, running, failedUpdate('等待负责人处理冲突'));
    const firstBatch = latestBatch(fixture.database, fixture.item.id);

    fixture.clock.set('2026-07-27T10:01:00.000Z');
    const later = fixture.createBug('冻结后的新候选');
    await completeNextRepair(fixture, 'repair-later', ['bbbbbbb']);
    fixture.clock.set('2026-07-27T10:03:00.000Z');
    expect(fixture.updates.prepareDueExecutions()).toEqual([]);
    expect(batchEntries(fixture.database, firstBatch.id)).toEqual([
      { bug_id: first.id, commits: ['aaaaaaa'] },
    ]);
    expect(currentBug(fixture.database, later.id).stage).toBe('WAITING_FOR_UPDATE');

    const continued = fixture.updates.retryUpdate(
      fixture.users.developer.id,
      firstBatch.id,
      {
        ...mutation(latestBatch(fixture.database, fixture.item.id).version),
      },
    );
    const resumed = await startExecution(
      fixture,
      continued.executionId,
      'first-batch-session',
    );
    completeSuccessfulExecution(fixture, resumed, completedUpdate());
    expect(fixture.updates.prepareDueExecutions()).toHaveLength(1);
    const secondBatch = latestBatch(fixture.database, fixture.item.id);
    expect(secondBatch.id).not.toBe(firstBatch.id);
    expect(batchEntries(fixture.database, secondBatch.id)).toEqual([
      { bug_id: later.id, commits: ['bbbbbbb'] },
    ]);
  });

  test('Lease 恢复保持冻结 Batch 和 Session，不重复创建 Attempt', async () => {
    const fixture = await setup();
    const { started: first } = await startCandidateUpdate(
      fixture,
      'Lease 恢复候选',
      'repair-one',
      ['aaaaaaa'],
      'lease-update-session',
    );
    fixture.clock.set('2026-07-27T10:00:16.000Z');
    const reclaimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
    expect(reclaimed.id).toBe(first.executionId);
    expect(reclaimed.codexTurn).toMatchObject({
      kind: 'CONTINUATION',
      taskId: 'lease-update-session',
    });
    fixture.executions.start(fixture.runner.id, reclaimed.id, {
      kind: 'STARTED',
      leaseToken: reclaimed.lease.token,
      sessionId: 'lease-update-session',
      taskSkillBinding: testSkillBinding('agent-party-time-integrate-update-batch'),
    });
    expect(
      fixture.database.get(
        'SELECT COUNT(*) count FROM cooking_update_attempt WHERE batch_id = ?',
        latestBatch(fixture.database, fixture.item.id).id,
      ),
    ).toEqual({ count: 1 });
  });

  test('非法 Update Result 可幂等重放且 Batch 保持失败', async () => {
    const fixture = await setup();
    const { started: running } = await startCandidateUpdate(
      fixture,
      '非法结果候选',
      'repair-one',
      ['aaaaaaa'],
      'invalid-result-session',
    );
    const completion = {
      leaseToken: running.leaseToken,
      sessionId: running.sessionId,
      outcome: {
        kind: 'SUCCEEDED' as const,
        result: { outcome: 'COMPLETED', summary: '完成', pushed: true },
      },
    };
    expect(
      fixture.executions.complete(fixture.runner.id, running.executionId, completion)
        .state,
    ).toBe('FAILED');
    expect(
      fixture.executions.complete(fixture.runner.id, running.executionId, completion)
        .state,
    ).toBe('FAILED');
    expect(latestBatch(fixture.database, fixture.item.id).state).toBe('FAILED');
  });

  test('失败 Update Result 保留验证结果与警告', async () => {
    const fixture = await setup();
    const { started: running } = await startCandidateUpdate(
      fixture,
      '质量门失败候选',
      'repair-one',
      ['aaaaaaa'],
      'failed-update-session',
    );
    const failedResult = {
      outcome: 'FAILED',
      failedStep: '质量门：pnpm run tsc',
      reason: '仓库不存在 tsconfig.json',
      completedActions: ['完成候选提交集成'],
      validations: [
        {
          name: 'TypeScript 静态检查',
          status: 'FAILED',
          detail: 'pnpm run tsc 退出码为 1',
        },
      ],
      warnings: ['该失败不直接证明候选修改存在类型错误'],
      pendingActions: ['修复质量门后重新执行'],
    };
    completeSuccessfulExecution(fixture, running, {
      result: structuredClone(failedResult),
    });

    const batch = latestBatch(fixture.database, fixture.item.id);
    const attempt = fixture.updates
      .batchView(fixture.users.developer.id, batch.id)
      .timeline.find((node) => node.kind === 'UPDATE_ATTEMPT');
    expect(batch.state).toBe('FAILED');
    expect(attempt?.kind === 'UPDATE_ATTEMPT' ? attempt.result : null).toEqual({
      ...failedResult,
      failureCode: null,
    });
  });

  test('Update Outcome 业务解释失败时整笔事务回滚', async () => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000005',
    ];
    let idIndex = 0;
    const fixture = await setup({
      updateCreateId: () => ids[idIndex++] ?? randomUUID(),
    });
    const { bug, started: running } = await startCandidateUpdate(
      fixture,
      '事务回滚候选',
      'repair-one',
      ['aaaaaaa'],
      'rollback-update-session',
    );
    const beforeBatch = latestBatch(fixture.database, fixture.item.id);
    const beforeBug = currentBug(fixture.database, bug.id);

    expect(() =>
      completeSuccessfulExecution(fixture, running, completedUpdate()),
    ).toThrow();
    expect(fixture.executions.get(running.executionId).state).toBe('RUNNING');
    expect(latestBatch(fixture.database, fixture.item.id)).toEqual(beforeBatch);
    expect(currentBug(fixture.database, bug.id)).toEqual(beforeBug);
    expect(pendingCommits(fixture.database, bug.id)).toEqual(['aaaaaaa']);
  });

  test('负责人可处理 Update Interaction，Tester 只能看到安全等待状态', async () => {
    const fixture = await setup();
    const { started: running } = await startCandidateUpdate(
      fixture,
      '需要审批的候选',
      'repair-one',
      ['aaaaaaa'],
      'interaction-session',
    );
    const interaction = fixture.executions.openInteraction(
      fixture.runner.id,
      running.executionId,
      {
        leaseToken: running.leaseToken,
        kind: 'APPROVAL',
        method: 'item/commandExecution/requestApproval',
        payload: {
          cwd: '/Users/example/private-repository',
          command: 'git push origin main',
          reason: '普通 Push 冻结批次',
        },
      },
    );
    const testerBatch = fixture.updates.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).updateBatches[0]!;
    const developerBatch = fixture.updates.workspace(
      fixture.users.developer.id,
      fixture.submission.id,
    ).updateBatches[0]!;
    const testerAttempt = testerBatch.timeline.find(
      (node) => node.kind === 'UPDATE_ATTEMPT',
    );
    const developerAttempt = developerBatch.timeline.find(
      (node) => node.kind === 'UPDATE_ATTEMPT',
    );
    expect(testerAttempt?.kind).toBe('UPDATE_ATTEMPT');
    expect(developerAttempt?.kind).toBe('UPDATE_ATTEMPT');
    expect(testerAttempt).toMatchObject({ sessionId: null });
    expect(developerAttempt).toMatchObject({
      sessionId: 'interaction-session',
    });
    const tester =
      testerAttempt?.kind === 'UPDATE_ATTEMPT'
        ? testerAttempt.interactions[0]!
        : undefined;
    const developer =
      developerAttempt?.kind === 'UPDATE_ATTEMPT'
        ? developerAttempt.interactions[0]!
        : undefined;
    expect(tester).toMatchObject({ request: null, canResolve: false });
    expect(developer).toMatchObject({
      request: {
        type: 'COMMAND',
        command: 'git push origin main',
        purpose: '普通 Push 冻结批次',
      },
      canResolve: true,
    });
    expect(testerBatch.presentation.visual).toEqual({
      state: 'NEEDS_APPROVAL',
      label: '等待工程负责人审批',
      symbol: '!',
    });
    expect(developerBatch.presentation.visual).toEqual({
      state: 'NEEDS_APPROVAL',
      label: '需要你审批',
      symbol: '!',
    });
    expect(JSON.stringify(developer)).not.toContain('/Users/example');
    expect(testerAttempt).toMatchObject({ result: null });
    expect(developerAttempt).toMatchObject({ result: null });
    const batch = latestBatch(fixture.database, fixture.item.id);
    expect(() =>
      fixture.updates.resolveInteraction(fixture.users.developer.id, interaction.id, {
        ...mutation(batch.version - 1),
        resolution: { decision: 'accept' },
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    fixture.updates.resolveInteraction(fixture.users.developer.id, interaction.id, {
      ...mutation(batch.version),
      resolution: { decision: 'acceptForSession' },
    });
    expect(
      fixture.database.get(
        'SELECT state FROM platform_execution_interaction WHERE id = ?',
        interaction.id,
      ),
    ).toEqual({ state: 'RESOLVED' });
    const resolvedAttempt = fixture.updates
      .workspace(fixture.users.developer.id, fixture.submission.id)
      .updateBatches[0]?.timeline.find((node) => node.kind === 'UPDATE_ATTEMPT');
    expect(
      resolvedAttempt?.kind === 'UPDATE_ATTEMPT'
        ? resolvedAttempt.interactions[0]
        : undefined,
    ).toMatchObject({
      state: 'RESOLVED',
      resolution: 'ACCEPTED_FOR_SESSION',
      canResolve: false,
    });
    const eventsBeforeResume = fixture.events.length;
    const revisionBeforeResume = fixture.events.at(-1)!.revision;
    const waited = await fixture.executions.waitInteraction(
      fixture.runner.id,
      running.executionId,
      interaction.id,
      running.leaseToken,
      0,
    );
    expect(waited).toMatchObject({ laneAcquired: true });
    expect(fixture.executions.get(running.executionId).state).toBe('RUNNING');
    expect(fixture.events).toHaveLength(eventsBeforeResume + 1);
    expect(fixture.events.at(-1)).toEqual({
      submissionId: fixture.submission.id,
      revision: revisionBeforeResume + 1,
    });
    expect(() =>
      fixture.updates.resolveInteraction(fixture.users.developer.id, interaction.id, {
        ...mutation(batch.version + 1),
        resolution: { decision: 'accept' },
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
  });
});
