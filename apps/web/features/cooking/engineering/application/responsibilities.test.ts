import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import { EngineeringService } from './engineering-service';
import { projectMemberHasEngineeringResponsibilities } from './responsibilities';

const directories: string[] = [];
const databases: AppDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test('工程成员关系接入 Project 成员活动职责保护', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-duty-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(database);
  const owner = await auth.seedUser({
    id: 'duty-owner',
    username: 'duty-owner',
    displayName: '职责所有者',
    password: 'password',
  });
  const member = await auth.seedUser({
    id: 'duty-member',
    username: 'duty-member',
    displayName: '职责成员',
    password: 'password',
  });
  const projects = new ProjectService(
    database,
    undefined,
    undefined,
    (projectId, userId) =>
      projectMemberHasEngineeringResponsibilities(database, projectId, userId),
  );
  const project = projects.createProject(owner.id, {
    mutationId: randomUUID(),
    name: '职责项目',
  });
  const invitation = projects.inviteUser(owner.id, project.project.id, {
    mutationId: randomUUID(),
    username: member.username,
  });
  projects.respondToInvitation(member.id, invitation.id, {
    mutationId: randomUUID(),
    expectedVersion: invitation.version,
    decision: 'ACCEPT',
  });
  const engineering = new EngineeringService(database).createEngineering(
    owner.id,
    project.project.id,
    {
      mutationId: randomUUID(),
      name: '职责工程',
      type: 'BACKEND',
      identifier: 'responsibility-api',
    },
  );
  new EngineeringService(database).addMember(
    owner.id,
    engineering.id,
    member.id,
    { mutationId: randomUUID() },
  );
  const projectMember = projects
    .listMembers(owner.id, project.project.id)
    .find(({ user }) => user.id === member.id)!;

  expect(() =>
    projects.removeMember(owner.id, project.project.id, member.id, {
      mutationId: randomUUID(),
      expectedVersion: projectMember.membership.version,
    }),
  ).toThrow(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
});
