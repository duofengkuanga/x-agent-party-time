import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@agent-party-time/execution-contract';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import {
  handleExecutionClaim,
  handleExecutionComplete,
  handleExecutionStart,
} from '@/server/execution/http';
import { ExecutionService } from '@/server/execution/service';
import { RunnerService } from '@/server/runner/service';
import { handleRunnerHeartbeat } from '@/server/runner/http';
import { BindingService } from '@/features/cooking/bindings/application/binding-service';
import { BugService } from '@/features/cooking/bugs/application/bug-service';
import { EngineeringService } from '@/features/cooking/engineering/application/engineering-service';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import { SubmissionService } from '@/features/cooking/submissions/application/submission-service';
import { AttachmentMaterializer } from '../../../../../../packages/runner/src/attachments';
import type {
  CodexExecutionInput,
  CodexExecutor,
  StartedCodexExecution,
} from '../../../../../../packages/runner/src/codex-app-server';
import { RunnerClient } from '../../../../../../packages/runner/src/client';
import { ExecutionOutbox } from '../../../../../../packages/runner/src/outbox';
import {
  RunnerStateStore,
  runnerLocalPaths,
} from '../../../../../../packages/runner/src/state';
import { RunnerWorker } from '../../../../../../packages/runner/src/worker';
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
    {
      applyStarted: (execution) => repairs.applyStartedExecution(execution),
      afterStarted: (execution) => repairs.afterStartedExecution(execution),
      applyTerminal: (execution) => repairs.applyTerminalExecution(execution),
      afterTerminal: (execution) => repairs.afterTerminalExecution(execution),
      applyInteractionOpened: (interaction) =>
        repairs.applyInteractionOpened(interaction.executionId, interaction.id),
      afterInteractionOpened: (interaction) =>
        repairs.afterInteractionOpened(interaction.executionId),
    },
  );
  const bugs = new BugService(
    database,
    now,
    undefined,
    (submissionId, revision) => events.push({ submissionId, revision }),
    {
      requested: (bugId, priority) =>
        repairs.createInitialExecution(bugId, priority),
      withdrawn: (bugId) => repairs.withdrawQueuedExecution(bugId),
      reordered: (submissionId) =>
        repairs.synchronizeQueuePriorities(submissionId),
    },
  );
  const created = bugs.createBug(users.tester.id, submission.id, {
    mutationId: randomUUID(),
    submissionItemId: item.id,
    title: '支付按钮无响应',
    actualResult: '点击后没有反应',
    expectedResult: '进入支付流程',
    attachmentIds: [],
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
  test('首次请求创建绑定正确且带业务优先级的通用 Execution', async () => {
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
      promptKind: 'cooking.repair',
      promptVersion: 1,
      resumeSessionId: null,
    });
    expect(execution.renderedPrompt).toContain('支付按钮无响应');
    expect(
      await fixture.executions.claim(fixture.otherRunner.id, 1, 0),
    ).toEqual([]);
    expect(
      (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]?.id,
    ).toBe(execution.id);
  });

  test('领取前撤回保留锁定报告与 Attempt 历史，重新发起创建新 Execution', async () => {
    const fixture = await setup();
    const first = latestAttempt(fixture.database, fixture.requested.bug.id);
    const withdrawn = fixture.bugs.withdrawRepair(
      fixture.users.tester.id,
      fixture.requested.bug.id,
      mutation(2),
    );
    expect(withdrawn.bug).toMatchObject({
      stage: 'WAITING_FOR_REPAIR',
      version: 3,
    });
    expect(withdrawn.bug.reportLockedAt).not.toBeNull();
    expect(fixture.executions.get(first.execution_id).state).toBe('CANCELLED');

    fixture.bugs.requestRepair(
      fixture.users.tester.id,
      fixture.requested.bug.id,
      mutation(3),
    );
    const second = latestAttempt(fixture.database, fixture.requested.bug.id);
    expect(second).toMatchObject({ attempt: 2 });
    expect(second.execution_id).not.toBe(first.execution_id);
    expect(fixture.executions.get(second.execution_id)).toMatchObject({
      previousExecutionId: first.execution_id,
      resumeSessionId: null,
      state: 'QUEUED',
    });
  });

  test('多次成功 Repair 在原 Session 追加有序候选 Commit 链', async () => {
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
            commits: ['aaaaaaa', 'bbbbbbb'],
          },
        },
      }).state,
    ).toBe('SUCCEEDED');
    expect(
      currentBug(fixture.database, fixture.requested.bug.id),
    ).toMatchObject({ stage: 'WAITING_FOR_UPDATE', version: 3 });

    const continued = fixture.repairs.continueRepair(
      fixture.users.developer.id,
      fixture.requested.bug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: 3,
        content: '继续补充键盘回车提交',
      },
    );
    const second = fixture.executions.get(continued.executionId);
    expect(second).toMatchObject({
      attempt: 2,
      previousExecutionId: first.executionId,
      resumeSessionId: 'repair-session',
      priority: -1_000_000,
    });
    expect(second.renderedPrompt).toContain('只处理以下增量信息');
    expect(second.renderedPrompt).toContain('继续补充键盘回车提交');
    expect(second.renderedPrompt).not.toContain('点击后没有反应');

    const resumed = await startLatest(fixture, 'repair-session');
    fixture.executions.complete(fixture.runner.id, resumed.executionId, {
      leaseToken: resumed.leaseToken,
      sessionId: 'repair-session',
      outcome: {
        kind: 'SUCCEEDED',
        result: {
          outcome: 'COMPLETED',
          summary: '已补充键盘提交',
          commits: ['ccccccc'],
        },
      },
    });
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.pendingCommits,
    ).toEqual(['aaaaaaa', 'bbbbbbb', 'ccccccc']);
  });

  test('真实 Runner、测试 Git 仓库与 Fake Codex 完成继续修复链路', async () => {
    const fixture = await setup();
    const repository = join(fixture.directory, 'repair-repository');
    await initializeGitRepository(repository);
    const paths = runnerLocalPaths({
      AGENT_PARTY_TIME_RUNNER_HOME: join(fixture.directory, 'runner-home'),
    });
    const state = new RunnerStateStore(paths);
    await state.saveConfig({
      serverUrl: 'http://repair.test',
      runnerId: fixture.runner.id,
      credential: fixture.pairedRunner.credential,
    });
    await state.bind(fixture.binding.id, repository);
    const client = new RunnerClient(state, repairProtocolFetch(fixture));
    const outbox = new ExecutionOutbox(paths);
    const executor = new RecordingRepairExecutor();
    const worker = new RunnerWorker(
      client,
      state,
      outbox,
      executor,
      new AttachmentMaterializer(client, paths),
      1,
      quietOutput,
    );

    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();
    expect(
      currentBug(fixture.database, fixture.requested.bug.id),
    ).toMatchObject({ stage: 'WAITING_FOR_UPDATE', version: 3 });

    const continued = fixture.repairs.continueRepair(
      fixture.users.developer.id,
      fixture.requested.bug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: 3,
        content: '继续补充键盘回车提交',
      },
    );
    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();

    expect(executor.inputs).toHaveLength(2);
    expect(executor.inputs[0]?.resumeSessionId).toBeNull();
    expect(executor.inputs[1]).toMatchObject({
      executionId: continued.executionId,
      resumeSessionId: executor.sessionId,
    });
    expect(executor.inputs[1]?.prompt).toContain('只处理以下增量信息');
    expect(executor.inputs[1]?.prompt).not.toContain('点击后没有反应');
    expect(
      fixture.repairs.repairView(
        fixture.users.developer.id,
        fixture.requested.bug.id,
      )?.pendingCommits,
    ).toEqual(executor.commits);
    expect(
      (await runGit(repository, ['rev-list', '--count', 'HEAD'])).trim(),
    ).toBe('3');
    expect(await outbox.list()).toEqual([]);
  });

  test('Schema 非法、缺失或重复 Commit 时 Execution FAILED 且 Bug 保持修复中', async () => {
    const invalidResults = [
      { outcome: 'COMPLETED', summary: '缺少提交', commits: [] },
      {
        outcome: 'COMPLETED',
        summary: '重复提交',
        commits: ['aaaaaaa', 'aaaaaaa'],
      },
      {
        outcome: 'COMPLETED',
        summary: '伪造字段',
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
      expect(tester.attempts.at(-1)?.summary).toBe(
        '修复执行未完成，可由工程负责人继续处理。',
      );
      expect(tester.attempts.at(-1)?.technicalFailure).toBeNull();
      expect(developer.attempts.at(-1)?.technicalFailure).not.toBeNull();
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

  test('Interaction 仅负责人可查看详情并响应，停止 Execution 不取消 Bug', async () => {
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
    const testerView = fixture.repairs.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).pendingInteractions[0]!;
    const developerView = fixture.repairs.workspace(
      fixture.users.developer.id,
      fixture.submission.id,
    ).pendingInteractions[0]!;
    expect(testerView).toMatchObject({
      method: null,
      payload: null,
      canResolve: false,
    });
    expect(developerView).toMatchObject({
      method: 'item/commandExecution/requestApproval',
      payload: {
        command: 'cat 本机路径已隐藏',
        reason: '验证修复',
      },
      canResolve: true,
    });
    expect(JSON.stringify(developerView)).not.toContain('/Users/example');
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

    const stoppedFixture = await setup();
    const running = await startLatest(stoppedFixture, 'stop-session');
    const stoppedInteraction = stoppedFixture.executions.openInteraction(
      stoppedFixture.runner.id,
      running.executionId,
      {
        leaseToken: running.leaseToken,
        kind: 'USER_INPUT',
        method: 'item/tool/requestUserInput',
        payload: { questions: [{ id: 'reason', question: '继续吗？' }] },
      },
    );
    const stopped = stoppedFixture.repairs.stopExecution(
      stoppedFixture.users.developer.id,
      stoppedFixture.requested.bug.id,
      { mutationId: randomUUID(), expectedVersion: 2 },
    );
    expect(stopped.executionId).toBe(running.executionId);
    expect(stoppedFixture.executions.get(running.executionId)).toMatchObject({
      state: 'CANCEL_REQUESTED',
      cancellationRequested: true,
    });
    expect(
      currentBug(stoppedFixture.database, stoppedFixture.requested.bug.id)
        .stage,
    ).toBe('REPAIRING');
    stoppedFixture.executions.complete(
      stoppedFixture.runner.id,
      running.executionId,
      {
        leaseToken: running.leaseToken,
        sessionId: running.sessionId,
        outcome: { kind: 'CANCELLED', reason: '用户请求停止' },
      },
    );
    expect(
      stoppedFixture.database
        .prepare(
          'SELECT state FROM platform_execution_interaction WHERE id = ?',
        )
        .get(stoppedInteraction.id),
    ).toEqual({ state: 'INVALIDATED' });
    expect(
      currentBug(stoppedFixture.database, stoppedFixture.requested.bug.id)
        .stage,
    ).toBe('REPAIRING');
  });
});

class RecordingRepairExecutor implements CodexExecutor {
  readonly sessionId = 'repair-e2e-session';
  readonly inputs: CodexExecutionInput[] = [];
  readonly commits: string[] = [];

  async begin(
    input: CodexExecutionInput,
    _signal: AbortSignal,
  ): Promise<StartedCodexExecution> {
    this.inputs.push(input);
    return {
      sessionId: input.resumeSessionId ?? this.sessionId,
      completion: this.commit(input),
    };
  }

  private async commit(input: CodexExecutionInput): Promise<JsonValue> {
    const attempt = this.inputs.length;
    await appendFile(
      join(input.repositoryPath, 'repair.txt'),
      `第 ${attempt} 次修复\n`,
      'utf8',
    );
    await runGit(input.repositoryPath, ['add', 'repair.txt']);
    await runGit(input.repositoryPath, [
      'commit',
      '-m',
      `fix: repair attempt ${attempt}`,
    ]);
    const commit = (await runGit(input.repositoryPath, ['rev-parse', 'HEAD']))
      .trim()
      .toLowerCase();
    this.commits.push(commit);
    return {
      outcome: 'COMPLETED',
      summary: `第 ${attempt} 次修复完成`,
      commits: [commit],
    };
  }
}

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

async function initializeGitRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await runGit(repository, ['init', '--initial-branch=main']);
  await runGit(repository, ['config', 'user.email', 'repair@example.com']);
  await runGit(repository, ['config', 'user.name', 'Repair Fixture']);
  await Bun.write(join(repository, 'README.md'), '# Repair Fixture\n');
  await runGit(repository, ['add', 'README.md']);
  await runGit(repository, ['commit', '-m', 'chore: initialize fixture']);
}

async function runGit(repository: string, args: string[]): Promise<string> {
  const process = Bun.spawn(['git', ...args], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`git ${args.join(' ')} 失败：${stderr.trim()}`);
  return stdout;
}

const quietOutput = { log: () => {}, error: () => {} };

async function startLatest(
  fixture: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
) {
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  fixture.executions.start(fixture.runner.id, claimed.id, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId,
  });
  return {
    executionId: claimed.id,
    leaseToken: claimed.lease.token,
    sessionId,
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
