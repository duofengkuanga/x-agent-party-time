import { mutation } from '@/cooking/testing/project';
import { completeSuccessfulExecution } from '@/cooking/testing/execution';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  currentBug,
  repairFixture,
  repairProtocolFetch,
  startLatest,
} from './repair-fixture';

const setup = repairFixture(testDatabases());

describe('RepairService', () => {
  test('Schema 非法或重复 Commit 时 Execution FAILED 且 Bug 保持修复中', async () => {
    const committed = {
      outcome: 'COMPLETED',
      completionKind: 'CHANGES_COMMITTED',
      summary: '重复提交',
      changes: ['修改'],
      validations: [],
      warnings: [],
      commits: ['aaaaaaa'],
      manualOperations: [],
    };
    const alreadyFixed = {
      outcome: 'COMPLETED',
      completionKind: 'TARGET_ALREADY_FIXED',
      summary: '仍有改动',
      changes: [],
      validations: [{ name: '目标分支检查', status: 'PASSED' }],
      warnings: [],
      commits: [],
      manualOperations: [],
    };
    const invalidResults = [
      { ...committed, commits: ['aaaaaaa', 'aaaaaaa'] },
      { ...committed, summary: '伪造字段', pushed: true },
      {
        ...committed,
        summary: '成功结果误填失败字段',
        failedStep: null,
        reason: null,
        completedActions: ['完成本地提交'],
        pendingActions: [],
      },
      { ...alreadyFixed, changes: ['修改'] },
      { ...alreadyFixed, summary: '未经验证', validations: [] },
      {
        ...alreadyFixed,
        summary: '验证失败',
        validations: [{ name: '目标分支检查', status: 'FAILED' }],
      },
      { outcome: 'UNKNOWN', summary: '非法状态', commits: ['aaaaaaa'] },
    ];
    for (const result of invalidResults) {
      const fixture = await setup();
      const started = await startLatest(fixture, randomUUID());
      const completion = {
        leaseToken: started.leaseToken,
        sessionId: started.sessionId,
        outcome: { kind: 'SUCCEEDED' as const, result },
      };
      const completed = fixture.executions.complete(
        fixture.runner.id,
        started.executionId,
        completion,
      );
      expect(completed.state).toBe('FAILED');
      expect(
        fixture.executions.complete(
          fixture.runner.id,
          started.executionId,
          completion,
        ).state,
      ).toBe('FAILED');
      expect(currentBug(fixture.database, fixture.requested.bug.id).stage).toBe(
        'REPAIRING',
      );
      const tester = fixture.repairs.repairView(
        fixture.users.tester.id,
        fixture.requested.bug.id,
      )!;
      const developer = fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )!;
      const testerAttempt = tester.timeline.at(-1);
      const developerAttempt = developer.timeline.at(-1);
      expect(testerAttempt?.kind).toBe('REPAIR_ATTEMPT');
      expect(developerAttempt?.kind).toBe('REPAIR_ATTEMPT');
      if (
        testerAttempt?.kind !== 'REPAIR_ATTEMPT' ||
        developerAttempt?.kind !== 'REPAIR_ATTEMPT'
      )
        throw new Error('缺少修复时间线节点');
      expect(testerAttempt.result).toMatchObject({
        outcome: 'FAILED',
        failedStep: '结构化结果校验',
        reason: '自动修复执行未完成，工程负责人可查看详细原因。',
        failureCode: null,
      });
      expect(developerAttempt.result).toMatchObject({
        outcome: 'FAILED',
        failureCode: 'RESULT_SCHEMA_INVALID',
      });
      if ('completedActions' in result)
        expect(developerAttempt.result.reason).toContain('completedActions');
    }
  });

  test('Execution Outcome 业务解释失败时整笔事务回滚', async () => {
    const duplicateAuditId = '00000000-0000-4000-8000-000000000008';
    const fixture = await setup({
      repairCreateId: () => duplicateAuditId,
    });
    const started = await startLatest(fixture, 'rollback-session');
    const before = currentBug(fixture.database, fixture.requested.bug.id);
    const beforeRevision = fixture.database.get(
      'SELECT workspace_revision FROM cooking_test_submission WHERE id = ?',
      fixture.submission.id,
    );

    expect(() =>
      completeSuccessfulExecution(fixture, started, {
        result: {
          outcome: 'COMPLETED',
          completionKind: 'CHANGES_COMMITTED',
          changes: ['修改支付按钮'],
          validations: [],
          warnings: [],
          commits: ['ddddddd'],
          manualOperations: [],
        },
      }),
    ).toThrow();

    expect(fixture.executions.get(started.executionId).state).toBe('RUNNING');
    expect(currentBug(fixture.database, fixture.requested.bug.id)).toEqual(
      before,
    );
    expect(
      fixture.database.get(
        'SELECT workspace_revision FROM cooking_test_submission WHERE id = ?',
        fixture.submission.id,
      ),
    ).toEqual(beforeRevision);
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.pendingCommits,
    ).toEqual([]);
  });

  test('Interaction 仅负责人可查看详情并响应', async () => {
    const fixture = await setup();
    const started = await startLatest(fixture, 'interaction-session');
    const interaction = fixture.executions.openInteraction(
      fixture.runner.id,
      started.executionId,
      {
        leaseToken: started.leaseToken,
        kind: 'APPROVAL',
        method: 'item/commandExecution/requestApproval',
        payload: {
          cwd: '/Users/example/private-repository',
          command: 'cat /Users/example/private-repository/secret.txt',
          reason: '验证修复',
        },
      },
    );
    const testerRepair = fixture.repairs.repairView(
      fixture.users.tester.id,
      fixture.requested.bug.id,
    )!;
    const developerRepair = fixture.repairs.repairView(
      fixture.users.developer.id,
      fixture.requested.bug.id,
    )!;
    const testerView = testerRepair.timeline
      .find((node) => node.kind === 'REPAIR_ATTEMPT')!
      .interactions.at(-1)!;
    const developerView = developerRepair.timeline
      .find((node) => node.kind === 'REPAIR_ATTEMPT')!
      .interactions.at(-1)!;
    expect(testerView).toMatchObject({
      kind: 'APPROVAL',
      request: null,
      canResolve: false,
    });
    expect(developerView).toMatchObject({
      kind: 'APPROVAL',
      request: {
        type: 'COMMAND',
        command: 'cat 本机路径已隐藏',
        purpose: '验证修复',
      },
      canResolve: true,
    });
    expect(testerRepair.presentation.visual).toEqual({
      state: 'NEEDS_APPROVAL',
      label: '等待工程负责人审批',
      symbol: '!',
    });
    expect(developerRepair.presentation.visual).toEqual({
      state: 'NEEDS_APPROVAL',
      label: '需要你审批',
      symbol: '!',
    });
    expect(
      testerRepair.timeline.find((node) => node.kind === 'REPAIR_ATTEMPT'),
    ).toMatchObject({
      sessionId: null,
    });
    expect(
      developerRepair.timeline.find((node) => node.kind === 'REPAIR_ATTEMPT'),
    ).toMatchObject({
      sessionId: 'interaction-session',
    });
    expect(JSON.stringify(developerView)).not.toContain('/Users/example');
    expect(() =>
      fixture.repairs.resolveInteraction(
        fixture.users.developer.id,
        interaction.id,
        {
          ...mutation(1),
          resolution: { decision: 'accept' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    expect(() =>
      fixture.repairs.resolveInteraction(
        fixture.users.owner.id,
        interaction.id,
        {
          ...mutation(2),
          resolution: { decision: 'decline' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const resolved = fixture.repairs.resolveInteraction(
      fixture.users.developer.id,
      interaction.id,
      {
        ...mutation(2),
        resolution: { decision: 'acceptForSession' },
      },
    );
    expect(resolved.bugVersion).toBe(3);
    expect(
      fixture.database.get(
        'SELECT state FROM platform_execution_interaction WHERE id = ?',
        interaction.id,
      ),
    ).toEqual({ state: 'RESOLVED' });
    expect(
      fixture.repairs
        .repairView(fixture.users.developer.id, fixture.requested.bug.id)!
        .timeline.find((node) => node.kind === 'REPAIR_ATTEMPT')
        ?.interactions.at(-1),
    ).toMatchObject({
      state: 'RESOLVED',
      resolution: 'ACCEPTED_FOR_SESSION',
      canResolve: false,
    });
    const eventsBeforeResume = fixture.events.length;
    const revisionBeforeResume = fixture.events.at(-1)!.revision;
    const waited = await fixture.executions.waitInteraction(
      fixture.runner.id,
      started.executionId,
      interaction.id,
      started.leaseToken,
      0,
    );
    expect(waited).toMatchObject({ laneAcquired: true });
    expect(fixture.executions.get(started.executionId).state).toBe('RUNNING');
    expect(fixture.events).toHaveLength(eventsBeforeResume + 1);
    expect(fixture.events.at(-1)).toEqual({
      submissionId: fixture.submission.id,
      revision: revisionBeforeResume + 1,
    });
    await fixture.executions.waitInteraction(
      fixture.runner.id,
      started.executionId,
      interaction.id,
      started.leaseToken,
      0,
    );
    expect(fixture.events).toHaveLength(eventsBeforeResume + 1);
    expect(() =>
      fixture.repairs.resolveInteraction(
        fixture.users.developer.id,
        interaction.id,
        {
          ...mutation(3),
          resolution: { decision: 'accept' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
  });
});

test('协议领取回收取消中的过期租约时同步结束 Repair Attempt', async () => {
  const fixture = await setup();
  const started = await startLatest(fixture, 'cancelled-session');
  fixture.executions.requestCancellation(started.executionId);
  fixture.database.run(
    'UPDATE platform_execution SET lease_expires_at = ? WHERE id = ?',
    ['2026-07-27T09:59:00.000Z', started.executionId],
  );
  const response = await repairProtocolFetch(fixture)(
    'http://repair.test/api/runner/executions/claim',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixture.pairedRunner.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ availableSlots: 1, waitMs: 0 }),
    },
  );
  expect(response.status).toBe(200);
  expect(fixture.executions.get(started.executionId).state).toBe('CANCELLED');
  expect(
    fixture.repairs
      .repairView(fixture.users.developer.id, fixture.requested.bug.id)
      ?.timeline.at(-1),
  ).toMatchObject({
    kind: 'REPAIR_ATTEMPT',
    result: { outcome: 'FAILED', failureCode: 'CANCELLED' },
  });
});
