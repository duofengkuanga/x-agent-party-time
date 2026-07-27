import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AuthService } from '@/server/auth/service';
import type { AppDatabase } from '@/server/database';
import { openDatabase } from '@/server/database';
import { ProjectService } from '@/features/cooking/projects/application/project-service';
import { CookingWriteStore } from './write-store';

const directories: string[] = [];
const databases: AppDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('CookingWriteStore 在同一事务中完成业务写入、Audit 与幂等结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-write-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(database);
  const user = await auth.seedUser({
    id: 'write-user',
    username: 'write-user',
    displayName: '写入用户',
    password: 'password',
  });
  const project = new ProjectService(database).createProject(user.id, {
    mutationId: randomUUID(),
    name: '写入测试项目',
  }).project;
  const store = new CookingWriteStore(database);
  const mutationId = randomUUID();
  let executions = 0;
  const command = () =>
    store.run({
      mutationId,
      actorUserId: user.id,
      operation: 'TEST_WRITE',
      resourceType: 'TEST_RESOURCE',
      resultSchema: z.object({ value: z.string() }),
      perform: () => {
        executions += 1;
        return {
          result: { value: '稳定结果' },
          resourceId: 'resource-one',
          audits: [
            {
              projectId: project.id,
              action: 'TEST_WRITTEN',
              targetType: 'TEST_RESOURCE',
              targetId: 'resource-one',
            },
          ],
        };
      },
    });

  expect(command()).toEqual({ value: '稳定结果' });
  expect(command()).toEqual({ value: '稳定结果' });
  expect(executions).toBe(1);
  expect(
    database
      .query<{ count: number }, []>(
        `SELECT COUNT(*) count FROM cooking_audit_event
         WHERE action = 'TEST_WRITTEN'`,
      )
      .get()?.count,
  ).toBe(1);
});

describe('CookingWriteStore 冲突保护', () => {
  test('同一操作标识不能复用于不同操作', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-write-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'server.sqlite'));
    databases.push(database);
    const auth = new AuthService(database);
    const user = await auth.seedUser({
      id: 'conflict-user',
      username: 'conflict-user',
      displayName: '冲突用户',
      password: 'password',
    });
    const store = new CookingWriteStore(database);
    const mutationId = randomUUID();
    const base = {
      mutationId,
      actorUserId: user.id,
      resourceType: 'TEST_RESOURCE',
      resultSchema: z.object({ ok: z.boolean() }),
      perform: () => ({ result: { ok: true }, resourceId: 'resource' }),
    };
    expect(store.run({ ...base, operation: 'FIRST' })).toEqual({ ok: true });
    expect(() => store.run({ ...base, operation: 'SECOND' })).toThrow(
      expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
    );
  });
});
