import { createCooking } from '@/cooking/runtime/create-cooking';
import { completeRepairExecution, testSkillBinding } from '@/cooking/testing/execution';
import { deliveryProject, mutableClock, mutation } from '@/cooking/testing/project';
import type { AppDatabase } from '@/platform/database';
import { testDatabases } from '@/testing/database';
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';

/** Each scenario file owns its database factory and cleanup hook. */
export function lifecycleFixture(createDatabase: ReturnType<typeof testDatabases>) {
  return () => setup(createDatabase);
}

async function setup(createDatabase: ReturnType<typeof testDatabases>) {
  const { directory, database } = await createDatabase();
  const clock = mutableClock('2026-07-27T12:00:00.000Z');
  const {
    users,
    engineering,
    pairedRunner: paired,
    project,
    submission,
    submissions,
    sources,
    items,
  } = await deliveryProject(database, {
    name: '生命周期项目',
    prefix: 'lifecycle',
    title: '双工程提测',
    description: '验证关闭与清理闭环',
    now: clock.now,
    sources: [
      {
        name: '本地脚本工程',
        type: 'FRONTEND',
        identifier: 'local-web',
        environment: '本地测试环境',
        deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
        repository: 'https://example.com/local.git',
        branch: 'main',
      },
      {
        name: '持续集成工程',
        type: 'BACKEND',
        identifier: 'ci-api',
        environment: '持续集成环境',
        deployment: { kind: 'CI_CD' },
        repository: 'https://example.com/ci.git',
        branch: 'main',
      },
    ],
  });
  const { source: localEngineering, environment: localEnvironment } = sources[0]!;
  const { source: ciEngineering, environment: ciEnvironment } = sources[1]!;
  const events: Array<{ submissionId: string; revision: number }> = [];
  const { repairs, updates, lifecycle, bugs, executions } = createCooking(database, {
    now: clock.now,
    publish: (submissionId, revision) => events.push({ submissionId, revision }),
  });

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

export function createBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  submissionItemId: string,
  title: string,
) {
  return fixture.bugs.createBug(fixture.users.tester.id, fixture.submission.id, {
    mutationId: randomUUID(),
    submissionItemId,
    title,
    actualResultAttachmentIds: [],
    expectedResultAttachmentIds: [],
  }).bug;
}

export function createAndRequestBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  submissionItemId: string,
  title: string,
) {
  const created = createBug(fixture, submissionItemId, title);
  return fixture.bugs.requestRepair(
    fixture.users.tester.id,
    created.id,
    mutation(created.version),
  ).bug;
}

export async function completeNextRepair(
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

export async function completeClaimedRepair(
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
  completeRepairExecution(fixture, executionId, leaseToken, sessionId, commits);
}

export async function completeUpdate(
  fixture: Awaited<ReturnType<typeof setup>>,
  submissionItemId: string,
  result: { outcome: 'COMPLETED' | 'PUSHED'; summary: string },
) {
  const frozen = fixture.updates.freezeNow(fixture.users.developer.id, submissionItemId, {
    mutationId: randomUUID(),
  });
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  expect(claimed.id).toBe(frozen.executionId!);
  fixture.executions.start(fixture.runner.id, claimed.id, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId: `update-${submissionItemId}`,
    taskSkillBinding: testSkillBinding('agent-party-time-integrate-update-batch'),
  });
  fixture.executions.complete(fixture.runner.id, claimed.id, {
    leaseToken: claimed.lease.token,
    sessionId: `update-${submissionItemId}`,
    outcome: {
      kind: 'SUCCEEDED',
      result: {
        result: {
          outcome: result.outcome,
          completedActions: ['集成候选并完成更新'],
          validations: [{ name: '定向检查', status: 'PASSED', detail: '' }],
          warnings: [],
        },
      },
    },
  });
  return latestBatch(fixture.database, submissionItemId);
}

export async function completeCleanup(
  fixture: Awaited<ReturnType<typeof setup>>,
  executionId: string,
  sessionId: string,
  result: { outcome: 'COMPLETED' | 'FAILED'; summary: string },
) {
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0)).find(
    ({ id }) => id === executionId,
  );
  if (!claimed) throw new Error('未领取到指定清理执行');
  fixture.executions.start(fixture.runner.id, executionId, {
    kind: 'STARTED',
    leaseToken: claimed.lease.token,
    sessionId,
    taskSkillBinding: null,
  });
  fixture.executions.complete(fixture.runner.id, executionId, {
    leaseToken: claimed.lease.token,
    sessionId,
    outcome: { kind: 'SUCCEEDED', result },
  });
  return fixture.database.get(
    `SELECT cleanup.id cleanupId, cleanup.state
       FROM cooking_cleanup_attempt attempt
       JOIN cooking_cleanup cleanup ON cleanup.id = attempt.cleanup_id
       WHERE attempt.execution_id = ?`,
    executionId,
  ) as { cleanupId: string; state: string };
}

export function latestBatch(database: AppDatabase, submissionItemId: string) {
  return database.get(
    `SELECT id, state, version FROM cooking_update_batch
       WHERE submission_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    submissionItemId,
  ) as { id: string; state: string; version: number };
}

export function currentBug(database: AppDatabase, bugId: string) {
  return database.get(
    'SELECT stage, version, archived_at FROM cooking_bug WHERE id = ?',
    bugId,
  ) as {
    stage: string;
    version: number;
    archived_at: string | null;
  };
}

export function submissionRow(database: AppDatabase, submissionId: string) {
  return database.get(
    `SELECT status, version, workspace_revision, closed_at
       FROM cooking_test_submission WHERE id = ?`,
    submissionId,
  ) as {
    status: 'ACTIVE' | 'CLOSED';
    version: number;
    workspace_revision: number;
    closed_at: string | null;
  };
}

export function bindingForItem(database: AppDatabase, submissionItemId: string): string {
  return (
    database.get(
      'SELECT binding_id FROM cooking_submission_item WHERE id = ?',
      submissionItemId,
    ) as { binding_id: string }
  ).binding_id;
}

export function createTakeoverSubmission(
  fixture: Awaited<ReturnType<typeof setup>>,
  title: string,
  requirementDescription: string,
) {
  const view = fixture.submissions.getWorkspace(
    fixture.users.developer.id,
    fixture.submission.id,
  );
  const item = view.submission.items[0]!;
  const input = {
    mutationId: randomUUID(),
    title,
    requirementDescription,
    testerUserId: fixture.users.tester.id,
    items: [
      {
        engineeringId: item.engineering.id,
        responsibleUserId: item.responsibleUser.id,
        bindingId: item.technical!.bindingId,
        targetBranch: item.targetBranch,
        environmentId: item.environment.id,
      },
    ],
  };
  const next = fixture.submissions.createSubmission(
    fixture.users.owner.id,
    fixture.project.id,
    {
      ...input,
      environmentTakeovers: fixture.submissions.environmentConflicts(
        fixture.users.owner.id,
        fixture.project.id,
        input,
      ),
    },
  );
  return { next, item };
}
