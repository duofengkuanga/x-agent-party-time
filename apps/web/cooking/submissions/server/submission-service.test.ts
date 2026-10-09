import { mutation } from '@/cooking/testing/project';
import { EngineeringService } from '@/cooking/engineering/server/engineering-service';
import { ProjectService } from '@/cooking/projects/server/project-service';
import { expectRowCount, testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  engineeringMemberHasSubmissionResponsibilities,
  projectMemberHasSubmissionResponsibilities,
  submissionReferencesEngineering,
  submissionReferencesEnvironment,
} from './references';
import {
  createSubmission,
  insertBug,
  item,
  submissionFixture,
} from './submission-fixture';

const setup = submissionFixture(testDatabases());

describe('SubmissionService create', () => {
  test('首次本机 Binding 尚未确认仓库时不能创建提测', async () => {
    const fixture = await setup({ confirmRepositories: false });
    expect(() =>
      createSubmission(fixture, [
        item(fixture, 'front', 'developerA', 'frontA', 'feature/pending'),
      ]),
    ).toThrow('提测项仓库、负责人、绑定、Agent 或环境配置无效');
    expectRowCount(fixture.database, 'cooking_test_submission').toBe(0);
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
        fixture.service.getWorkspace(fixture.users.creator.id, submission.id).submission
          .items,
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
    engineering.updateEngineering(fixture.users.owner.id, fixture.engineering.front.id, {
      ...mutation(current.version),
      name: '改名后的工程',
      type: 'BACKEND',
      identifier: current.identifier,
    });

    expect(
      fixture.service.getWorkspace(fixture.users.creator.id, submission.id).submission
        .items[0]?.engineering,
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
    expectRowCount(fixture.database, 'cooking_test_submission').toBe(0);
    const invalidInputs = [
      [item(fixture, 'front', 'tester', 'frontA', 'feature/tester-conflict')],
      [item(fixture, 'front', 'member', 'frontA', 'feature/not-engineering-member')],
      [item(fixture, 'front', 'developerA', 'backA', 'feature/wrong-binding')],
    ];
    for (const items of invalidInputs) {
      expect(() => createSubmission(fixture, items)).toThrow(PlatformErrorLike);
      expectRowCount(fixture.database, 'cooking_test_submission').toBe(0);
      expectRowCount(fixture.database, 'cooking_submission_item').toBe(0);
      expectRowCount(fixture.database, 'cooking_submission_environment_lock').toBe(0);
    }

    fixture.database.run(
      `UPDATE cooking_engineering_binding
         SET runner_id = ?
         WHERE id = ?`,
      [fixture.runners.runnerB.runner.id, fixture.bindings.frontA.id],
    );
    expect(() =>
      createSubmission(fixture, [
        {
          ...item(fixture, 'front', 'developerA', 'frontA', 'feature/forged-runner'),
          bindingId: fixture.bindings.frontA.id,
        },
      ]),
    ).toThrow(PlatformErrorLike);
    expectRowCount(fixture.database, 'cooking_test_submission').toBe(0);
    fixture.database.run(
      `UPDATE cooking_engineering_binding
         SET runner_id = ?
         WHERE id = ?`,
      [fixture.runners.runnerA.runner.id, fixture.bindings.frontA.id],
    );

    const active = createSubmission(fixture, [
      item(fixture, 'front', 'developerA', 'frontA', 'feature/active'),
    ]);
    expect(active.status).toBe('ACTIVE');
    expect(() =>
      createSubmission(fixture, [
        item(fixture, 'front', 'developerA', 'frontA', 'feature/conflict'),
      ]),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expectRowCount(fixture.database, 'cooking_test_submission').toBe(1);
    expectRowCount(fixture.database, 'cooking_submission_item').toBe(1);
  });

  test('创建和更新的幂等回放不会重复发布失效通知', async () => {
    const fixture = await setup();
    const createMutationId = randomUUID();
    const createInput = {
      mutationId: createMutationId,
      title: '幂等提测',
      requirementDescription: '验证重复请求没有重复副作用',
      testerUserId: fixture.users.tester.id,
      items: [item(fixture, 'front', 'developerA', 'frontA', 'feature/idempotency')],
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
      ...mutation(1),
      title: '幂等提测已更新',
      requirementDescription: '重复更新也只通知一次',
    };
    const updated = fixture.service.updateSubmission(
      fixture.users.owner.id,
      created.id,
      updateInput,
    );
    expect(
      fixture.service.updateSubmission(fixture.users.owner.id, created.id, updateInput),
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
    const tester = fixture.service.getWorkspace(fixture.users.tester.id, submission.id);
    expect(tester.submission.items.map(({ targetBranch }) => targetBranch)).toEqual([
      'feature/front',
      'feature/back',
    ]);
    expect(tester.submission.items.every(({ technical }) => !technical)).toBe(true);
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
        ...mutation(1),
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
      fixture.service.getWorkspace(fixture.users.developerA.id, submission.id).submission
        .items[0]?.targetBranch,
    ).toBe('feature/front-next');
    expect(fixture.events).toEqual([{ submissionId: submission.id, revision: 2 }]);

    expect(() =>
      fixture.service.updateSubmission(fixture.users.developerA.id, submission.id, {
        ...mutation(2),
        title: submission.title,
        requirementDescription: submission.requirementDescription,
        targetBranches: [{ submissionItemId: back.id, targetBranch: 'feature/forged' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() =>
      fixture.service.updateSubmission(fixture.users.owner.id, submission.id, {
        ...mutation(2),
        title: submission.title,
        requirementDescription: submission.requirementDescription,
        targetBranches: [
          { submissionItemId: front.id, targetBranch: 'feature/owner-forged' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));

    insertBug(fixture, submission.id, front.id);
    expect(
      fixture.service.getWorkspace(fixture.users.developerA.id, submission.id).submission
        .items[0]?.availableActions,
    ).toEqual([]);
    expect(() =>
      fixture.service.updateSubmission(fixture.users.developerA.id, submission.id, {
        ...mutation(2),
        title: submission.title,
        requirementDescription: submission.requirementDescription,
        targetBranches: [
          { submissionItemId: front.id, targetBranch: 'feature/too-late' },
        ],
      }),
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
          ...mutation(
            engineering.getEngineering(
              fixture.users.owner.id,
              fixture.engineering.front.id,
            ).version,
          ),
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
          ...mutation(fixture.environments.front.version),
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
          ...mutation(developerMembership.version),
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));

    const projects = new ProjectService(
      fixture.database,
      undefined,
      undefined,
      (projectId, userId) =>
        projectMemberHasSubmissionResponsibilities(fixture.database, projectId, userId),
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
          ...mutation(testerMembership.version),
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
        ...mutation(1),
        title: '第一次修改',
        requirementDescription: '第一次需求修改',
      },
    );
    expect(creatorUpdate).toMatchObject({ version: 2, workspaceRevision: 2 });
    expect(fixture.events).toEqual([{ submissionId: submission.id, revision: 2 }]);
    expect(() =>
      fixture.service.updateSubmission(fixture.users.creator.id, submission.id, {
        ...mutation(1),
        title: '旧版本',
        requirementDescription: '不能覆盖',
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    expect(
      fixture.service.getWorkspace(fixture.users.creator.id, submission.id).revision,
    ).toBe(2);
    expect(() =>
      fixture.service.updateSubmission(fixture.users.member.id, submission.id, {
        ...mutation(2),
        title: '普通成员修改',
        requirementDescription: '不应允许',
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    const ownerUpdate = fixture.service.updateSubmission(
      fixture.users.owner.id,
      submission.id,
      {
        ...mutation(2),
        title: '所有者修改',
        requirementDescription: '项目所有者可以修改',
      },
    );
    expect(ownerUpdate).toMatchObject({ version: 3, workspaceRevision: 3 });
    expectRowCount(fixture.database, 'cooking_audit_event', {
      target_id: submission.id,
      action: 'SUBMISSION_DETAILS_UPDATED',
    }).toBe(2);
  });
});

const PlatformErrorLike = expect.objectContaining({
  code: expect.any(String),
});
