import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { testDatabases } from '@/testing/database';
import { openDatabase } from '@/server/database/index';
import { RepairExecutionResultSchema } from '@/contracts/submissions/repair';
import { UpdateExecutionResultSchema } from '@/contracts/submissions/update';
import { completeSuccessfulExecution } from '@/testing/submissions/execution';
import {
  completedUpdate,
  startCandidateUpdate,
  updateFixture,
} from '@/server/submissions/update/updateFixture';
import { projectAttemptResult } from '@/server/submissions/repair/results';
import { projectUpdateAttemptResult } from '@/server/submissions/update/results';
import { migrateServerDatabase } from './migrateServer';

const setup = updateFixture(testDatabases());
const opened: Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

async function fixture() {
  const f = await setup();
  const { bug, started } = await startCandidateUpdate(
    f,
    '保留已有缺陷与历史交付',
    'repair-session',
    ['a'.repeat(40)],
    'update-session',
  );
  completeSuccessfulExecution(f, started, completedUpdate());
  f.database.run("UPDATE submission_bug SET stage='DONE' WHERE id=?", [bug.id]);
  for (const table of ['submission_repair_attempt', 'submission_update_attempt'])
    f.database.exec(
      `UPDATE ${table} SET outcome_json=json_remove(outcome_json, '$.testingScope', '$.testingScopes')`,
    );
  for (const column of ['outcome_json', 'reported_outcome_json'])
    f.database.exec(
      `UPDATE platform_execution SET ${column}=json_remove(${column}, '$.result.result.testingScope', '$.result.result.testingScopes')`,
    );
  f.database.exec(`UPDATE submission_update_batch_entry SET handoffs_json=(
    SELECT json_group_array(json_remove(value, '$.testingScope', '$.unchangedTestingScopes')) FROM json_each(handoffs_json)
  ); PRAGMA user_version=36`);
  return { ...f, path: join(f.directory, 'server.sqlite') };
}

function rows(db: Database) {
  return Object.fromEntries(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        db.query(`SELECT rowid, * FROM "${name}" ORDER BY rowid`).all(),
      ]),
  );
}

test('Schema 36 预检只读，备份后保留全部历史事实并恢复新版详情', async () => {
  const f = await fixture();
  const before = rows(f.database);
  expect(migrateServerDatabase(f.path)).toMatchObject({
    status: 'ready',
    from: 36,
    to: 37,
    backupPath: null,
  });
  expect(rows(f.database)).toEqual(before);
  expect(f.database.get('PRAGMA user_version')).toEqual({ user_version: 36 });
  const report = migrateServerDatabase(f.path, true);
  expect(report).toMatchObject({ status: 'migrated', from: 36, to: 37 });
  const backup = new Database(report.backupPath!, { readonly: true });
  opened.push(backup);
  expect(rows(backup)).toEqual(before);
  expect(backup.query('PRAGMA user_version').get()).toEqual({ user_version: 36 });
  expect(f.database.all('PRAGMA foreign_key_check')).toEqual([]);
  const reopened = openDatabase(f.path);
  opened.push(reopened);
  expect(reopened.get('PRAGMA user_version')).toEqual({ user_version: 37 });
  const repair = JSON.parse(
    f.database.get<{ outcome_json: string }>(
      'SELECT outcome_json FROM submission_repair_attempt',
    )!.outcome_json,
  );
  expect(repair.testingScope).toBeNull();
  expect(projectAttemptResult(JSON.stringify(repair), true)).toMatchObject({
    outcome: 'COMPLETED',
    testingScopes: [],
  });
  expect(RepairExecutionResultSchema.safeParse({ result: repair }).success).toBe(false);
  const update = JSON.parse(
    f.database.get<{ outcome_json: string }>(
      'SELECT outcome_json FROM submission_update_attempt',
    )!.outcome_json,
  );
  expect(projectUpdateAttemptResult(JSON.stringify(update), true)).toMatchObject({
    outcome: 'COMPLETED',
    testingScopes: [],
  });
  expect(UpdateExecutionResultSchema.safeParse({ result: update }).success).toBe(false);
  expect(() => f.repairs.workspace(f.users.tester.id, f.submission.id)).not.toThrow();
  expect(() => f.updates.workspace(f.users.developer.id, f.submission.id)).not.toThrow();
  const migrated = rows(f.database);
  for (const [table, original] of Object.entries(before)) {
    expect(migrated[table]).toHaveLength(original.length);
    original.forEach((row, index) => {
      for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
        const current = (migrated[table]![index] as Record<string, unknown>)[column];
        if (
          column.endsWith('_json') &&
          typeof value === 'string' &&
          typeof current === 'string'
        )
          expect(JSON.parse(current)).toMatchObject(JSON.parse(value));
        else expect(current).toEqual(value);
      }
    });
  }
  expect(migrateServerDatabase(f.path, true)).toMatchObject({
    status: 'current',
    from: 37,
    to: 37,
    backupPath: null,
  });
  expect(rows(f.database)).toEqual(migrated);
});

test('Schema 36 拒绝未完成流程和未知结构，原数据不变', async () => {
  const f = await fixture();
  f.database.exec("UPDATE submission_bug SET stage='WAITING_FOR_VERIFICATION'");
  const before = rows(f.database);
  expect(() => migrateServerDatabase(f.path, true)).toThrow('未完成');
  expect(rows(f.database)).toEqual(before);
  f.database.exec(
    "UPDATE submission_bug SET stage='DONE'; CREATE TABLE unexpected(id TEXT)",
  );
  expect(() => migrateServerDatabase(f.path, true)).toThrow('结构');
  expect(f.database.get('PRAGMA user_version')).toEqual({ user_version: 36 });
});

test('Schema 36 提交前失败回滚所有结果转换与版本号', async () => {
  const f = await fixture();
  const before = rows(f.database);
  const exec = Database.prototype.exec;
  const fault = spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database,
    sql: string,
  ) {
    if (sql === 'PRAGMA user_version=37') throw new Error('模拟提交前故障');
    return exec.call(this, sql);
  });
  try {
    expect(() => migrateServerDatabase(f.path, true)).toThrow('模拟提交前故障');
  } finally {
    fault.mockRestore();
  }
  expect(rows(f.database)).toEqual(before);
  expect(f.database.get('PRAGMA user_version')).toEqual({ user_version: 36 });
});
