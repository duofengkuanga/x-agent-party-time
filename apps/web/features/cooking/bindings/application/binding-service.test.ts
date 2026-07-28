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
  const runners = new RunnerService(database);
  const pairRunner = (userId: string, name: string) =>
    runners.pair(runners.issuePairingCode(userId).code, name);
  return {
    database,
    engineering,
    runners: {
      owner: pairRunner(users.owner.id, 'Owner Runner'),
      member: pairRunner(users.member.id, 'Member Runner'),
      other: pairRunner(users.other.id, 'Other Runner'),
    },
    service: new BindingService(
      database,
      () => new Date('2026-07-26T11:00:00Z'),
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
    const { engineering, runners, service, users } = await setup();
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
