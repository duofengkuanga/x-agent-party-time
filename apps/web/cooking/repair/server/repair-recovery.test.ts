import { mutation } from '@/cooking/testing/project';
import {
  completeClaimedExecution,
  testSkillBinding,
} from '@/cooking/testing/execution';
import { testDatabases } from '@/testing/database';
import type { ClaimedExecution } from '@agent-party-time/execution-contract';
import { ProtocolAgent } from '@agent-party-time/runner-conformance';
import { describe, expect, test } from 'bun:test';
import {
  currentBug,
  repairFixture,
  repairProtocolFetch,
  requestSyncAfterFailure,
  startLatest,
} from './repair-fixture';

const setup = repairFixture(testDatabases());

describe('RepairService', () => {
  test('协议级 Agent 完成失败后无输入重新执行链路', async () => {
    const fixture = await setup();
    const agent = new ProtocolAgent({
      serverUrl: 'http://repair.test',
      fetch: repairProtocolFetch(fixture),
      credential: fixture.pairedRunner.credential,
    });
    const claimed: ClaimedExecution[] = [];

    await agent.runNext(
      async (execution) => {
        claimed.push(execution);
        return {
          kind: 'SUCCEEDED',
          result: {
            result: {
              outcome: 'FAILED',
              failedStep: '定向测试',
              reason: '仍有一项回归测试失败',
              completedActions: ['定位失败测试'],
              pendingActions: ['修复回归并重新验证'],
            },
          },
        };
      },
      { sessionId: () => 'repair-conformance-session' },
    );
    expect(
      currentBug(fixture.database, fixture.requested.bug.id),
    ).toMatchObject({ stage: 'REPAIRING', version: 3 });

    const continued = fixture.repairs.continueRepair(
      fixture.users.developer.id,
      fixture.requested.bug.id,
      {
        ...mutation(3),
      },
    );
    await agent.runNext(
      async (execution) => {
        claimed.push(execution);
        return {
          kind: 'SUCCEEDED',
          result: {
            result: {
              outcome: 'COMPLETED',
              completionKind: 'CHANGES_COMMITTED',
              changes: ['完成第二次修复'],
              validations: [{ name: '定向检查', status: 'PASSED', detail: '' }],
              warnings: [],
              commits: ['abcdef1'],
              manualOperations: [],
            },
          },
        };
      },
      { sessionId: () => 'repair-conformance-session' },
    );

    expect(claimed).toHaveLength(2);
    expect(claimed[0]?.codexTurn?.kind).toBe('INITIAL');
    expect(claimed[1]).toMatchObject({
      id: continued.executionId,
      codexTurn: {
        kind: 'CONTINUATION',
        taskId: 'repair-conformance-session',
      },
    });
    expect(claimed[1]?.codexTurn?.kind).toBe('CONTINUATION');
    if (claimed[1]?.codexTurn?.kind !== 'CONTINUATION')
      throw new Error('需要继续 Turn');
    expect(claimed[1].codexTurn.input).toBe('继续完成上次未完成的任务。');
    expect(claimed[1].codexTurn.input).not.toContain('点击后没有反应');
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.pendingCommits,
    ).toEqual(['abcdef1']);
  });

  test('同步状态把手动 Session 的有效结果追加为新 Repair 尝试', async () => {
    const fixture = await setup();
    const { started, synced, claimed } = await requestSyncAfterFailure(fixture);
    expect(claimed).toMatchObject({
      previousExecutionId: started.executionId,
      codexTurn: {
        kind: 'READ_SESSION',
        resultAssertions: [
          { kind: 'GIT_COMMITS_CREATED', resultPath: ['result', 'commits'] },
        ],
      },
      workspace: {
        key: `bug-repair:${fixture.requested.bug.id}`,
        isolation: 'BRANCH_WORKTREE',
      },
    });
    fixture.executions.start(fixture.runner.id, claimed.id, {
      kind: 'STARTED',
      leaseToken: claimed.lease.token,
      sessionId: 'manual-repair-session',
      taskSkillBinding: null,
    });
    fixture.executions.complete(fixture.runner.id, claimed.id, {
      leaseToken: claimed.lease.token,
      sessionId: 'manual-repair-session',
      outcome: {
        kind: 'SUCCEEDED',
        result: {
          turnId: 'manual-turn-1',
          result: {
            result: {
              outcome: 'COMPLETED',
              completionKind: 'CHANGES_COMMITTED',
              changes: ['修复支付'],
              validations: [{ name: '测试', status: 'PASSED', detail: '' }],
              warnings: [],
              commits: ['ccccccc'],
              manualOperations: [],
            },
          },
        },
      },
    });
    expect(synced.executionId).toBe(claimed.id);
    expect(currentBug(fixture.database, fixture.requested.bug.id).stage).toBe(
      'WAITING_FOR_UPDATE',
    );
    expect(
      fixture.repairs
        .repairView(fixture.users.developer.id, fixture.requested.bug.id)
        ?.timeline.filter((node) => node.kind === 'REPAIR_ATTEMPT'),
    ).toHaveLength(2);
  });

  test('同步无法确认最新 Turn 时只向负责人显示可操作错误', async () => {
    const fixture = await setup();
    const { synced, claimed } = await requestSyncAfterFailure(fixture);
    fixture.executions.start(fixture.runner.id, claimed.id, {
      kind: 'START_FAILED',
      leaseToken: claimed.lease.token,
      failure: {
        code: 'CODEX_EXECUTION_FAILED',
        message: 'Codex 会话的最新一轮尚未完成或暂无法确认，请完成后再同步',
        retryable: true,
      },
    });

    expect(synced.executionId).toBe(claimed.id);
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.synchronizationError,
    ).toBe('Codex 会话的最新一轮尚未完成或暂无法确认，请完成后再同步');
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.synchronizationCorrection,
    ).toBeNull();
    expect(
      fixture.repairs.repairView(
        fixture.users.tester.id,
        fixture.requested.bug.id,
      )?.synchronizationError,
    ).toBeNull();
    expect(
      fixture.repairs
        .repairView(fixture.users.developer.id, fixture.requested.bug.id)
        ?.timeline.filter((node) => node.kind === 'REPAIR_ATTEMPT'),
    ).toHaveLength(1);

    fixture.repairs.synchronizeSession(
      fixture.users.developer.id,
      fixture.requested.bug.id,
      {
        ...mutation(
          currentBug(fixture.database, fixture.requested.bug.id).version,
        ),
      },
    );
    const [schemaClaim] = await fixture.executions.claim(
      fixture.runner.id,
      1,
      0,
    );
    if (!schemaClaim) throw new Error('缺少 Schema 同步 Execution');
    fixture.executions.start(fixture.runner.id, schemaClaim.id, {
      kind: 'START_FAILED',
      leaseToken: schemaClaim.lease.token,
      failure: {
        code: 'CODEX_EXECUTION_FAILED',
        message: 'Codex 会话的最新轮次不符合原任务结果约束',
        retryable: true,
      },
    });
    const correction = fixture.repairs.repairView(
      fixture.users.developer.id,
      fixture.requested.bug.id,
    )?.synchronizationCorrection;
    expect(correction?.instruction).toContain('原 Codex 会话');
    expect(correction?.schema).toContain('"result"');
    expect(
      fixture.repairs.repairView(
        fixture.users.tester.id,
        fixture.requested.bug.id,
      )?.synchronizationCorrection,
    ).toBeNull();
  });

  test('Execution 失败使用真实 code/message 且仅向工程负责人投影技术码', async () => {
    const fixture = await setup();
    const started = await startLatest(fixture, 'failed-session');
    const failureSummary =
      'Codex 请求过多：429 Too Many Requests，已超过重试次数。';
    completeClaimedExecution(fixture, started, {
      kind: 'FAILED',
      failure: {
        code: 'CODEX_EXECUTION_FAILED',
        message: failureSummary,
        retryable: true,
      },
    });
    const testerAttempt = fixture.repairs
      .repairView(fixture.users.tester.id, fixture.requested.bug.id)!
      .timeline.at(-1);
    const developerAttempt = fixture.repairs
      .repairView(fixture.users.developer.id, fixture.requested.bug.id)!
      .timeline.at(-1);
    expect(testerAttempt).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'FAILED',
        failedStep: '修复执行',
        reason: '自动修复执行未完成，工程负责人可查看详细原因。',
        failureCode: null,
      },
    });
    expect(developerAttempt).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'FAILED',
        reason: failureSummary,
        failureCode: 'CODEX_EXECUTION_FAILED',
      },
    });
  });

  test('启动失败使用更新后的 Execution 向 Repair 投影真实失败信息', async () => {
    const fixture = await setup();
    const claim = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;

    const failed = fixture.executions.start(fixture.runner.id, claim.id, {
      kind: 'START_FAILED',
      leaseToken: claim.lease.token,
      failure: {
        code: 'CODEX_START_FAILED',
        message: 'Agent 重启后原生 Codex Interaction Turn 已不可恢复',
        retryable: true,
      },
    });

    expect(failed).toMatchObject({
      state: 'FAILED',
      outcome: {
        kind: 'FAILED',
        failure: {
          code: 'CODEX_START_FAILED',
          message: 'Agent 重启后原生 Codex Interaction Turn 已不可恢复',
        },
      },
    });
    expect(
      fixture.repairs
        .repairView(fixture.users.developer.id, fixture.requested.bug.id)!
        .timeline.at(-1),
    ).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'FAILED',
        reason: 'Agent 重启后原生 Codex Interaction Turn 已不可恢复',
        failureCode: 'CODEX_START_FAILED',
      },
    });
    expect(() =>
      fixture.repairs.continueRepair(
        fixture.users.developer.id,
        fixture.requested.bug.id,
        {
          ...mutation(3),
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_TRANSITION',
        message: '原修复任务不存在，不能自动重建',
      }),
    );
  });

  test('旧 Task 无法恢复时仍保持原 Task 与 Skill Binding，不自动重建', async () => {
    const fixture = await setup();
    const started = await startLatest(fixture, 'legacy-custom-session');
    fixture.database
      .prepare(
        `UPDATE cooking_bug_repair_context
         SET pending_commits_json = ? WHERE bug_id = ?`,
      )
      .run(JSON.stringify(['aaaaaaa']), fixture.requested.bug.id);
    completeClaimedExecution(fixture, started, {
      kind: 'FAILED',
      failure: {
        code: 'CODEX_START_FAILED',
        message:
          'failed to load configuration: Model provider `custom` not found',
        retryable: true,
      },
    });

    const continued = fixture.repairs.continueRepair(
      fixture.users.developer.id,
      fixture.requested.bug.id,
      {
        ...mutation(3),
      },
    );
    const execution = fixture.executions.get(continued.executionId);

    expect(execution.codexTurn).toMatchObject({
      kind: 'CONTINUATION',
      taskId: 'legacy-custom-session',
      taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
      input: '继续完成上次未完成的任务。',
      resultAssertions: [
        {
          kind: 'GIT_COMMITS_CREATED',
          resultPath: ['result', 'commits'],
        },
      ],
    });
  });
});
