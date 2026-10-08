import { mutation } from '@/cooking/testing/project';
import { completeSuccessfulExecution } from '@/cooking/testing/execution';
import { SubmissionService } from '@/cooking/submissions/server/submission-service';
import { CookingWorkspaceService } from '@/cooking/workspace/server/workspace-service';
import { AuthService } from '@/platform/auth/service';
import { handleExecutionClaim } from '@/platform/execution/http';
import { ExecutionService } from '@/platform/execution/service';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { UpdateService } from './update-service';
import {
  batchEntries,
  completeNextRepair,
  completedUpdate,
  currentBug,
  freezeUpdate,
  latestBatch,
  pending,
  startCandidateUpdate,
  updateFixture,
} from './update-fixture';

const setup = updateFixture(testDatabases());

describe('UpdateService', () => {
  test('冻结 Repair 候选中的数据库人工操作并向工作台暴露标识', async () => {
    const fixture = await setup();
    const { started } = await startCandidateUpdate(
      fixture,
      '需要数据库脚本的更新',
      'repair-with-sql',
      ['aaaaaaa'],
      'update-with-sql',
      [{ kind: 'DATABASE_SQL', paths: ['sql/add-payment-index.sql'] }],
    );
    completeSuccessfulExecution(
      fixture,
      started,
      completedUpdate('统一更新完成，SQL 交由人工执行'),
    );

    const batch = latestBatch(fixture.database, fixture.item.id);
    expect(
      fixture.updates.batchView(fixture.users.developer.id, batch.id)
        .hasManualDatabaseOperation,
    ).toBe(true);
  });

  test('候选未声明人工数据库操作时不展示标识', async () => {
    const fixture = await setup();
    const { started } = await startCandidateUpdate(
      fixture,
      '未收集变更文件的更新',
      'repair-without-changes',
      ['aaaaaaa'],
      'update-without-changes',
    );
    completeSuccessfulExecution(
      fixture,
      started,
      completedUpdate('统一更新完成'),
    );

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
        ...mutation(currentBug(fixture.database, second.id).version),
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
      fixture.database.get(
        'SELECT COUNT(*) count FROM cooking_update_batch WHERE submission_id = ?',
        fixture.submission.id,
      ),
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
    const first = freezeUpdate(fixture);
    const second = freezeUpdate(fixture, fixture.secondItem!.id);
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
    const frozen = freezeUpdate(fixture);
    const nextBug = fixture.createBug('后续普通修复');
    const claimed = (
      await fixture.executions.claim(fixture.runner.id, 1, 0)
    )[0]!;
    expect(claimed.id).toBe(frozen.executionId);
    expect(claimed.priority).toBe(0);
    expect(currentBug(fixture.database, first.id).stage).toBe('UPDATING');
    expect(currentBug(fixture.database, nextBug.id).stage).toBe('REPAIRING');
  });
});
