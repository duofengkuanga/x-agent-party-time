import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/platform/auth/service';
import type { AppDatabase } from '@/platform/database';
import { openDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ProjectService } from './project-service';

const directories: string[] = [];
const databases: AppDatabase[] = [];

async function setup(options?: {
  hasActiveResponsibilities?: (projectId: string, userId: string) => boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-projects-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(
    database,
    () => new Date('2026-07-26T08:00:00Z'),
  );
  const users = {
    owner: await auth.seedUser({
      id: 'user-owner',
      username: 'owner',
      displayName: '所有者',
      password: 'password',
    }),
    member: await auth.seedUser({
      id: 'user-member',
      username: 'member',
      displayName: '成员',
      password: 'password',
    }),
    other: await auth.seedUser({
      id: 'user-other',
      username: 'other',
      displayName: '其他用户',
      password: 'password',
    }),
  };
  return {
    database,
    users,
    service: new ProjectService(
      database,
      () => new Date('2026-07-26T08:30:00Z'),
      randomUUID,
      options?.hasActiveResponsibilities,
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

describe('ProjectService', () => {
  test('原子创建唯一 OWNER，并按成员关系隔离项目和 Mutation', async () => {
    const { database, service, users } = await setup();
    const mutationId = randomUUID();
    const created = service.createProject(users.owner.id, {
      mutationId,
      name: '  私密项目  ',
    });
    const retried = service.createProject(users.owner.id, {
      mutationId,
      name: '不会重复创建',
    });

    expect(retried).toEqual(created);
    expect(created.project.name).toBe('私密项目');
    expect(created.membership.role).toBe('OWNER');
    expect(service.listProjects(users.owner.id)).toEqual([created]);
    expect(service.listProjects(users.member.id)).toEqual([]);
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM cooking_project',
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM cooking_project_membership',
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) count FROM cooking_audit_event',
        )
        .get()?.count,
    ).toBe(1);
  });

  test('非成员读取真实或不存在项目都得到相同安全错误', async () => {
    const { service, users } = await setup();
    const project = service.createProject(users.owner.id, {
      mutationId: randomUUID(),
      name: '不可枚举项目',
    }).project;

    const realError = capturePlatformError(() =>
      service.getProject(users.other.id, project.id),
    );
    const missingError = capturePlatformError(() =>
      service.getProject(users.other.id, randomUUID()),
    );
    expect(realError.code).toBe('NOT_FOUND');
    expect(missingError.code).toBe('NOT_FOUND');
    expect(realError.message).toBe(missingError.message);
  });

  test('OWNER 邀请现有用户，受邀者幂等接受并成为 MEMBER', async () => {
    const { database, service, users } = await setup();
    const project = service.createProject(users.owner.id, {
      mutationId: randomUUID(),
      name: '协作项目',
    }).project;
    expect(() =>
      service.inviteUser(users.owner.id, project.id, {
        mutationId: randomUUID(),
        username: 'missing-user',
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    const invitation = service.inviteUser(users.owner.id, project.id, {
      mutationId: randomUUID(),
      username: 'MEMBER',
    });
    const duplicatePending = service.inviteUser(users.owner.id, project.id, {
      mutationId: randomUUID(),
      username: 'member',
    });
    expect(duplicatePending).toEqual(invitation);
    expect(service.listReceivedInvitations(users.member.id)).toHaveLength(1);
    expect(() =>
      service.respondToInvitation(users.other.id, invitation.id, {
        mutationId: randomUUID(),
        expectedVersion: invitation.version,
        decision: 'ACCEPT',
      }),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

    const accepted = service.respondToInvitation(
      users.member.id,
      invitation.id,
      {
        mutationId: randomUUID(),
        expectedVersion: invitation.version,
        decision: 'ACCEPT',
      },
    );
    const repeated = service.respondToInvitation(
      users.member.id,
      invitation.id,
      {
        mutationId: randomUUID(),
        expectedVersion: invitation.version,
        decision: 'ACCEPT',
      },
    );
    expect(accepted.status).toBe('ACCEPTED');
    expect(repeated).toEqual(accepted);
    expect(service.listProjects(users.member.id)[0]?.membership.role).toBe(
      'MEMBER',
    );
    expect(service.listMembers(users.owner.id, project.id)).toHaveLength(2);
    expect(
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) count FROM cooking_project_membership
           WHERE project_id = ? AND user_id = ?`,
        )
        .get(project.id, users.member.id)?.count,
    ).toBe(1);
    expect(() =>
      service.inviteUser(users.member.id, project.id, {
        mutationId: randomUUID(),
        username: 'other',
      }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });

  test('邀请可拒绝或撤销，终态重复操作幂等且相反操作被拒绝', async () => {
    const { service, users } = await setup();
    const project = service.createProject(users.owner.id, {
      mutationId: randomUUID(),
      name: '邀请状态项目',
    }).project;
    const rejectedInvitation = service.inviteUser(users.owner.id, project.id, {
      mutationId: randomUUID(),
      username: 'member',
    });
    const rejected = service.respondToInvitation(
      users.member.id,
      rejectedInvitation.id,
      {
        mutationId: randomUUID(),
        expectedVersion: rejectedInvitation.version,
        decision: 'REJECT',
      },
    );
    expect(
      service.respondToInvitation(users.member.id, rejectedInvitation.id, {
        mutationId: randomUUID(),
        expectedVersion: rejectedInvitation.version,
        decision: 'REJECT',
      }),
    ).toEqual(rejected);
    expect(() =>
      service.respondToInvitation(users.member.id, rejectedInvitation.id, {
        mutationId: randomUUID(),
        expectedVersion: rejectedInvitation.version,
        decision: 'ACCEPT',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));

    const revokedInvitation = service.inviteUser(users.owner.id, project.id, {
      mutationId: randomUUID(),
      username: 'other',
    });
    const revoked = service.revokeInvitation(
      users.owner.id,
      revokedInvitation.id,
      {
        mutationId: randomUUID(),
        expectedVersion: revokedInvitation.version,
      },
    );
    expect(
      service.revokeInvitation(users.owner.id, revokedInvitation.id, {
        mutationId: randomUUID(),
        expectedVersion: revokedInvitation.version,
      }),
    ).toEqual(revoked);
  });

  test('版本冲突、活动职责和最后 OWNER 保护成员与项目写入', async () => {
    const activeUsers = new Set(['user-member']);
    const { service, users } = await setup({
      hasActiveResponsibilities: (_projectId, userId) =>
        activeUsers.has(userId),
    });
    const created = service.createProject(users.owner.id, {
      mutationId: randomUUID(),
      name: '版本项目',
    });
    const invitation = service.inviteUser(users.owner.id, created.project.id, {
      mutationId: randomUUID(),
      username: 'member',
    });
    service.respondToInvitation(users.member.id, invitation.id, {
      mutationId: randomUUID(),
      expectedVersion: invitation.version,
      decision: 'ACCEPT',
    });
    const member = service
      .listMembers(users.owner.id, created.project.id)
      .find(({ user }) => user.id === users.member.id)!;

    expect(() =>
      service.updateProject(users.owner.id, created.project.id, {
        mutationId: randomUUID(),
        expectedVersion: 99,
        name: '过期修改',
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    expect(() =>
      service.removeMember(
        users.owner.id,
        created.project.id,
        users.member.id,
        {
          mutationId: randomUUID(),
          expectedVersion: member.membership.version,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    activeUsers.clear();
    expect(
      service.removeMember(
        users.owner.id,
        created.project.id,
        users.member.id,
        {
          mutationId: randomUUID(),
          expectedVersion: member.membership.version,
        },
      ),
    ).toEqual({ removed: true, userId: users.member.id });
    expect(() =>
      service.removeMember(users.owner.id, created.project.id, users.owner.id, {
        mutationId: randomUUID(),
        expectedVersion: created.membership.version,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });
});

function capturePlatformError(action: () => unknown): PlatformError {
  try {
    action();
  } catch (error) {
    if (error instanceof PlatformError) return error;
    throw error;
  }
  throw new Error('预期操作失败');
}
