import { mutation } from '@/testing/submissions/project';
import { completeSuccessfulExecution } from '@/testing/submissions/execution';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import {
  completeNextRepair,
  completedUpdate,
  currentBug,
  failedUpdate,
  freezeUpdate,
  latestBatch,
  pendingCommits,
  startCandidateUpdate,
  startExecution,
  updateFixture,
} from './updateFixture';

const setup = updateFixture(testDatabases());

describe('UpdateService', () => {
  test('LOCAL_SCRIPT 失败后沿用 Session 继续，成功时全部原子进入待验证', async () => {
    const fixture = await setup();
    const first = fixture.createBug('支付按钮无响应');
    await completeNextRepair(fixture, 'repair-one', [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
    const { bug: second, started: failed } = await startCandidateUpdate(
      fixture,
      '支付金额错误',
      'repair-two',
      ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      'update-session',
    );
    completeSuccessfulExecution(fixture, failed, failedUpdate('部署脚本返回非零状态'));
    let batch = latestBatch(fixture.database, fixture.item.id);
    expect(batch.state).toBe('FAILED');
    expect(currentBug(fixture.database, first.id).stage).toBe('UPDATING');
    expect(currentBug(fixture.database, second.id).stage).toBe('UPDATING');
    const testerAttempt = fixture.updates
      .batchView(fixture.users.tester.id, batch.id)
      .timeline.find((node) => node.kind === 'UPDATE_ATTEMPT');
    expect(
      testerAttempt?.kind === 'UPDATE_ATTEMPT' ? testerAttempt.result : undefined,
    ).toMatchObject({
      outcome: 'FAILED',
      failedStep: '执行统一更新',
      reason: '部署脚本返回非零状态',
      completedActions: [],
      pendingActions: ['修正失败原因后重新执行'],
      failureCode: null,
    });

    const continued = fixture.updates.retryUpdate(fixture.users.developer.id, batch.id, {
      ...mutation(batch.version),
    });
    const continuation = fixture.executions.get(continued.executionId);
    expect(continuation).toMatchObject({
      previousExecutionId: failed.executionId,
      codexTurn: {
        kind: 'CONTINUATION',
        taskId: 'update-session',
      },
      priority: 1,
    });
    expect(continuation.codexTurn?.kind).toBe('CONTINUATION');
    if (continuation.codexTurn?.kind !== 'CONTINUATION') throw new Error('需要继续 Turn');
    expect(continuation.codexTurn.input).toBe('继续完成上次未完成的任务。');
    const resumed = await startExecution(fixture, continuation.id, 'update-session');
    completeSuccessfulExecution(fixture, resumed, completedUpdate());
    batch = latestBatch(fixture.database, fixture.item.id);
    expect(batch.state).toBe('COMPLETED');
    expect(currentBug(fixture.database, first.id).stage).toBe('WAITING_FOR_VERIFICATION');
    expect(currentBug(fixture.database, second.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    expect(pendingCommits(fixture.database, first.id)).toEqual([]);
    expect(pendingCommits(fixture.database, second.id)).toEqual([]);
  });

  test('规则包在启动前不匹配时，更新规则后重试原冻结批次', async () => {
    const fixture = await setup();
    fixture.createBug('更新规则后重试');
    await completeNextRepair(fixture, 'repair-before-skill-update', ['a'.repeat(40)]);
    const frozen = freezeUpdate(fixture);
    const [claimed] = await fixture.executions.claim(fixture.runner.id, 1, 0);
    fixture.executions.start(fixture.runner.id, claimed!.id, {
      kind: 'START_FAILED',
      leaseToken: claimed!.lease.token,
      failure: {
        code: 'SKILL_PROTOCOL_MISMATCH',
        message: '当前规则包不支持此任务协议，请更新 Agent 规则包',
        retryable: false,
      },
    });
    const batch = fixture.updates.batchView(fixture.users.developer.id, frozen.batchId);
    expect(batch.availableActions).toEqual(['RETRY_UPDATE']);
    const retried = fixture.updates.retryUpdate(
      fixture.users.developer.id,
      batch.id,
      mutation(batch.version),
    );
    expect(retried.batchId).toBe(batch.id);
    const [next] = await fixture.executions.claim(fixture.runner.id, 1, 0);
    expect(next!.codexTurn).toEqual(claimed!.codexTurn);
    expect(next!.workspaces).toEqual(claimed!.workspaces);
  });

  test('首次启动失败且原 Task 不存在时不自动重建 Update Task', async () => {
    const fixture = await setup();
    fixture.createBug('启动失败候选');
    await completeNextRepair(fixture, 'repair-before-start-failure', [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
    const frozen = freezeUpdate(fixture);
    const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
    expect(claimed.id).toBe(frozen.executionId);
    fixture.executions.start(fixture.runner.id, claimed.id, {
      kind: 'START_FAILED',
      leaseToken: claimed.lease.token,
      failure: {
        code: 'CODEX_START_FAILED',
        message: 'Codex Task 未创建',
        retryable: true,
      },
    });
    const batch = latestBatch(fixture.database, fixture.item.id);

    expect(() =>
      fixture.updates.retryUpdate(fixture.users.developer.id, batch.id, {
        ...mutation(batch.version),
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_TRANSITION',
        message: '原更新任务不存在，不能自动重建',
      }),
    );
  });
});
