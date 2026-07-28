import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import {
  EngineeringService,
  type EngineeringGuards,
} from './engineering-service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup() {
  const directory = await mkdtemp(
    join(tmpdir(), 'agent-party-time-engineering-'),
  );
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(
    database,
    () => new Date('2026-07-26T09:00:00Z'),
  );
  const users = {
    owner: await auth.seedUser({
      id: 'engineering-owner',
      username: 'engineering-owner',
      displayName: '工程所有者',
      password: 'password',
    }),
    member: await auth.seedUser({
      id: 'engineering-member',
      username: 'engineering-member',
      displayName: '工程成员',
      password: 'password',
    }),
    other: await auth.seedUser({
      id: 'engineering-other',
      username: 'engineering-other',
      displayName: '项目外用户',
      password: 'password',
    }),
  };
  const projects = new ProjectService(database);
  const project = projects.createProject(users.owner.id, {
    mutationId: randomUUID(),
    name: '工程测试项目',
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

  const references = {
    engineering: new Set<string>(),
    environment: new Set<string>(),
    member: new Set<string>(),
  };
  const guards: EngineeringGuards = {
    engineeringReferenced: (engineeringId) =>
      references.engineering.has(engineeringId),
    environmentReferenced: (environmentId) =>
      references.environment.has(environmentId),
    memberHasActiveResponsibilities: (engineeringId, userId) =>
      references.member.has(`${engineeringId}:${userId}`),
  };
  return {
    database,
    project,
    projects,
    references,
    users,
    service: new EngineeringService(
      database,
      guards,
      () => new Date('2026-07-26T09:30:00Z'),
      randomUUID,
    ),
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

describe('EngineeringService', () => {
  test('工程初始化原子创建创建者成员、额外成员与首个环境', async () => {
    const { project, service, users } = await setup();
    const engineering = service.createEngineeringSetup(
      users.owner.id,
      project.id,
      {
        mutationId: randomUUID(),
        name: '完整初始化工程',
        creatorMembershipMutationId: randomUUID(),
        members: [{ userId: users.member.id, mutationId: randomUUID() }],
        environment: {
          mutationId: randomUUID(),
          name: '测试环境',
          deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
        },
      },
    );
    const workspace = service.getWorkspace(users.owner.id, engineering.id);
    expect(workspace.members.map(({ user }) => user.id).sort()).toEqual(
      [users.owner.id, users.member.id].sort(),
    );
    expect(workspace.environments).toHaveLength(1);
    expect(workspace.environments[0]).toMatchObject({
      name: '测试环境',
      deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
    });
  });

  test('工程初始化后续步骤失败时回滚工程与 Mutation', async () => {
    const { database, project, service, users } = await setup();
    const mutationCountBefore = database
      .query<{ count: number }, []>(
        'SELECT COUNT(*) count FROM cooking_mutation',
      )
      .get()!.count;
    expect(() =>
      service.createEngineeringSetup(users.owner.id, project.id, {
        mutationId: randomUUID(),
        name: '应回滚工程',
        creatorMembershipMutationId: randomUUID(),
        members: [{ userId: users.other.id, mutationId: randomUUID() }],
        environment: {
          mutationId: randomUUID(),
          name: '测试环境',
          deployment: { kind: 'CI_CD' },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(service.listEngineering(users.owner.id, project.id)).toEqual([]);
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM cooking_mutation',
        )
        .get()?.count,
    ).toBe(mutationCountBefore);
  });

  test('OWNER 可以创建任意命名工程，项目成员可读但不能管理', async () => {
    const { database, project, service, users } = await setup();
    const mutationId = randomUUID();
    const engineering = service.createEngineering(users.owner.id, project.id, {
      mutationId,
      name: '全栈一体化工程',
    });
    expect(engineering).toMatchObject({ repositoryState: 'PENDING' });
    expect(
      service.createEngineering(users.owner.id, project.id, {
        mutationId,
        name: '不会重复创建',
      }),
    ).toEqual(engineering);
    expect(service.listEngineering(users.member.id, project.id)).toEqual([
      engineering,
    ]);
    expect(() =>
      service.getEngineering(users.other.id, engineering.id),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() =>
      service.createEngineering(users.member.id, project.id, {
        mutationId: randomUUID(),
        name: '越权工程',
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM cooking_engineering',
        )
        .get()?.count,
    ).toBe(1);
  });

  test('工程成员必须先属于项目，添加幂等且活动职责阻止移除', async () => {
    const { project, references, service, users } = await setup();
    const engineering = service.createEngineering(users.owner.id, project.id, {
      mutationId: randomUUID(),
      name: '成员工程',
    });
    expect(() =>
      service.addMember(users.owner.id, engineering.id, users.other.id, {
        mutationId: randomUUID(),
      }),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const membership = service.addMember(
      users.owner.id,
      engineering.id,
      users.member.id,
      { mutationId: randomUUID() },
    );
    expect(
      service.addMember(users.owner.id, engineering.id, users.member.id, {
        mutationId: randomUUID(),
      }),
    ).toEqual(membership);
    expect(service.listMembers(users.member.id, engineering.id)).toHaveLength(
      1,
    );

    references.member.add(`${engineering.id}:${users.member.id}`);
    expect(() =>
      service.removeMember(users.owner.id, engineering.id, users.member.id, {
        mutationId: randomUUID(),
        expectedVersion: membership.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    references.member.clear();
    expect(
      service.removeMember(users.owner.id, engineering.id, users.member.id, {
        mutationId: randomUUID(),
        expectedVersion: membership.version,
      }),
    ).toEqual({ removed: true, userId: users.member.id });
  });

  test('环境名称在工程内唯一，Version 和 Deployment 判别联合受保护', async () => {
    const { project, service, users } = await setup();
    const engineering = service.createEngineering(users.owner.id, project.id, {
      mutationId: randomUUID(),
      name: '环境工程',
    });
    const environment = service.createEnvironment(
      users.owner.id,
      engineering.id,
      {
        mutationId: randomUUID(),
        name: '测试环境',
        deployment: { kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' },
      },
    );
    expect(() =>
      service.createEnvironment(users.owner.id, engineering.id, {
        mutationId: randomUUID(),
        name: '测试环境',
        deployment: { kind: 'CI_CD' },
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expect(() =>
      service.updateEnvironment(users.owner.id, environment.id, {
        mutationId: randomUUID(),
        expectedVersion: 99,
        name: '测试环境',
        deployment: { kind: 'CI_CD' },
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    const updated = service.updateEnvironment(users.owner.id, environment.id, {
      mutationId: randomUUID(),
      expectedVersion: environment.version,
      name: '持续集成环境',
      deployment: { kind: 'CI_CD' },
    });
    expect(updated.deployment).toEqual({ kind: 'CI_CD' });
    expect(updated.version).toBe(2);
    expect(service.listEnvironments(users.member.id, engineering.id)).toEqual([
      updated,
    ]);
  });

  test('活动引用阻止破坏性修改，归档保留工程、成员和环境历史', async () => {
    const { database, project, references, service, users } = await setup();
    const engineering = service.createEngineering(users.owner.id, project.id, {
      mutationId: randomUUID(),
      name: '历史工程',
    });
    service.addMember(users.owner.id, engineering.id, users.member.id, {
      mutationId: randomUUID(),
    });
    const environment = service.createEnvironment(
      users.owner.id,
      engineering.id,
      {
        mutationId: randomUUID(),
        name: '共享环境',
        deployment: { kind: 'CI_CD' },
      },
    );
    references.environment.add(environment.id);
    expect(() =>
      service.updateEnvironment(users.owner.id, environment.id, {
        mutationId: randomUUID(),
        expectedVersion: environment.version,
        name: '不可修改',
        deployment: { kind: 'LOCAL_SCRIPT', command: 'deploy' },
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    expect(() =>
      service.deleteEnvironment(users.owner.id, environment.id, {
        mutationId: randomUUID(),
        expectedVersion: environment.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    references.environment.clear();
    references.engineering.add(engineering.id);
    expect(() =>
      service.archiveEngineering(users.owner.id, engineering.id, {
        mutationId: randomUUID(),
        expectedVersion: engineering.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    references.engineering.clear();
    const archived = service.archiveEngineering(
      users.owner.id,
      engineering.id,
      {
        mutationId: randomUUID(),
        expectedVersion: engineering.version,
      },
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM cooking_engineering WHERE id = ?',
        )
        .get(engineering.id)?.count,
    ).toBe(1);
    expect(
      service.getWorkspace(users.member.id, engineering.id).members,
    ).toHaveLength(1);
    expect(
      service.getWorkspace(users.member.id, engineering.id).environments,
    ).toHaveLength(1);
  });
});
