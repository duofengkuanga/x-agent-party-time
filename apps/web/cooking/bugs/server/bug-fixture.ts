import { projectScenario, engineeringScenario } from '@/cooking/testing/scenario';
import { SubmissionService } from '@/cooking/submissions/server/submission-service';
import { LocalFileStore } from '@/platform/files/local-file-store';
import { RunnerService } from '@/platform/runner/service';
import { testDatabases } from '@/testing/database';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BugService } from './bug-service';

/** Each importing test file owns its database cleanup hook. */
export function bugFixture(createDatabase: ReturnType<typeof testDatabases>) {
  return () => setup(createDatabase);
}

async function setup(createDatabase: ReturnType<typeof testDatabases>) {
  const { directory, database } = await createDatabase();
  const people = {
    owner: ['bug-owner', '项目所有者'],
    tester: ['bug-tester', '测试负责人'],
    developerA: ['bug-dev-a', '开发甲'],
    developerB: ['bug-dev-b', '开发乙'],
    member: ['bug-member', '普通成员'],
    outsider: ['bug-outsider', '项目外用户'],
  } satisfies Record<string, [string, string]>;
  const { users, project } = await projectScenario<keyof typeof people>(database, {
    name: '缺陷协作项目',
    owner: 'owner',
    members: ['tester', 'developerA', 'developerB', 'member'],
    people,
  });
  const runners = new RunnerService(database);
  const runnerA = runners.pair(
    runners.issuePairingCode(users.developerA.id).code,
    '开发甲 Runner',
  );
  const runnerB = runners.pair(
    runners.issuePairingCode(users.developerB.id).code,
    '开发乙 Runner',
  );
  const front = engineeringScenario(database, users.owner.id, project.id, {
    name: '前端工程',
    type: 'FRONTEND',
    identifier: 'web',
    environment: '前端测试环境',
    deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
    repository: 'https://example.com/front.git',
    developers: {
      developer: { userId: users.developerA.id, runnerId: runnerA.runner.id },
    },
  });
  const back = engineeringScenario(database, users.owner.id, project.id, {
    name: '后端工程',
    type: 'BACKEND',
    identifier: 'api',
    environment: '后端测试环境',
    deployment: { kind: 'CI_CD' },
    repository: 'https://example.com/back.git',
    developers: {
      developer: { userId: users.developerB.id, runnerId: runnerB.runner.id },
    },
  });
  const submission = new SubmissionService(database).createSubmission(
    users.owner.id,
    project.id,
    {
      mutationId: randomUUID(),
      title: '双工程提测',
      requirementDescription: '验证全局缺陷队列',
      testerUserId: users.tester.id,
      items: [
        {
          engineeringId: front.source.id,
          responsibleUserId: users.developerA.id,
          bindingId: front.bindings.developer.id,
          targetBranch: 'feature/front',
          environmentId: front.environment.id,
        },
        {
          engineeringId: back.source.id,
          responsibleUserId: users.developerB.id,
          bindingId: back.bindings.developer.id,
          targetBranch: 'feature/back',
          environmentId: back.environment.id,
        },
      ],
    },
  );
  const items = database.all(
    `SELECT id, engineering_id FROM cooking_submission_item
       WHERE submission_id = ? ORDER BY position`,
    submission.id,
  ) as Array<{ id: string; engineering_id: string }>;
  const events: Array<{ submissionId: string; revision: number }> = [];
  const service = new BugService(
    database,
    () => new Date('2026-07-27T03:00:00.000Z'),
    undefined,
    (submissionId, revision) => events.push({ submissionId, revision }),
  );
  return {
    database,
    directory,
    events,
    files: new LocalFileStore(database, join(directory, 'files')),
    items: { front: items[0]!.id, back: items[1]!.id },
    project,
    service,
    submission,
    users,
  };
}

export function createBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  actorUserId: string,
  values: {
    title: string;
    submissionItemId?: string;
    operationPath?: string;
    actualResultAttachmentIds?: string[];
    expectedResultAttachmentIds?: string[];
  },
) {
  return fixture.service.createBug(actorUserId, fixture.submission.id, {
    mutationId: randomUUID(),
    submissionItemId: values.submissionItemId ?? null,
    title: values.title,
    operationPath: values.operationPath,
    actualResultAttachmentIds: values.actualResultAttachmentIds ?? [],
    expectedResultAttachmentIds: values.expectedResultAttachmentIds ?? [],
  });
}

export function createAssignedBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  title: string,
  submissionItemId: string,
) {
  return createBug(fixture, fixture.users.tester.id, {
    title,
    submissionItemId,
  }).bug;
}
