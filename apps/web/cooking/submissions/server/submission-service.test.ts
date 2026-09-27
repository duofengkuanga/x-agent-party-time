import {
  projectScenario,
  engineeringScenario,
} from '@/cooking/testing/scenario';
import { EngineeringService } from '@/cooking/engineering/server/engineering-service';
import { ProjectService } from '@/cooking/projects/server/project-service';
import type { AppDatabase } from '@/platform/database';
import { RunnerService } from '@/platform/runner/service';
import { testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  engineeringMemberHasSubmissionResponsibilities,
  projectMemberHasSubmissionResponsibilities,
  submissionReferencesEngineering,
  submissionReferencesEnvironment,
} from './references';
import { SubmissionService } from './submission-service';

const createDatabase = testDatabases();

async function setup(options: { confirmRepositories?: boolean } = {}) {
  const { directory, database } = await createDatabase();
  const { users, project } = await projectScenario(database, {
    name: '提测项目',
    owner: 'owner',
    members: ['creator', 'tester', 'developerA', 'developerB', 'member'],
    people: {
      owner: ['submission-owner', '项目所有者'],
      creator: ['submission-creator', '提测创建人'],
      tester: ['submission-tester', '测试负责人'],
      developerA: ['submission-dev-a', '开发甲'],
      developerB: ['submission-dev-b', '开发乙'],
      member: ['submission-member', '普通成员'],
      outsider: ['submission-outsider', '项目外用户'],
    },
  });
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

describe('SubmissionService create', () => {
  test('首次本机 Binding 尚未确认仓库时不能创建提测', async () => {
    const fixture = await setup({ confirmRepositories: false });
    expect(() =>
      createSubmission(fixture, [
        item(fixture, 'front', 'developerA', 'frontA', 'feature/pending'),
      ]),
    ).toThrow('提测项仓库、负责人、绑定、Agent 或环境配置无效');
    expect(countRows(fixture.database, 'cooking_test_submission')).toBe(0);
  });

  test('支持同一人多工程、不同人多工程和单个全栈工程', async () => {
    {
      const fixture = await setup();
      const submission = createSubmission(fixture, [
        item(fixture, 'front', 'developerA', 'frontA', 'feature/front'),
        item(fixture, 'back', 'developerA', 'backA', 'feature/back'),
      ]);
      expect(submission.workspaceRevision).toBe(1);
      expect(
        fixture.service.getWorkspace(fixture.users.developerA.id, submission.id)
          .submission.items,
      ).toHaveLength(2);
    }
    {
      const fixture = await setup();
      const submission = createSubmission(fixture, [
        item(fixture, 'front', 'developerA', 'frontA', 'feature/front'),
        item(fixture, 'back', 'developerB', 'backB', 'feature/back'),
      ]);
      expect(
        fixture.service
          .getWorkspace(fixture.users.tester.id, submission.id)
          .submission.items.map(({ responsibleUser }) => responsibleUser.id),
      ).toEqual([fixture.users.developerA.id, fixture.users.developerB.id]);
    }
    {
      const fixture = await setup();
      const submission = createSubmission(
        fixture,
        [item(fixture, 'front', 'developerA', 'frontA', 'feature/fullstack')],
        fixture.users.member.id,
      );
      expect(
        fixture.service.getWorkspace(fixture.users.creator.id, submission.id)
          .submission.items,
      ).toHaveLength(1);
    }
  });

  test('提测项固定工程名称、归属和稳定标识快照', async () => {
    const fixture = await setup();
    const submission = createSubmission(fixture, [
      item(fixture, 'front', 'developerA', 'frontA', 'feature/snapshot'),
    ]);
    const engineering = new EngineeringService(fixture.database, {
      engineeringReferenced: (engineeringId) =>
        submissionReferencesEngineering(fixture.database, engineeringId),
      environmentReferenced: () => false,
      memberHasActiveResponsibilities: () => false,
    });
    const current = engineering.getEngineering(
      fixture.users.owner.id,
      fixture.engineering.front.id,
    );
    engineering.updateEngineering(
      fixture.users.owner.id,
      fixture.engineering.front.id,
      {
        mutationId: randomUUID(),
        expectedVersion: current.version,
        name: '改名后的工程',
        type: 'BACKEND',
        identifier: current.identifier,
      },
    );

    expect(
      fixture.service.getWorkspace(fixture.users.creator.id, submission.id)
        .submission.items[0]?.engineering,
    ).toMatchObject({
      name: '前端工程',
      type: 'FRONTEND',
      identifier: 'web',
    });
  });

  test('参与者、Binding、Runner 与环境验证失败时原子回滚', async () => {
    const fixture = await setup();
    expect(() =>
      createSubmission(
        fixture,
        [item(fixture, 'front', 'developerA', 'frontA', 'feature/outsider')],
        fixture.users.outsider.id,
      ),
    ).toThrow(PlatformErrorLike);
    expect(countRows(fixture.database, 'cooking_test_submission')).toBe(0);
    const invalidInputs = [
      [item(fixture, 'front', 'tester', 'frontA', 'feature/tester-conflict')],
      [
        item(
          fixture,
          'front',
          'member',
          'frontA',
          'feature/not-engineering-member',
        ),
      ],
      [item(fixture, 'front', 'developerA', 'backA', 'feature/wrong-binding')],
    ];
    for (const items of invalidInputs) {
      expect(() => createSubmission(fixture, items)).toThrow(PlatformErrorLike);
      expect(countRows(fixture.database, 'cooking_test_submission')).toBe(0);
      expect(countRows(fixture.database, 'cooking_submission_item')).toBe(0);
      expect(
        countRows(fixture.database, 'cooking_submission_environment_lock'),
      ).toBe(0);
    }

    fixture.database
      .prepare(
        `UPDATE cooking_engineering_binding
         SET runner_id = ?
         WHERE id = ?`,
      )
      .run(fixture.runners.runnerB.runner.id, fixture.bindings.frontA.id);
    expect(() =>
      createSubmission(fixture, [
        {
          ...item(
            fixture,
            'front',
            'developerA',
            'frontA',
            'feature/forged-runner',
          ),
          bindingId: fixture.bindings.frontA.id,
        },
      ]),
    ).toThrow(PlatformErrorLike);
    expect(countRows(fixture.database, 'cooking_test_submission')).toBe(0);
    fixture.database
      .prepare(
        `UPDATE cooking_engineering_binding
         SET runner_id = ?
         WHERE id = ?`,
      )
      .run(fixture.runners.runnerA.runner.id, fixture.bindings.frontA.id);

    const active = createSubmission(fixture, [
      item(fixture, 'front', 'developerA', 'frontA', 'feature/active'),
    ]);
    expect(active.status).toBe('ACTIVE');
    expect(() =>
      createSubmission(fixture, [
        item(fixture, 'front', 'developerA', 'frontA', 'feature/conflict'),
      ]),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expect(countRows(fixture.database, 'cooking_test_submission')).toBe(1);
    expect(countRows(fixture.database, 'cooking_submission_item')).toBe(1);
  });

  test('创建和更新的幂等回放不会重复发布失效通知', async () => {
    const fixture = await setup();
    const createMutationId = randomUUID();
    const createInput = {
      mutationId: createMutationId,
      title: '幂等提测',
      requirementDescription: '验证重复请求没有重复副作用',
      testerUserId: fixture.users.tester.id,
      items: [
        item(fixture, 'front', 'developerA', 'frontA', 'feature/idempotency'),
      ],
    };
    const created = fixture.service.createSubmission(
      fixture.users.owner.id,
      fixture.project.id,
      createInput,
    );
    expect(
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        createInput,
      ),
    ).toEqual(created);
    expect(fixture.events).toEqual([{ submissionId: created.id, revision: 1 }]);

    fixture.events.splice(0);
    const updateInput = {
      mutationId: randomUUID(),
      expectedVersion: 1,
      title: '幂等提测已更新',
      requirementDescription: '重复更新也只通知一次',
    };
    const updated = fixture.service.updateSubmission(
      fixture.users.owner.id,
      created.id,
      updateInput,
    );
    expect(
      fixture.service.updateSubmission(
        fixture.users.owner.id,
        created.id,
        updateInput,
      ),
    ).toEqual(updated);
    expect(fixture.events).toEqual([{ submissionId: created.id, revision: 2 }]);
  });
});

describe('Submission workspace', () => {
  test('项目成员可见目标分支，但只有对应负责人看到技术配置', async () => {
    const fixture = await setup();
    const submission = createSubmission(fixture, [
      item(fixture, 'front', 'developerA', 'frontA', 'feature/front'),
      item(fixture, 'back', 'developerB', 'backB', 'feature/back'),
    ]);
    const developer = fixture.service.getWorkspace(
      fixture.users.developerA.id,
      submission.id,
    );
    expect(developer.revision).toBe(1);
    expect(developer.submission.items[0]?.targetBranch).toBe('feature/front');
    expect(developer.submission.items[0]?.technical).toEqual({
      bindingId: fixture.bindings.frontA.id,
      repositoryUrl: 'https://example.com/front.git',
      deployment: fixture.environments.front.deployment,
    });
    expect(developer.submission.items[0]?.availableActions).toEqual([
      'EDIT_TARGET_BRANCH',
    ]);
    expect(developer.submission.items[1]?.targetBranch).toBe('feature/back');
    expect(developer.submission.items[1]?.technical).toBeNull();
    expect(developer.submission.items[1]?.availableActions).toEqual([]);
    const tester = fixture.service.getWorkspace(
      fixture.users.tester.id,
      submission.id,
    );
    expect(
      tester.submission.items.map(({ targetBranch }) => targetBranch),
    ).toEqual(['feature/front', 'feature/back']);
    expect(tester.submission.items.every(({ technical }) => !technical)).toBe(
      true,
    );
    expect(
      tester.submission.items.every(
        ({ availableActions }) => availableActions.length === 0,
      ),
    ).toBe(true);
    expect(() =>
      fixture.service.getWorkspace(fixture.users.outsider.id, submission.id),
    ).toThrow(
      expect.objectContaining({
        code: 'NOT_FOUND',
        message: '提测单不存在或无权访问',
      }),
    );
  });

  test('开发负责人只在零缺陷时通过保存提测信息修改自己的目标分支', async () => {
    const fixture = await setup();
    const submission = createSubmission(fixture, [
      item(fixture, 'front', 'developerA', 'frontA', 'feature/front'),
      item(fixture, 'back', 'developerB', 'backB', 'feature/back'),
    ]);
    const initial = fixture.service.getWorkspace(
      fixture.users.developerA.id,
      submission.id,
    );
    const front = initial.submission.items[0]!;
    const back = initial.submission.items[1]!;
    fixture.events.splice(0);

    const updated = fixture.service.updateSubmission(
      fixture.users.developerA.id,
      submission.id,
      {
        mutationId: randomUUID(),
        expectedVersion: 1,
        title: submission.title,
        requirementDescription: submission.requirementDescription,
        targetBranches: [
          {
            submissionItemId: front.id,
            targetBranch: 'feature/front-next',
          },
        ],
      },
    );
    expect(updated).toMatchObject({ version: 2, workspaceRevision: 2 });
    expect(
      fixture.service.getWorkspace(fixture.users.developerA.id, submission.id)
        .submission.items[0]?.targetBranch,
    ).toBe('feature/front-next');
    expect(fixture.events).toEqual([
      { submissionId: submission.id, revision: 2 },
    ]);

    expect(() =>
      fixture.service.updateSubmission(
        fixture.users.developerA.id,
        submission.id,
        {
          mutationId: randomUUID(),
          expectedVersion: 2,
          title: submission.title,
          requirementDescription: submission.requirementDescription,
          targetBranches: [
            { submissionItemId: back.id, targetBranch: 'feature/forged' },
          ],
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() =>
      fixture.service.updateSubmission(fixture.users.owner.id, submission.id, {
        mutationId: randomUUID(),
        expectedVersion: 2,
        title: submission.title,
        requirementDescription: submission.requirementDescription,
        targetBranches: [
          { submissionItemId: front.id, targetBranch: 'feature/owner-forged' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));

    insertBug(fixture, submission.id, front.id);
    expect(
      fixture.service.getWorkspace(fixture.users.developerA.id, submission.id)
        .submission.items[0]?.availableActions,
    ).toEqual([]);
    expect(() =>
      fixture.service.updateSubmission(
        fixture.users.developerA.id,
        submission.id,
        {
          mutationId: randomUUID(),
          expectedVersion: 2,
          title: submission.title,
          requirementDescription: submission.requirementDescription,
          targetBranches: [
            { submissionItemId: front.id, targetBranch: 'feature/too-late' },
          ],
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });

  test('活动提测保护 Tester、负责人、工程标识与环境配置', async () => {
    const fixture = await setup();
    createSubmission(fixture, [
      item(fixture, 'front', 'developerA', 'frontA', 'feature/front'),
    ]);
    const engineering = new EngineeringService(fixture.database, {
      engineeringReferenced: (engineeringId) =>
        submissionReferencesEngineering(fixture.database, engineeringId),
      environmentReferenced: (environmentId) =>
        submissionReferencesEnvironment(fixture.database, environmentId),
      memberHasActiveResponsibilities: (engineeringId, userId) =>
        engineeringMemberHasSubmissionResponsibilities(
          fixture.database,
          engineeringId,
          userId,
        ),
    });
    expect(() =>
      engineering.updateEngineering(
        fixture.users.owner.id,
        fixture.engineering.front.id,
        {
          mutationId: randomUUID(),
          expectedVersion: engineering.getEngineering(
            fixture.users.owner.id,
            fixture.engineering.front.id,
          ).version,
          name: fixture.engineering.front.name,
          type: fixture.engineering.front.type,
          identifier: 'renamed-web',
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expect(() =>
      engineering.updateEnvironment(
        fixture.users.owner.id,
        fixture.environments.front.id,
        {
          mutationId: randomUUID(),
          expectedVersion: fixture.environments.front.version,
          name: fixture.environments.front.name,
          deployment: { kind: 'CI_CD' },
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    const developerMembership = engineering
      .listMembers(fixture.users.owner.id, fixture.engineering.front.id)
      .find(({ user }) => user.id === fixture.users.developerA.id)!.membership;
    expect(() =>
      engineering.removeMember(
        fixture.users.owner.id,
        fixture.engineering.front.id,
        fixture.users.developerA.id,
        {
          mutationId: randomUUID(),
          expectedVersion: developerMembership.version,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));

    const projects = new ProjectService(
      fixture.database,
      undefined,
      undefined,
      (projectId, userId) =>
        projectMemberHasSubmissionResponsibilities(
          fixture.database,
          projectId,
          userId,
        ),
    );
    const testerMembership = projects
      .listMembers(fixture.users.owner.id, fixture.project.id)
      .find(({ user }) => user.id === fixture.users.tester.id)!.membership;
    expect(() =>
      projects.removeMember(
        fixture.users.owner.id,
        fixture.project.id,
        fixture.users.tester.id,
        {
          mutationId: randomUUID(),
          expectedVersion: testerMembership.version,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
  });

  test('创建人和 OWNER 按 Version 修改，每次事务只增加一次 Revision', async () => {
    const fixture = await setup();
    const submission = createSubmission(
      fixture,
      [item(fixture, 'front', 'developerA', 'frontA', 'feature/front')],
      fixture.users.creator.id,
    );
    fixture.events.splice(0);
    const creatorUpdate = fixture.service.updateSubmission(
      fixture.users.creator.id,
      submission.id,
      {
        mutationId: randomUUID(),
        expectedVersion: 1,
        title: '第一次修改',
        requirementDescription: '第一次需求修改',
      },
    );
    expect(creatorUpdate).toMatchObject({ version: 2, workspaceRevision: 2 });
    expect(fixture.events).toEqual([
      { submissionId: submission.id, revision: 2 },
    ]);
    expect(() =>
      fixture.service.updateSubmission(
        fixture.users.creator.id,
        submission.id,
        {
          mutationId: randomUUID(),
          expectedVersion: 1,
          title: '旧版本',
          requirementDescription: '不能覆盖',
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    expect(
      fixture.service.getWorkspace(fixture.users.creator.id, submission.id)
        .revision,
    ).toBe(2);
    expect(() =>
      fixture.service.updateSubmission(fixture.users.member.id, submission.id, {
        mutationId: randomUUID(),
        expectedVersion: 2,
        title: '普通成员修改',
        requirementDescription: '不应允许',
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const ownerUpdate = fixture.service.updateSubmission(
      fixture.users.owner.id,
      submission.id,
      {
        mutationId: randomUUID(),
        expectedVersion: 2,
        title: '所有者修改',
        requirementDescription: '项目所有者可以修改',
      },
    );
    expect(ownerUpdate).toMatchObject({ version: 3, workspaceRevision: 3 });
    expect(
      fixture.database.get<{ count: number }>(
        `SELECT COUNT(*) count FROM cooking_audit_event
           WHERE target_id = ? AND action = 'SUBMISSION_DETAILS_UPDATED'`,
        submission.id,
      )?.count,
    ).toBe(2);
  });
});

const PlatformErrorLike = expect.objectContaining({
  code: expect.any(String),
});

function pairRunner(service: RunnerService, userId: string, name: string) {
  return service.pair(service.issuePairingCode(userId).code, name);
}

function item(
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

function createSubmission(
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

function insertBug(
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

function countRows(database: AppDatabase, table: string): number {
  return (
    database.get<{ count: number }>(`SELECT COUNT(*) count FROM ${table}`)
      ?.count ?? 0
  );
}

describe('环境使用权切换', () => {
  test('多工程原子切换、幂等回放、只暂停目标提测项并通知双方', async () => {
    const fixture = await setup();
    const front = item(fixture, 'front', 'developerA', 'frontA', 'main');
    const back = item(fixture, 'back', 'developerB', 'backB', 'main');
    const original = createSubmission(fixture, [front, back]);
    const input = {
      mutationId: randomUUID(),
      title: '优先提测',
      requirementDescription: '优先验收前端',
      testerUserId: fixture.users.tester.id,
      items: [front],
    };
    expect(() =>
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        input,
      ),
    ).toThrow('所选环境');
    const conflicts = fixture.service.environmentConflicts(
      fixture.users.owner.id,
      fixture.project.id,
      input,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      submissionId: original.id,
      blockedReason: null,
    });
    const confirmed = { ...input, environmentTakeovers: conflicts };
    fixture.events.length = 0;
    const next = fixture.service.createSubmission(
      fixture.users.owner.id,
      fixture.project.id,
      confirmed,
    );
    expect(
      fixture.events.map(({ submissionId }) => submissionId).sort(),
    ).toEqual([next.id, original.id].sort());
    const oldItems = fixture.service.getWorkspace(
      fixture.users.owner.id,
      original.id,
    ).submission.items;
    expect(oldItems[0]!.environmentAccess.owned).toBe(false);
    expect(oldItems[1]!.environmentAccess.owned).toBe(true);
    const nextItem = fixture.service.getWorkspace(
      fixture.users.developerA.id,
      next.id,
    ).submission.items[0]!;
    expect(nextItem.environmentAccess).toMatchObject({
      owned: true,
      deploymentConfirmed: false,
      canConfirmDeployment: true,
    });
    const eventCount = fixture.events.length;
    expect(
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        confirmed,
      ).id,
    ).toBe(next.id);
    expect(fixture.events).toHaveLength(eventCount);
    expect(
      countRows(fixture.database, 'cooking_submission_environment_lock'),
    ).toBe(2);
    const competing = { ...confirmed, mutationId: randomUUID() };
    expect(() =>
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        competing,
      ),
    ).toThrow('环境使用情况已变化');
    expect(countRows(fixture.database, 'cooking_test_submission')).toBe(2);
    expect(() =>
      fixture.service.changeEnvironment(fixture.users.tester.id, nextItem.id, {
        mutationId: randomUUID(),
        expectedRevision: next.workspaceRevision,
        action: 'CONFIRM_DEPLOYMENT',
      }),
    ).toThrow('只有对应工程负责人');
    fixture.service.changeEnvironment(
      fixture.users.developerA.id,
      nextItem.id,
      {
        mutationId: randomUUID(),
        expectedRevision: next.workspaceRevision,
        action: 'CONFIRM_DEPLOYMENT',
      },
    );
    expect(
      fixture.service.getWorkspace(fixture.users.tester.id, next.id).submission
        .items[0]!.environmentAccess.deploymentConfirmed,
    ).toBe(true);
  });

  test('第二个环境确认过期时全部回滚；同一原提测单的多个环境可以一起转移', async () => {
    const fixture = await setup();
    const items = [
      item(fixture, 'front', 'developerA', 'frontA', 'main'),
      item(fixture, 'back', 'developerB', 'backB', 'main'),
    ];
    const original = createSubmission(fixture, items);
    const input = {
      mutationId: randomUUID(),
      title: '多环境接手',
      requirementDescription: '原子切换',
      testerUserId: fixture.users.tester.id,
      items,
    };
    const conflicts = fixture.service.environmentConflicts(
      fixture.users.owner.id,
      fixture.project.id,
      input,
    );
    const invalid = conflicts.map((entry, index) => ({
      ...entry,
      expectedRevision: entry.expectedRevision + index,
    }));
    const eventCount = fixture.events.length;
    expect(() =>
      fixture.service.createSubmission(
        fixture.users.owner.id,
        fixture.project.id,
        { ...input, environmentTakeovers: invalid },
      ),
    ).toThrow('环境使用情况已变化');
    expect(fixture.events).toHaveLength(eventCount);
    expect(countRows(fixture.database, 'cooking_test_submission')).toBe(1);
    expect(
      fixture.service
        .getWorkspace(fixture.users.owner.id, original.id)
        .submission.items.every((entry) => entry.environmentAccess.owned),
    ).toBe(true);
    const next = fixture.service.createSubmission(
      fixture.users.owner.id,
      fixture.project.id,
      { ...input, environmentTakeovers: conflicts },
    );
    expect(
      fixture.service
        .getWorkspace(fixture.users.owner.id, next.id)
        .submission.items.every((entry) => entry.environmentAccess.owned),
    ).toBe(true);
  });

  test('普通成员不能抢占，项目外用户不能读取占用详情', async () => {
    const fixture = await setup();
    const items = [item(fixture, 'front', 'developerA', 'frontA', 'main')];
    createSubmission(fixture, items);
    const input = {
      mutationId: randomUUID(),
      title: '无权抢占',
      requirementDescription: '权限检查',
      testerUserId: fixture.users.tester.id,
      items,
    };
    const conflicts = fixture.service.environmentConflicts(
      fixture.users.member.id,
      fixture.project.id,
      input,
    );
    expect(conflicts[0]!.blockedReason).toContain('只有项目所有者');
    expect(() =>
      fixture.service.createSubmission(
        fixture.users.member.id,
        fixture.project.id,
        { ...input, environmentTakeovers: conflicts },
      ),
    ).toThrow('只有项目所有者');
    expect(() =>
      fixture.service.environmentConflicts(
        fixture.users.outsider.id,
        fixture.project.id,
        input,
      ),
    ).toThrow('项目不存在或无权访问');
    expect(countRows(fixture.database, 'cooking_test_submission')).toBe(1);
  });
});
