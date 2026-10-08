import {
  completeSuccessfulExecution,
  testSkillBinding,
} from '@/cooking/testing/execution';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  batchEntries,
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
    completeSuccessfulExecution(
      fixture,
      failed,
      failedUpdate('部署脚本返回非零状态'),
    );
    let batch = latestBatch(fixture.database, fixture.item.id);
    expect(batch.state).toBe('FAILED');
    expect(currentBug(fixture.database, first.id).stage).toBe('UPDATING');
    expect(currentBug(fixture.database, second.id).stage).toBe('UPDATING');
    const testerAttempt = fixture.updates
      .batchView(fixture.users.tester.id, batch.id)
      .timeline.find((node) => node.kind === 'UPDATE_ATTEMPT');
    expect(
      testerAttempt?.kind === 'UPDATE_ATTEMPT'
        ? testerAttempt.result
        : undefined,
    ).toMatchObject({
      outcome: 'FAILED',
      failedStep: '执行统一更新',
      reason: '部署脚本返回非零状态',
      completedActions: [],
      pendingActions: ['修正失败原因后重新执行'],
      failureCode: null,
    });

    const continued = fixture.updates.retryUpdate(
      fixture.users.developer.id,
      batch.id,
      {
        mutationId: randomUUID(),
        expectedVersion: batch.version,
      },
    );
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
    if (continuation.codexTurn?.kind !== 'CONTINUATION')
      throw new Error('需要继续 Turn');
    expect(continuation.codexTurn.input).toBe('继续完成上次未完成的任务。');
    const resumed = await startExecution(
      fixture,
      continuation.id,
      'update-session',
    );
    completeSuccessfulExecution(
      fixture,
      resumed,
      completedUpdate('统一更新和部署完成'),
    );
    batch = latestBatch(fixture.database, fixture.item.id);
    expect(batch.state).toBe('COMPLETED');
    expect(currentBug(fixture.database, first.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    expect(currentBug(fixture.database, second.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    expect(pendingCommits(fixture.database, first.id)).toEqual([]);
    expect(pendingCommits(fixture.database, second.id)).toEqual([]);
  });

  test('首次启动失败且原 Task 不存在时不自动重建 Update Task', async () => {
    const fixture = await setup();
    fixture.createBug('启动失败候选');
    await completeNextRepair(fixture, 'repair-before-start-failure', [
      'aaaaaaa',
    ]);
    const frozen = freezeUpdate(fixture);
    const claimed = (
      await fixture.executions.claim(fixture.runner.id, 1, 0)
    )[0]!;
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
        mutationId: randomUUID(),
        expectedVersion: batch.version,
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
    completeSuccessfulExecution(
      fixture,
      first,
      pushedUpdate('代码已普通 Push'),
    );
    const waiting = latestBatch(fixture.database, fixture.item.id);
    expect(waiting.state).toBe('WAITING_EXTERNAL');
    expect(currentBug(fixture.database, bug.id).stage).toBe('UPDATING');
    expect(
      fixture.updates.batchView(fixture.users.tester.id, waiting.id),
    ).toMatchObject({
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
      fixture.updates.batchView(fixture.users.developer.id, waiting.id)
        .availableActions,
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
      fixture.updates.reportExternalDeployment(
        fixture.users.tester.id,
        waiting.id,
        {
          mutationId: randomUUID(),
          expectedVersion: waiting.version,
          outcome: 'FAILED',
          summary: '流水线测试失败',
          attachmentIds: [],
        },
      ),
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
      fixture.updates.reportExternalDeployment(
        fixture.users.developer.id,
        waiting.id,
        {
          mutationId: reportMutationId,
          expectedVersion: waiting.version,
          outcome: 'FAILED',
          summary: '流水线测试失败',
          attachmentIds: [evidence.id],
        },
      ),
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
        mutationId: randomUUID(),
        expectedVersion: failed.batchVersion,
      },
    );
    const continuationExecution = fixture.executions.get(
      continued.executionId!,
    );
    expect(continuationExecution.codexTurn?.kind).toBe('CONTINUATION');
    if (continuationExecution.codexTurn?.kind !== 'CONTINUATION')
      throw new Error('需要继续 Turn');
    expect(continuationExecution.codexTurn.taskId).toBe('update-ci-session');
    expect(continuationExecution.codexTurn.input).toContain('流水线测试失败');
    expect(continuationExecution.codexTurn.input).not.toContain(
      'repositoryUrl',
    );
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
    completeSuccessfulExecution(
      fixture,
      second,
      pushedUpdate('修复后已重新 Push'),
    );
    const waitingAgain = latestBatch(fixture.database, fixture.item.id);
    expect(waitingAgain.id).toBe(waiting.id);
    expect(waitingAgain.state).toBe('WAITING_EXTERNAL');
    fixture.updates.reportExternalDeployment(
      fixture.users.developer.id,
      waiting.id,
      {
        mutationId: randomUUID(),
        expectedVersion: waitingAgain.version,
        outcome: 'SUCCEEDED',
        summary: '流水线与部署均成功',
        attachmentIds: [],
      },
    );
    expect(latestBatch(fixture.database, fixture.item.id).state).toBe(
      'COMPLETED',
    );
    expect(currentBug(fixture.database, bug.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    expect(pendingCommits(fixture.database, bug.id)).toEqual([]);
  });

  test('活动失败 Batch 隔离后续候选，完成后下一轮独立冻结', async () => {
    const fixture = await setup();
    const { bug: first, started: running } = await startCandidateUpdate(
      fixture,
      '首批候选',
      'repair-one',
      ['aaaaaaa'],
      'first-batch-session',
    );
    completeSuccessfulExecution(
      fixture,
      running,
      failedUpdate('等待负责人处理冲突'),
    );
    const firstBatch = latestBatch(fixture.database, fixture.item.id);

    fixture.clock.set('2026-07-27T10:01:00.000Z');
    const later = fixture.createBug('冻结后的新候选');
    await completeNextRepair(fixture, 'repair-later', ['bbbbbbb']);
    fixture.clock.set('2026-07-27T10:03:00.000Z');
    expect(fixture.updates.prepareDueExecutions()).toEqual([]);
    expect(batchEntries(fixture.database, firstBatch.id)).toEqual([
      { bug_id: first.id, commits: ['aaaaaaa'] },
    ]);
    expect(currentBug(fixture.database, later.id).stage).toBe(
      'WAITING_FOR_UPDATE',
    );

    const continued = fixture.updates.retryUpdate(
      fixture.users.developer.id,
      firstBatch.id,
      {
        mutationId: randomUUID(),
        expectedVersion: latestBatch(fixture.database, fixture.item.id).version,
      },
    );
    const resumed = await startExecution(
      fixture,
      continued.executionId,
      'first-batch-session',
    );
    completeSuccessfulExecution(fixture, resumed, completedUpdate('首批完成'));
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
    const reclaimed = (
      await fixture.executions.claim(fixture.runner.id, 1, 0)
    )[0]!;
    expect(reclaimed.id).toBe(first.executionId);
    expect(reclaimed.codexTurn).toMatchObject({
      kind: 'CONTINUATION',
      taskId: 'lease-update-session',
    });
    fixture.executions.start(fixture.runner.id, reclaimed.id, {
      kind: 'STARTED',
      leaseToken: reclaimed.lease.token,
      sessionId: 'lease-update-session',
      taskSkillBinding: testSkillBinding(
        'agent-party-time-integrate-update-batch',
      ),
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
      fixture.executions.complete(
        fixture.runner.id,
        running.executionId,
        completion,
      ).state,
    ).toBe('FAILED');
    expect(
      fixture.executions.complete(
        fixture.runner.id,
        running.executionId,
        completion,
      ).state,
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
    completeSuccessfulExecution(fixture, running, {
      result: {
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
      },
    });

    const batch = latestBatch(fixture.database, fixture.item.id);
    const attempt = fixture.updates
      .batchView(fixture.users.developer.id, batch.id)
      .timeline.find((node) => node.kind === 'UPDATE_ATTEMPT');
    expect(batch.state).toBe('FAILED');
    expect(attempt?.kind === 'UPDATE_ATTEMPT' ? attempt.result : null).toEqual({
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
      completeSuccessfulExecution(
        fixture,
        running,
        completedUpdate('应整体回滚'),
      ),
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
      fixture.updates.resolveInteraction(
        fixture.users.developer.id,
        interaction.id,
        {
          mutationId: randomUUID(),
          expectedVersion: batch.version - 1,
          resolution: { decision: 'accept' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    fixture.updates.resolveInteraction(
      fixture.users.developer.id,
      interaction.id,
      {
        mutationId: randomUUID(),
        expectedVersion: batch.version,
        resolution: { decision: 'acceptForSession' },
      },
    );
    expect(
      fixture.database.get(
        'SELECT state FROM platform_execution_interaction WHERE id = ?',
        interaction.id,
      ),
    ).toEqual({ state: 'RESOLVED' });
    const resolvedAttempt = fixture.updates
      .workspace(fixture.users.developer.id, fixture.submission.id)
      .updateBatches[0]?.timeline.find(
        (node) => node.kind === 'UPDATE_ATTEMPT',
      );
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
      fixture.updates.resolveInteraction(
        fixture.users.developer.id,
        interaction.id,
        {
          mutationId: randomUUID(),
          expectedVersion: batch.version + 1,
          resolution: { decision: 'accept' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
  });
});
