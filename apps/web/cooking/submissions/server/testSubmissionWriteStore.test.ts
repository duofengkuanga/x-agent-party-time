import { ProjectService } from '@/cooking/projects/server/projectService';
import { AuthService } from '@/platform/auth/service';
import { expectRowCount, testDatabases } from '@/testing/database';
import { seedTestUser } from '@/testing/users';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TestSubmissionWriteStore } from './testSubmissionWriteStore';

const createDatabase = testDatabases();

async function affectedWorkspacesFixture() {
  const { database } = await createDatabase();
  const user = await seedTestUser(new AuthService(database), [
    'affected-writes',
    '关联写入',
  ]);
  const project = new ProjectService(database).createProject(user.id, {
    mutationId: randomUUID(),
    name: '关联工作区',
  }).project;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const createdAt = '2026-10-23T00:00:00.000Z';
  const updatedAt = '2026-10-23T01:00:00.000Z';
  for (const id of ids)
    database.run(
      `INSERT INTO cooking_test_submission(
        id, project_id, title, requirement_description, tester_user_id,
        status, version, workspace_revision, created_by_user_id,
        created_at, updated_at, closed_at
      ) VALUES (?, ?, '关联提测', '验证事务和通知', ?, 'ACTIVE', 1, 1, ?, ?, ?, NULL)`,
      [id, project.id, user.id, user.id, createdAt, createdAt],
    );
  const revisions = () =>
    ids.map(
      (id) =>
        database.get<{ workspace_revision: number }>(
          'SELECT workspace_revision FROM cooking_test_submission WHERE id = ?',
          id,
        )!.workspace_revision,
    );
  const events: Array<{
    submissionId: string;
    revision: number;
    inTransaction: boolean;
    visibleRevisions: number[];
  }> = [];
  const store = new TestSubmissionWriteStore(
    database,
    () => new Date(updatedAt),
    randomUUID,
    (submissionId, revision) =>
      events.push({
        submissionId,
        revision,
        inTransaction: database.inTransaction,
        visibleRevisions: revisions(),
      }),
  );
  return { database, user, project, ids, createdAt, updatedAt, revisions, events, store };
}

test('关联提测单在同一事务递增版本，提交后去重通知，回放和后续写入不重复通知', async () => {
  const f = await affectedWorkspacesFixture();
  const [primary, first, second] = f.ids as [string, string, string];
  const mutationId = randomUUID();
  let performed = 0;
  const command = () =>
    f.store.run({
      mutationId,
      actorUserId: f.user.id,
      operation: 'AFFECTED_SUBMISSIONS',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: z.object({ revision: z.number().int() }),
      submissionId: () => primary,
      perform: () => {
        performed++;
        expect(f.database.inTransaction).toBe(true);
        return {
          result: { revision: f.store.bumpRevision(primary, f.updatedAt) },
          resourceId: primary,
          affectedSubmissions: {
            ids: [first, second, first, primary],
            updatedAt: f.updatedAt,
          },
        };
      },
    });
  expect(command()).toEqual({ revision: 2 });
  expect(f.revisions()).toEqual([2, 2, 2]);
  expect(f.events).toEqual(
    f.ids.map((submissionId) => ({
      submissionId,
      revision: 2,
      inTransaction: false,
      visibleRevisions: [2, 2, 2],
    })),
  );
  expect(command()).toEqual({ revision: 2 });
  expect(performed).toBe(1);
  expect(f.events).toHaveLength(3);
  expect(
    f.database.get<{ result_json: string }>(
      'SELECT result_json FROM cooking_mutation WHERE id = ?',
      mutationId,
    )!.result_json,
  ).toBe('{"revision":2}');
  expect(
    f.database
      .all<{ updated_at: string }>('SELECT updated_at FROM cooking_test_submission')
      .map(({ updated_at }) => updated_at),
  ).toEqual([f.updatedAt, f.updatedAt, f.updatedAt]);

  f.store.run({
    mutationId: randomUUID(),
    actorUserId: f.user.id,
    operation: 'PRIMARY_ONLY',
    resourceType: 'TEST_SUBMISSION',
    resultSchema: z.object({ revision: z.number().int() }),
    submissionId: () => primary,
    perform: () => ({
      result: { revision: f.store.bumpRevision(primary, f.updatedAt) },
      resourceId: primary,
    }),
  });
  expect(f.revisions()).toEqual([3, 2, 2]);
  expect(f.events).toHaveLength(4);
  expect(f.events.at(-1)).toEqual({
    submissionId: primary,
    revision: 3,
    inTransaction: false,
    visibleRevisions: [3, 2, 2],
  });
});

test('结果校验失败回滚关联提测单版本且不通知，修正后同一操作可重试', async () => {
  const f = await affectedWorkspacesFixture();
  const primary = f.ids[0]!;
  const mutationId = randomUUID();
  let valid = false;
  const command = () =>
    f.store.run({
      mutationId,
      actorUserId: f.user.id,
      operation: 'AFFECTED_SUBMISSIONS_VALIDATION',
      resourceType: 'TEST_SUBMISSION',
      resultSchema: z
        .object({ revision: z.number().int() })
        .refine(() => valid, '结果未通过校验'),
      submissionId: () => primary,
      perform: () => ({
        result: { revision: f.store.bumpRevision(primary, f.updatedAt) },
        resourceId: primary,
        affectedSubmissions: { ids: f.ids.slice(1), updatedAt: f.updatedAt },
      }),
    });
  expect(command).toThrow('结果未通过校验');
  expect(f.revisions()).toEqual([1, 1, 1]);
  expect(f.events).toEqual([]);
  expectRowCount(f.database, 'cooking_mutation', { id: mutationId }).toBe(0);
  valid = true;
  expect(command()).toEqual({ revision: 2 });
  expect(f.revisions()).toEqual([2, 2, 2]);
  expect(f.events).toHaveLength(3);
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
