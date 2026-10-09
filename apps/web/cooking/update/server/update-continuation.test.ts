import { mutation } from '@/cooking/testing/project';
import { completeSuccessfulExecution } from '@/cooking/testing/execution';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  completeNextRepair,
  completedUpdate,
  currentBug,
  failedUpdate,
  freezeUpdate,
  latestBatch,
  pendingCommits,
  pushedUpdate,
  startCandidateUpdate,
  startExecution,
  updateFixture,
} from './update-fixture';

const setup = updateFixture(testDatabases());

describe('UpdateService', () => {
  test('LOCAL_SCRIPT 失败后沿用 Session 继续，成功时全部原子进入待验证', async () => {
    const fixture = await setup();
    const first = fixture.createBug('支付按钮无响应');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    const { bug: second, started: failed } = await startCandidateUpdate(
      fixture,
      '支付金额错误',
      'repair-two',
      ['bbbbbbb'],
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
      priority: 0,
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

  test('首次启动失败且原 Task 不存在时不自动重建 Update Task', async () => {
    const fixture = await setup();
    fixture.createBug('启动失败候选');
    await completeNextRepair(fixture, 'repair-before-start-failure', ['aaaaaaa']);
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

  test('CI/CD Push 后等待外部结果，失败报告携带附件在原 Batch 与 Session 继续', async () => {
    const fixture = await setup({ deploymentKind: 'CI_CD' });
    const { bug, started: first } = await startCandidateUpdate(
      fixture,
      '流水线部署失败',
      'repair-ci',
      ['c1c1c1c'],
      'update-ci-session',
    );
    completeSuccessfulExecution(fixture, first, pushedUpdate());
    const waiting = latestBatch(fixture.database, fixture.item.id);
    expect(waiting.state).toBe('WAITING_EXTERNAL');
    expect(currentBug(fixture.database, bug.id).stage).toBe('UPDATING');
    expect(fixture.updates.batchView(fixture.users.tester.id, waiting.id)).toMatchObject({
      timeline: [
        { kind: 'BATCH_FORMED' },
        {
          kind: 'UPDATE_ATTEMPT',
          result: {
            outcome: 'PUSHED',
            completedActions: ['集成候选并普通 Push'],
            validations: [{ name: '定向检查', status: 'PASSED', detail: '' }],
            warnings: [],
          },
        },
      ],
      availableActions: [],
      presentation: { statusLabel: '等待外部部署结果' },
    });
    expect(
      fixture.updates.batchView(fixture.users.developer.id, waiting.id).availableActions,
    ).toContain('REPORT_EXTERNAL');

    const files = new LocalFileStore(
      fixture.database,
      join(fixture.directory, 'files'),
      fixture.clock.now,
    );
    const evidence = await files.put({
      bytes: new TextEncoder().encode('pipeline failed'),
      originalName: 'pipeline.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.developer.id,
    });
    expect(() =>
      fixture.updates.reportExternalDeployment(fixture.users.tester.id, waiting.id, {
        ...mutation(waiting.version),
        outcome: 'FAILED',
        summary: '流水线测试失败',
        attachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const reportMutationId = randomUUID();
    const failed = fixture.updates.reportExternalDeployment(
      fixture.users.developer.id,
      waiting.id,
      {
        mutationId: reportMutationId,
        expectedVersion: waiting.version,
        outcome: 'FAILED',
        summary: '流水线测试失败',
        attachmentIds: [evidence.id],
      },
    );
    expect(
      fixture.updates.reportExternalDeployment(fixture.users.developer.id, waiting.id, {
        mutationId: reportMutationId,
        expectedVersion: waiting.version,
        outcome: 'FAILED',
        summary: '流水线测试失败',
        attachmentIds: [evidence.id],
      }),
    ).toEqual(failed);
    expect(latestBatch(fixture.database, fixture.item.id).state).toBe('FAILED');
    const responsibleView = fixture.updates.batchView(
      fixture.users.developer.id,
      waiting.id,
    );
    expect(
      responsibleView.timeline.find((node) => node.kind === 'EXTERNAL_REPORT'),
    ).toMatchObject({
      round: 1,
      outcome: 'FAILED',
      summary: '流水线测试失败',
      attachments: [{ id: evidence.id, originalName: 'pipeline.txt' }],
    });
    expect(
      fixture.updates
        .batchView(fixture.users.tester.id, waiting.id)
        .timeline.find((node) => node.kind === 'EXTERNAL_REPORT'),
    ).toMatchObject({ summary: '流水线测试失败', attachments: [] });

    const continued = fixture.updates.retryUpdate(
      fixture.users.developer.id,
      waiting.id,
      {
        ...mutation(failed.batchVersion),
      },
    );
    const continuationExecution = fixture.executions.get(continued.executionId!);
    expect(continuationExecution.codexTurn?.kind).toBe('CONTINUATION');
    if (continuationExecution.codexTurn?.kind !== 'CONTINUATION')
      throw new Error('需要继续 Turn');
    expect(continuationExecution.codexTurn.taskId).toBe('update-ci-session');
    expect(continuationExecution.codexTurn.input).toContain('流水线测试失败');
    expect(continuationExecution.codexTurn.input).not.toContain('repositoryUrl');
    expect(
      fixture.database.all(
        `SELECT file_id FROM platform_execution_attachment
           WHERE execution_id = ?`,
        continued.executionId!,
      ),
    ).toEqual([{ file_id: evidence.id }]);
    const second = await startExecution(
      fixture,
      continued.executionId!,
      'update-ci-session',
    );
    completeSuccessfulExecution(fixture, second, pushedUpdate());
    const waitingAgain = latestBatch(fixture.database, fixture.item.id);
    expect(waitingAgain.id).toBe(waiting.id);
    expect(waitingAgain.state).toBe('WAITING_EXTERNAL');
    fixture.updates.reportExternalDeployment(fixture.users.developer.id, waiting.id, {
      ...mutation(waitingAgain.version),
      outcome: 'SUCCEEDED',
      summary: '流水线与部署均成功',
      attachmentIds: [],
    });
    expect(latestBatch(fixture.database, fixture.item.id).state).toBe('COMPLETED');
    expect(currentBug(fixture.database, bug.id).stage).toBe('WAITING_FOR_VERIFICATION');
    expect(pendingCommits(fixture.database, bug.id)).toEqual([]);
  });
});
