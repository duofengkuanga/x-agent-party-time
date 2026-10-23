import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase, openDatabase } from '@/server/database/index';
import { createSubmissionWorkflow } from '@/server/runtime/createSubmissionWorkflow';
import { testDatabases } from '@/testing/database';
import { completeSuccessfulExecution } from '@/testing/submissions/execution';
import {
  completedUpdate,
  latestBatch,
  startCandidateUpdate,
  updateFixture,
} from '@/server/submissions/update/updateFixture';
import { migrateServerDatabase } from './migrateServer';
import { SCHEMA_31_TABLE_NAMES } from './schema31Migration';
import { ExecutionService } from '@/server/platform/execution/service';
import { PLATFORM_SCHEMA } from '@/server/database/platformSchema';
import { projectAttemptResult } from '@/server/submissions/repair/results';
import { projectUpdateAttemptResult } from '@/server/submissions/update/results';
import { RepairExecutionResultSchema } from '@/contracts/submissions/repair';
import { LocalScriptUpdateExecutionResultSchema } from '@/contracts/submissions/update';

const setup = updateFixture(testDatabases());
const opened: Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
const legacySql = readFileSync(join(import.meta.dir, 'fixtures/serverV27.sql'), 'utf8');
const schema30 = readFileSync(join(import.meta.dir, 'fixtures/serverV30.sql'), 'utf8');

function copyCurrentToLegacy(directory: string, version: 27 | 28 | 29 | 30) {
  const path = join(directory, `legacy${version}.sqlite`);
  const db = new AppDatabase(path, { create: true });
  opened.push(db);
  let sql = version === 27 ? legacySql : schema30;
  if (version === 28 || version === 29) {
    const observationStart = sql.indexOf('CREATE TABLE platform_observation_');
    if (observationStart < 0) throw new Error('旧 Schema 缺少归因表边界');
    sql = sql.slice(0, observationStart);
  }
  if (version === 28) sql = sql.replace('  handoffs_json TEXT NOT NULL,\n', '');
  db.exec(sql);
  db.query('ATTACH DATABASE ? AS seed').run(join(directory, 'server.sqlite'));
  for (const { name } of db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )) {
    const columns = db
      .all<{ name: string }>(`PRAGMA table_info(${name})`)
      .map(({ name }) => `"${name}"`)
      .join(', ');
    db.exec(
      `INSERT INTO ${name} (rowid, ${columns}) SELECT rowid, ${columns} FROM seed.${SCHEMA_31_TABLE_NAMES[name] ?? name}`,
    );
  }
  db.exec('DETACH DATABASE seed');
  db.exec(
    "UPDATE platform_execution SET owner_namespace='cooking' WHERE owner_namespace='submissions'",
  );
  db.exec(`PRAGMA user_version=${version}`);
  return { db, path };
}

async function legacyFixture() {
  const f = await setup();
  const { bug, started } = await startCandidateUpdate(
    f,
    '保留历史记录',
    'old-repair-session',
    ['a'.repeat(40)],
    'old-update-session',
  );
  completeSuccessfulExecution(f, started, completedUpdate());
  f.database.run("UPDATE submission_bug SET stage='DONE' WHERE id=?", [bug.id]);
  const batch = latestBatch(f.database, f.item.id);
  const { db, path } = copyCurrentToLegacy(f.directory, 27);
  db.exec(
    "UPDATE cooking_repair_attempt SET outcome_json=json_remove(outcome_json, '$.handoff')",
  );
  db.exec(
    "UPDATE cooking_update_attempt SET outcome_json=json_remove(outcome_json, '$.handoffUse')",
  );
  for (const field of ['outcome_json', 'reported_outcome_json'])
    db.exec(`UPDATE platform_execution SET ${field}=json_remove(${field},
      '$.result.result.handoff', '$.result.result.handoffUse',
      '$.result.result.result.handoff', '$.result.result.result.handoffUse')`);
  db.exec('PRAGMA journal_mode=WAL');
  return { ...f, db, path, bug, batch };
}

