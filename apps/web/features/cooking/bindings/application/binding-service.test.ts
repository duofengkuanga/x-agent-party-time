import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { RunnerService } from '@/server/runner/service';
import { EngineeringService } from '@/features/cooking/engineering/application/engineering-service';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import { BindingRequestService } from './binding-request-service';
import { BindingService } from './binding-service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-binding-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(database);
  const users = {
    owner: await auth.seedUser({
      id: 'binding-owner',
      username: 'binding-owner',
      displayName: 'Binding 所有者',
      password: 'password',
    }),
    member: await auth.seedUser({
      id: 'binding-member',
      username: 'binding-member',
      displayName: 'Binding 成员',
      password: 'password',
    }),
    other: await auth.seedUser({
      id: 'binding-other',
      username: 'binding-other',
      displayName: 'Binding 外部用户',
      password: 'password',
    }),
  };
  const projects = new ProjectService(database);
  const project = projects.createProject(users.owner.id, {
    mutationId: randomUUID(),
    name: 'Binding 项目',
  }).project;
  const invitation = projects.inviteUser(users.owner.id, project.id, {
    mutationId: randomUUID(),
    username: users.member.username,
  });
  projects.respondToInvitation(users.member.id, invitation.id, {
    mutationId: randomUUID(),
    expectedVersion: invitation.version,
    decision: 'ACCEPT',
  });
  const engineeringService = new EngineeringService(database);
  const engineering = engineeringService.createEngineering(
    users.owner.id,
    project.id,
    {
      mutationId: randomUUID(),
      name: 'Binding 工程',
      type: 'FRONTEND',
      identifier: 'binding-web',
    },
  );
  engineeringService.addMember(
    users.owner.id,
    engineering.id,
    users.member.id,
    {
      mutationId: randomUUID(),
    },
  );
  const now = () => new Date('2026-07-26T11:00:00Z');
  const runners = new RunnerService(database, now);
  const pairRunner = (userId: string, name: string) =>
    runners.pair(runners.issuePairingCode(userId).code, name);
  return {
    database,
    engineering,
    project,
    runnerService: runners,
    runners: {
      owner: pairRunner(users.owner.id, 'Owner Runner'),
      member: pairRunner(users.member.id, 'Member Runner'),
      other: pairRunner(users.other.id, 'Other Runner'),
    },
    service: new BindingService(database, now),
    requestService: new BindingRequestService(
      database,
      new BindingService(database, now),
      now,
    ),
    users,
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('BindingService', () => {
  test('工程成员只能用自己的有效 Runner 建立稳定 Binding', async () => {
    const { engineering, runnerService, runners, service, users } =
      await setup();
    const mutationId = randomUUID();
    const binding = service.createBinding(
      users.member.id,
      engineering.id,
      runners.member.runner.id,
      mutationId,
    );
    expect(binding.createdAt).toBe('2026-07-26T11:00:00.000Z');
    expect(
      service.createBinding(
        users.member.id,
        engineering.id,
        runners.member.runner.id,
        randomUUID(),
      ),
    ).toEqual(binding);
    expect(service.listBindingsForRunner(runners.member.runner.id)).toEqual([
      binding,
    ]);
    const secondRunner = runnerService.pair(
      runnerService.issuePairingCode(users.member.id).code,
      'Member Runner 2',
    );
    expect(() =>
      service.createBinding(
        users.member.id,
        engineering.id,
        secondRunner.runner.id,
        randomUUID(),
      ),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expect(() =>
      service.createBinding(
        users.member.id,
        engineering.id,
        runners.owner.runner.id,
        randomUUID(),
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() =>
      service.createBinding(
        users.owner.id,
        engineering.id,
        runners.owner.runner.id,
        randomUUID(),
      ),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('Server Binding Schema、数据库和响应都不包含本机路径', async () => {
    const { database, engineering, runners, service, users } = await setup();
    service.createBinding(
      users.member.id,
      engineering.id,
      runners.member.runner.id,
      randomUUID(),
    );
    const columns = database
      .query<{ name: string }, []>(
        'PRAGMA table_info(cooking_engineering_binding)',
      )
      .all()
      .map(({ name }) => name);
    expect(columns).toEqual([
      'id',
      'engineering_id',
      'user_id',
      'runner_id',
      'created_at',
    ]);
    const response = service.listBindings(users.member.id, engineering.id);
    expect(JSON.stringify(response)).not.toMatch(/local|path|\/Users\//iu);
    expect(response[0]?.runner.name).toBe('Member Runner');
  });

  test('项目外用户不能枚举 Binding', async () => {
    const { engineering, service, users } = await setup();
    expect(() => service.listBindings(users.other.id, engineering.id)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});

test('首次 Runner Binding 确认仓库身份，后续 Binding 必须匹配', async () => {
  const { database, engineering, runners, service, users } = await setup();
  const binding = service.createBinding(
    users.member.id,
    engineering.id,
    runners.member.runner.id,
    randomUUID(),
  );
  expect(
    service.confirmRepository(
      runners.member.runner.id,
      binding.id,
      'git@Example.com:team/project.git',
    ),
  ).toBe('https://example.com/team/project.git');
  expect(
    new EngineeringService(database).getEngineering(
      binding.userId,
      engineering.id,
    ),
  ).toMatchObject({
    repositoryState: 'CONFIRMED',
    repositoryUrl: 'https://example.com/team/project.git',
    version: 2,
  });
  expect(
    service.confirmRepository(
      runners.member.runner.id,
      binding.id,
      'ssh://git@example.com/team/project',
    ),
  ).toBe('https://example.com/team/project.git');
  expect(
    database
      .query<{ count: number }, []>(
        `SELECT COUNT(*) count FROM cooking_audit_event
         WHERE action = 'ENGINEERING_REPOSITORY_CONFIRMED'`,
      )
      .get()?.count,
  ).toBe(1);
  expect(() =>
    service.confirmRepository(
      runners.member.runner.id,
      binding.id,
      'https://example.com/other/project.git',
    ),
  ).toThrow('本机仓库与工程仓库身份不一致');
});

describe('Web 驱动工程绑定', () => {
  test('在线 Agent 领取请求前服务端无半成品，完成后原子确认仓库', async () => {
    const {
      database,
      engineering,
      requestService,
      runnerService,
      runners,
      service,
      users,
    } = await setup();
    runnerService.heartbeat(runners.member.credential);
    const request = requestService.createRequest(
      users.member.id,
      engineering.id,
      runners.member.runner.id,
      randomUUID(),
    );
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM cooking_engineering_binding',
        )
        .get()?.count,
    ).toBe(0);
    expect(requestService.claimNext(runners.other.runner.id)).toBeNull();
    const work = requestService.claimNext(runners.member.runner.id);
    expect(work).toMatchObject({ requestId: request.id });
    expect(service.listBindings(users.member.id, engineering.id)).toEqual([]);

    expect(
      requestService.complete(runners.member.runner.id, request.id, {
        outcome: 'SUCCEEDED',
        repositoryUrl: 'git@Example.com:team/project.git',
      }),
    ).toBe('SUCCEEDED');
    expect(
      requestService.complete(runners.member.runner.id, request.id, {
        outcome: 'SUCCEEDED',
        repositoryUrl: 'git@Example.com:team/project.git',
      }),
    ).toBe('SUCCEEDED');
    expect(service.listBindings(users.member.id, engineering.id)).toHaveLength(
      1,
    );
    expect(
      new EngineeringService(database).getEngineering(
        users.member.id,
        engineering.id,
      ),
    ).toMatchObject({
      repositoryState: 'CONFIRMED',
      repositoryUrl: 'https://example.com/team/project.git',
    });
    expect(
      JSON.stringify(requestService.getRequest(users.member.id, request.id)),
    ).not.toMatch(/\/Users\/|repositoryPath|bindingId/u);
  });

  test('取消目录选择或请求过期不会留下页面可见绑定', async () => {
    const {
      engineering,
      requestService,
      runnerService,
      runners,
      service,
      users,
    } = await setup();
    runnerService.heartbeat(runners.member.credential);
    const request = requestService.createRequest(
      users.member.id,
      engineering.id,
      runners.member.runner.id,
      randomUUID(),
    );
    requestService.claimNext(runners.member.runner.id);
    expect(
      requestService.complete(runners.member.runner.id, request.id, {
        outcome: 'FAILED',
        code: 'CANCELLED',
        message: '已取消选择仓库目录',
      }),
    ).toBe('FAILED');
    expect(service.listBindings(users.member.id, engineering.id)).toEqual([]);
    expect(
      requestService.getRequest(users.member.id, request.id),
    ).toMatchObject({
      state: 'FAILED',
      errorMessage: '已取消选择仓库目录',
    });
  });
});

describe('删除未使用工程绑定', () => {
  test('只有绑定所有者可删除未使用绑定，重复删除保持幂等', async () => {
    const { engineering, runners, service, users } = await setup();
    const binding = service.createBinding(
      users.member.id,
      engineering.id,
      runners.member.runner.id,
      randomUUID(),
    );
    expect(() =>
      service.deleteBinding(users.owner.id, binding.id, randomUUID()),
    ).not.toThrow();
    expect(
      service.deleteBinding(users.member.id, binding.id, randomUUID()),
    ).toEqual({ deleted: true, bindingId: binding.id });
    expect(
      service.deleteBinding(users.member.id, binding.id, randomUUID()),
    ).toEqual({ deleted: false, bindingId: binding.id });
    const replacement = service.createBinding(
      users.member.id,
      engineering.id,
      runners.member.runner.id,
      randomUUID(),
    );
    expect(replacement.id).not.toBe(binding.id);
  });

  test('已被提测引用的绑定不能删除且历史保持完整', async () => {
    const { database, engineering, project, runners, service, users } =
      await setup();
    const binding = service.createBinding(
      users.member.id,
      engineering.id,
      runners.member.runner.id,
      randomUUID(),
    );
    const submissionId = randomUUID();
    const itemId = randomUUID();
    const createdAt = '2026-07-26T11:00:00.000Z';
    database
      .prepare(
        `INSERT INTO cooking_test_submission(
           id, project_id, title, requirement_description, tester_user_id,
           status, version, workspace_revision, created_by_user_id,
           created_at, updated_at, closed_at
         ) VALUES (?, ?, '删除保护', '验证绑定历史', ?, 'ACTIVE', 1, 1, ?, ?, ?, NULL)`,
      )
      .run(
        submissionId,
        project.id,
        users.owner.id,
        users.owner.id,
        createdAt,
        createdAt,
      );
    database
      .prepare(
        `INSERT INTO cooking_submission_item(
           id, submission_id, position, engineering_id, engineering_name,
           engineering_type, engineering_identifier, repository_url,
           responsible_user_id, responsible_username,
           responsible_display_name, responsible_user_created_at, binding_id,
           target_branch, environment_id, environment_name, deployment_json,
           created_at
         ) VALUES (?, ?, 0, ?, 'Binding 工程', 'FRONTEND', 'binding-web',
                   'https://example.com/team/project.git', ?, ?, ?, ?, ?,
                   'main', ?, '测试环境', '{"kind":"CI_CD"}', ?)`,
      )
      .run(
        itemId,
        submissionId,
        engineering.id,
        users.member.id,
        users.member.username,
        users.member.displayName,
        users.member.createdAt,
        binding.id,
        randomUUID(),
        createdAt,
      );
    expect(() =>
      service.deleteBinding(users.member.id, binding.id, randomUUID()),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expect(service.listBindings(users.member.id, engineering.id)).toHaveLength(
      1,
    );
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM cooking_submission_item WHERE id = ?',
        )
        .get(itemId)?.count,
    ).toBe(1);
  });

  test('已被执行历史引用的绑定不能删除', async () => {
    const { database, engineering, runners, service, users } = await setup();
    const binding = service.createBinding(
      users.member.id,
      engineering.id,
      runners.member.runner.id,
      randomUUID(),
    );
    const executionId = randomUUID();
    database
      .prepare(
        `INSERT INTO platform_execution(
           id, owner_namespace, owner_kind, owner_id, attempt,
           previous_execution_id, runner_id, binding_id, priority, state,
           prompt_kind, prompt_version, rendered_prompt, rendered_prompt_hash,
           output_json_schema, resume_session_id, session_id,
           lease_token_hash, lease_expires_at, outcome_json,
           reported_outcome_json, cancellation_requested, created_at,
           claimed_at, started_at, finished_at
         ) VALUES (
           ?, 'COOKING', 'REPAIR', 'historical-owner', 1, NULL, ?, ?, 0,
           'SUCCEEDED', 'REPAIR', 1, '历史任务', ?, '{}', NULL, NULL,
           NULL, NULL, '{}', '{}', 0, ?, NULL, NULL, ?
         )`,
      )
      .run(
        executionId,
        runners.member.runner.id,
        binding.id,
        'a'.repeat(64),
        '2026-07-26T11:00:00.000Z',
        '2026-07-26T11:01:00.000Z',
      );
    expect(() =>
      service.deleteBinding(users.member.id, binding.id, randomUUID()),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM platform_execution WHERE id = ?',
        )
        .get(executionId)?.count,
    ).toBe(1);
  });
});
