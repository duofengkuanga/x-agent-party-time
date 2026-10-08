import { cookingRunnerFetch } from '@/cooking/runtime/runner-http';
import { createCooking } from '@/cooking/runtime/create-cooking';
import {
  completeRepairExecution,
  testSkillBinding,
} from '@/cooking/testing/execution';
import {
  deliveryProject,
  mutableClock,
  mutation,
} from '@/cooking/testing/project';
import type { AppDatabase } from '@/platform/database';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { testDatabases } from '@/testing/database';
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Each test file owns its database factory and cleanup hook. */
export function updateFixture(
  createDatabase: ReturnType<typeof testDatabases>,
) {
  return (options: Parameters<typeof setup>[1] = {}) =>
    setup(createDatabase, options);
}

async function setup(
  createDatabase: ReturnType<typeof testDatabases>,
  options: {
    updateCreateId?: () => string;
    secondItem?: boolean;
    deploymentKind?: 'LOCAL_SCRIPT' | 'CI_CD';
  } = {},
) {
  const { directory, database } = await createDatabase();
  const clock = mutableClock('2026-07-27T10:00:00.000Z');
  const { users, runners, pairedRunner, runner, submission, sources, items } =
    await deliveryProject(database, {
      name: 'Update 项目',
      prefix: 'update',
      title: '支付功能提测',
      description: '验证统一更新链路',
      sources: [
        {
          name: '支付工程',
          type: 'BACKEND',
          identifier: 'payment-api',
          environment: '支付测试环境',
          deployment:
            options.deploymentKind === 'CI_CD'
              ? { kind: 'CI_CD' }
              : { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
          repository: 'https://example.com/payment.git',
          branch: 'main',
        },
        ...(options.secondItem
          ? [
              {
                name: '订单工程',
                type: 'BACKEND' as const,
                identifier: 'order-api',
                environment: '订单测试环境',
                deployment: {
                  kind: 'LOCAL_SCRIPT' as const,
                  command: 'bun run deploy:order',
                },
                repository: 'https://example.com/order.git',
                branch: 'main',
              },
            ]
          : []),
      ],
    });
  const { binding } = sources[0]!;
  const secondBinding = sources[1]?.binding ?? null;
  const item = items[0]!;
  const secondItem = items[1] ?? null;
  const events: Array<{ submissionId: string; revision: number }> = [];
  const { repairs, updates, bugs, executions } = createCooking(database, {
    now: clock.now,
    publish: (submissionId, revision) =>
      events.push({ submissionId, revision }),
    ids: { update: options.updateCreateId },
  });

  function createBugFor(submissionItemId: string, title: string) {
    const created = bugs.createBug(users.tester.id, submission.id, {
      mutationId: randomUUID(),
      submissionItemId,
      title,
      actualResultAttachmentIds: [],
      expectedResultAttachmentIds: [],
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

export function completedUpdate(_summary: string) {
  return {
    result: {
      outcome: 'COMPLETED' as const,
      completedActions: ['集成候选并完成部署'],
      validations: [
        { name: '定向检查', status: 'PASSED' as const, detail: '' },
      ],
      warnings: [],
    },
  };
}

export function pushedUpdate(_summary: string) {
  return {
    result: {
      outcome: 'PUSHED' as const,
      completedActions: ['集成候选并普通 Push'],
      validations: [
        { name: '定向检查', status: 'PASSED' as const, detail: '' },
      ],
      warnings: [],
    },
  };
}

export function failedUpdate(summary: string) {
  return {
    result: {
      outcome: 'FAILED' as const,
      failedStep: '执行统一更新',
      reason: summary,
      completedActions: [],
      validations: [],
      warnings: [],
      pendingActions: ['修正失败原因后重新执行'],
    },
  };
}

export async function completeNextRepair(
  fixture: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
  commits: string[],
  manualOperations: Array<{ kind: 'DATABASE_SQL'; paths: string[] }> = [],
): Promise<void> {
  const claimed = (await fixture.executions.claim(fixture.runner.id, 1, 0))[0]!;
  completeRepairExecution(
    fixture,
    claimed.id,
    claimed.lease.token,
    sessionId,
    commits,
    manualOperations,
  );
}

export function freezeUpdate(
  fixture: Awaited<ReturnType<typeof setup>>,
  submissionItemId = fixture.item.id,
) {
  return fixture.updates.freezeNow(
    fixture.users.developer.id,
    submissionItemId,
    { mutationId: randomUUID() },
  );
}

export async function startCandidateUpdate(
  fixture: Awaited<ReturnType<typeof setup>>,
  title: string,
  repairSessionId: string,
  commits: string[],
  updateSessionId: string,
  manualOperations: Array<{ kind: 'DATABASE_SQL'; paths: string[] }> = [],
) {
  const bug = fixture.createBug(title);
  await completeNextRepair(fixture, repairSessionId, commits, manualOperations);
  const frozen = freezeUpdate(fixture);
  const started = await startExecution(
    fixture,
    frozen.executionId!,
    updateSessionId,
  );
  return { bug, started };
}

export async function startExecution(
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
    taskSkillBinding: testSkillBinding(
      'agent-party-time-integrate-update-batch',
    ),
  });
  return {
    executionId,
    leaseToken: claimed.lease.token,
    sessionId,
  };
}

export function pending(database: AppDatabase, submissionItemId: string) {
  return database.get(
    `SELECT last_candidate_at, eligible_at FROM cooking_pending_delivery
       WHERE submission_item_id = ?`,
    submissionItemId,
  ) as { last_candidate_at: string; eligible_at: string } | undefined;
}

export function latestBatch(database: AppDatabase, submissionItemId: string) {
  return database.get(
    `SELECT id, state, version, active_execution_id
       FROM cooking_update_batch WHERE submission_item_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    submissionItemId,
  ) as {
    id: string;
    state: string;
    version: number;
    active_execution_id: string | null;
  };
}

export function batchEntries(database: AppDatabase, batchId: string) {
  return (
    database.all(
      `SELECT bug_id, commits_json FROM cooking_update_batch_entry
         WHERE batch_id = ? ORDER BY position`,
      batchId,
    ) as Array<{ bug_id: string; commits_json: string }>
  ).map((row) => ({
    bug_id: row.bug_id,
    commits: JSON.parse(row.commits_json),
  }));
}

export function currentBug(database: AppDatabase, bugId: string) {
  return database.get(
    'SELECT stage, version FROM cooking_bug WHERE id = ?',
    bugId,
  ) as { stage: string; version: number };
}

export function pendingCommits(database: AppDatabase, bugId: string): string[] {
  const row = database.get(
    'SELECT pending_commits_json FROM cooking_bug_repair_context WHERE bug_id = ?',
    bugId,
  ) as { pending_commits_json: string };
  return JSON.parse(row.pending_commits_json) as string[];
}

export function updateProtocolFetch(
  fixture: Awaited<ReturnType<typeof setup>>,
): ReturnType<typeof cookingRunnerFetch> {
  return cookingRunnerFetch(fixture.database, {
    runners: fixture.runners,
    executions: fixture.executions,
    files: new LocalFileStore(
      fixture.database,
      join(fixture.directory, 'files'),
    ),
    prepare: () => {},
  });
}