function originalRows(db: Database) {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => ({
      name,
      columns: db
        .query<{ name: string }, []>(`PRAGMA table_info(${name})`)
        .all()
        .map((c) => c.name),
      rows: db.query(`SELECT * FROM ${name} ORDER BY rowid`).values(),
    }));
}

function expectOriginalFacts(db: Database, before: ReturnType<typeof originalRows>) {
  for (const table of before) {
    const rows = db
      .query(
        `SELECT ${table.columns.join(',')} FROM ${SCHEMA_31_TABLE_NAMES[table.name] ?? table.name} ORDER BY rowid`,
      )
      .values();
    expect(rows).toHaveLength(table.rows.length);
    table.rows.forEach((row, index) =>
      row.forEach((value, column) => {
        const field = table.columns[column];
        if (value && (field === 'outcome_json' || field === 'reported_outcome_json'))
          expect(JSON.parse(rows[index]![column] as string)).toMatchObject(
            JSON.parse(value as string),
          );
        else if (
          table.name === 'platform_execution' &&
          field === 'owner_namespace' &&
          value === 'cooking'
        )
          expect(rows[index]![column]).toEqual('submissions');
        else expect(rows[index]![column]).toEqual(value);
      }),
    );
  }
}

test('预检只读；迁移备份并逐字段保留全部旧数据、关联和历史详情', async () => {
  const f = await legacyFixture();
  const before = originalRows(f.db);
  expect(migrateServerDatabase(f.path).status).toBe('ready');
  expect(f.db.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
    user_version: 27,
  });
  expect(readdirSync(f.directory).some((name) => name.includes('.backup-'))).toBe(false);
  const result = migrateServerDatabase(f.path, true);
  expect(result.status).toBe('migrated');
  const backup = new Database(result.backupPath!, { readonly: true });
  opened.push(backup);
  expect(backup.query('PRAGMA user_version').get()).toEqual({ user_version: 27 });
  expect(originalRows(backup)).toEqual(before);
  expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
  expectOriginalFacts(f.db, before);
  expect(result.rewrittenResults).toBeGreaterThan(0);
  expect(f.db.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
    user_version: 31,
  });
  expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
  const handoffs = JSON.parse(
    f.db.get<{ handoffs_json: string }>(
      'SELECT handoffs_json FROM submission_update_batch_entry',
    )!.handoffs_json,
  );
  expect(handoffs).toHaveLength(1);
  expect(handoffs[0].commits).toEqual(['a'.repeat(40)]);
  expect(handoffs[0].handoff.validationCommands).toEqual([]);
  expect(handoffs[0].handoff.limitations[0]).toContain('旧版本未记录');
  const migrated = openDatabase(f.path);
  opened.push(migrated);
  const submissionWorkflow = createSubmissionWorkflow(migrated);
  for (const user of [f.users.developer, f.users.tester]) {
    const repair = submissionWorkflow.repairs.repairView(user.id, f.bug.id);
    expect(
      repair?.timeline.some(
        (node) => node.kind === 'REPAIR_ATTEMPT' && node.result?.outcome === 'COMPLETED',
      ),
    ).toBe(true);
    const update = submissionWorkflow.updates.batchView(user.id, f.batch.id);
    expect(update.state).toBe('COMPLETED');
    if (user.id === f.users.tester.id)
      expect(JSON.stringify(update)).not.toContain('validationCommands');
  }
  expect(migrateServerDatabase(f.path, true).status).toBe('current');
});

