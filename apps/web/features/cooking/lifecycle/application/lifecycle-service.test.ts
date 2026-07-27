import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { ExecutionService } from '@/server/execution/service';
import { LocalFileStore } from '@/server/files/local-file-store';
import { RunnerService } from '@/server/runner/service';
import { BindingService } from '@/features/cooking/bindings/application/binding-service';
import { BugService } from '@/features/cooking/bugs/application/bug-service';
import { EngineeringService } from '@/features/cooking/engineering/application/engineering-service';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import { RepairService } from '@/features/cooking/repair/application/repair-service';
import { SubmissionService } from '@/features/cooking/submissions/application/submission-service';
import { UpdateService } from '@/features/cooking/update/application/update-service';
import { LifecycleService } from './lifecycle-service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-lifecycle-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const clock = mutableClock('2026-07-27T12:00:00.000Z');
  const auth = new AuthService(database);
  const users = {
    owner: await auth.seedUser(user('lifecycle-owner', '项目所有者')),
    tester: await auth.seedUser(user('lifecycle-tester', '测试负责人')),
    developer: await auth.seedUser(user('lifecycle-developer', '工程负责人')),
  };
  const projects = new ProjectService(database);
  const project = projects.createProject(users.owner.id, {
    mutationId: randomUUID(),
    name: '生命周期项目',
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
  const localEngineering = engineering.createEngineering(
    users.owner.id,
    project.id,
    {
      mutationId: randomUUID(),
      name: '本地脚本工程',
      repositoryUrl: 'https://example.com/local.git',
    },
  );
  const ciEngineering = engineering.createEngineering(
    users.owner.id,
    project.id,
    {
      mutationId: randomUUID(),
      name: '持续集成工程',
      repositoryUrl: 'https://example.com/ci.git',
    },
  );
  for (const item of [localEngineering, ciEngineering])
    engineering.addMember(users.owner.id, item.id, users.developer.id, {
      mutationId: randomUUID(),
    });
  const localEnvironment = engineering.createEnvironment(
    users.owner.id,
    localEngineering.id,
    {
      mutationId: randomUUID(),
      name: '本地测试环境',
      deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
    },
  );
  const ciEnvironment = engineering.createEnvironment(
    users.owner.id,
    ciEngineering.id,
    {
      mutationId: randomUUID(),
      name: '持续集成环境',
      deployment: { kind: 'CI_CD' },
    },
  );
  const runners = new RunnerService(database);
  const paired = runners.pair(
    runners.issuePairingCode(users.developer.id).code,
    '生命周期 Runner',
  );
  const bindings = new BindingService(database);
  const localBinding = bindings.createBinding(
    users.developer.id,
    localEngineering.id,
    paired.runner.id,
    randomUUID(),
  );
  const ciBinding = bindings.createBinding(
    users.developer.id,
    ciEngineering.id,
    paired.runner.id,
    randomUUID(),
  );
  const submissions = new SubmissionService(database, clock.now);
  const submission = submissions.createSubmission(users.owner.id, project.id, {
    mutationId: randomUUID(),
    title: '双工程提测',
    requirementDescription: '验证关闭与清理闭环',
    testerUserId: users.tester.id,
    items: [
      {
        engineeringId: localEngineering.id,
        responsibleUserId: users.developer.id,
        bindingId: localBinding.id,
        targetBranch: 'main',
        environmentId: localEnvironment.id,
      },
      {
        engineeringId: ciEngineering.id,
        responsibleUserId: users.developer.id,
        bindingId: ciBinding.id,
        targetBranch: 'main',
        environmentId: ciEnvironment.id,
      },
    ],
  });
  const items = database
    .prepare(
      `SELECT id, environment_id FROM cooking_submission_item
       WHERE submission_id = ? ORDER BY position`,
    )
    .all(submission.id) as Array<{ id: string; environment_id: string }>;
  const events: Array<{ submissionId: string; revision: number }> = [];
  const updates = new UpdateService(
    database,
    new ExecutionService(database, clock.now),
    clock.now,
    undefined,
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
  const lifecycle = new LifecycleService(
    database,
    repairs,
    new ExecutionService(database, clock.now),
    clock.now,
    undefined,
    (submissionId, revision) => events.push({ submissionId, revision }),
    {
      bugCancelled: (bugId) => updates.recalculatePendingDeliveryForBug(bugId),
    },
  );
  let leaseIndex = 0;
  const executions = new ExecutionService(
    database,
    clock.now,
    undefined,
    () => `lifecycle-lease-${++leaseIndex}`.padEnd(48, 'x'),
    15_000,
    {
      applyStarted: (execution) => {
        repairs.applyStartedExecution(execution);
        updates.applyStartedExecution(execution);
        lifecycle.applyStartedExecution(execution);
      },
      afterStarted: (execution) => {
        repairs.afterStartedExecution(execution);
        updates.afterStartedExecution(execution);
        lifecycle.afterStartedExecution(execution);
      },
      applyTerminal: (execution) => {
        repairs.applyTerminalExecution(execution);
        updates.applyTerminalExecution(execution);
        lifecycle.applyTerminalExecution(execution);
      },
      afterTerminal: (execution) => {
        repairs.afterTerminalExecution(execution);
        updates.afterTerminalExecution(execution);
        lifecycle.afterTerminalExecution(execution);
      },
      applyInteractionOpened: (interaction) =>
        lifecycle.applyInteractionOpened(
          interaction.executionId,
          interaction.id,
        ),
      afterInteractionOpened: (interaction) =>
        lifecycle.afterInteractionOpened(interaction.executionId),
    },
  );
  const bugs = new BugService(
    database,
    clock.now,
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
  return {
    bugs,
    ciEnvironment,
    clock,
    database,
    directory,
    engineering,
    events,
    executions,
    items,
    lifecycle,
    localEngineering,
    ciEngineering,
    localEnvironment,
    paired,
    project,
    repairs,
    runner: paired.runner,
    submission,
    submissions,
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

describe('LifecycleService', () => {
  test('验证失败自动沿用 Repair Session，再次更新通过后关闭并异步清理', async () => {
    const fixture = await setup();
    const localBug = createAndRequestBug(
      fixture,
      fixture.items[0]!.id,
      '本地缺陷',
    );
    await completeNextRepair(fixture, 'repair-local', ['1111111']);
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '本地部署完成',
    });
    const ciBug = createAndRequestBug(
      fixture,
      fixture.items[1]!.id,
      '持续集成缺陷',
    );
    await completeNextRepair(fixture, 'repair-ci', ['2222222']);
    const ciBatch = await completeUpdate(fixture, fixture.items[1]!.id, {
      outcome: 'PUSHED',
      summary: '已普通 Push',
    });
    fixture.updates.reportExternalDeployment(
      fixture.users.developer.id,
      ciBatch.id,
      {
        mutationId: randomUUID(),
        expectedVersion: latestBatch(fixture.database, fixture.items[1]!.id)
          .version,
        outcome: 'SUCCEEDED',
        summary: '外部部署成功',
        attachmentIds: [],
      },
    );
    expect(currentBug(fixture.database, localBug.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );
    expect(currentBug(fixture.database, ciBug.id).stage).toBe(
      'WAITING_FOR_VERIFICATION',
    );

    const files = new LocalFileStore(
      fixture.database,
      join(fixture.directory, 'files'),
      fixture.clock.now,
    );
    const evidence = await files.put({
      bytes: new TextEncoder().encode('still broken'),
      originalName: 'verification.txt',
      mediaType: 'text/plain',
      uploadedByUserId: fixture.users.tester.id,
    });
    expect(() =>
      fixture.lifecycle.verifyBug(fixture.users.developer.id, localBug.id, {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, localBug.id).version,
        result: 'FAILED',
        feedback: '仍可复现',
        attachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const failed = fixture.lifecycle.verifyBug(
      fixture.users.tester.id,
      localBug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, localBug.id).version,
        result: 'FAILED',
        feedback: '仍可复现，请检查边界条件',
        attachmentIds: [evidence.id],
      },
    );
    expect(currentBug(fixture.database, localBug.id).stage).toBe('REPAIRING');
    const continued = fixture.executions.get(failed.executionId!);
    expect(continued.resumeSessionId).toBe('repair-local');
    expect(continued.priority).toBe(-1_500_000);
    expect(continued.renderedPrompt).toContain('第 1 轮验证失败');
    expect(
      fixture.database
        .prepare(
          `SELECT file_id FROM platform_execution_attachment
           WHERE execution_id = ?`,
        )
        .all(failed.executionId!),
    ).toEqual([{ file_id: evidence.id }]);

    await completeClaimedRepair(fixture, failed.executionId!, 'repair-local', [
      '3333333',
    ]);
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '再次部署完成',
    });
    const passed = fixture.lifecycle.verifyBug(
      fixture.users.tester.id,
      localBug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, localBug.id).version,
        result: 'PASSED',
        comment: '边界场景已通过',
        attachmentIds: [],
      },
    );
    expect(passed.executionId).toBeNull();
    expect(currentBug(fixture.database, localBug.id).stage).toBe('DONE');
    fixture.lifecycle.verifyBug(fixture.users.tester.id, ciBug.id, {
      mutationId: randomUUID(),
      expectedVersion: currentBug(fixture.database, ciBug.id).version,
      result: 'PASSED',
      attachmentIds: [],
    });
    expect(currentBug(fixture.database, ciBug.id).stage).toBe('DONE');

    const beforeClose = submissionRow(fixture.database, fixture.submission.id);
    const closed = fixture.lifecycle.closeSubmission(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        expectedVersion: beforeClose.version,
      },
    );
    expect(closed.cleanupExecutionIds).toHaveLength(2);
    expect(
      submissionRow(fixture.database, fixture.submission.id),
    ).toMatchObject({
      status: 'CLOSED',
      version: beforeClose.version + 1,
    });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) count FROM cooking_submission_environment_lock
           WHERE submission_id = ?`,
        )
        .get(fixture.submission.id),
    ).toEqual({ count: 0 });
    const replacement = fixture.submissions.createSubmission(
      fixture.users.owner.id,
      fixture.project.id,
      {
        mutationId: randomUUID(),
        title: '环境复用提测',
        requirementDescription: '关闭后环境可以再次占用',
        testerUserId: fixture.users.tester.id,
        items: fixture.items.map((item, index) => ({
          engineeringId:
            index === 0
              ? fixture.localEngineering.id
              : fixture.ciEngineering.id,
          responsibleUserId: fixture.users.developer.id,
          bindingId:
            index === 0
              ? bindingForItem(fixture.database, fixture.items[0]!.id)
              : bindingForItem(fixture.database, fixture.items[1]!.id),
          targetBranch: 'main',
          environmentId: item.environment_id,
        })),
      },
    );
    expect(replacement.status).toBe('ACTIVE');

    const cleanupExecutions = closed.cleanupExecutionIds;
    const claimedCleanup = (
      await fixture.executions.claim(fixture.runner.id, 1, 0)
    ).find(({ id }) => id === cleanupExecutions[0]);
    if (!claimedCleanup) throw new Error('未领取到首个清理执行');
    fixture.executions.start(fixture.runner.id, claimedCleanup.id, {
      kind: 'STARTED',
      leaseToken: claimedCleanup.lease.token,
      sessionId: 'cleanup-session',
    });
    const cleanupInteraction = fixture.executions.openInteraction(
      fixture.runner.id,
      claimedCleanup.id,
      {
        leaseToken: claimedCleanup.lease.token,
        kind: 'APPROVAL',
        method: 'item/commandExecution/requestApproval',
        payload: {
          cwd: '/Users/example/private-repository',
          command: 'rm -rf /Users/example/private-repository/worktree',
          reason: '清理提测临时资源',
        },
      },
    );
    const testerCleanupInteraction = fixture.lifecycle.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).cleanupInteractions[0]!;
    const developerWorkspace = fixture.lifecycle.workspace(
      fixture.users.developer.id,
      fixture.submission.id,
    );
    const developerCleanupInteraction =
      developerWorkspace.cleanupInteractions[0]!;
    const runningCleanup = developerWorkspace.cleanups.find(
      ({ id }) => id === developerCleanupInteraction.cleanupId,
    )!;
    expect(testerCleanupInteraction).toMatchObject({
      method: null,
      payload: null,
      canResolve: false,
    });
    expect(developerCleanupInteraction).toMatchObject({
      method: 'item/commandExecution/requestApproval',
      payload: {
        command: 'rm -rf 本机路径已隐藏',
        reason: '清理提测临时资源',
      },
      canResolve: true,
    });
    expect(JSON.stringify(developerCleanupInteraction)).not.toContain(
      '/Users/example',
    );
    expect(() =>
      fixture.lifecycle.resolveCleanupInteraction(
        fixture.users.owner.id,
        cleanupInteraction.id,
        {
          mutationId: randomUUID(),
          expectedVersion: runningCleanup.version,
          resolution: { decision: 'decline' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const resolvedCleanupInteraction =
      fixture.lifecycle.resolveCleanupInteraction(
        fixture.users.developer.id,
        cleanupInteraction.id,
        {
          mutationId: randomUUID(),
          expectedVersion: runningCleanup.version,
          resolution: { decision: 'decline' },
        },
      );
    expect(resolvedCleanupInteraction.cleanupVersion).toBe(
      runningCleanup.version + 1,
    );
    expect(
      fixture.database
        .prepare(
          'SELECT state FROM platform_execution_interaction WHERE id = ?',
        )
        .get(cleanupInteraction.id),
    ).toEqual({ state: 'RESOLVED' });
    fixture.executions.complete(fixture.runner.id, claimedCleanup.id, {
      leaseToken: claimedCleanup.lease.token,
      sessionId: 'cleanup-session',
      outcome: {
        kind: 'SUCCEEDED',
        result: { outcome: 'FAILED', summary: 'Worktree 被占用' },
      },
    });
    const failedCleanup = fixture.database
      .prepare(
        `SELECT cleanup.id cleanupId, cleanup.state
         FROM cooking_cleanup_attempt attempt
         JOIN cooking_cleanup cleanup ON cleanup.id = attempt.cleanup_id
         WHERE attempt.execution_id = ?`,
      )
      .get(claimedCleanup.id) as { cleanupId: string; state: string };
    await completeCleanup(
      fixture,
      cleanupExecutions[1]!,
      'cleanup-ci-session',
      { outcome: 'COMPLETED', summary: '资源不存在，幂等完成' },
    );
    expect(submissionRow(fixture.database, fixture.submission.id).status).toBe(
      'CLOSED',
    );
    const cleanup = fixture.lifecycle
      .workspace(fixture.users.developer.id, fixture.submission.id)
      .cleanups.find(({ id }) => id === failedCleanup.cleanupId)!;
    expect(cleanup.subjectId).toBe(fixture.submission.id);
    expect(cleanup.state).toBe('FAILED');
    expect(cleanup.availableActions).toEqual(['RETRY_CLEANUP']);
    const retried = fixture.lifecycle.retryCleanup(
      fixture.users.developer.id,
      cleanup.id,
      {
        mutationId: randomUUID(),
        expectedVersion: cleanup.version,
      },
    );
    expect(fixture.executions.get(retried.executionId).resumeSessionId).toBe(
      'cleanup-session',
    );
    await completeCleanup(fixture, retried.executionId, 'cleanup-session', {
      outcome: 'COMPLETED',
      summary: '重试完成',
    });
    expect(
      fixture.lifecycle
        .workspace(fixture.users.developer.id, fixture.submission.id)
        .cleanups.find(({ id }) => id === cleanup.id)?.state,
    ).toBe('COMPLETED');
    expect(
      fixture.lifecycle.workspace(
        fixture.users.tester.id,
        fixture.submission.id,
      ).timeline,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '提测单已关闭' }),
        expect.objectContaining({ kind: 'VERIFICATION' }),
        expect.objectContaining({ kind: 'EXTERNAL_DEPLOYMENT' }),
      ]),
    );
  });

  test('DONE 可在活动期重开，关闭后所有 Lifecycle 写操作只读', async () => {
    const fixture = await setup();
    const bug = createAndRequestBug(fixture, fixture.items[0]!.id, '重开缺陷');
    await completeNextRepair(fixture, 'repair-reopen', ['4444444']);
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '部署完成',
    });
    fixture.lifecycle.verifyBug(fixture.users.tester.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: currentBug(fixture.database, bug.id).version,
      result: 'PASSED',
      attachmentIds: [],
    });
    const reopened = fixture.lifecycle.reopenBug(
      fixture.users.tester.id,
      bug.id,
      {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, bug.id).version,
        feedback: '回归时发现新证据',
        attachmentIds: [],
      },
    );
    expect(currentBug(fixture.database, bug.id).stage).toBe('REPAIRING');
    expect(fixture.executions.get(reopened.executionId!).resumeSessionId).toBe(
      'repair-reopen',
    );
    await completeClaimedRepair(
      fixture,
      reopened.executionId!,
      'repair-reopen',
      ['5555555'],
    );
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '重开后部署完成',
    });
    fixture.lifecycle.verifyBug(fixture.users.tester.id, bug.id, {
      mutationId: randomUUID(),
      expectedVersion: currentBug(fixture.database, bug.id).version,
      result: 'PASSED',
      attachmentIds: [],
    });
    const other = fixture.bugs.createBug(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        submissionItemId: fixture.items[1]!.id,
        title: '取消缺陷',
        attachmentIds: [],
      },
    ).bug;
    fixture.lifecycle.cancelBug(fixture.users.tester.id, other.id, {
      mutationId: randomUUID(),
      expectedVersion: other.version,
    });
    expect(currentBug(fixture.database, other.id).stage).toBe('CANCELLED');
    const beforeClose = submissionRow(fixture.database, fixture.submission.id);
    fixture.lifecycle.closeSubmission(
      fixture.users.tester.id,
      fixture.submission.id,
      {
        mutationId: randomUUID(),
        expectedVersion: beforeClose.version,
      },
    );
    expect(() =>
      fixture.lifecycle.reopenBug(fixture.users.tester.id, bug.id, {
        mutationId: randomUUID(),
        expectedVersion: currentBug(fixture.database, bug.id).version,
        feedback: '关闭后不允许',
        attachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(() =>
      fixture.bugs.createBug(fixture.users.tester.id, fixture.submission.id, {
        mutationId: randomUUID(),
        submissionItemId: fixture.items[0]!.id,
        title: '关闭后新增',
        attachmentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });
});

function createAndRequestBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  submissionItemId: string,
  title: string,
) {
  const created = fixture.bugs.createBug(
    fixture.users.tester.id,
    fixture.submission.id,
    {
      mutationId: randomUUID(),
      submissionItemId,
      title,
      attachmentIds: [],
    },
  ).bug;
  return fixture.bugs.requestRepair(
    fixture.users.tester.id,
    created.id,
    mutation(created.version),
  ).bug;
}

async function completeNextRepair(
  fixture: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
  commits: string[],
): Promise<void> {
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  await completeClaimedRepair(
    fixture,
    claimed.id,
    sessionId,
    commits,
    claimed.lease.token,
  );
}

async function completeClaimedRepair(
  fixture: Awaited<ReturnType<typeof setup>>,
  executionId: string,
  sessionId: string,
  commits: string[],
  existingLease?: string,
): Promise<void> {
  const leaseToken =
    existingLease ??
    (await fixture.executions.claim(fixture.runner.id, 1, 0)).find(
      ({ id }) => id === executionId,
    )?.lease.token;
  if (!leaseToken) throw new Error('未领取到指定修复执行');
  fixture.executions.start(fixture.runner.id, executionId, {
    kind: 'STARTED',
    leaseToken,
    sessionId,
  });
  fixture.executions.complete(fixture.runner.id, executionId, {
    leaseToken,
    sessionId,
    outcome: {
      kind: 'SUCCEEDED',
      result: { outcome: 'COMPLETED', summary: '修复完成', commits },
    },
  });
}

async function completeUpdate(
  fixture: Awaited<ReturnType<typeof setup>>,
  submissionItemId: string,
  result: { outcome: 'COMPLETED' | 'PUSHED'; summary: string },
) {
  const frozen = fixture.updates.freezeNow(
    fixture.users.developer.id,
    submissionItemId,
    { mutationId: randomUUID() },
  );
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  expect(claimed.id).toBe(frozen.executionId);
  fixture.executions.start(fixture.runner.id, claimed.id, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId: `update-${submissionItemId}`,
  });
  fixture.executions.complete(fixture.runner.id, claimed.id, {
    leaseToken: claimed.lease.token,
    sessionId: `update-${submissionItemId}`,
    outcome: { kind: 'SUCCEEDED', result },
  });
  return latestBatch(fixture.database, submissionItemId);
}

async function completeCleanup(
  fixture: Awaited<ReturnType<typeof setup>>,
  executionId: string,
  sessionId: string,
  result: { outcome: 'COMPLETED' | 'FAILED'; summary: string },
) {
  const claimed = (
    await fixture.executions.claim(fixture.runner.id, 1, 0)
  ).find(({ id }) => id === executionId);
  if (!claimed) throw new Error('未领取到指定清理执行');
  fixture.executions.start(fixture.runner.id, executionId, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId,
  });
  fixture.executions.complete(fixture.runner.id, executionId, {
    leaseToken: claimed.lease.token,
    sessionId,
    outcome: { kind: 'SUCCEEDED', result },
  });
  return fixture.database
    .prepare(
      `SELECT cleanup.id cleanupId, cleanup.state
       FROM cooking_cleanup_attempt attempt
       JOIN cooking_cleanup cleanup ON cleanup.id = attempt.cleanup_id
       WHERE attempt.execution_id = ?`,
    )
    .get(executionId) as { cleanupId: string; state: string };
}

function latestBatch(database: AppDatabase, submissionItemId: string) {
  return database
    .prepare(
      `SELECT id, state, version FROM cooking_update_batch
       WHERE submission_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(submissionItemId) as { id: string; state: string; version: number };
}

function currentBug(database: AppDatabase, bugId: string) {
  return database
    .prepare('SELECT stage, version FROM cooking_bug WHERE id = ?')
    .get(bugId) as { stage: string; version: number };
}

function submissionRow(database: AppDatabase, submissionId: string) {
  return database
    .prepare(
      `SELECT status, version, workspace_revision, closed_at
       FROM cooking_test_submission WHERE id = ?`,
    )
    .get(submissionId) as {
    status: 'ACTIVE' | 'CLOSED';
    version: number;
    workspace_revision: number;
    closed_at: string | null;
  };
}

function bindingForItem(
  database: AppDatabase,
  submissionItemId: string,
): string {
  return (
    database
      .prepare('SELECT binding_id FROM cooking_submission_item WHERE id = ?')
      .get(submissionItemId) as { binding_id: string }
  ).binding_id;
}

function mutation(expectedVersion: number) {
  return { mutationId: randomUUID(), expectedVersion };
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

function user(username: string, displayName: string) {
  return {
    id: randomUUID(),
    username,
    displayName,
    password: 'password',
  };
}
