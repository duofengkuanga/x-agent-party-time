import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimedExecution } from '@agent-party-time/execution-contract';
import { ProtocolAgent } from '@agent-party-time/runner-conformance';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import {
  handleExecutionClaim,
  handleExecutionComplete,
  handleExecutionStart,
} from '@/server/execution/http';
import { ExecutionService } from '@/server/execution/service';
import { cookingExecutionProjection } from '@/features/cooking/execution/application/execution-projection';
import { RunnerService } from '@/server/runner/service';
import { LocalFileStore } from '@/server/files/local-file-store';
import { handleRunnerHeartbeat } from '@/server/runner/http';
import { BindingService } from '@/features/cooking/bindings/application/binding-service';
import { BugService } from '@/features/cooking/bugs/application/bug-service';
import { EngineeringService } from '@/features/cooking/engineering/application/engineering-service';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import { SubmissionService } from '@/features/cooking/submissions/application/submission-service';
import { RepairService } from './repair-service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup(options: { repairCreateId?: () => string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-repair-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(database);
  const users = {
    owner: await auth.seedUser(user('repair-owner', '项目所有者')),
    tester: await auth.seedUser(user('repair-tester', '测试负责人')),
    developer: await auth.seedUser(user('repair-developer', '工程负责人')),
  };
  const projects = new ProjectService(database);
  const project = projects.createProject(users.owner.id, {
    mutationId: randomUUID(),
    name: 'Repair 项目',
  }).project;
  for (const invited of [users.tester, users.developer]) {
    const invitation = projects.inviteUser(users.owner.id, project.id, {
      mutationId: randomUUID(),
      username: invited.username,
    });
    projects.respondToInvitation(invited.id, invitation.id, {
      mutationId: randomUUID(),
      expectedVersion: invitation.version,
      decision: 'ACCEPT',
    });
  }
  const engineering = new EngineeringService(database);
  const source = engineering.createEngineering(users.owner.id, project.id, {
    mutationId: randomUUID(),
    name: '支付工程',
    type: 'BACKEND',
    identifier: 'payment-api',
  });
  engineering.addMember(users.owner.id, source.id, users.developer.id, {
    mutationId: randomUUID(),
  });
  const environment = engineering.createEnvironment(users.owner.id, source.id, {
    mutationId: randomUUID(),
    name: '支付测试环境',
    deployment: { kind: 'CI_CD' },
  });
  const runners = new RunnerService(database);
  const pairedRunner = runners.pair(
    runners.issuePairingCode(users.developer.id).code,
    'Repair Runner',
  );
  const runner = pairedRunner.runner;
  const otherRunner = runners.pair(
    runners.issuePairingCode(users.owner.id).code,
    '其他 Runner',
  ).runner;
  const bindings = new BindingService(database);
  const binding = bindings.createBinding(
    users.developer.id,
    source.id,
    runner.id,
    randomUUID(),
  );
  bindings.confirmRepository(
    runner.id,
    binding.id,
    'https://example.com/payment.git',
  );
  const submission = new SubmissionService(database).createSubmission(
    users.owner.id,
    project.id,
    {
      mutationId: randomUUID(),
      title: '支付功能提测',
      requirementDescription: '验证支付修复链路',
      testerUserId: users.tester.id,
      items: [
        {
          engineeringId: source.id,
          responsibleUserId: users.developer.id,
          bindingId: binding.id,
          targetBranch: 'feature/payment',
          environmentId: environment.id,
        },
      ],
    },
  );
  const item = database
    .prepare('SELECT id FROM cooking_submission_item WHERE submission_id = ?')
    .get(submission.id) as { id: string };
  const now = () => new Date('2026-07-27T10:00:00.000Z');
  const events: Array<{ submissionId: string; revision: number }> = [];
  const repairs = new RepairService(
    database,
    new ExecutionService(database, now),
    now,
    options.repairCreateId,
    (submissionId, revision) => events.push({ submissionId, revision }),
  );
  let leaseIndex = 0;
  const executions = new ExecutionService(
    database,
    now,
    undefined,
    () => `repair-lease-${++leaseIndex}`.padEnd(40, 'x'),
    15_000,
    cookingExecutionProjection(database, {
      BUG_REPAIR: repairs,
      UPDATE_BATCH: { projectExecution: () => {} },
      CLEANUP: { projectExecution: () => {} },
    }),
  );
  const bugs = new BugService(
    database,
    now,
    undefined,
    (submissionId, revision) => events.push({ submissionId, revision }),
    {
      requested: (bugId) => repairs.createInitialExecution(bugId),
    },
  );
  const files = new LocalFileStore(database, join(directory, 'files'));
  const actualResultAttachment = await files.put({
    bytes: new TextEncoder().encode('实际结果截图'),
    originalName: '实际结果.png',
    mediaType: 'image/png',
    uploadedByUserId: users.tester.id,
  });
  const expectedResultAttachment = await files.put({
    bytes: new TextEncoder().encode('预期结果说明'),
    originalName: '预期结果.txt',
    mediaType: 'text/plain',
    uploadedByUserId: users.tester.id,
  });
  const created = bugs.createBug(users.tester.id, submission.id, {
    mutationId: randomUUID(),
    submissionItemId: item.id,
    title: '支付按钮无响应',
    actualResult: '点击后没有反应',
    expectedResult: '进入支付流程',
    actualResultAttachmentIds: [actualResultAttachment.id],
    expectedResultAttachmentIds: [expectedResultAttachment.id],
  });
  const requested = bugs.requestRepair(
    users.tester.id,
    created.bug.id,
    mutation(created.bug.version),
  );
  return {
    binding,
    bugs,
    database,
    directory,
    events,
    executions,
    otherRunner,
    pairedRunner,
    repairs,
    resultAttachments: {
      actual: actualResultAttachment,
      expected: expectedResultAttachment,
    },
    requested,
    runner,
    runners,
    submission,
    users,
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('RepairService', () => {
  test('工作区允许缺陷暂未确定工程', async () => {
    const fixture = await setup();
    const unassigned = fixture.bugs.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        submissionItemId: null,
        title: '暂未确定工程的缺陷',
        actualResultAttachmentIds: [],
        expectedResultAttachmentIds: [],
      },
    );

    const workspace = fixture.repairs.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    );

    expect(workspace.repairByBug[fixture.requested.bug.id]).toBeDefined();
    expect(workspace.repairByBug[unassigned.bug.id]).toBeUndefined();
  });

  test('首次请求创建绑定正确且带隔离 Worktree 的通用 Execution', async () => {
    const fixture = await setup();
    const attempt = latestAttempt(fixture.database, fixture.requested.bug.id);
    const execution = fixture.executions.get(attempt.execution_id);
    expect(execution).toMatchObject({
      owner: { namespace: 'cooking', kind: 'BUG_REPAIR', id: attempt.id },
      attempt: 1,
      previousExecutionId: null,
      runnerId: fixture.runner.id,
      bindingId: fixture.binding.id,
      priority: 0,
      codexTurn: {
        kind: 'INITIAL',
        requiredSkillName: 'agent-party-time-repair-bug',
        taskSkillBinding: null,
        executionBrief: {
          bug: {
            title: '支付按钮无响应',
            attachments: {
              actualResult: [
                {
                  fileId: fixture.resultAttachments.actual.id,
                  originalName: '实际结果.png',
                },
              ],
              expectedResult: [
                {
                  fileId: fixture.resultAttachments.expected.id,
                  originalName: '预期结果.txt',
                },
              ],
            },
          },
        },
      },
      workspace: {
        key: `bug-repair:${fixture.requested.bug.id}`,
        isolation: 'BRANCH_WORKTREE',
        baseRef: 'origin/feature/payment',
        branch: `apt/repair/${fixture.requested.bug.id}`,
      },
    });
    expect(execution.codexTurn?.kind).toBe('INITIAL');
    if (execution.codexTurn?.kind !== 'INITIAL')
      throw new Error('需要首次 Turn');
    expect(execution.codexTurn.executionBriefHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(execution.attachments.map(({ id }) => id)).toEqual([
      fixture.resultAttachments.actual.id,
      fixture.resultAttachments.expected.id,
    ]);
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.presentation.visual,
    ).toEqual({
      state: 'QUEUED_FOR_ENGINEERING',
      label: '等待工程执行通道（前方 0 项）',
      symbol: '…',
      aheadCount: 0,
    });
    expect(
      await fixture.executions.claim(fixture.otherRunner.id, 1, 0),
    ).toEqual([]);
    expect(
      (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]?.id,
    ).toBe(execution.id);
  });

  test('成功 Repair 冻结候选提交且不能重新执行', async () => {
    const fixture = await setup();
    const first = await startLatest(fixture, 'repair-session');
    expect(
      fixture.executions.complete(fixture.runner.id, first.executionId, {
        leaseToken: first.leaseToken,
        sessionId: 'repair-session',
        outcome: {
          kind: 'SUCCEEDED',
          result: {
            outcome: 'COMPLETED',
            summary: '已修复支付按钮',
            changes: ['修复支付按钮事件绑定'],
            validations: [
              { name: '支付服务单测', status: 'PASSED', detail: '12 项通过' },
            ],
            warnings: [],
            commits: ['aaaaaaa', 'bbbbbbb'],
          },
        },
      }).state,
    ).toBe('SUCCEEDED');
    expect(
      currentBug(fixture.database, fixture.requested.bug.id),
    ).toMatchObject({ stage: 'WAITING_FOR_UPDATE', version: 3 });
    const testerTimeline = fixture.repairs.repairView(
      fixture.users.tester.id,
      fixture.requested.bug.id,
    )!.timeline;
    const developerTimeline = fixture.repairs.repairView(
      fixture.users.developer.id,
      fixture.requested.bug.id,
    )!.timeline;
    expect(testerTimeline.map(({ kind }) => kind)).toEqual([
      'BUG_REGISTERED',
      'REPAIR_ATTEMPT',
    ]);
    expect(testerTimeline.at(-1)).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'COMPLETED',
        changes: ['修复支付按钮事件绑定'],
        commitCount: 2,
        commits: null,
        rawSummary: null,
      },
    });
    expect(developerTimeline.at(-1)).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'COMPLETED',
        commits: ['aaaaaaa', 'bbbbbbb'],
        rawSummary: '已修复支付按钮',
      },
    });

    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.availableActions,
    ).not.toContain('RETRY_REPAIR');
    expect(() =>
      fixture.repairs.continueRepair(
        fixture.users.developer.id,
        fixture.requested.bug.id,
        {
          mutationId: randomUUID(),
          expectedVersion: 3,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.pendingCommits,
    ).toEqual(['aaaaaaa', 'bbbbbbb']);
  });

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
            outcome: 'FAILED',
            summary: '首次修复未完成',
            failedStep: '定向测试',
            reason: '仍有一项回归测试失败',
            completedActions: ['定位失败测试'],
            pendingActions: ['修复回归并重新验证'],
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
        mutationId: randomUUID(),
        expectedVersion: 3,
      },
    );
    await agent.runNext(
      async (execution) => {
        claimed.push(execution);
        return {
          kind: 'SUCCEEDED',
          result: {
            outcome: 'COMPLETED',
            summary: '第二次修复完成',
            changes: ['完成第二次修复'],
            validations: [{ name: '定向检查', status: 'PASSED' }],
            warnings: [],
            commits: ['abcdef1'],
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

  test('Execution 失败使用真实 code/message 且仅向工程负责人投影技术码', async () => {
    const fixture = await setup();
    const started = await startLatest(fixture, 'failed-session');
    const failureSummary =
      'Codex 请求过多：429 Too Many Requests，已超过重试次数。';
    fixture.executions.complete(fixture.runner.id, started.executionId, {
      leaseToken: started.leaseToken,
      sessionId: started.sessionId,
      outcome: {
        kind: 'FAILED',
        failure: {
          code: 'CODEX_EXECUTION_FAILED',
          message: failureSummary,
          retryable: true,
        },
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
        rawSummary: null,
      },
    });
    expect(developerAttempt).toMatchObject({
      kind: 'REPAIR_ATTEMPT',
      result: {
        outcome: 'FAILED',
        reason: failureSummary,
        failureCode: 'CODEX_EXECUTION_FAILED',
        rawSummary: failureSummary,
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
        rawSummary: 'Agent 重启后原生 Codex Interaction Turn 已不可恢复',
      },
    });
    expect(() =>
      fixture.repairs.continueRepair(
        fixture.users.developer.id,
        fixture.requested.bug.id,
        {
          mutationId: randomUUID(),
          expectedVersion: 3,
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_TRANSITION',
        message: '原 Repair Task 不存在，不能自动重建',
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
    fixture.executions.complete(fixture.runner.id, started.executionId, {
      leaseToken: started.leaseToken,
      sessionId: started.sessionId,
      outcome: {
        kind: 'FAILED',
        failure: {
          code: 'CODEX_START_FAILED',
          message:
            'failed to load configuration: Model provider `custom` not found',
          retryable: true,
        },
      },
    });

    const continued = fixture.repairs.continueRepair(
      fixture.users.developer.id,
      fixture.requested.bug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: 3,
      },
    );
    const execution = fixture.executions.get(continued.executionId);

    expect(execution.codexTurn).toMatchObject({
      kind: 'CONTINUATION',
      taskId: 'legacy-custom-session',
      taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
      input: '继续完成上次未完成的任务。',
    });
  });

  test('Schema 非法、缺失或重复 Commit 时 Execution FAILED 且 Bug 保持修复中', async () => {
    const invalidResults = [
      {
        outcome: 'COMPLETED',
        summary: '缺少提交',
        changes: [],
        validations: [],
        warnings: [],
        commits: [],
      },
      {
        outcome: 'COMPLETED',
        summary: '重复提交',
        changes: ['修改'],
        validations: [],
        warnings: [],
        commits: ['aaaaaaa', 'aaaaaaa'],
      },
      {
        outcome: 'COMPLETED',
        summary: '伪造字段',
        changes: ['修改'],
        validations: [],
        warnings: [],
        commits: ['aaaaaaa'],
        pushed: true,
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
        failureCode: null,
        rawSummary: null,
      });
      expect(developerAttempt.result).toMatchObject({
        outcome: 'FAILED',
        failureCode: 'RESULT_SCHEMA_INVALID',
      });
    }
  });

  test('Execution Outcome 业务解释失败时整笔事务回滚', async () => {
    const duplicateAuditId = '00000000-0000-4000-8000-000000000008';
    const fixture = await setup({
      repairCreateId: () => duplicateAuditId,
    });
    const started = await startLatest(fixture, 'rollback-session');
    const before = currentBug(fixture.database, fixture.requested.bug.id);
    const beforeRevision = fixture.database
      .prepare(
        'SELECT workspace_revision FROM cooking_test_submission WHERE id = ?',
      )
      .get(fixture.submission.id);

    expect(() =>
      fixture.executions.complete(fixture.runner.id, started.executionId, {
        leaseToken: started.leaseToken,
        sessionId: started.sessionId,
        outcome: {
          kind: 'SUCCEEDED',
          result: {
            outcome: 'COMPLETED',
            summary: '本次提交应整体回滚',
            changes: ['修改支付按钮'],
            validations: [],
            warnings: [],
            commits: ['ddddddd'],
          },
        },
      }),
    ).toThrow();

    expect(fixture.executions.get(started.executionId).state).toBe('RUNNING');
    expect(currentBug(fixture.database, fixture.requested.bug.id)).toEqual(
      before,
    );
    expect(
      fixture.database
        .prepare(
          'SELECT workspace_revision FROM cooking_test_submission WHERE id = ?',
        )
        .get(fixture.submission.id),
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
          mutationId: randomUUID(),
          expectedVersion: 1,
          resolution: { decision: 'accept' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    expect(() =>
      fixture.repairs.resolveInteraction(
        fixture.users.owner.id,
        interaction.id,
        {
          mutationId: randomUUID(),
          expectedVersion: 2,
          resolution: { decision: 'decline' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const resolved = fixture.repairs.resolveInteraction(
      fixture.users.developer.id,
      interaction.id,
      {
        mutationId: randomUUID(),
        expectedVersion: 2,
        resolution: { decision: 'acceptForSession' },
      },
    );
    expect(resolved.bugVersion).toBe(3);
    expect(
      fixture.database
        .prepare(
          'SELECT state FROM platform_execution_interaction WHERE id = ?',
        )
        .get(interaction.id),
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
          mutationId: randomUUID(),
          expectedVersion: 3,
          resolution: { decision: 'accept' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
  });
});

function repairProtocolFetch(
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

async function startLatest(
  fixture: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
) {
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  fixture.executions.start(fixture.runner.id, claimed.id, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId,
    taskSkillBinding: testSkillBinding('agent-party-time-repair-bug'),
  });
  return {
    executionId: claimed.id,
    leaseToken: claimed.lease.token,
    sessionId,
  };
}

function testSkillBinding(skillName: string) {
  return {
    skillName,
    bundleHash: 'a'.repeat(64),
    sourceRevision: 'b'.repeat(40),
  };
}

function latestAttempt(database: AppDatabase, bugId: string) {
  return database
    .prepare(
      `SELECT id, execution_id, attempt FROM cooking_repair_attempt
       WHERE bug_id = ? ORDER BY attempt DESC LIMIT 1`,
    )
    .get(bugId) as { id: string; execution_id: string; attempt: number };
}

function currentBug(database: AppDatabase, bugId: string) {
  return database
    .prepare('SELECT stage, version FROM cooking_bug WHERE id = ?')
    .get(bugId) as { stage: string; version: number };
}

function mutation(expectedVersion: number) {
  return { mutationId: randomUUID(), expectedVersion };
}

function user(username: string, displayName: string) {
  return {
    id: randomUUID(),
    username,
    displayName,
    password: 'password',
  };
}
