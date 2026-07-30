import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@agent-party-time/execution-contract';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { LocalFileStore } from '@/server/files/local-file-store';
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
import { RepairService } from '@/features/cooking/repair/application/repair-service';
import { SubmissionService } from '@/features/cooking/submissions/application/submission-service';
import { CookingWorkspaceService } from '@/features/cooking/workspace/application/workspace-service';
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
import { UpdateService } from './update-service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup(
  options: {
    updateCreateId?: () => string;
    secondItem?: boolean;
    deploymentKind?: 'LOCAL_SCRIPT' | 'CI_CD';
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-update-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const clock = mutableClock('2026-07-27T10:00:00.000Z');
  const auth = new AuthService(database);
  const users = {
    owner: await auth.seedUser(user('update-owner', '项目所有者')),
    tester: await auth.seedUser(user('update-tester', '测试负责人')),
    developer: await auth.seedUser(user('update-developer', '工程负责人')),
  };
  const projects = new ProjectService(database);
  const project = projects.createProject(users.owner.id, {
    mutationId: randomUUID(),
    name: 'Update 项目',
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
    deployment:
      options.deploymentKind === 'CI_CD'
        ? { kind: 'CI_CD' as const }
        : { kind: 'LOCAL_SCRIPT' as const, command: 'bun run deploy:test' },
  });
  const runners = new RunnerService(database);
  const pairedRunner = runners.pair(
    runners.issuePairingCode(users.developer.id).code,
    'Update Runner',
  );
  const runner = pairedRunner.runner;
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
  let secondBinding: { id: string } | null = null;
  let secondEnvironment: { id: string } | null = null;
  let secondSource: { id: string } | null = null;
  if (options.secondItem) {
    secondSource = engineering.createEngineering(users.owner.id, project.id, {
      mutationId: randomUUID(),
      name: '订单工程',
      type: 'BACKEND',
      identifier: 'order-api',
    });
    engineering.addMember(users.owner.id, secondSource.id, users.developer.id, {
      mutationId: randomUUID(),
    });
    secondEnvironment = engineering.createEnvironment(
      users.owner.id,
      secondSource.id,
      {
        mutationId: randomUUID(),
        name: '订单测试环境',
        deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:order' },
      },
    );
    secondBinding = bindings.createBinding(
      users.developer.id,
      secondSource.id,
      runner.id,
      randomUUID(),
    );
    bindings.confirmRepository(
      runner.id,
      secondBinding.id,
      'https://example.com/order.git',
    );
  }
  const submission = new SubmissionService(database).createSubmission(
    users.owner.id,
    project.id,
    {
      mutationId: randomUUID(),
      title: '支付功能提测',
      requirementDescription: '验证统一更新链路',
      testerUserId: users.tester.id,
      items: [
        {
          engineeringId: source.id,
          responsibleUserId: users.developer.id,
          bindingId: binding.id,
          targetBranch: 'main',
          environmentId: environment.id,
        },
        ...(secondSource && secondEnvironment && secondBinding
          ? [
              {
                engineeringId: secondSource.id,
                responsibleUserId: users.developer.id,
                bindingId: secondBinding.id,
                targetBranch: 'main',
                environmentId: secondEnvironment.id,
              },
            ]
          : []),
      ],
    },
  );
  const items = database
    .prepare(
      'SELECT id FROM cooking_submission_item WHERE submission_id = ? ORDER BY position',
    )
    .all(submission.id) as Array<{ id: string }>;
  const item = items[0]!;
  const secondItem = items[1] ?? null;
  const events: Array<{ submissionId: string; revision: number }> = [];
  const updates = new UpdateService(
    database,
    new ExecutionService(database, clock.now),
    clock.now,
    options.updateCreateId,
    (submissionId, revision) => events.push({ submissionId, revision }),
  );
  const repairs = new RepairService(
    database,
    new ExecutionService(database, clock.now),
    clock.now,
    undefined,
    (submissionId, revision) => events.push({ submissionId, revision }),
    {
      candidateAvailable: (bugId, candidateAt) =>
        updates.recordCandidateAvailable(bugId, candidateAt),
      candidateReconsidered: (bugId) =>
        updates.recalculatePendingDeliveryForBug(bugId),
    },
  );
  let leaseIndex = 0;
  const executions = new ExecutionService(
    database,
    clock.now,
    undefined,
    () => `update-lease-${++leaseIndex}`.padEnd(40, 'x'),
    15_000,
    {
      applyStarted: (execution) => {
        repairs.applyStartedExecution(execution);
        updates.applyStartedExecution(execution);
      },
      afterStarted: (execution) => {
        repairs.afterStartedExecution(execution);
        updates.afterStartedExecution(execution);
      },
      applyTerminal: (execution) => {
        repairs.applyTerminalExecution(execution);
        updates.applyTerminalExecution(execution);
      },
      afterTerminal: (execution) => {
        repairs.afterTerminalExecution(execution);
        updates.afterTerminalExecution(execution);
      },
      applyInteractionOpened: (interaction) => {
        repairs.applyInteractionOpened(interaction.executionId, interaction.id);
        updates.applyInteractionOpened(interaction.executionId, interaction.id);
      },
      afterInteractionOpened: (interaction) => {
        repairs.afterInteractionOpened(interaction.executionId);
        updates.afterInteractionOpened(interaction.executionId);
      },
    },
  );
  const bugs = new BugService(
    database,
    clock.now,
    undefined,
    (submissionId, revision) => events.push({ submissionId, revision }),
    {
      requested: (bugId) => repairs.createInitialExecution(bugId),
    },
  );

  function createBugFor(submissionItemId: string, title: string) {
    const created = bugs.createBug(users.tester.id, submission.id, {
      mutationId: randomUUID(),
      submissionItemId,
      title,
      attachmentIds: [],
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

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('UpdateService', () => {
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

  test('无权访问的 Workspace Query 不会触发到期冻结', async () => {
    const fixture = await setup();
    fixture.createBug('无权访问时到期的候选');
    await completeNextRepair(fixture, 'repair-one', ['aaaaaaa']);
    fixture.clock.set('2026-07-27T10:02:00.000Z');
    const outsider = await new AuthService(fixture.database).seedUser(
      user('update-outsider', '项目外用户'),
    );
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
      rawSummary: null,
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
      resumeSessionId: 'update-session',
      priority: 0,
    });
    expect(continuation.renderedPrompt).toContain('上一轮结构化失败结果');
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
            validations: [{ name: '定向检查', status: 'PASSED' }],
            warnings: [],
            rawSummary: null,
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
    expect(continuationExecution.resumeSessionId).toBe('update-ci-session');
    expect(continuationExecution.renderedPrompt).toContain('流水线测试失败');
    expect(continuationExecution.renderedPrompt).not.toContain('仓库逻辑地址');
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
    expect(reclaimed.resumeSessionId).toBe('lease-update-session');
    fixture.executions.start(fixture.runner.id, reclaimed.id, {
      kind: 'STARTED',
      leaseToken: reclaimed.lease.token,
      sessionId: 'lease-update-session',
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

  test('Update Outcome 业务解释失败时整笔事务回滚', async () => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000004',
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

  test('真实 Runner 在测试 Git 仓库按冻结顺序 Push 并执行 LOCAL_SCRIPT', async () => {
    const fixture = await setup();
    const repository = join(fixture.directory, 'integration-repository');
    const remote = join(fixture.directory, 'remote.git');
    const deploymentOutput = join(fixture.directory, 'deployment-output.txt');
    const commits = await initializeIntegrationRepository(
      repository,
      remote,
      deploymentOutput,
    );
    fixture.createBug('第一个真实候选');
    await completeNextRepair(fixture, 'repair-one', [commits[0]!]);
    fixture.createBug('第二个真实候选');
    await completeNextRepair(fixture, 'repair-two', [commits[1]!]);
    const frozen = fixture.updates.freezeNow(
      fixture.users.developer.id,
      fixture.item.id,
      { mutationId: randomUUID() },
    );

    const paths = runnerLocalPaths({
      AGENT_PARTY_TIME_RUNNER_HOME: join(fixture.directory, 'runner-home'),
    });
    const state = new RunnerStateStore(paths);
    await state.saveConfig({
      serverUrl: 'http://update.test',
      runnerId: fixture.runner.id,
      credential: fixture.pairedRunner.credential,
    });
    await state.bind(fixture.binding.id, repository);
    const client = new RunnerClient(state, updateProtocolFetch(fixture));
    const outbox = new ExecutionOutbox(paths);
    const executor = new GitUpdateExecutor(commits, deploymentOutput);
    const worker = new RunnerWorker(
      client,
      state,
      outbox,
      executor,
      new AttachmentMaterializer(client, paths),
      1,
      quietOutput,
      {
        prepare: async (repositoryPath) => ({
          kind: 'EXECUTE' as const,
          cwd: repositoryPath,
        }),
      },
    );

    expect(await worker.cycle(0)).toBe(1);
    await worker.waitForIdle();
    expect(executor.input?.executionId).toBe(frozen.executionId);
    expect(executor.input?.prompt.indexOf(commits[0]!)).toBeLessThan(
      executor.input?.prompt.indexOf(commits[1]!) ?? -1,
    );
    expect(latestBatch(fixture.database, fixture.item.id).state).toBe(
      'COMPLETED',
    );
    expect(await readFile(deploymentOutput, 'utf8')).toBe('deployed\n');
    expect(
      (await runGit(repository, ['rev-list', '--count', 'origin/main'])).trim(),
    ).toBe('3');
    expect(await outbox.list()).toEqual([]);
  });
});

class GitUpdateExecutor implements CodexExecutor {
  input: CodexExecutionInput | null = null;

  constructor(
    private readonly commits: string[],
    private readonly deploymentOutput: string,
  ) {}

  async begin(
    input: CodexExecutionInput,
    _signal: AbortSignal,
  ): Promise<StartedCodexExecution> {
    this.input = input;
    return {
      sessionId: input.resumeSessionId ?? 'update-e2e-session',
      completion: this.execute(input),
    };
  }

  private async execute(input: CodexExecutionInput): Promise<JsonValue> {
    await runGit(input.repositoryPath, ['cherry-pick', ...this.commits]);
    await runGit(input.repositoryPath, ['push', 'origin', 'main']);
    const deployment = Bun.spawn(['bun', 'run', 'deploy:test'], {
      cwd: input.repositoryPath,
      env: { ...process.env, DEPLOYMENT_OUTPUT: this.deploymentOutput },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(deployment.stderr).text(),
      deployment.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return completedUpdate('普通 Push 和本地脚本完成');
  }
}

function completedUpdate(summary: string) {
  return {
    outcome: 'COMPLETED' as const,
    summary,
    completedActions: ['集成候选并完成部署'],
    validations: [{ name: '定向检查', status: 'PASSED' as const }],
    warnings: [],
  };
}

function pushedUpdate(summary: string) {
  return {
    outcome: 'PUSHED' as const,
    summary,
    completedActions: ['集成候选并普通 Push'],
    validations: [{ name: '定向检查', status: 'PASSED' as const }],
    warnings: [],
  };
}

function failedUpdate(summary: string) {
  return {
    outcome: 'FAILED' as const,
    summary,
    failedStep: '执行统一更新',
    reason: summary,
    completedActions: [],
    pendingActions: ['修正失败原因后重新执行'],
  };
}

async function completeNextRepair(
  fixture: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
  commits: string[],
): Promise<void> {
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  fixture.executions.start(fixture.runner.id, claimed.id, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId,
  });
  fixture.executions.complete(fixture.runner.id, claimed.id, {
    leaseToken: claimed.lease.token,
    sessionId,
    outcome: {
      kind: 'SUCCEEDED',
      result: {
        outcome: 'COMPLETED',
        summary: '修复完成',
        changes: ['完成缺陷修复'],
        validations: [{ name: '定向测试', status: 'PASSED' }],
        warnings: [],
        commits,
      },
    },
  });
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

async function initializeIntegrationRepository(
  repository: string,
  remote: string,
  deploymentOutput: string,
): Promise<string[]> {
  await mkdir(repository, { recursive: true });
  await runGit(repository, ['init', '--initial-branch=main']);
  await runGit(repository, ['config', 'user.email', 'update@example.com']);
  await runGit(repository, ['config', 'user.name', 'Update Fixture']);
  await Bun.write(
    join(repository, 'package.json'),
    `${JSON.stringify({
      scripts: { 'deploy:test': 'node deploy.mjs' },
    })}\n`,
  );
  await Bun.write(
    join(repository, 'deploy.mjs'),
    `import { writeFile } from 'node:fs/promises';\nawait writeFile(process.env.DEPLOYMENT_OUTPUT, 'deployed\\n');\n`,
  );
  await Bun.write(join(repository, 'base.txt'), 'base\n');
  await runGit(repository, ['add', '.']);
  await runGit(repository, [
    'commit',
    '-m',
    'chore: initialize update fixture',
  ]);
  await runGit(repository, ['init', '--bare', remote]);
  await runGit(repository, ['remote', 'add', 'origin', remote]);
  await runGit(repository, ['push', '-u', 'origin', 'main']);
  const base = (await runGit(repository, ['rev-parse', 'HEAD'])).trim();

  await appendFile(join(repository, 'feature.txt'), 'repair one\n');
  await runGit(repository, ['add', 'feature.txt']);
  await runGit(repository, ['commit', '-m', 'fix: repair one']);
  const first = (await runGit(repository, ['rev-parse', 'HEAD'])).trim();
  await appendFile(join(repository, 'feature.txt'), 'repair two\n');
  await runGit(repository, ['add', 'feature.txt']);
  await runGit(repository, ['commit', '-m', 'fix: repair two']);
  const second = (await runGit(repository, ['rev-parse', 'HEAD'])).trim();
  await runGit(repository, ['reset', '--hard', base]);
  await rm(deploymentOutput, { force: true });
  return [first, second];
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

function mutableClock(initial: string) {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    set: (next: string) => {
      value = new Date(next);
    },
  };
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

const quietOutput = { log: () => {}, error: () => {} };
