import { cookingRunnerFetch } from '@/cooking/runtime/runner-http';
import { createCooking } from '@/cooking/runtime/create-cooking';
import {
  completeClaimedExecution,
  testSkillBinding,
} from '@/cooking/testing/execution';
import { deliveryProject, mutation } from '@/cooking/testing/project';
import type { AppDatabase } from '@/platform/database';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { testDatabases } from '@/testing/database';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Each test file owns its database factory and cleanup hook. */
export function repairFixture(
  createDatabase: ReturnType<typeof testDatabases>,
) {
  return (options: Parameters<typeof setup>[1] = {}) =>
    setup(createDatabase, options);
}

async function setup(
  createDatabase: ReturnType<typeof testDatabases>,
  options: { repairCreateId?: () => string } = {},
) {
  const { directory, database } = await createDatabase();
  const { users, runners, pairedRunner, runner, submission, sources, items } =
    await deliveryProject(database, {
      name: 'Repair 项目',
      prefix: 'repair',
      title: '支付功能提测',
      description: '验证支付修复链路',
      sources: [
        {
          name: '支付工程',
          type: 'BACKEND',
          identifier: 'payment-api',
          environment: '支付测试环境',
          deployment: { kind: 'CI_CD' },
          repository: 'https://example.com/payment.git',
          branch: 'feature/payment',
        },
      ],
    });
  const { binding } = sources[0]!;
  const item = items[0]!;
  const otherRunner = runners.pair(
    runners.issuePairingCode(users.owner.id).code,
    '其他 Runner',
  ).runner;
  const now = () => new Date('2026-07-27T10:00:00.000Z');
  const events: Array<{ submissionId: string; revision: number }> = [];
  const { repairs, bugs, executions } = createCooking(database, {
    now: now,
    publish: (submissionId, revision) =>
      events.push({ submissionId, revision }),
    ids: { repair: options.repairCreateId },
  });
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

export function repairProtocolFetch(
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

export async function requestSyncAfterFailure(
  fixture: Awaited<ReturnType<typeof setup>>,
) {
  const started = await startLatest(fixture, 'manual-repair-session');
  completeClaimedExecution(fixture, started, {
    kind: 'FAILED',
    failure: {
      code: 'CODEX_EXECUTION_FAILED',
      message: '首次失败',
      retryable: true,
    },
  });
  const synced = fixture.repairs.synchronizeSession(
    fixture.users.developer.id,
    fixture.requested.bug.id,
    {
      mutationId: randomUUID(),
      expectedVersion: currentBug(fixture.database, fixture.requested.bug.id)
        .version,
    },
  );
  const [claimed] = await fixture.executions.claim(fixture.runner.id, 1, 0);
  if (!claimed) throw new Error('缺少同步 Execution');
  return { started, synced, claimed };
}

export async function startLatest(
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

export function latestAttempt(database: AppDatabase, bugId: string) {
  return database.get(
    `SELECT id, execution_id, attempt FROM cooking_repair_attempt
       WHERE bug_id = ? ORDER BY attempt DESC LIMIT 1`,
    bugId,
  ) as { id: string; execution_id: string; attempt: number };
}

export function currentBug(database: AppDatabase, bugId: string) {
  return database.get(
    'SELECT stage, version FROM cooking_bug WHERE id = ?',
    bugId,
  ) as { stage: string; version: number };
}
