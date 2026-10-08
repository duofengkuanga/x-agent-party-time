import {
  projectScenario,
  engineeringScenario,
} from '@/cooking/testing/scenario';
import { RunnerService } from '@/platform/runner/service';
import { testDatabases } from '@/testing/database';
import { randomUUID } from 'node:crypto';
import { SubmissionService } from './submission-service';

type FixtureOptions = { confirmRepositories?: boolean };

/** Each test file supplies its own database factory and cleanup hook. */
export function submissionFixture(
  createDatabase: ReturnType<typeof testDatabases>,
) {
  return (options: FixtureOptions = {}) => setup(createDatabase, options);
}

async function setup(
  createDatabase: ReturnType<typeof testDatabases>,
  options: FixtureOptions = {},
) {
  const { database } = await createDatabase();
  const people = {
    owner: ['submission-owner', '项目所有者'],
    creator: ['submission-creator', '提测创建人'],
    tester: ['submission-tester', '测试负责人'],
    developerA: ['submission-dev-a', '开发甲'],
    developerB: ['submission-dev-b', '开发乙'],
    member: ['submission-member', '普通成员'],
    outsider: ['submission-outsider', '项目外用户'],
  } satisfies Record<string, [string, string]>;
  const { users, project } = await projectScenario<keyof typeof people>(
    database,
    {
      name: '提测项目',
      owner: 'owner',
      members: ['creator', 'tester', 'developerA', 'developerB', 'member'],
      people,
    },
  );
  const runners = new RunnerService(database);
  const runnerA = pairRunner(runners, users.developerA.id, '开发甲 Runner');
  const runnerB = pairRunner(runners, users.developerB.id, '开发乙 Runner');
  const developerA = {
    userId: users.developerA.id,
    runnerId: runnerA.runner.id,
  };
  const developerB = {
    userId: users.developerB.id,
    runnerId: runnerB.runner.id,
  };
  const front = engineeringScenario(database, users.owner.id, project.id, {
    name: '前端工程',
    type: 'FRONTEND',
    identifier: 'web',
    environment: '前端测试环境',
    deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
    repository:
      options.confirmRepositories === false
        ? null
        : 'https://example.com/front.git',
    developers: { developerA },
  });
  const back = engineeringScenario(database, users.owner.id, project.id, {
    name: '后端工程',
    type: 'BACKEND',
    identifier: 'api',
    environment: '后端测试环境',
    deployment: { kind: 'CI_CD' },
    repository:
      options.confirmRepositories === false
        ? null
        : 'https://example.com/back.git',
    developers: { developerA, developerB },
  });
  const events: Array<{ submissionId: string; revision: number }> = [];
  const service = new SubmissionService(
    database,
    () => new Date('2026-07-27T02:00:00Z'),
    undefined,
    (submissionId, revision) => events.push({ submissionId, revision }),
  );
  return {
    database,
    engineering: { front: front.source, back: back.source },
    environments: { front: front.environment, back: back.environment },
    bindings: {
      frontA: front.bindings.developerA,
      backA: back.bindings.developerA,
      backB: back.bindings.developerB,
    },
    runners: { runnerA, runnerB },
    project,
    service,
    users,
    events,
  };
}

function pairRunner(service: RunnerService, userId: string, name: string) {
  return service.pair(service.issuePairingCode(userId).code, name);
}

export function item(
  fixture: Awaited<ReturnType<typeof setup>>,
  engineering: 'back' | 'front',
  responsible: 'developerA' | 'developerB' | 'member' | 'tester',
  binding: 'backA' | 'backB' | 'frontA',
  targetBranch: string,
) {
  return {
    engineeringId: fixture.engineering[engineering].id,
    responsibleUserId: fixture.users[responsible].id,
    bindingId: fixture.bindings[binding].id,
    targetBranch,
    environmentId: fixture.environments[engineering].id,
  };
}

export function createSubmission(
  fixture: Awaited<ReturnType<typeof setup>>,
  items: ReturnType<typeof item>[],
  actorUserId: string = fixture.users.owner.id,
) {
  return fixture.service.createSubmission(actorUserId, fixture.project.id, {
    mutationId: randomUUID(),
    title: '版本 1.0 提测',
    requirementDescription: '验证项目多工程协作流程',
    testerUserId: fixture.users.tester.id,
    items,
  });
}

export function insertBug(
  fixture: Awaited<ReturnType<typeof setup>>,
  submissionId: string,
  submissionItemId: string,
): void {
  const now = '2026-07-30T00:00:00.000Z';
  fixture.database
    .prepare(
      `INSERT INTO cooking_bug(
         id, short_id, submission_id, submission_item_id, stage, title,
         operation_path, actual_result, expected_result,
         report_locked_at, archived_at, archived_by_user_id, version,
         created_by_user_id, created_at, updated_at
       ) VALUES (?, 1, ?, ?, 'WAITING_FOR_REPAIR', ?, ?, ?, ?,
                 NULL, NULL, NULL, 1, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      submissionId,
      submissionItemId,
      '锁定目标分支',
      '打开测试页面',
      '出现缺陷',
      '应按预期工作',
      fixture.users.tester.id,
      now,
      now,
    );
}
