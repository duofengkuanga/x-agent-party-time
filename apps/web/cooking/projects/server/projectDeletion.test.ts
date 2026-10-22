import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { projectScenario, engineeringScenario } from '@/cooking/testing/scenario';
import { mutation } from '@/cooking/testing/project';
import { RunnerService } from '@/platform/runner/service';
import { EngineeringService } from '@/cooking/engineering/server/engineeringService';
import { BindingRequestService } from '@/cooking/engineering/server/bindingRequestService';
import { expectRowCount, testDatabases } from '@/testing/database';
import {
  completeCleanup,
  completeNextRepair,
  completeUpdate,
  createAndRequestBug,
  currentBug,
  latestBatch,
  lifecycleFixture,
  submissionRow,
} from '@/cooking/lifecycle/server/lifecycleFixture';
import { ProjectService } from './projectService';

const createDatabase = testDatabases();
const delivery = lifecycleFixture(createDatabase);

async function setup() {
  const { database } = await createDatabase();
  const scenario = await projectScenario(database, {
    name: '待删除项目',
    owner: 'owner',
    members: ['member'],
    people: {
      owner: ['owner', '项目负责人'],
      member: ['member', '项目成员'],
      outsider: ['outsider', '其他用户'],
    },
  });
  return { database, ...scenario };
}