test.each(['execution', 'batch', 'candidate', 'interaction'])(
  '未完成的旧 %s 阻止迁移，保留原库且不创建备份',
  async (kind) => {
    const f = await legacyFixture();
    if (kind === 'execution')
      f.db.exec("UPDATE platform_execution SET state='WAITING_TO_RESUME'");
    if (kind === 'batch') f.db.exec("UPDATE cooking_update_batch SET state='FAILED'");
    if (kind === 'candidate')
      f.db.exec(
        `UPDATE cooking_bug_repair_context SET pending_commits_json='["${'b'.repeat(40)}"]'`,
      );
    if (kind === 'interaction')
      f.db.exec(`INSERT INTO platform_execution_interaction
      SELECT 'pending', id, 'USER_INPUT', 'question', '{}', 'PENDING', NULL, created_at, NULL FROM platform_execution LIMIT 1`);
    const before = originalRows(f.db);
    expect(() => migrateServerDatabase(f.path, true)).toThrow('未完成');
    expect(originalRows(f.db)).toEqual(before);
    expect(f.db.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
      user_version: 27,
    });
    expect(readdirSync(f.directory).some((name) => name.includes('.backup-'))).toBe(
      false,
    );
  },
);

test('不认可未知结构或损坏的外键；不能只修改版本号绕过检查', async () => {
  const f = await legacyFixture();
  f.db.exec('CREATE TABLE unexpected(value TEXT)');
  expect(() => migrateServerDatabase(f.path, true)).toThrow('结构');
  f.db.exec('DROP TABLE unexpected');
  f.db.exec("UPDATE cooking_repair_attempt SET bug_id='missing'");
  expect(() => migrateServerDatabase(f.path, true)).toThrow('完整性');
  expect(f.db.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
    user_version: 27,
  });
});

test('竞争写锁阻止迁移；原数据、Schema 和版本均不变', async () => {
  const f = await legacyFixture();
  const before = originalRows(f.db);
  // A competing write transaction must prevent migration before any DDL is run.
  f.db.exec('BEGIN IMMEDIATE');
  try {
    expect(() => migrateServerDatabase(f.path, true)).toThrow();
  } finally {
    f.db.exec('ROLLBACK');
  }
  expect(originalRows(f.db)).toEqual(before);
  expect(f.db.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
    user_version: 27,
  });
});

test('提交前故障回滚全部 DDL；备份和旧数据均可重新打开', async () => {
  const f = await legacyFixture();
  const before = originalRows(f.db);
  const originalExec = Database.prototype.exec;
  const fault = spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database,
    sql: string,
  ) {
    if (sql === 'PRAGMA user_version=31') throw new Error('模拟提交前故障');
    return originalExec.call(this, sql);
  });
  try {
    expect(() => migrateServerDatabase(f.path, true)).toThrow('模拟提交前故障');
  } finally {
    fault.mockRestore();
  }
  expect(f.db.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
    user_version: 27,
  });
  expect(originalRows(f.db)).toEqual(before);
  expect(migrateServerDatabase(f.path).status).toBe('ready');
  expect(readdirSync(f.directory).some((name) => name.includes('.backup-'))).toBe(true);
});

test('Schema 28 同样支持保留数据升级，最新版本重复执行无副作用', async () => {
  const f = await legacyFixture();
  const start = PLATFORM_SCHEMA.indexOf('CREATE TABLE platform_execution (');
  const end = PLATFORM_SCHEMA.indexOf('CREATE TABLE platform_execution_attachment (');
  const ddl = PLATFORM_SCHEMA.slice(start, end);
  const split = ddl.indexOf('CREATE UNIQUE INDEX');
  f.db.exec(
    ddl
      .slice(0, split)
      .replace('CREATE TABLE platform_execution (', 'CREATE TABLE execution_v28 ('),
  );
  f.db.exec(
    'INSERT INTO execution_v28 SELECT * FROM platform_execution; DROP TABLE platform_execution; ALTER TABLE execution_v28 RENAME TO platform_execution;',
  );
  f.db.exec(ddl.slice(split));
  f.db.exec('PRAGMA user_version=28');
  const before = originalRows(f.db);
  expect(migrateServerDatabase(f.path, true).from).toBe(28);
  expectOriginalFacts(f.db, before);
  expect(migrateServerDatabase(f.path, true).status).toBe('current');
});

