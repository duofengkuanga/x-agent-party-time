import { ProjectService } from '@/cooking/projects/server/project-service';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import { AuthService } from '@/platform/auth/service';
import { expectRowCount, testDatabases } from '@/testing/database';
import { seedTestUser } from '@/testing/users';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CookingWriteStore } from './write-store';

const createDatabase = testDatabases();

test('CookingWriteStore 在同一事务中完成业务写入、Audit 与幂等结果', async () => {
  const { directory, database } = await createDatabase();
  const auth = new AuthService(database);
  const user = await seedTestUser(auth, ['write-user', '写入用户']);
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
  expectRowCount(database, 'cooking_audit_event', {
    action: 'TEST_WRITTEN',
  }).toBe(1);
  expect(
    database.get<{ target_type: string; target_id: string }>(
      `SELECT target_type, target_id FROM cooking_audit_event
       WHERE action = 'TEST_WRITTEN'`,
    ),
  ).toEqual({ target_type: 'TEST_RESOURCE', target_id: 'resource-one' });
});

describe('CookingWriteStore 冲突保护', () => {
  test('同一操作标识不能复用于不同操作', async () => {
    const { directory, database } = await createDatabase();
    const auth = new AuthService(database);
    const user = await seedTestUser(auth, ['conflict-user', '冲突用户']);
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

test('TestSubmissionWriteStore 只在首次成功提交后发布 Revision', async () => {
  const { directory, database } = await createDatabase();
  const auth = new AuthService(database);
  const user = await seedTestUser(auth, ['submission-write-user', '提测写入用户']);
  const project = new ProjectService(database).createProject(user.id, {
    mutationId: randomUUID(),
    name: '提测写入项目',
  }).project;
  const submissionId = randomUUID();
  const createdAt = '2026-08-11T00:00:00.000Z';
  database.run(
    `INSERT INTO cooking_test_submission(
         id, project_id, title, requirement_description, tester_user_id,
         status, version, workspace_revision, created_by_user_id,
         created_at, updated_at, closed_at
       ) VALUES (?, ?, '提测写入', '验证写入时序', ?, 'ACTIVE', 1, 1, ?, ?, ?, NULL)`,
    [submissionId, project.id, user.id, user.id, createdAt, createdAt],
  );
  const invalidations: Array<{ submissionId: string; revision: number }> = [];
  const store = new TestSubmissionWriteStore(
    database,
    () => new Date(createdAt),
    randomUUID,
    (id, revision) => invalidations.push({ submissionId: id, revision }),
  );
  const mutationId = randomUUID();
  let executions = 0;
  const command = () =>
    store.run({
      mutationId,
      actorUserId: user.id,
      operation: 'TEST_SUBMISSION_WRITE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: z.object({ revision: z.number().int() }),
      submissionId: () => submissionId,
      perform: () => {
        executions += 1;
        const revision = store.bumpRevision(submissionId, createdAt);
        return {
          result: { revision },
          resourceId: submissionId,
          audit: {
            projectId: project.id,
            action: 'TEST_SUBMISSION_WRITTEN',
          },
        };
      },
    });

  expect(command()).toEqual({ revision: 2 });
  expect(command()).toEqual({ revision: 2 });
  expect(executions).toBe(1);
  expect(invalidations).toEqual([{ submissionId, revision: 2 }]);
  expectRowCount(database, 'cooking_audit_event', {
    action: 'TEST_SUBMISSION_WRITTEN',
  }).toBe(1);

  expect(() =>
    store.run({
      mutationId: randomUUID(),
      actorUserId: user.id,
      operation: 'TEST_SUBMISSION_FAILURE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: z.object({ revision: z.number().int() }),
      submissionId: () => submissionId,
      perform: () => {
        store.bumpRevision(submissionId, createdAt);
        throw new Error('rollback');
      },
    }),
  ).toThrow('rollback');
  expect(
    database.get<{ workspace_revision: number }>(
      `SELECT workspace_revision FROM cooking_test_submission WHERE id = ?`,
      submissionId,
    )?.workspace_revision,
  ).toBe(2);
  expect(invalidations).toEqual([{ submissionId, revision: 2 }]);
});
