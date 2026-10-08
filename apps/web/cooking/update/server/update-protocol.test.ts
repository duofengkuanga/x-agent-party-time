import { completeSuccessfulExecution } from '@/cooking/testing/execution';
import { SubmissionService } from '@/cooking/submissions/server/submission-service';
import { mutation } from '@/cooking/testing/project';
import { testDatabases } from '@/testing/database';
import { ProtocolAgent } from '@agent-party-time/runner-conformance';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  completeNextRepair,
  completedUpdate,
  failedUpdate,
  freezeUpdate,
  latestBatch,
  pending,
  pushedUpdate,
  startCandidateUpdate,
  startExecution,
  updateFixture,
  updateProtocolFetch,
} from './update-fixture';

const setup = updateFixture(testDatabases());

describe('UpdateService', () => {
  test('协议级 Agent 按冻结顺序完成 LOCAL_SCRIPT Update Outcome', async () => {
    const fixture = await setup();
    const commits = ['a'.repeat(40), 'b'.repeat(40)];
    fixture.createBug('第一个真实候选');
    await completeNextRepair(fixture, 'repair-one', [commits[0]!]);
    fixture.createBug('第二个真实候选');
    await completeNextRepair(fixture, 'repair-two', [commits[1]!]);
    const frozen = freezeUpdate(fixture);

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
    expect(() => freezeUpdate(fixture)).toThrow('已暂停使用环境');
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
  const { started: running } = await startCandidateUpdate(
    fixture,
    '外部部署占用',
    'external-lock-repair',
    ['ccccccc'],
    'external-lock-update',
  );
  completeSuccessfulExecution(fixture, running, pushedUpdate('等待外部部署'));
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
      ...mutation(waiting.version),
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
      ...mutation(batch.version),
    }),
  ).toThrow('已暂停使用环境');
  expect(() =>
    fixture.updates.synchronizeSession(fixture.users.developer.id, batch.id, {
      ...mutation(batch.version),
    }),
  ).toThrow('已暂停使用环境');
  expect(
    fixture.updates.batchView(fixture.users.developer.id, batch.id)
      .availableActions,
  ).toEqual([]);
});
