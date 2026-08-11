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
import { TestSubmissionWriteStore } from '@/features/cooking/submissions/application/test-submission-write-store';
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

test('TestSubmissionWriteStore 只在首次成功提交后发布 Revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-party-time-write-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  databases.push(database);
  const auth = new AuthService(database);
  const user = await auth.seedUser({
    id: 'submission-write-user',
    username: 'submission-write-user',
    displayName: '提测写入用户',
    password: 'password',
  });
  const project = new ProjectService(database).createProject(user.id, {
    mutationId: randomUUID(),
    name: '提测写入项目',
  }).project;
  const submissionId = randomUUID();
  const createdAt = '2026-08-11T00:00:00.000Z';
  database
    .prepare(
      `INSERT INTO cooking_test_submission(
         id, project_id, title, requirement_description, tester_user_id,
         status, version, workspace_revision, created_by_user_id,
         created_at, updated_at, closed_at
       ) VALUES (?, ?, '提测写入', '验证写入时序', ?, 'ACTIVE', 1, 1, ?, ?, ?, NULL)`,
    )
    .run(submissionId, project.id, user.id, user.id, createdAt, createdAt);
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
      invalidation: (result) => ({
        submissionId,
        revision: result.revision,
      }),
      perform: () => {
        executions += 1;
        const revision = store.bumpRevision(submissionId, createdAt);
        return {
          result: { revision },
          resourceId: submissionId,
          audits: [
            {
              projectId: project.id,
              action: 'TEST_SUBMISSION_WRITTEN',
              targetType: 'TEST_SUBMISSION',
              targetId: submissionId,
            },
          ],
        };
      },
    });

  expect(command()).toEqual({ revision: 2 });
  expect(command()).toEqual({ revision: 2 });
  expect(executions).toBe(1);
  expect(invalidations).toEqual([{ submissionId, revision: 2 }]);
  expect(
    database
      .query<{ count: number }, []>(
        `SELECT COUNT(*) count FROM cooking_audit_event
         WHERE action = 'TEST_SUBMISSION_WRITTEN'`,
      )
      .get()?.count,
  ).toBe(1);

  expect(() =>
    store.run({
      mutationId: randomUUID(),
      actorUserId: user.id,
      operation: 'TEST_SUBMISSION_FAILURE',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: z.object({ revision: z.number().int() }),
      invalidation: (result) => ({ submissionId, revision: result.revision }),
      perform: () => {
        store.bumpRevision(submissionId, createdAt);
        throw new Error('rollback');
      },
    }),
  ).toThrow('rollback');
  expect(
    database
      .query<{ workspace_revision: number }, [string]>(
        `SELECT workspace_revision FROM cooking_test_submission WHERE id = ?`,
      )
      .get(submissionId)?.workspace_revision,
  ).toBe(2);
  expect(invalidations).toEqual([{ submissionId, revision: 2 }]);
});