describe('项目删除', () => {
  test('负责人确认后原子删除成员、邀请、工程、环境和绑定，重试幂等且不影响其他项目', async () => {
    const { database, projects, project, users } = await setup();
    const other = projects.createProject(users.owner.id, {
      mutationId: randomUUID(),
      name: '保留项目',
    });
    projects.inviteUser(users.owner.id, project.id, {
      mutationId: randomUUID(),
      username: users.outsider.username,
    });
    const runners = new RunnerService(database);
    const paired = runners.pair(
      runners.issuePairingCode(users.member.id).code,
      '测试 Agent',
    );
    engineeringScenario(database, users.owner.id, project.id, {
      name: '工程',
      type: 'FRONTEND',
      identifier: 'web',
      environment: '测试环境',
      deployment: { kind: 'CI_CD' },
      repository: 'https://example.com/project.git',
      developers: { member: { userId: users.member.id, runnerId: paired.runner.id } },
    });
    const input = { ...mutation(project.version), confirmationName: project.name };
    const result = projects.deleteProject(users.owner.id, project.id, input);
    expect(projects.deleteProject(users.owner.id, project.id, input)).toEqual(result);
    expect(result).toMatchObject({ projectId: project.id, projectName: project.name });
    expect(projects.listProjects(users.owner.id)).toEqual([other]);
    expect(projects.listProjects(users.member.id)).toEqual([]);
    expect(projects.listReceivedInvitations(users.outsider.id)).toEqual([]);
    for (const table of [
      'cooking_engineering',
      'cooking_environment',
      'cooking_engineering_binding',
    ])
      expectRowCount(database, table).toBe(0);
    expectRowCount(database, 'platform_runner').toBe(1);
    expectRowCount(database, 'platform_user').toBe(3);
    expectRowCount(database, 'cooking_mutation', {
      operation: `PROJECT_DELETE:${project.id}`,
    }).toBe(1);
    expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(() =>
      projects.deleteProject(users.owner.id, other.project.id, {
        ...input,
        confirmationName: other.project.name,
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
  });

  test('成员、非成员及不存在项目不能删除，确认名称和版本由服务端校验', async () => {
    const { projects, project, users } = await setup();
    const input = { ...mutation(project.version), confirmationName: project.name };
    expect(() => projects.deleteProject(users.member.id, project.id, input)).toThrow(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(() => projects.deleteProject(users.outsider.id, project.id, input)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() => projects.deleteProject(users.outsider.id, randomUUID(), input)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() =>
      projects.deleteProject(users.owner.id, project.id, {
        ...input,
        confirmationName: '错误名称',
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    const updated = projects.updateProject(users.owner.id, project.id, {
      ...mutation(project.version),
      name: '已改名项目',
    });
    expect(() => projects.deleteProject(users.owner.id, project.id, input)).toThrow(
      expect.objectContaining({ code: 'STALE_STATE' }),
    );
    expect(projects.getProject(users.owner.id, project.id).project).toEqual(updated);
  });

  test('活动提测单阻止删除且保留全部数据', async () => {
    const fixture = await delivery();
    const projects = new ProjectService(fixture.database);
    expect(() =>
      projects.deleteProject(fixture.users.owner.id, fixture.project.id, {
        ...mutation(fixture.project.version),
        confirmationName: fixture.project.name,
      }),
    ).toThrow('请先关闭项目中的活动提测单');
    expectRowCount(fixture.database, 'cooking_test_submission').toBe(1);
    expectRowCount(fixture.database, 'cooking_submission_environment_lock').toBe(2);
    expectRowCount(fixture.database, 'cooking_project').toBe(1);
  });

  test('尚未结束的绑定请求阻止删除，过期后可以删除', async () => {
    const { database, projects, project, users } = await setup();
    const runners = new RunnerService(database);
    const paired = runners.pair(
      runners.issuePairingCode(users.member.id).code,
      '绑定 Agent',
    );
    runners.heartbeat(paired.credential);
    const engineering = new EngineeringService(database);
    const source = engineering.createEngineering(users.owner.id, project.id, {
      mutationId: randomUUID(),
      name: '待绑定工程',
      type: 'FRONTEND',
      identifier: 'pending-web',
    });
    engineering.addMember(users.owner.id, source.id, users.member.id, {
      mutationId: randomUUID(),
    });
    const request = new BindingRequestService(database).createRequest(
      users.member.id,
      source.id,
      paired.runner.id,
      randomUUID(),
    );
    const input = { ...mutation(project.version), confirmationName: project.name };
    expect(() => projects.deleteProject(users.owner.id, project.id, input)).toThrow(
      '正在建立本机绑定',
    );
    expectRowCount(database, 'cooking_binding_request').toBe(1);
    database.run('UPDATE cooking_binding_request SET expires_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      request.id,
    ]);
    projects.deleteProject(users.owner.id, project.id, input);
    expectRowCount(database, 'cooking_binding_request').toBe(0);
  });

  test('已关闭提测单的绑定上仍有活动执行时阻止删除', async () => {
    const fixture = await delivery();
    const { database, project, users } = fixture;
    fixture.lifecycle.closeSubmission(
      users.tester.id,
      fixture.submission.id,
      mutation(fixture.submission.version),
    );
    database.run(
      `INSERT INTO platform_execution(
        id, owner_namespace, owner_kind, owner_id, attempt, runner_id, binding_id,
        approval_policy, state, created_at
       ) SELECT ?, 'test', 'test', ?, 1, runner_id, id, 'never', 'QUEUED', created_at
         FROM cooking_engineering_binding LIMIT 1`,
      [randomUUID(), randomUUID()],
    );
    const projects = new ProjectService(database);
    for (const state of [
      'QUEUED',
      'CLAIMED',
      'RUNNING',
      'WAITING_FOR_INTERACTION',
      'WAITING_TO_RESUME',
      'CANCEL_REQUESTED',
    ]) {
      database.run('UPDATE platform_execution SET state = ?', [state]);
      expect(() =>
        projects.deleteProject(users.owner.id, project.id, {
          ...mutation(project.version),
          confirmationName: project.name,
        }),
      ).toThrow('进行中的本机任务');
      expectRowCount(database, 'cooking_project').toBe(1);
    }
  });

  test('删除完整交付历史前等待善后，完成后清理记录、执行链及归因数据', async () => {
    const fixture = await delivery();
    const { database, project, users } = fixture;
    const projects = new ProjectService(database);
    const localBug = createAndRequestBug(fixture, fixture.items[0]!.id, '本地缺陷');
    await completeNextRepair(fixture, 'project-delete-local', ['1'.repeat(40)]);
    await completeUpdate(fixture, fixture.items[0]!.id, {
      outcome: 'COMPLETED',
      summary: '部署完成',
    });
    const ciBug = createAndRequestBug(fixture, fixture.items[1]!.id, '持续集成缺陷');
    await completeNextRepair(fixture, 'project-delete-ci', ['2'.repeat(40)]);
    const batch = await completeUpdate(fixture, fixture.items[1]!.id, {
      outcome: 'PUSHED',
      summary: '推送完成',
    });
    fixture.updates.reportExternalDeployment(users.developer.id, batch.id, {
      ...mutation(latestBatch(database, fixture.items[1]!.id).version),
      outcome: 'SUCCEEDED',
      summary: '外部部署完成',
      attachmentIds: [],
    });
    for (const bug of [localBug, ciBug])
      fixture.lifecycle.verifyBug(users.tester.id, bug.id, {
        ...mutation(currentBug(database, bug.id).version),
        result: 'PASSED',
        attachmentIds: [],
      });
    const closed = fixture.lifecycle.closeSubmission(
      users.tester.id,
      fixture.submission.id,
      {
        ...mutation(submissionRow(database, fixture.submission.id).version),
      },
    );
    const input = { ...mutation(project.version), confirmationName: project.name };
    expect(() => projects.deleteProject(users.owner.id, project.id, input)).toThrow(
      '未完成的本机善后任务',
    );
    for (const executionId of closed.cleanupExecutionIds)
      await completeCleanup(fixture, executionId, `cleanup-${executionId}`, {
        outcome: 'COMPLETED',
        summary: '善后完成',
      });
    const executionCount = database.get<{ count: number }>(
      'SELECT count(*) count FROM platform_execution',
    )!.count;
    expect(executionCount).toBeGreaterThan(0);
    projects.deleteProject(users.owner.id, project.id, input);
    for (const table of [
      'cooking_project',
      'cooking_project_membership',
      'cooking_audit_event',
      'cooking_engineering',
      'cooking_engineering_membership',
      'cooking_environment',
      'cooking_engineering_binding',
      'cooking_test_submission',
      'cooking_submission_item',
      'cooking_bug',
      'cooking_bug_deployment',
      'cooking_bug_repair_context',
      'cooking_repair_attempt',
      'cooking_update_batch',
      'cooking_update_batch_entry',
      'cooking_update_attempt',
      'cooking_external_deployment_report',
      'cooking_verification_record',
      'cooking_cleanup',
      'cooking_cleanup_attempt',
      'platform_execution',
      'platform_execution_interaction',
      'platform_observation_report',
    ])
      expectRowCount(database, table).toBe(0);
    expectRowCount(database, 'platform_observation_tombstone').toBe(executionCount);
    expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  test('项目范围外的后继任务会回滚删除，不留下部分删除的数据', async () => {
    const fixture = await delivery();
    const { database, project, users } = fixture;
    const projects = new ProjectService(database);
    createAndRequestBug(fixture, fixture.items[0]!.id, '执行链缺陷');
    await completeNextRepair(fixture, 'project-delete-chain', ['3'.repeat(40)]);
    // Focus this closed-history fixture on the execution dependency guard.
    database.run("UPDATE cooking_test_submission SET status = 'CLOSED' WHERE id = ?", [
      fixture.submission.id,
    ]);
    database.run(
      `INSERT INTO platform_execution(
        id, owner_namespace, owner_kind, owner_id, attempt, runner_id, binding_id,
        approval_policy, state, created_at, previous_execution_id
       ) SELECT ?, owner_namespace, owner_kind, ?, 1, runner_id, ?, approval_policy,
         'SUCCEEDED', created_at, id FROM platform_execution LIMIT 1`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    const before = database.all('SELECT * FROM cooking_mutation');
    expect(() =>
      projects.deleteProject(users.owner.id, project.id, {
        ...mutation(project.version),
        confirmationName: project.name,
      }),
    ).toThrow('项目任务仍被其他任务引用');
    expectRowCount(database, 'cooking_project').toBe(1);
    expectRowCount(database, 'cooking_test_submission').toBe(1);
    expectRowCount(database, 'cooking_bug').toBe(1);
    expectRowCount(database, 'cooking_repair_attempt').toBe(1);
    expectRowCount(database, 'platform_execution').toBe(2);
    expect(database.all('SELECT * FROM cooking_mutation')).toEqual(before);
    expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});
