import { RepairService } from '@/cooking/repair/server/repair-service';
import type { AppDatabase } from '@/platform/database';
import { countRows, testDatabases } from '@/testing/database';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { bugFixture, createBug, createAssignedBug } from './bug-fixture';

const setup = bugFixture(testDatabases());

describe('BugService', () => {
  test('deleteBugs 校验缺陷存在与参数互斥', async () => {
    const fixture = await setup();
    expect(() => fixture.service.deleteBugs({})).toThrow(ZodError);
    expect(() => fixture.service.deleteBugs({ bugIds: [] })).toThrow(ZodError);
    expect(() =>
      fixture.service.deleteBugs({
        bugIds: [randomUUID()],
        all: true,
      }),
    ).toThrow(ZodError);
    expect(() =>
      fixture.service.deleteBugs({ bugIds: [randomUUID()] }),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('deleteBugs 删除无执行的普通缺陷并推进提测版本', async () => {
    const fixture = await setup();
    const first = createBug(fixture, fixture.users.tester.id, {
      title: '待删除缺陷一',
    });
    const second = createBug(fixture, fixture.users.tester.id, {
      title: '待删除缺陷二',
    });
    const revisionBefore = fixture.service.workspace(
      fixture.users.tester.id,
      fixture.submission.id,
    ).bugs.length;
    expect(revisionBefore).toBe(2);

    const result = fixture.service.deleteBugs({
      bugIds: [first.bug.id, second.bug.id],
    });
    expect(result.deletedBugIds).toEqual([first.bug.id, second.bug.id]);
    expect(result.deletedExecutionIds).toEqual([]);
    expect(
      countRows(fixture.database, 'cooking_bug', { id: first.bug.id }),
    ).toBe(0);
    expect(
      countRows(fixture.database, 'cooking_mutation', {
        resource_type: 'BUG',
        resource_id: first.bug.id,
      }),
    ).toBe(0);
    expect(
      countRows(fixture.database, 'cooking_audit_event', {
        target_type: 'BUG',
        target_id: second.bug.id,
      }),
    ).toBe(0);
    expect(fixture.events.at(-1)).toEqual({
      submissionId: fixture.submission.id,
      revision: 4,
    });
  });

  test('deleteBugs 存在非终态执行且未 force 时拒绝删除', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '进行中缺陷', fixture.items.front);
    new RepairService(fixture.database).createInitialExecution(bug.id);
    expect(() => fixture.service.deleteBugs({ bugIds: [bug.id] })).toThrow(
      expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
    );
    expect(countRows(fixture.database, 'cooking_bug', { id: bug.id })).toBe(1);
  });

  test('deleteBugs --force 删除链式修复执行与关联上下文', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '链式修复缺陷', fixture.items.front);
    const repairs = new RepairService(fixture.database);
    const first = repairs.createInitialExecution(bug.id);
    fixture.database.run(
      `UPDATE platform_execution
         SET state = 'FAILED', finished_at = ? WHERE id = ?`,
      ['2026-07-27T03:30:00.000Z', first],
    );
    const second = repairs.createInitialExecution(bug.id);
    fixture.database.run(
      `UPDATE platform_execution
         SET state = 'SUCCEEDED', finished_at = ? WHERE id = ?`,
      ['2026-07-27T04:00:00.000Z', second],
    );
    const previous = fixture.database.get<{
      previous_execution_id: string | null;
    }>(
      'SELECT previous_execution_id FROM platform_execution WHERE id = ?',
      second,
    )?.previous_execution_id;
    expect(previous).toBe(first);

    const result = fixture.service.deleteBugs({
      bugIds: [bug.id],
      force: true,
    });
    expect(new Set(result.deletedExecutionIds)).toEqual(
      new Set([first, second]),
    );
    expect(
      countRows(fixture.database, 'platform_execution', { id: first }),
    ).toBe(0);
    expect(
      countRows(fixture.database, 'cooking_repair_attempt', { bug_id: bug.id }),
    ).toBe(0);
    expect(
      countRows(fixture.database, 'cooking_bug_repair_context', {
        bug_id: bug.id,
      }),
    ).toBe(0);
    expect(countRows(fixture.database, 'cooking_bug', { id: bug.id })).toBe(0);
  });

  test('deleteBugs --all --force 清理空的统一更新批次与活动执行', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '批次内缺陷', fixture.items.front);
    const repairs = new RepairService(fixture.database);
    const executionId = repairs.createInitialExecution(bug.id);
    fixture.database.run(
      `UPDATE platform_execution
         SET state = 'SUCCEEDED', finished_at = ? WHERE id = ?`,
      ['2026-07-27T04:00:00.000Z', executionId],
    );
    const now = '2026-07-27T04:00:00.000Z';
    const batchId = randomUUID();
    fixture.database.run(
      `INSERT INTO cooking_update_batch(
           id, submission_id, submission_item_id, state, version,
           active_execution_id, session_id, deployment_json, frozen_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'RUNNING', 1, ?, NULL, '{}', ?, ?, ?)`,
      [
        batchId,
        fixture.submission.id,
        fixture.items.front,
        executionId,
        now,
        now,
        now,
      ],
    );
    fixture.database.run(
      `INSERT INTO cooking_update_batch_entry(
           batch_id, bug_id, position, commits_json, manual_operations_json
         ) VALUES (?, ?, 0, '[]', '[]')`,
      [batchId, bug.id],
    );
    fixture.database.run(
      `INSERT INTO cooking_update_attempt(
           id, batch_id, execution_id, attempt, outcome_json, created_at, finished_at
         ) VALUES (?, ?, ?, 1, NULL, ?, NULL)`,
      [randomUUID(), batchId, executionId, now],
    );

    const sync = addSessionSync(fixture.database, executionId, 'FAILED');
    fixture.database.run(
      'INSERT INTO cooking_update_session_sync(id, batch_id, execution_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [randomUUID(), batchId, sync, 'update-session', now],
    );
    const result = fixture.service.deleteBugs({ all: true, force: true });
    expect(new Set(result.deletedExecutionIds)).toEqual(
      new Set([executionId, sync]),
    );
    expect(
      fixture.database.all('SELECT id FROM cooking_update_session_sync'),
    ).toEqual([]);
    expect(
      countRows(fixture.database, 'cooking_update_batch_entry', {
        bug_id: bug.id,
      }),
    ).toBe(0);
    expect(
      countRows(fixture.database, 'cooking_update_attempt', {
        execution_id: executionId,
      }),
    ).toBe(0);
    expect(
      countRows(fixture.database, 'cooking_update_batch', { id: batchId }),
    ).toBe(0);
    expect(
      countRows(fixture.database, 'platform_execution', { id: executionId }),
    ).toBe(0);
  });

  test.each(['QUEUED', 'FAILED'])(
    'deleteBugs 收集修复会话同步执行（%s）',
    async (state) => {
      const fixture = await setup();
      const bug = createAssignedBug(fixture, '同步缺陷', fixture.items.front);
      const parent = new RepairService(fixture.database).createInitialExecution(
        bug.id,
      );
      fixture.database.run(
        "UPDATE platform_execution SET state = 'FAILED' WHERE id = ?",
        [parent],
      );
      const sync = addSessionSync(fixture.database, parent, state);
      fixture.database.run(
        'INSERT INTO cooking_repair_session_sync(id, bug_id, execution_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
        [
          randomUUID(),
          bug.id,
          sync,
          'test-session',
          '2026-07-27T04:00:00.000Z',
        ],
      );
      if (state === 'QUEUED') {
        expect(() => fixture.service.deleteBugs({ all: true })).toThrow(
          expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
        );
      }
      const result = fixture.service.deleteBugs({ all: true, force: true });
      expect(new Set(result.deletedExecutionIds)).toEqual(
        new Set([parent, sync]),
      );
      expect(
        fixture.database.all('SELECT id FROM cooking_repair_session_sync'),
      ).toEqual([]);
      expect(fixture.database.all('PRAGMA foreign_key_check')).toEqual([]);
    },
  );

  test('deleteBugs 遇到范围外的后继执行时明确拒绝并回滚', async () => {
    const fixture = await setup();
    const bug = createAssignedBug(fixture, '额外依赖', fixture.items.front);
    const parent = new RepairService(fixture.database).createInitialExecution(
      bug.id,
    );
    const successor = addSessionSync(fixture.database, parent, 'FAILED');
    expect(() =>
      fixture.service.deleteBugs({ all: true, force: true }),
    ).toThrow(
      expect.objectContaining({
        code: 'RESOURCE_CONFLICT',
        message: expect.stringContaining('本次删除范围外'),
      }),
    );
    expect(
      fixture.database.get('SELECT id FROM cooking_bug WHERE id = ?', bug.id),
    ).not.toBeNull();
    expect(
      fixture.database.get(
        'SELECT id FROM cooking_repair_attempt WHERE execution_id = ?',
        parent,
      ),
    ).not.toBeNull();
    expect(
      fixture.database.get(
        'SELECT id FROM platform_execution WHERE id = ?',
        successor,
      ),
    ).not.toBeNull();
  });

  test('deleteBugs --all 删除全部缺陷', async () => {
    const fixture = await setup();
    createBug(fixture, fixture.users.tester.id, { title: '全部清理一' });
    createBug(fixture, fixture.users.tester.id, { title: '全部清理二' });
    const result = fixture.service.deleteBugs({ all: true });
    expect(result.deletedBugIds).toHaveLength(2);
    expect(
      countRows(fixture.database, 'cooking_bug', {
        submission_id: fixture.submission.id,
      }),
    ).toBe(0);
  });
});

function addSessionSync(
  database: AppDatabase,
  parent: string,
  state: string,
): string {
  const id = randomUUID();
  database.run(
    `INSERT INTO platform_execution(id, owner_namespace, owner_kind, owner_id, attempt,
      previous_execution_id, runner_id, binding_id, approval_policy, state, created_at)
     SELECT ?, 'cooking', 'SESSION_SYNC', ?, 1, id, runner_id, binding_id, 'never', ?, created_at
     FROM platform_execution WHERE id = ?`,
    [id, randomUUID(), state, parent],
  );
  return id;
}
