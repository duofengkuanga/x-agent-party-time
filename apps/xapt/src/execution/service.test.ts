import { expect, test } from 'bun:test';
import { EXECUTION_STATE_SCHEMA_VERSION } from '../state/schemas';
import { CodexAppServerError } from '../codex/errors';
import { ExecutionRecovery } from './recovery';
import { ExecutionResultVerificationError } from './result-verification';
import {
  bindingId,
  claimedExecution,
  continuationTurn,
  createFixture,
  executionId,
  leaseToken,
  session,
  skillBinding,
} from './service-fixture';

test('单槽完成领取、Codex Session、START 与结构化 Outcome happy path', async () => {
  const fixture = await createFixture();

  expect(await fixture.service.cycle(session)).toBe(true);
  await fixture.service.waitForIdle();

  expect(fixture.http.claimSlots).toEqual([3]);
  expect(fixture.http.starts).toEqual([
    {
      kind: 'STARTED',
      leaseToken,
      sessionId: 'thread-new',
      taskSkillBinding: skillBinding,
    },
  ]);
  expect(fixture.http.outcomes).toEqual([
    {
      leaseToken,
      sessionId: 'thread-new',
      outcome: { kind: 'SUCCEEDED', result: { summary: 'done' } },
    },
  ]);
  expect(fixture.executor.inputs[0]).toMatchObject({
    repositoryPath: fixture.repositoryPath,
    text: '{"instruction":"只返回 JSON"}',
    taskId: null,
    skill: { name: skillBinding.skillName },
  });
  expect(await fixture.state.loadExecutions()).toEqual([]);
  expect(await fixture.state.loadOutbox()).toEqual([]);
  expect(fixture.service.projection.activeExecutionCount).toBe(0);
});

test('已有 Task 通过 codexTurn 继续原 Thread', async () => {
  const fixture = await createFixture({ taskId: 'thread-existing' });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.executor.inputs[0]?.taskId).toBe('thread-existing');
  expect(fixture.executor.inputs[0]?.skill).toBeNull();
});

