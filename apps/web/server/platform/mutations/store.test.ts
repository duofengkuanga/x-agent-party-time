import { ProjectService } from '@/server/platform/projects/projectService';
import { AuthService } from '@/server/platform/auth/service';
import { expectRowCount, testDatabases } from '@/testing/database';
import { seedTestUser } from '@/testing/users';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MutationStore } from './store';

const createDatabase = testDatabases();

test('MutationStore 在同一事务中完成业务写入、Audit 与幂等结果', async () => {
  const { directory, database } = await createDatabase();
  const auth = new AuthService(database);
  const user = await seedTestUser(auth, ['write-user', '写入用户']);
  const project = new ProjectService(database).createProject(user.id, {
    mutationId: randomUUID(),
    name: '写入测试项目',
  }).project;
  const store = new MutationStore(database);
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
          audit: {
            projectId: project.id,
            action: 'TEST_WRITTEN',
          },
        };
      },
    });

  expect(command()).toEqual({ value: '稳定结果' });
  expect(command()).toEqual({ value: '稳定结果' });
  expect(executions).toBe(1);
  expectRowCount(database, 'platform_audit_event', {
    action: 'TEST_WRITTEN',
  }).toBe(1);
  expect(
    database.get<{ target_type: string; target_id: string }>(
      `SELECT target_type, target_id FROM platform_audit_event
       WHERE action = 'TEST_WRITTEN'`,
    ),
  ).toEqual({ target_type: 'TEST_RESOURCE', target_id: 'resource-one' });
});

describe('MutationStore 冲突保护', () => {
  test('同一操作标识不能复用于不同操作', async () => {
    const { directory, database } = await createDatabase();
    const auth = new AuthService(database);
    const user = await seedTestUser(auth, ['conflict-user', '冲突用户']);
    const store = new MutationStore(database);
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