test('运行时只接受最新结果契约，无修改结果仍正常显示', () => {
  const result = {
    outcome: 'COMPLETED',
    completionKind: 'CHANGES_COMMITTED',
    changes: ['已修复'],
    validations: [],
    warnings: [],
    commits: ['a'.repeat(40)],
    manualOperations: [],
  };
  expect(() => projectAttemptResult(JSON.stringify(result), false)).toThrow();
  expect(RepairExecutionResultSchema.safeParse({ result }).success).toBe(false);
  const noChange = {
    ...result,
    completionKind: 'TARGET_ALREADY_FIXED',
    changes: [],
    commits: [],
    validations: [{ name: '检查', status: 'PASSED', detail: '' }],
  };
  expect(projectAttemptResult(JSON.stringify(noChange), true).commitCount).toBe(0);
  const update = {
    outcome: 'COMPLETED',
    completedActions: ['已部署'],
    validations: [],
    warnings: [],
  };
  expect(() => projectUpdateAttemptResult(JSON.stringify(update), true)).toThrow();
  expect(
    LocalScriptUpdateExecutionResultSchema.safeParse({ result: update }).success,
  ).toBe(false);
  expect(() =>
    projectUpdateAttemptResult(JSON.stringify({ ...update, handoffUse: {} }), true),
  ).toThrow();
});

test('Schema29保留活动执行并升级归因存储与模块命名', async () => {
  const f = await setup();
  const { started } = await startCandidateUpdate(
    f,
    '归因升级活动执行',
    'repair-active',
    ['a'.repeat(40)],
    'update-active',
  );
  const { db, path } = copyCurrentToLegacy(f.directory, 29);
  const before = originalRows(db);
  expect(migrateServerDatabase(path).status).toBe('ready');
  expect(migrateServerDatabase(path, true).from).toBe(29);
  expectOriginalFacts(db, before);
  expect(new ExecutionService(db).get(started.executionId).state).toBe('RUNNING');
  expect(
    db.get<{ count: number }>('SELECT COUNT(*) count FROM platform_observation_event'),
  ).toEqual({ count: 0 });
  expect(migrateServerDatabase(path, true).status).toBe('current');
});

test('Schema30逐字段保留活动流程、幂等回执和归因记录，只更新明确的执行归属', async () => {
  const f = await setup();
  const { bug, started } = await startCandidateUpdate(
    f,
    '命名迁移保留活动流程',
    'repair-live',
    ['a'.repeat(40)],
    'update-live',
  );
  const { db, path } = copyCurrentToLegacy(f.directory, 30);
  const before = originalRows(db);
  expect(migrateServerDatabase(path).status).toBe('ready');
  expect(originalRows(db)).toEqual(before);
  const report = migrateServerDatabase(path, true);
  expect(report.from).toBe(30);
  expect(report.to).toBe(31);
  expect(report.rewrittenResults).toBe(0);
  expectOriginalFacts(db, before);
  expect(db.all("SELECT name FROM sqlite_master WHERE name GLOB 'cooking_*'")).toEqual(
    [],
  );
  expect(
    db.all("SELECT id FROM platform_execution WHERE owner_namespace='cooking'"),
  ).toEqual([]);
  const execution = new ExecutionService(db).get(started.executionId);
  expect(execution.owner.namespace).toBe('submissions');
  expect(execution.state).toBe('RUNNING');
  const workflow = createSubmissionWorkflow(db);
  const workspace = workflow.workspace.getWorkspace(
    f.users.developer.id,
    f.submission.id,
  );
  expect(workspace.bugs.some((item) => item.id === bug.id)).toBe(true);
  const backup = new Database(report.backupPath!, { readonly: true });
  opened.push(backup);
  expect(originalRows(backup)).toEqual(before);
  expect(backup.query('PRAGMA user_version').get()).toEqual({ user_version: 30 });
  expect(migrateServerDatabase(path, true).status).toBe('current');
});