test('首次执行保存结果校验基线供后续同步复用', async () => {
  const fixture = await createFixture({
    capturedBaseline: { gitHead: 'baseline-commit' },
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(await fixture.state.loadExecutionResultBaseline(executionId)).toEqual({
    gitHead: 'baseline-commit',
  });
});

test('同步会话使用原执行基线和断言校验结果', async () => {
  const previousExecutionId = '00000000-0000-4000-8000-000000000399';
  const fixture = await createFixture({
    readSessionId: 'manual-session',
    readResultAssertions: [
      { kind: 'GIT_COMMITS_CREATED', resultPath: ['result', 'commits'] },
    ],
    previousExecutionId,
    workspace: {
      key: 'bug-repair:bug-1',
      isolation: 'BRANCH_WORKTREE',
      baseRef: 'origin/main',
      branch: 'apt/repair/bug-1',
    },
  });
  await fixture.state.saveExecutionResultBaseline(previousExecutionId, {
    gitHead: 'baseline-commit',
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.verifiedBaselines).toEqual([{ gitHead: 'baseline-commit' }]);
  expect(fixture.http.starts[0]).toMatchObject({
    kind: 'STARTED',
    sessionId: 'manual-session',
  });
  expect(fixture.http.outcomes[0]).toMatchObject({
    outcome: { kind: 'SUCCEEDED' },
  });
});

test('同步会话拒绝不符合原任务结果约束的结果', async () => {
  const fixture = await createFixture({
    readSessionId: 'manual-session',
    readOutputJsonSchema: {
      type: 'object',
      properties: { result: { type: 'object' } },
      required: ['result'],
      additionalProperties: false,
    },
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.starts[0]).toMatchObject({
    kind: 'START_FAILED',
    failure: {
      code: 'CODEX_EXECUTION_FAILED',
      message: 'Codex 会话的最新轮次不符合原任务结果约束',
    },
  });
  expect(fixture.http.outcomes).toEqual([]);
});

test('同步会话保留原结果证据校验失败原因', async () => {
  const previousExecutionId = '00000000-0000-4000-8000-000000000398';
  const fixture = await createFixture({
    readSessionId: 'manual-session',
    readResultAssertions: [
      { kind: 'GIT_COMMITS_CREATED', resultPath: ['result', 'commits'] },
    ],
    previousExecutionId,
    workspace: {
      key: 'bug-repair:bug-1',
      isolation: 'BRANCH_WORKTREE',
      baseRef: 'origin/main',
      branch: 'apt/repair/bug-1',
    },
    resultValidationFailure: new ExecutionResultVerificationError(
      '本机 Commit 结果校验缺少执行前基线',
    ),
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.starts[0]).toMatchObject({
    kind: 'START_FAILED',
    failure: {
      code: 'CODEX_EXECUTION_FAILED',
      message: '本机 Commit 结果校验缺少执行前基线',
    },
  });
  expect(fixture.http.outcomes).toEqual([]);
});

test('同步会话接受不声明提交的有效业务失败结果', async () => {
  const fixture = await createFixture({
    readSessionId: 'manual-session',
    readResultAssertions: [
      { kind: 'GIT_COMMITS_CREATED', resultPath: ['result', 'commits'] },
    ],
    previousExecutionId: '00000000-0000-4000-8000-000000000397',
    workspace: {
      key: 'bug-repair:bug-1',
      isolation: 'BRANCH_WORKTREE',
      baseRef: 'origin/main',
      branch: 'apt/repair/bug-1',
    },
    readOutputJsonSchema: {
      type: 'object',
      properties: {
        result: {
          type: 'object',
          properties: { outcome: { type: 'string', enum: ['FAILED'] } },
          required: ['outcome'],
        },
      },
      required: ['result'],
    },
    readResult: {
      result: {
        outcome: 'FAILED',
        failedStep: '执行测试',
        reason: '测试失败',
        completedActions: [],
        pendingActions: [],
      },
    },
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.starts[0]).toMatchObject({ kind: 'STARTED' });
  expect(fixture.http.outcomes[0]).toMatchObject({
    outcome: { kind: 'SUCCEEDED' },
  });
});

test('同步会话不泄露原工作区解析错误', async () => {
  const fixture = await createFixture({
    readSessionId: 'manual-session',
    readResultAssertions: [
      { kind: 'GIT_COMMITS_CREATED', resultPath: ['result', 'commits'] },
    ],
    previousExecutionId: '00000000-0000-4000-8000-000000000396',
    workspace: {
      key: 'bug-repair:bug-1',
      isolation: 'BRANCH_WORKTREE',
      baseRef: 'origin/main',
      branch: 'apt/repair/bug-1',
    },
    workspaceResolveFailure: new Error(
      '/Users/example/private-worktree 不可读取',
    ),
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.starts[0]).toMatchObject({
    kind: 'START_FAILED',
    failure: { message: '原任务工作区不可用，无法校验同步结果' },
  });
  expect(JSON.stringify(fixture.http.starts[0])).not.toContain('/Users/');
});

test('只读会话无法确认时投递可操作的同步失败', async () => {
  const fixture = await createFixture({
    readSessionId: 'manual-session',
    readSessionFailure: new CodexAppServerError(
      'Codex 会话的最新一轮尚未完成或暂无法确认，请完成后再同步',
      'manual-session',
    ),
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.starts).toEqual([
    {
      kind: 'START_FAILED',
      leaseToken,
      failure: {
        code: 'CODEX_EXECUTION_FAILED',
        message: 'Codex 会话的最新一轮尚未完成或暂无法确认，请完成后再同步',
        retryable: true,
      },
    },
  ]);
  expect(fixture.http.outcomes).toEqual([]);
  expect(await fixture.state.loadExecutions()).toEqual([]);
});

test('按 Execution 携带的审批约束启动 Codex', async () => {
  for (const approvalPolicy of ['never', 'on-request'] as const) {
    const fixture = await createFixture({ approvalPolicy });

    await fixture.service.cycle(session);
    await fixture.service.waitForIdle();

    expect(fixture.executor.inputs[0]?.approvalPolicy).toBe(approvalPolicy);
  }
});

test('Codex 结构化结果失败只收敛当前 Execution，不退出服务', async () => {
  const fixture = await createFixture({
    executorFailure: new CodexAppServerError(
      'Codex Turn 返回的结构化结果无效',
      'thread-failed',
    ),
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.outcomes[0]).toMatchObject({
    outcome: {
      kind: 'FAILED',
      failure: {
        code: 'CODEX_EXECUTION_FAILED',
        message: 'Codex Turn 返回的结构化结果无效',
      },
    },
  });
  expect(await fixture.state.loadExecutions()).toEqual([]);
});

test('本机 Commit 结果断言失败时不提交 Codex 成功结果', async () => {
  const fixture = await createFixture({
    resultAssertions: [
      { kind: 'GIT_COMMITS_CREATED', resultPath: ['result', 'commits'] },
    ],
    resultValidationFailure: new ExecutionResultVerificationError(
      'Codex 返回的本地 Commit deadbeef 不存在',
    ),
  });

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.outcomes[0]).toMatchObject({
    outcome: {
      kind: 'FAILED',
      failure: {
        code: 'CODEX_EXECUTION_FAILED',
        message: 'Codex 返回的本地 Commit deadbeef 不存在',
        retryable: true,
      },
    },
  });
});

test('Outcome 网络失败进入 Outbox，重启后先重放再尝试领取', async () => {
  const fixture = await createFixture({ failOutcome: true });
  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();
  expect(await fixture.state.loadOutbox()).toHaveLength(1);
  expect(await fixture.state.loadExecutions()).toHaveLength(1);

  fixture.http.failOutcome = false;
  fixture.http.claimed = [];
  fixture.http.events.length = 0;
  const restarted = fixture.restartedService();
  expect(await restarted.cycle(session)).toBe(false);

  expect(fixture.http.events).toEqual(['complete', 'claim']);
  expect(await fixture.state.loadOutbox()).toEqual([]);
  expect(await fixture.state.loadExecutions()).toEqual([]);
});

test('固定三槽并发，第四条等待空闲槽位', async () => {
  const fixture = await createFixture({ deferredExecutor: true });
  const executions = [0, 1, 2, 3].map((index) =>
    claimedExecution(
      null,
      `00000000-0000-4000-8000-${String(310 + index).padStart(12, '0')}`,
      `00000000-0000-4000-8000-${String(320 + index).padStart(12, '0')}`,
    ),
  );
  for (const execution of executions)
    await fixture.state.bind(execution.bindingId, fixture.repositoryPath);
  fixture.http.claimed = executions;

  await fixture.service.cycle(session);
  await waitUntil(() => fixture.executor.inputs.length === 3);
  expect(fixture.service.projection.activeExecutionCount).toBe(3);
  expect(await fixture.service.cycle(session)).toBe(false);
  expect(fixture.executor.inputs).toHaveLength(3);

  fixture.executor.resolveAll();
  await fixture.service.waitForIdle();
  expect(await fixture.service.cycle(session)).toBe(true);
  await waitUntil(() => fixture.executor.inputs.length === 4);
  fixture.executor.resolveAll();
  await fixture.service.waitForIdle();
});

test('同一 Binding 的第二条 Execution 在第一条收敛后才启动', async () => {
  const fixture = await createFixture({ deferredExecutor: true });
  fixture.http.claimed = [
    claimedExecution(null),
    claimedExecution(null, '00000000-0000-4000-8000-000000000311', bindingId),
  ];

  await fixture.service.cycle(session);
  await waitUntil(() => fixture.executor.inputs.length === 1);
  expect(fixture.service.projection.activeExecutionCount).toBe(1);
  fixture.executor.resolveNext();
  await waitUntil(() => fixture.executor.inputs.length === 2);
  fixture.executor.resolveNext();
  await fixture.service.waitForIdle();
});

test('Codex Interaction 经 Server 解决后继续原 Session', async () => {
  const fixture = await createFixture({ interactionExecutor: true });
  fixture.http.interactionResolution = {
    answers: { question: { answers: ['ok'] } },
  };

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.http.openedInteractions).toHaveLength(1);
  expect(fixture.http.outcomes[0]).toMatchObject({
    sessionId: 'thread-new',
    outcome: {
      kind: 'SUCCEEDED',
      result: fixture.http.interactionResolution,
    },
  });
  expect(fixture.service.projection.waitingInteractionCount).toBe(0);
});

test('恢复后的已解决 Interaction 直接回填给恢复的 Codex Session', async () => {
  const fixture = await createFixture({ interactionExecutor: true });
  const resolution = {
    answers: { question: { answers: ['恢复答案'] } },
  };
  fixture.http.claimed[0] = {
    ...fixture.http.claimed[0]!,
    codexTurn: continuationTurn('thread-recovered'),
    recoveredInteraction: {
      method: 'item/tool/requestUserInput',
      payload: { questions: [{ id: 'question' }] },
      resolution,
    },
  };

  await fixture.service.cycle(session);
  await fixture.service.waitForIdle();

  expect(fixture.executor.inputs[0]?.taskId).toBe('thread-recovered');
  expect(fixture.http.openedInteractions).toEqual([]);
  expect(fixture.http.outcomes[0]).toMatchObject({
    outcome: { kind: 'SUCCEEDED', result: resolution },
  });
});

test('重启保留本地执行记录至 Server Lease 收敛后再领取', async () => {
  const fixture = await createFixture();
  const execution = claimedExecution(null);
  fixture.http.claimed = [];
  await fixture.state.saveExecution({
    schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
    executionId: execution.id,
    bindingId: execution.bindingId,
    phase: 'RUNNING',
    sessionId: 'thread-interrupted',
    claimedExecution: execution,
    updatedAt: '2026-08-03T08:00:00.000Z',
  });

  const restarted = fixture.restartedService();
  expect(await restarted.cycle(session)).toBe(true);

  expect(fixture.http.events).toEqual([]);
  expect(fixture.http.outcomes).toEqual([]);
  expect(await fixture.state.loadExecutions()).toHaveLength(1);
  expect(restarted.projection.recoveryRequired).toBe(true);

  fixture.setNow('2026-08-03T10:00:00.000Z');
  const afterLeaseExpiry = fixture.restartedService();
  expect(await afterLeaseExpiry.cycle(session)).toBe(true);
  expect(await fixture.state.loadExecutions()).toEqual([]);
  expect(afterLeaseExpiry.projection.recoveryRequired).toBe(true);
});

test('续租将最新 Lease 过期时间写入崩溃恢复记录', async () => {
  const fixture = await createFixture();
  const execution = claimedExecution(null);
  await fixture.state.saveExecution({
    schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
    executionId: execution.id,
    bindingId: execution.bindingId,
    phase: 'RUNNING',
    sessionId: 'thread-interrupted',
    claimedExecution: execution,
    updatedAt: '2026-08-03T08:00:00.000Z',
  });

  fixture.http.renewedExpiresAt = '2026-08-03T10:00:00.000Z';
  await new ExecutionRecovery(
    fixture.http,
    fixture.state,
    () => new Date(),
  ).renew(session, execution);
  fixture.setNow('2026-08-03T09:30:00.000Z');

  const restarted = fixture.restartedService();
  expect(await restarted.cycle(session)).toBe(true);
  expect(await fixture.state.loadExecutions()).toHaveLength(1);
  expect(restarted.projection.recoveryRequired).toBe(true);
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
