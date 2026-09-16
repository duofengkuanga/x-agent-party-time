import { createCooking } from '@/cooking/runtime/create-cooking';
import { SubmissionService } from '@/cooking/submissions/server/submission-service';
import {
  deliveryProject,
  mutableClock,
  mutation,
} from '@/cooking/testing/project';
import { CookingWorkspaceService } from '@/cooking/workspace/server/workspace-service';
import { AuthService } from '@/platform/auth/service';
import type { AppDatabase } from '@/platform/database';
import {
  handleExecutionClaim,
  handleExecutionComplete,
  handleExecutionStart,
} from '@/platform/execution/http';
import { ExecutionService } from '@/platform/execution/service';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { handleRunnerHeartbeat } from '@/platform/runner/http';
import { testDatabases } from '@/testing/database';
import { ProtocolAgent } from '@agent-party-time/runner-conformance';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { UpdateService } from './update-service';

const createDatabase = testDatabases();

async function setup(
  options: {
    updateCreateId?: () => string;
    secondItem?: boolean;
    deploymentKind?: 'LOCAL_SCRIPT' | 'CI_CD';
  } = {},
) {
  const { directory, database } = await createDatabase();
  const clock = mutableClock('2026-07-27T10:00:00.000Z');
  const { users, runners, pairedRunner, runner, submission, sources, items } =
    await deliveryProject(database, {
      name: 'Update 项目',
      prefix: 'update',
      title: '支付功能提测',
      description: '验证统一更新链路',
      sources: [
        {
          name: '支付工程',
          type: 'BACKEND',
          identifier: 'payment-api',
          environment: '支付测试环境',
          deployment:
            options.deploymentKind === 'CI_CD'
              ? { kind: 'CI_CD' }
              : { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
          repository: 'https://example.com/payment.git',
          branch: 'main',
        },
        ...(options.secondItem
          ? [
              {
                name: '订单工程',
                type: 'BACKEND' as const,
                identifier: 'order-api',
                environment: '订单测试环境',
                deployment: {
                  kind: 'LOCAL_SCRIPT' as const,
                  command: 'bun run deploy:order',
                },
                repository: 'https://example.com/order.git',
                branch: 'main',
              },
            ]
          : []),
      ],
    });
  const { binding } = sources[0]!;
  const secondBinding = sources[1]?.binding ?? null;
  const item = items[0]!;
  const secondItem = items[1] ?? null;
  const events: Array<{ submissionId: string; revision: number }> = [];
  const { repairs, updates, lifecycle, bugs, executions } = createCooking(
    database,
    {
      now: clock.now,
      publish: (submissionId, revision) =>
        events.push({ submissionId, revision }),
      ids: { update: options.updateCreateId },
    },
  );

  function createBugFor(submissionItemId: string, title: string) {
    const created = bugs.createBug(users.tester.id, submission.id, {
      mutationId: randomUUID(),
      submissionItemId,
      title,
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
    });
    return bugs.requestRepair(
      users.tester.id,
      created.bug.id,
      mutation(created.bug.version),
    ).bug;
  }

  function createBug(title: string) {
    return createBugFor(item.id, title);
  }

  return {
    binding,
    bugs,
    clock,
    createBug,
    createBugFor,
    database,
    directory,
    events,
    executions,
    item,
    pairedRunner,
    repairs,
    runner,
    runners,
    secondBinding,
    secondItem,
    submission,
    updates,
    users,
  };
}

describe('UpdateService', () => {
  test('冻结 Repair 候选中的数据库人工操作并向工作台暴露标识', async () => {
    const fixture = await setup();
    fixture.createBug('需要数据库脚本的更新');
    await completeNextRepair(
      fixture,
      'repair-with-sql',
      ['aaaaaaa'],
      [{ kind: 'DATABASE_SQL', paths: ['sql/add-payment-index.sql'] }],
    );
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const started = await startExecution(
      fixture,
      frozen.executionId,
      'update-with-sql',
    );
    fixture.executions.complete(fixture.runner.id, started.executionId, {
      leaseToken: started.leaseToken,
      sessionId: started.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: completedUpdate('统一更新完成，SQL 交由人工执行'),
      },
    });

    const batch = latestBatch(fixture.database, fixture.item.id);
    expect(
      fixture.updates.batchView(fixture.users.developer.id, batch.id)
        .hasManualDatabaseOperation,
    ).toBe(true);
  });

  test('候选未声明人工数据库操作时不展示标识', async () => {
    const fixture = await setup();
    fixture.createBug('未收集变更文件的更新');
    await completeNextRepair(fixture, 'repair-without-changes', ['aaaaaaa']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const started = await startExecution(
      fixture,
      frozen.executionId,
      'update-without-changes',
    );
    fixture.executions.complete(fixture.runner.id, started.executionId, {
      leaseToken: started.leaseToken,
      sessionId: started.sessionId,
      outcome: { kind: 'SUCCEEDED', result: completedUpdate('统一更新完成') },
    });

    const batch = latestBatch(fixture.database, fixture.item.id);
    expect(batch.state).toBe('COMPLETED');
    expect(
      fixture.updates.batchView(fixture.users.developer.id, batch.id)
        .hasManualDatabaseOperation,
    ).toBe(false);
  });

  test('候选提交重算两分钟截止，重启后由惰性准备原子冻结', async () => {
    const fixture = await setup();
    const first = fixture.createBug('支付按钮无响应');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    expect(pending(fixture.database, fixture.item.id)).toEqual({
      last_candidate_at: '2026-07-27T10:00:00.000Z',
      eligible_at: '2026-07-27T10:02:00.000Z',
    });

    fixture.clock.set('2026-07-27T10:01:00.000Z');
    const second = fixture.createBug('支付金额错误');
    await completeNextRepair(fixture, 'repair-two', ['bbbbbbb', 'ccccccc']);
    expect(pending(fixture.database, fixture.item.id)).toEqual({
      last_candidate_at: '2026-07-27T10:01:00.000Z',
      eligible_at: '2026-07-27T10:03:00.000Z',
    });

    const restarted = new UpdateService(
      fixture.database,
      new ExecutionService(fixture.database, fixture.clock.now),
      fixture.clock.now,
    );
    fixture.clock.set('2026-07-27T10:02:59.000Z');
    expect(restarted.prepareDueExecutions()).toEqual([]);
    fixture.clock.set('2026-07-27T10:03:00.000Z');
    expect(restarted.prepareDueExecutions()).toHaveLength(1);
    expect(restarted.prepareDueExecutions()).toEqual([]);

    const batch = latestBatch(fixture.database, fixture.item.id);
    expect(batch).toMatchObject({ state: 'READY', version: 1 });
    expect(batchEntries(fixture.database, batch.id)).toEqual([
      { bug_id: first.id, commits: ['aaaaaaa'] },
      { bug_id: second.id, commits: ['bbbbbbb', 'ccccccc'] },
    ]);
    expect(currentBug(fixture.database, first.id).stage).toBe('UPDATING');
    expect(currentBug(fixture.database, second.id).stage).toBe('UPDATING');
    expect(pending(fixture.database, fixture.item.id)).toBeNull();
  });

  test('待更新 Bug 的成功 Repair 已冻结，不能移出候选批次', async () => {
    const fixture = await setup();
    const first = fixture.createBug('保留候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    fixture.clock.set('2026-07-27T10:01:00.000Z');
    const second = fixture.createBug('需要继续修复的候选');
    await completeNextRepair(fixture, 'repair-two', ['bbbbbbb']);
    expect(pending(fixture.database, fixture.item.id)?.eligible_at).toBe(
      '2026-07-27T10:03:00.000Z',
    );

    expect(() =>
      fixture.repairs.continueRepair(fixture.users.developer.id, second.id, {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, second.id).version,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(pending(fixture.database, fixture.item.id)).toEqual({
      last_candidate_at: '2026-07-27T10:01:00.000Z',
      eligible_at: '2026-07-27T10:03:00.000Z',
    });
    expect(currentBug(fixture.database, first.id).stage).toBe(
      'WAITING_FOR_UPDATE',
    );
    expect(currentBug(fixture.database, second.id).stage).toBe(
      'WAITING_FOR_UPDATE',
    );
  });

  test('Workspace Query 会在读取前准备到期 Batch', async () => {
    const fixture = await setup();
    const bug = fixture.createBug('Workspace 到期候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    fixture.clock.set('2026-07-27T10:02:00.000Z');
    const workspace = new CookingWorkspaceService(
      new SubmissionService(fixture.database),
      fixture.bugs,
      fixture.repairs,
      fixture.updates,
    ).getWorkspace(fixture.users.developer.id, fixture.submission.id);
    expect(workspace.pendingDeliveries).toEqual([]);
    expect(workspace.updateBatches).toHaveLength(1);
    expect(workspace.updateBatches[0]?.state).toBe('READY');
    expect(workspace.visualByBug[bug.id]).toEqual({
      state: 'QUEUED_FOR_ENGINEERING',
      label: '等待工程执行通道（前方 0 项）',
      symbol: '…',
      aheadCount: 0,
    });
  });

  test('Workspace 忽略删除缺陷后遗留的空更新批次', async () => {
    const fixture = await setup();
    const now = fixture.clock.now().toISOString();
    fixture.database
      .prepare(
        `INSERT INTO cooking_update_batch(
           id, submission_id, submission_item_id, state, version,
           active_execution_id, session_id, deployment_json, frozen_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'COMPLETED', 1, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        fixture.submission.id,
        fixture.item.id,
        JSON.stringify({
          kind: 'LOCAL_SCRIPT',
          command: 'bun run deploy:test',
        }),
        now,
        now,
        now,
      );

    expect(
      fixture.updates.workspace(
        fixture.users.developer.id,
        fixture.submission.id,
      ).updateBatches,
    ).toEqual([]);
  });

  test('无权访问的 Workspace Query 不会触发到期冻结', async () => {
    const fixture = await setup();
    fixture.createBug('无权访问时到期的候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    fixture.clock.set('2026-07-27T10:02:00.000Z');
    const outsider = await new AuthService(fixture.database).seedUser({
      id: randomUUID(),
      username: 'update-outsider',
      displayName: '项目外用户',
      password: 'password',
    });
    const workspace = new CookingWorkspaceService(
      new SubmissionService(fixture.database),
      fixture.bugs,
      fixture.repairs,
      fixture.updates,
    );
    expect(() =>
      workspace.getWorkspace(outsider.id, fixture.submission.id),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(
      fixture.database
        .prepare(
          'SELECT COUNT(*) count FROM cooking_update_batch WHERE submission_id = ?',
        )
        .get(fixture.submission.id),
    ).toEqual({ count: 0 });
    expect(pending(fixture.database, fixture.item.id)).not.toBeNull();
  });

  test('Runner Claim 会在认证和解析请求后准备到期 Batch', async () => {
    const fixture = await setup();
    fixture.createBug('Claim 到期候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    fixture.clock.set('2026-07-27T10:02:00.000Z');
    const response = await handleExecutionClaim(
      new Request('http://update.test/api/runner/executions/claim', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fixture.pairedRunner.credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ availableSlots: 1, waitMs: 0 }),
      }),
      fixture.runners,
      fixture.executions,
      () => fixture.updates.prepareDueExecutions(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      executions: Array<{ id: string; priority: number }>;
    };
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0]?.priority).toBe(0);
    expect(latestBatch(fixture.database, fixture.item.id).state).toBe('READY');
  });

  test('不同 Submission Item 可独立冻结并由不同 Binding 并行领取', async () => {
    const fixture = await setup({ secondItem: true });
    expect(fixture.secondItem).not.toBeNull();
    expect(fixture.secondBinding).not.toBeNull();
    fixture.createBug('支付工程候选');
    await completeNextRepair(fixture, 'repair-payment', ['aaaaaaa']);
    fixture.createBugFor(fixture.secondItem!.id, '订单工程候选');
    await completeNextRepair(fixture, 'repair-order', ['bbbbbbb']);
    const first = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const second = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.secondItem!.id,
      { mutationId: randomUUID() },
    );
    const claimed = await fixture.executions.claim(fixture.runner.id, 2, 0);
    expect(claimed.map(({ id }) => id).sort()).toEqual(
      [first.executionId, second.executionId].sort(),
    );
    expect(new Set(claimed.map(({ bindingId }) => bindingId))).toEqual(
      new Set([fixture.binding.id, fixture.secondBinding!.id]),
    );
  });

  test('立即冻结仅允许负责人，同 Binding 普通任务按创建时间 FIFO', async () => {
    const fixture = await setup();
    const first = fixture.createBug('首个候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    expect(() =>
      fixture.updates.freezeNow(fixture.users.owner.id, fixture.item.id, {
        mutationId: randomUUID(),
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const nextBug = fixture.createBug('后续普通修复');
    const claimed = (
      await fixture.executions.claim(fixture.runner.id, 1, 0)
    )[0]!;
    expect(claimed.id).toBe(frozen.executionId);
    expect(claimed.priority).toBe(0);
    expect(currentBug(fixture.database, first.id).stage).toBe('UPDATING');
    expect(currentBug(fixture.database, nextBug.id).stage).toBe('REPAIRING');
  });

  test('LOCAL_SCRIPT 失败后沿用 Session 继续，成功时全部原子进入待验证', async () => {
    const fixture = await setup();
    const first = fixture.createBug('支付按钮无响应');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    const second = fixture.createBug('支付金额错误');
    await completeNextRepair(fixture, 'repair-two', ['bbbbbbb']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const failed = await startExecution(
      fixture,
      frozen.executionId,
      'update-session',
    );
    fixture.executions.complete(fixture.runner.id, failed.executionId, {
      leaseToken: failed.leaseToken,
      sessionId: failed.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: failedUpdate('部署脚本返回非零状态'),
      },
    });
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
    fixture.executions.complete(fixture.runner.id, resumed.executionId, {
      leaseToken: resumed.leaseToken,
      sessionId: resumed.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: completedUpdate('统一更新和部署完成'),
      },
    });
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
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
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
    const bug = fixture.createBug('流水线部署失败');
    await completeNextRepair(fixture, 'repair-ci', ['c1c1c1c']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const first = await startExecution(
      fixture,
      frozen.executionId!,
      'update-ci-session',
    );
    fixture.executions.complete(fixture.runner.id, first.executionId, {
      leaseToken: first.leaseToken,
      sessionId: first.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: pushedUpdate('代码已普通 Push'),
      },
    });
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
      fixture.database
        .prepare(
          `SELECT file_id FROM platform_execution_attachment
           WHERE execution_id = ?`,
        )
        .all(continued.executionId!),
    ).toEqual([{ file_id: evidence.id }]);
    const second = await startExecution(
      fixture,
      continued.executionId!,
      'update-ci-session',
    );
    fixture.executions.complete(fixture.runner.id, second.executionId, {
      leaseToken: second.leaseToken,
      sessionId: second.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: pushedUpdate('修复后已重新 Push'),
      },
    });
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
    const first = fixture.createBug('首批候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const running = await startExecution(
      fixture,
      frozen.executionId,
      'first-batch-session',
    );
    fixture.executions.complete(fixture.runner.id, running.executionId, {
      leaseToken: running.leaseToken,
      sessionId: running.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: failedUpdate('等待负责人处理冲突'),
      },
    });
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
    fixture.executions.complete(fixture.runner.id, resumed.executionId, {
      leaseToken: resumed.leaseToken,
      sessionId: resumed.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: completedUpdate('首批完成'),
      },
    });
    expect(fixture.updates.prepareDueExecutions()).toHaveLength(1);
    const secondBatch = latestBatch(fixture.database, fixture.item.id);
    expect(secondBatch.id).not.toBe(firstBatch.id);
    expect(batchEntries(fixture.database, secondBatch.id)).toEqual([
      { bug_id: later.id, commits: ['bbbbbbb'] },
    ]);
  });

  test('Lease 恢复保持冻结 Batch 和 Session，不重复创建 Attempt', async () => {
    const fixture = await setup();
    fixture.createBug('Lease 恢复候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const first = await startExecution(
      fixture,
      frozen.executionId,
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
      fixture.database
        .prepare(
          'SELECT COUNT(*) count FROM cooking_update_attempt WHERE batch_id = ?',
        )
        .get(latestBatch(fixture.database, fixture.item.id).id),
    ).toEqual({ count: 1 });
  });

  test('非法 Update Result 可幂等重放且 Batch 保持失败', async () => {
    const fixture = await setup();
    fixture.createBug('非法结果候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const running = await startExecution(
      fixture,
      frozen.executionId,
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
    fixture.createBug('质量门失败候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const running = await startExecution(
      fixture,
      frozen.executionId,
      'failed-update-session',
    );
    fixture.executions.complete(fixture.runner.id, running.executionId, {
      leaseToken: running.leaseToken,
      sessionId: running.sessionId,
      outcome: {
        kind: 'SUCCEEDED',
        result: {
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
        },
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
    const bug = fixture.createBug('事务回滚候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const running = await startExecution(
      fixture,
      frozen.executionId,
      'rollback-update-session',
    );
    const beforeBatch = latestBatch(fixture.database, fixture.item.id);
    const beforeBug = currentBug(fixture.database, bug.id);

    expect(() =>
      fixture.executions.complete(fixture.runner.id, running.executionId, {
        leaseToken: running.leaseToken,
        sessionId: running.sessionId,
        outcome: {
          kind: 'SUCCEEDED',
          result: completedUpdate('应整体回滚'),
        },
      }),
    ).toThrow();
    expect(fixture.executions.get(running.executionId).state).toBe('RUNNING');
    expect(latestBatch(fixture.database, fixture.item.id)).toEqual(beforeBatch);
    expect(currentBug(fixture.database, bug.id)).toEqual(beforeBug);
    expect(pendingCommits(fixture.database, bug.id)).toEqual(['aaaaaaa']);
  });

  test('负责人可处理 Update Interaction，Tester 只能看到安全等待状态', async () => {
    const fixture = await setup();
    fixture.createBug('需要审批的候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );
    const running = await startExecution(
      fixture,
      frozen.executionId,
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
      fixture.database
        .prepare(
          'SELECT state FROM platform_execution_interaction WHERE id = ?',
        )
        .get(interaction.id),
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

  test('协议级 Agent 按冻结顺序完成 LOCAL_SCRIPT Update Outcome', async () => {
    const fixture = await setup();
    const commits = ['a'.repeat(40), 'b'.repeat(40)];
    fixture.createBug('第一个真实候选');
    await completeNextRepair(fixture, 'repair-one', [commits[0]!]);
    fixture.createBug('第二个真实候选');
    await completeNextRepair(fixture, 'repair-two', [commits[1]!]);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );

    const agent = new ProtocolAgent({
      serverUrl: 'http://update.test',
      fetch: updateProtocolFetch(fixture),
      credential: fixture.pairedRunner.credential,
    });
    let claimedCommits: string[] = [];
    const completed = await agent.runNext(
      async (execution) => {
        if (execution.codexTurn?.kind !== 'INITIAL')
          throw new Error('需要首次 Update Turn');
        const candidates = execution.codexTurn.executionBrief
          .frozenCandidates as Array<{ commits: string[] }>;
        claimedCommits = candidates.flatMap((candidate) => candidate.commits);
        return {
          kind: 'SUCCEEDED',
          result: completedUpdate('普通 Push 和本地脚本完成'),
        };
      },
      { sessionId: () => 'update-conformance-session' },
    );

    expect(completed?.id).toBe(frozen.executionId);
    expect(claimedCommits).toEqual(commits);
    expect(latestBatch(fixture.database, fixture.item.id).state).toBe(
      'COMPLETED',
    );
  });
});

test('统一装配只向 Update 投影更新会话同步，保留原失败尝试', async () => {
  const fixture = await setup();
  const { users, updates, executions, runner, item, database } = fixture;
  fixture.createBug('平台外完成更新');
  await completeNextRepair(fixture, 'repair-before-sync', ['aaaaaaa']);
  const frozen = updates.freezeNow(users.developer.id, item.id, {
    mutationId: randomUUID(),
  });
  const started = await startExecution(
    fixture,
    frozen.executionId,
    'update-to-sync',
  );
  executions.complete(runner.id, started.executionId, {
    leaseToken: started.leaseToken,
    sessionId: started.sessionId,
    outcome: { kind: 'SUCCEEDED', result: failedUpdate('部署失败') },
  });
  const batch = latestBatch(database, item.id);
  const sync = updates.synchronizeSession(
    users.developer.id,
    batch.id,
    mutation(batch.version),
  );
  const [claimed] = await executions.claim(runner.id, 1, 0);
  expect(claimed?.id).toBe(sync.executionId);
  expect(claimed?.codexTurn?.kind).toBe('READ_SESSION');
  executions.start(runner.id, claimed!.id, {
    kind: 'STARTED',
    leaseToken: claimed!.lease.token,
    sessionId: started.sessionId,
  });
  const synchronized = executions.complete(runner.id, claimed!.id, {
    leaseToken: claimed!.lease.token,
    sessionId: started.sessionId,
    outcome: {
      kind: 'SUCCEEDED',
      result: {
        turnId: 'external-update-turn',
        result: completedUpdate('外部更新已完成'),
      },
    },
  });
  expect(synchronized.state).toBe('SUCCEEDED');
  expect(latestBatch(database, item.id).state).toBe('COMPLETED');
  const attempts = updates
    .batchView(users.developer.id, batch.id)
    .timeline.filter((entry) => entry.kind === 'UPDATE_ATTEMPT');
  expect(attempts.map((attempt) => attempt.result?.outcome)).toEqual([
    'FAILED',
    'COMPLETED',
  ]);
});

function completedUpdate(_summary: string) {
  return {
    result: {
      outcome: 'COMPLETED' as const,
      completedActions: ['集成候选并完成部署'],
      validations: [
        { name: '定向检查', status: 'PASSED' as const, detail: '' },
      ],
      warnings: [],
    },
  };
}

function pushedUpdate(_summary: string) {
  return {
    result: {
      outcome: 'PUSHED' as const,
      completedActions: ['集成候选并普通 Push'],
      validations: [
        { name: '定向检查', status: 'PASSED' as const, detail: '' },
      ],
      warnings: [],
    },
  };
}

function failedUpdate(summary: string) {
  return {
    result: {
      outcome: 'FAILED' as const,
      failedStep: '执行统一更新',
      reason: summary,
      completedActions: [],
      validations: [],
      warnings: [],
      pendingActions: ['修正失败原因后重新执行'],
    },
  };
}

async function completeNextRepair(
  fixture: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
  commits: string[],
  manualOperations: Array<{ kind: 'DATABASE_SQL'; paths: string[] }> = [],
): Promise<void> {
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  fixture.executions.start(fixture.runner.id, claimed.id, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId,
    taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
  });
  fixture.executions.complete(fixture.runner.id, claimed.id, {
    leaseToken: claimed.lease.token,
    sessionId,
    outcome: {
      kind: 'SUCCEEDED',
      result: {
        result: {
          outcome: 'COMPLETED',
          completionKind: 'CHANGES_COMMITTED',
          changes: ['完成缺陷修复'],
          validations: [{ name: '定向测试', status: 'PASSED', detail: '' }],
          warnings: [],
          commits,
          manualOperations,
        },
      },
    },
  });
}

function testSkillBinding(skillName: string) {
  return {
    skillName,
    bundleHash: 'a'.repeat(64),
    sourceRevision: 'b'.repeat(40),
  };
}

async function startExecution(
  fixture: Awaited<ReturnType<typeof setup>>,
  executionId: string,
  sessionId: string,
) {
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  expect(claimed.id).toBe(executionId);
  fixture.executions.start(fixture.runner.id, executionId, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId,
    taskSkillBinding: testSkillBinding(
      'agent-party-time-integrate-update-batch',
    ),
  });
  return {
    executionId,
    leaseToken: claimed.lease.token,
    sessionId,
  };
}

function pending(database: AppDatabase, submissionItemId: string) {
  return database
    .prepare(
      `SELECT last_candidate_at, eligible_at FROM cooking_pending_delivery
       WHERE submission_item_id = ?`,
    )
    .get(submissionItemId) as
    { last_candidate_at: string; eligible_at: string } | undefined;
}

function latestBatch(database: AppDatabase, submissionItemId: string) {
  return database
    .prepare(
      `SELECT id, state, version, active_execution_id
       FROM cooking_update_batch WHERE submission_item_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(submissionItemId) as {
    id: string;
    state: string;
    version: number;
    active_execution_id: string | null;
  };
}

function batchEntries(database: AppDatabase, batchId: string) {
  return (
    database
      .prepare(
        `SELECT bug_id, commits_json FROM cooking_update_batch_entry
         WHERE batch_id = ? ORDER BY position`,
      )
      .all(batchId) as Array<{ bug_id: string; commits_json: string }>
  ).map((row) => ({
    bug_id: row.bug_id,
    commits: JSON.parse(row.commits_json),
  }));
}

function currentBug(database: AppDatabase, bugId: string) {
  return database
    .prepare('SELECT stage, version FROM cooking_bug WHERE id = ?')
    .get(bugId) as { stage: string; version: number };
}

function pendingCommits(database: AppDatabase, bugId: string): string[] {
  const row = database
    .prepare(
      'SELECT pending_commits_json FROM cooking_bug_repair_context WHERE bug_id = ?',
    )
    .get(bugId) as { pending_commits_json: string };
  return JSON.parse(row.pending_commits_json) as string[];
}

function updateProtocolFetch(
  fixture: Awaited<ReturnType<typeof setup>>,
): typeof fetch {
  return async (inputValue, init) => {
    const request =
      inputValue instanceof Request
        ? inputValue
        : new Request(String(inputValue), init);
    const path = new URL(request.url).pathname;
    if (path === '/api/runner/heartbeat')
      return handleRunnerHeartbeat(request, fixture.runners);
    if (path === '/api/runner/executions/claim')
      return handleExecutionClaim(request, fixture.runners, fixture.executions);
    const match = /^\/api\/runner\/executions\/([^/]+)\/([^/]+)$/u.exec(path);
    if (match?.[2] === 'start')
      return handleExecutionStart(
        request,
        match[1]!,
        fixture.runners,
        fixture.executions,
      );
    if (match?.[2] === 'complete')
      return handleExecutionComplete(
        request,
        match[1]!,
        fixture.runners,
        fixture.executions,
      );
    return Response.json(
      { error: { code: 'NOT_FOUND', message: '未找到' } },
      { status: 404 },
    );
  };
}

describe('更新遵守环境使用权', () => {
  test('暂停后不自动冻结也不能手动更新，重新取得环境后恢复；活动更新阻止切换', async () => {
    const fixture = await setup();
    fixture.createBug('切换期间保留候选');
    await completeNextRepair(fixture, 'environment-repair', ['aaaaaaa']);
    const submissions = new SubmissionService(
      fixture.database,
      fixture.clock.now,
    );
    const view = submissions.getWorkspace(
      fixture.users.owner.id,
      fixture.submission.id,
    );
    const originalItem = view.submission.items[0]!;
    const input = {
      mutationId: randomUUID(),
      title: '插队提测',
      requirementDescription: '切换环境',
      testerUserId: fixture.users.tester.id,
      items: [
        {
          engineeringId: originalItem.engineering.id,
          responsibleUserId: fixture.users.developer.id,
          bindingId: fixture.binding.id,
          targetBranch: 'main',
          environmentId: originalItem.environment.id,
        },
      ],
    };
    const conflicts = submissions.environmentConflicts(
      fixture.users.owner.id,
      view.submission.submission.projectId,
      input,
    );
    const next = submissions.createSubmission(
      fixture.users.owner.id,
      view.submission.submission.projectId,
      { ...input, environmentTakeovers: conflicts },
    );
    fixture.clock.set('2026-07-27T10:03:00.000Z');
    expect(fixture.updates.prepareDueExecutions()).toEqual([]);
    expect(pending(fixture.database, fixture.item.id)).not.toBeNull();
    expect(
      fixture.updates.workspace(
        fixture.users.developer.id,
        fixture.submission.id,
      ).pendingDeliveries[0]!.availableActions,
    ).toEqual([]);
    expect(() =>
      fixture.updates.freezeNow(fixture.users.developer.id, fixture.item.id, {
        mutationId: randomUUID(),
      }),
    ).toThrow('已暂停使用环境');
    const paused = submissions.getWorkspace(
      fixture.users.owner.id,
      fixture.submission.id,
    );
    submissions.changeEnvironment(fixture.users.owner.id, originalItem.id, {
      mutationId: randomUUID(),
      expectedRevision: paused.revision,
      action: 'ACQUIRE',
      takeover: paused.submission.items[0]!.environmentAccess.conflict!,
    });
    expect(fixture.updates.prepareDueExecutions()).toHaveLength(1);
    const nextView = submissions.getWorkspace(fixture.users.owner.id, next.id);
    const nextItem = nextView.submission.items[0]!;
    expect(nextItem.environmentAccess.conflict!.blockedReason).toContain(
      '正在更新',
    );
    expect(() =>
      submissions.changeEnvironment(fixture.users.owner.id, nextItem.id, {
        mutationId: randomUUID(),
        expectedRevision: nextView.revision,
        action: 'ACQUIRE',
        takeover: nextItem.environmentAccess.conflict!,
      }),
    ).toThrow('正在更新');
    expect(
      submissions.getWorkspace(fixture.users.owner.id, fixture.submission.id)
        .submission.items[0]!.environmentAccess.owned,
    ).toBe(true);
  });
});

test('外部部署等待期间禁止切换；失败后允许切换但原批次不能重试或同步', async () => {
  const fixture = await setup({ deploymentKind: 'CI_CD' });
  fixture.createBug('外部部署占用');
  await completeNextRepair(fixture, 'external-lock-repair', ['ccccccc']);
  const frozen = fixture.updates.freezeNow(
    fixture.users.developer.id,
    fixture.item.id,
    { mutationId: randomUUID() },
  );
  const running = await startExecution(
    fixture,
    frozen.executionId,
    'external-lock-update',
  );
  fixture.executions.complete(fixture.runner.id, running.executionId, {
    leaseToken: running.leaseToken,
    sessionId: running.sessionId,
    outcome: { kind: 'SUCCEEDED', result: pushedUpdate('等待外部部署') },
  });
  const submissions = new SubmissionService(
    fixture.database,
    fixture.clock.now,
  );
  const original = submissions.getWorkspace(
    fixture.users.owner.id,
    fixture.submission.id,
  );
  const item = original.submission.items[0]!;
  const input = {
    mutationId: randomUUID(),
    title: '等待环境',
    requirementDescription: '验证外部部署保护',
    testerUserId: fixture.users.tester.id,
    items: [
      {
        engineeringId: item.engineering.id,
        responsibleUserId: item.responsibleUser.id,
        bindingId: fixture.binding.id,
        targetBranch: item.targetBranch,
        environmentId: item.environment.id,
      },
    ],
  };
  const projectId = original.submission.submission.projectId;
  const blocked = submissions.environmentConflicts(
    fixture.users.owner.id,
    projectId,
    input,
  );
  expect(blocked[0]!.blockedReason).toContain('等待部署结果');
  expect(() =>
    submissions.createSubmission(fixture.users.owner.id, projectId, {
      ...input,
      environmentTakeovers: blocked,
    }),
  ).toThrow('等待部署结果');
  const waiting = latestBatch(fixture.database, fixture.item.id);
  fixture.updates.reportExternalDeployment(
    fixture.users.developer.id,
    waiting.id,
    {
      mutationId: randomUUID(),
      expectedVersion: waiting.version,
      outcome: 'FAILED',
      summary: '外部部署已经失败并结束',
      attachmentIds: [],
    },
  );
  const available = submissions.environmentConflicts(
    fixture.users.owner.id,
    projectId,
    input,
  );
  expect(available[0]!.blockedReason).toBeNull();
  submissions.createSubmission(fixture.users.owner.id, projectId, {
    ...input,
    environmentTakeovers: available,
  });
  const batch = latestBatch(fixture.database, fixture.item.id);
  expect(() =>
    fixture.updates.retryUpdate(fixture.users.developer.id, batch.id, {
      mutationId: randomUUID(),
      expectedVersion: batch.version,
    }),
  ).toThrow('已暂停使用环境');
  expect(() =>
    fixture.updates.synchronizeSession(fixture.users.developer.id, batch.id, {
      mutationId: randomUUID(),
      expectedVersion: batch.version,
    }),
  ).toThrow('已暂停使用环境');
  expect(
    fixture.updates.batchView(fixture.users.developer.id, batch.id)
      .availableActions,
  ).toEqual([]);
});
