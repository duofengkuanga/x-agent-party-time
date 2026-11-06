import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LocalFileStore } from '@/server/platform/files/localFileStore';
import { randomUUID } from 'node:crypto';
import { AppDatabase, openDatabase } from '@/server/database/index';
import { testDatabases } from '@/testing/database';
import {
  completeSuccessfulExecution,
  testSkillBinding,
} from '@/testing/submissions/execution';
import {
  completedUpdate,
  latestBatch,
  startCandidateUpdate,
  updateFixture,
} from '@/server/submissions/update/updateFixture';
import { migrateServerDatabase, schema34 } from './migrateServer';
import { SCHEMA_31_TABLE_NAMES } from './schema31Migration';
import { ExecutionService } from '@/server/platform/execution/service';
import { projectAttemptResult } from '@/server/submissions/repair/results';
import { projectUpdateAttemptResult } from '@/server/submissions/update/results';
import { RepairExecutionResultSchema } from '@/contracts/submissions/repair';
import { UpdateExecutionResultSchema } from '@/contracts/submissions/update';

const setup = updateFixture(testDatabases());
const opened: Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
const legacySql = readFileSync(join(import.meta.dir, 'fixtures/serverV27.sql'), 'utf8');
const schema30 = readFileSync(join(import.meta.dir, 'fixtures/serverV30.sql'), 'utf8');
const schema31 = readFileSync(join(import.meta.dir, 'fixtures/serverV31.sql'), 'utf8');
const schema32 = schema31
  .replace(
    'ON platform_execution(binding_id)\n  WHERE state IN (',
    "ON platform_execution(binding_id, COALESCE(json_extract(workspace_json, '$.isolation'), 'EXCLUSIVE'))\n  WHERE state IN (",
  )
  .replace(
    'CREATE INDEX platform_execution_runner_claim',
    `CREATE UNIQUE INDEX platform_execution_workspace_reservation
  ON platform_execution(runner_id, json_extract(workspace_json, '$.key'))
  WHERE workspace_json IS NOT NULL AND state IN ('CLAIMED', 'RUNNING', 'CANCEL_REQUESTED');
CREATE INDEX platform_execution_runner_claim`,
  );

const schema33 = readFileSync(join(import.meta.dir, 'fixtures/serverV33.sql'), 'utf8');

function copyCurrentToLegacy(
  directory: string,
  version: 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34,
) {
  const path = join(directory, `legacy${version}.sqlite`);
  const db = new AppDatabase(path, { create: true });
  opened.push(db);
  let sql =
    version === 27
      ? legacySql
      : version === 31
        ? schema31
        : version === 32
          ? schema32
          : version === 33
            ? schema33
            : version === 34
              ? schema34
              : schema30;
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
    if (name.includes('external_deployment_report')) continue;
    if (name === 'submission_bug_deployment' || name === 'cooking_bug_deployment') {
      db.exec(`INSERT INTO ${name}(bug_id, deployment_json)
        SELECT bug_id, '${version < 33 ? '{"kind":"LOCAL_SCRIPT","command":"bun run deploy:test"}' : '{"command":"bun run deploy:test"}'}'
        FROM seed.submission_bug_repair_context`);
      continue;
    }
    const fields = db
      .all<{ name: string }>(`PRAGMA table_info(${name})`)
      .map(({ name }) => name);
    const columns = fields.map((name) => `"${name}"`).join(', ');
    const source = fields
      .map((name) =>
        name === 'person_agent_scope_json'
          ? 'NULL'
          : name === 'workspace_json' && version < 34
            ? "json_extract(workspace_json, '$[0].workspace')"
            : name === 'continuation_report_id'
              ? 'NULL'
              : name === 'deployment_json'
                ? version < 33
                  ? `'{"kind":"LOCAL_SCRIPT","command":"bun run deploy:test"}'`
                  : `'{"command":"bun run deploy:test"}'`
                : `"${name}"`,
      )
      .join(', ');
    db.exec(
      `INSERT INTO ${name} (rowid, ${columns}) SELECT rowid, ${source} FROM seed.${SCHEMA_31_TABLE_NAMES[name] ?? name}`,
    );
  }
  db.exec('DETACH DATABASE seed');
  db.exec(`UPDATE ${version >= 31 ? 'platform' : 'cooking'}_mutation
    SET result_json=json_set(json_remove(result_json, '$.key'), '$.deployment',
      json('${version < 33 ? '{"kind":"LOCAL_SCRIPT","command":"bun run deploy:test"}' : '{"command":"bun run deploy:test"}'}'))
    WHERE operation IN ('ENVIRONMENT_CREATE', 'ENVIRONMENT_UPDATE')`);

  if (version < 31)
    db.exec(
      "UPDATE platform_execution SET owner_namespace='cooking' WHERE owner_namespace='submissions'",
    );
  db.exec(`PRAGMA user_version=${version}`);
  return { db, path };
}

function fixtureEnvironmentKeys(db: AppDatabase) {
  return Object.fromEntries(
    db
      .all<{ id: string }>('SELECT id FROM platform_environment')
      .map(({ id }, index) => [id, `isolated-${index + 1}`]),
  );
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
    "UPDATE cooking_update_attempt SET outcome_json=json_remove(outcome_json, '$.handoffUse', '$.deliveries')",
  );
  for (const field of ['outcome_json', 'reported_outcome_json'])
    db.exec(`UPDATE platform_execution SET ${field}=json_remove(${field},
      '$.result.result.handoff', '$.result.result.handoffUse',
      '$.result.result.result.handoff', '$.result.result.result.handoffUse', '$.result.result.deliveries', '$.result.result.result.deliveries')`);
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
    if (table.name.includes('external_deployment_report')) {
      expect(table.rows).toEqual([]);
      continue;
    }
    const columns = table.columns.map((name) =>
      name === 'continuation_report_id' ? 'NULL AS continuation_report_id' : name,
    );
    const rows = db
      .query(
        `SELECT ${columns.join(',')} FROM ${SCHEMA_31_TABLE_NAMES[table.name] ?? table.name} ORDER BY rowid`,
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
        else if (field === 'workspace_json' && table.name === 'platform_execution') {
          const bindingId = row[table.columns.indexOf('binding_id')];
          expect(JSON.parse(rows[index]![column] as string)).toEqual([
            {
              bindingId,
              workspace: value ? JSON.parse(value as string) : null,
            },
          ]);
        } else if (field === 'deployment_json') {
          const { kind: _, ...script } = JSON.parse(value as string);
          expect(JSON.parse(rows[index]![column] as string)).toEqual(script);
        } else if (field === 'result_json' && table.name.endsWith('_mutation')) {
          const expected = JSON.parse(value as string);
          if (expected.deployment?.kind === 'LOCAL_SCRIPT')
            delete expected.deployment.kind;
          expect(JSON.parse(rows[index]![column] as string)).toEqual(expected);
        } else expect(rows[index]![column]).toEqual(value);
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
    user_version: 34,
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
  migrateServerDatabase(f.path, true, {}, fixtureEnvironmentKeys(f.db));
  expect(f.db.get('PRAGMA user_version')).toEqual({ user_version: 35 });
  expect(() => openDatabase(f.path)).toThrow('数据库版本不匹配');
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
    if (sql === 'PRAGMA user_version=34') throw new Error('模拟提交前故障');
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
  const start = schema30.indexOf('CREATE TABLE platform_execution (');
  const end = schema30.indexOf('CREATE TABLE platform_execution_attachment (');
  const ddl = schema30.slice(start, end);
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
  migrateServerDatabase(f.path, true, {}, fixtureEnvironmentKeys(f.db));
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
    testingScope: {
      review: {
        baseCommit: 'a'.repeat(40),
        headCommit: 'a'.repeat(40),
        verdict: 'READY',
      },
      points: [
        {
          kind: 'ORIGINAL',
          title: '复测',
          steps: '重现原操作',
          expectedResult: '问题不再出现',
        },
      ],
      limitations: [],
    },
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
  expect(UpdateExecutionResultSchema.safeParse({ result: update }).success).toBe(false);
  expect(() =>
    projectUpdateAttemptResult(JSON.stringify({ ...update, handoffUse: {} }), true),
  ).toThrow();
});

test('Schema31 离线升级并发索引，完整保留活动执行且可幂等重跑', async () => {
  const f = await setup();
  const bug = f.createBug('并发升级');
  const [claimed] = await f.executions.claim(f.runner.id, 1, 0);
  const started = { executionId: claimed!.id };
  f.executions.start(f.runner.id, claimed!.id, {
    kind: 'STARTED',
    leaseToken: claimed!.lease.token,
    sessionId: 'migration-repair',
    taskSkillBinding: testSkillBinding('XBugRepaire'),
  });
  const { db, path } = copyCurrentToLegacy(f.directory, 31);
  const before = originalRows(db);
  expect(migrateServerDatabase(path).status).toBe('ready');
  expect(originalRows(db)).toEqual(before);
  const report = migrateServerDatabase(path, true);
  expect(report).toMatchObject({
    from: 31,
    to: 34,
    rewrittenResults: 0,
    status: 'migrated',
  });
  expectOriginalFacts(db, before);
  expect(new ExecutionService(db).get(started.executionId).state).toBe('RUNNING');
  expect(
    db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE name = 'platform_execution_binding_reservation'",
    )!.sql,
  ).toContain('$[0].workspace.isolation');
  const backup = new Database(report.backupPath!, { readonly: true });
  opened.push(backup);
  expect(originalRows(backup)).toEqual(before);
  expect(backup.query('PRAGMA user_version').get()).toEqual({ user_version: 31 });
  expect(() => migrateServerDatabase(path, true, {}, fixtureEnvironmentKeys(db))).toThrow(
    '未完成',
  );
});

test('Schema29保留活动执行并升级归因存储与模块命名', async () => {
  const f = await setup();
  const bug = f.createBug('归因升级活动执行');
  const [claimed] = await f.executions.claim(f.runner.id, 1, 0);
  const started = { executionId: claimed!.id };
  f.executions.start(f.runner.id, claimed!.id, {
    kind: 'STARTED',
    leaseToken: claimed!.lease.token,
    sessionId: 'migration-repair',
    taskSkillBinding: testSkillBinding('XBugRepaire'),
  });
  const { db, path } = copyCurrentToLegacy(f.directory, 29);
  const before = originalRows(db);
  expect(migrateServerDatabase(path).status).toBe('ready');
  expect(migrateServerDatabase(path, true).from).toBe(29);
  expectOriginalFacts(db, before);
  expect(new ExecutionService(db).get(started.executionId).state).toBe('RUNNING');
  expect(
    db.get<{ count: number }>('SELECT COUNT(*) count FROM platform_observation_event'),
  ).toEqual({ count: 0 });
  expect(() => migrateServerDatabase(path, true, {}, fixtureEnvironmentKeys(db))).toThrow(
    '未完成',
  );
});

test('Schema30逐字段保留活动流程、幂等回执和归因记录，只更新明确的执行归属', async () => {
  const f = await setup();
  const bug = f.createBug('命名迁移保留活动流程');
  const [claimed] = await f.executions.claim(f.runner.id, 1, 0);
  const started = { executionId: claimed!.id };
  f.executions.start(f.runner.id, claimed!.id, {
    kind: 'STARTED',
    leaseToken: claimed!.lease.token,
    sessionId: 'migration-repair',
    taskSkillBinding: testSkillBinding('XBugRepaire'),
  });
  const { db, path } = copyCurrentToLegacy(f.directory, 30);
  const before = originalRows(db);
  expect(migrateServerDatabase(path).status).toBe('ready');
  expect(originalRows(db)).toEqual(before);
  const report = migrateServerDatabase(path, true);
  expect(report.from).toBe(30);
  expect(report.to).toBe(34);
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
  expect(db.get('SELECT id FROM submission_bug WHERE id = ?', bug.id)).toEqual({
    id: bug.id,
  });
  const backup = new Database(report.backupPath!, { readonly: true });
  opened.push(backup);
  expect(originalRows(backup)).toEqual(before);
  expect(backup.query('PRAGMA user_version').get()).toEqual({ user_version: 30 });
  expect(() => migrateServerDatabase(path, true, {}, fixtureEnvironmentKeys(db))).toThrow(
    '未完成',
  );
});

test('Schema 32 要求真实命令并保留历史 Push、人工确认和附件权限', async () => {
  const f = await setup();
  const { bug, started } = await startCandidateUpdate(
    f,
    '旧流水线交付',
    'legacy-repair',
    ['a'.repeat(40)],
    'legacy-update',
  );
  completeSuccessfulExecution(f, started, completedUpdate());
  const { db, path } = copyCurrentToLegacy(f.directory, 32);
  const batch = latestBatch(db, f.item.id);
  const oldConfiguration = JSON.stringify({ kind: 'CI_CD' });
  const receipt = db.get<{ id: string; result_json: string }>(
    "SELECT id, result_json FROM platform_mutation WHERE resource_id = ? AND operation = 'ENVIRONMENT_CREATE'",
    f.item.environment_id,
  )!;
  const originalReceipt = {
    ...JSON.parse(receipt.result_json),
    deployment: { kind: 'CI_CD' },
  };
  db.run('UPDATE platform_mutation SET result_json = ? WHERE id = ?', [
    JSON.stringify(originalReceipt),
    receipt.id,
  ]);

  const environmentId = f.item.environment_id;
  const reportId = randomUUID();
  const file = await new LocalFileStore(f.database, join(f.directory, 'files')).put({
    bytes: new TextEncoder().encode('历史验收依据'),
    originalName: 'legacy.txt',
    mediaType: 'text/plain',
    uploadedByUserId: f.users.developer.id,
  });
  db.query('ATTACH DATABASE ? AS seed').run(join(f.directory, 'server.sqlite'));
  db.run('INSERT INTO platform_file SELECT * FROM seed.platform_file WHERE id = ?', [
    file.id,
  ]);
  db.exec('DETACH DATABASE seed');
  db.run('UPDATE platform_environment SET deployment_json = ? WHERE id = ?', [
    JSON.stringify({ kind: 'CI_CD', scriptCommand: 'bun run obsolete-script' }),
    environmentId,
  ]);
  db.run('UPDATE submission_item SET deployment_json = ? WHERE id = ?', [
    oldConfiguration,
    f.item.id,
  ]);
  db.run('UPDATE submission_bug_deployment SET deployment_json = ? WHERE bug_id = ?', [
    oldConfiguration,
    bug.id,
  ]);
  db.run('UPDATE submission_update_batch SET deployment_json = ? WHERE id = ?', [
    oldConfiguration,
    batch.id,
  ]);
  db.run(
    `UPDATE submission_update_attempt SET outcome_json = json_set(outcome_json, '$.outcome', 'PUSHED')
          WHERE batch_id = ?`,
    [batch.id],
  );
  db.run(
    `INSERT INTO submission_external_deployment_report
    (id, batch_id, round, outcome, summary, reported_by_user_id, created_at)
    VALUES (?, ?, 1, 'SUCCEEDED', '人工核对了旧流水线', ?, ?)`,
    [reportId, batch.id, f.users.developer.id, f.clock.now().toISOString()],
  );
  db.run(
    'INSERT INTO submission_external_deployment_report_attachment VALUES (?, ?, 0)',
    [file.id, reportId],
  );

  const before = originalRows(db);
  expect(() => migrateServerDatabase(path, true)).toThrow('需要提供实际部署脚本');
  expect(originalRows(db)).toEqual(before);
  expect(readdirSync(f.directory).some((name) => name.includes('.backup-'))).toBe(false);

  const commands = { [environmentId]: 'bun run deploy:verified' };
  db.run("UPDATE submission_update_batch SET state = 'WAITING_EXTERNAL' WHERE id = ?", [
    batch.id,
  ]);
  expect(() => migrateServerDatabase(path, false, commands)).toThrow(
    '未完成的旧更新批次',
  );
  db.run("UPDATE submission_update_batch SET state = 'COMPLETED' WHERE id = ?", [
    batch.id,
  ]);
  db.run('UPDATE submission_item SET deployment_json = ? WHERE id = ?', [
    JSON.stringify({ kind: 'LOCAL_SCRIPT', command: ' ' }),
    f.item.id,
  ]);
  expect(() => migrateServerDatabase(path, true, commands)).toThrow('旧部署快照无效');
  db.run('UPDATE submission_item SET deployment_json = ? WHERE id = ?', [
    oldConfiguration,
    f.item.id,
  ]);

  const result = migrateServerDatabase(path, true, commands);
  expect(result).toMatchObject({ from: 32, to: 34, historicalConfirmations: 1 });
  expect(
    db.get(
      'SELECT deployment_json FROM platform_environment WHERE id = ?',
      environmentId,
    ),
  ).toEqual({
    deployment_json: JSON.stringify({ command: 'bun run deploy:verified' }),
  });
  expect(
    db.get(
      'SELECT operation, result_json FROM platform_mutation WHERE id = ?',
      receipt.id,
    ),
  ).toEqual({
    operation: 'HISTORICAL_ENVIRONMENT_CREATE',
    result_json: JSON.stringify(originalReceipt),
  });
  expect(
    db.get(
      'SELECT applied_at FROM platform_environment_deployment_cutover WHERE environment_id = ?',
      environmentId,
    ),
  ).not.toBeNull();
  migrateServerDatabase(path, true, {}, fixtureEnvironmentKeys(db));
  expect(() => openDatabase(path)).toThrow('数据库版本不匹配');
  const migrated = new AppDatabase(path);
  opened.push(migrated);
  migrated.exec('PRAGMA foreign_keys = ON');
  const historicalFiles = new LocalFileStore(migrated, join(f.directory, 'files'));
  await expect(
    historicalFiles.deleteUnbound(file.id, f.users.developer.id),
  ).rejects.toThrow();
  expect(historicalFiles.get(file.id)).not.toBeNull();
  expect(db.get('PRAGMA user_version')).toEqual({ user_version: 35 });
  expect(
    db.get(
      'SELECT file_id FROM submission_update_history_file WHERE batch_id = ?',
      batch.id,
    ),
  ).toEqual({ file_id: file.id });
  const backup = new Database(result.backupPath!, { readonly: true });
  opened.push(backup);
  expect(originalRows(backup)).toEqual(before);
});

test('Schema 33 保存原工作区、绑定和租约，升级后只使用成员集合', async () => {
  const f = await setup();
  f.createBug('工作区集合迁移');
  const [claimed] = await f.executions.claim(f.runner.id, 1, 0);
  const { db, path } = copyCurrentToLegacy(f.directory, 33);
  const before = originalRows(db);
  expect(migrateServerDatabase(path).status).toBe('ready');
  expect(originalRows(db)).toEqual(before);
  const result = migrateServerDatabase(path, true);
  expect(result).toMatchObject({ from: 33, to: 34 });
  expectOriginalFacts(db, before);
  const execution = new ExecutionService(db).get(claimed!.id);
  expect(execution.workspaces).toEqual(claimed!.workspaces);
  expect(execution.lease).toEqual({ expiresAt: claimed!.lease.expiresAt });
  expect(() => migrateServerDatabase(path, true, {}, fixtureEnvironmentKeys(db))).toThrow(
    '未完成',
  );
});

test('Schema 34 切换要求核实环境映射，保留历史回执，且不把旧命令写回活动配置', async () => {
  const f = await setup();
  const { bug, started } = await startCandidateUpdate(
    f,
    '历史候选',
    'repair',
    ['a'.repeat(40)],
    'update',
  );
  const { db, path } = copyCurrentToLegacy(f.directory, 34);
  const keys = fixtureEnvironmentKeys(db);
  expect(() => migrateServerDatabase(path, false, {}, keys)).toThrow('未完成');
  completeSuccessfulExecution(f, started, completedUpdate());
  f.database.run("UPDATE submission_bug SET stage='DONE' WHERE id=?", [bug.id]);
  const closed = copyCurrentToLegacy(f.directory, 33);
  migrateServerDatabase(closed.path, true);
  expect(() => migrateServerDatabase(closed.path)).toThrow('--environment-keys');
  const prior = closed.db.all('SELECT id, outcome_json FROM submission_update_attempt');
  const report = migrateServerDatabase(
    closed.path,
    true,
    {},
    fixtureEnvironmentKeys(closed.db),
  );
  expect(report).toMatchObject({ from: 34, to: 35, status: 'migrated' });
  expect(closed.db.all('SELECT id, outcome_json FROM submission_update_attempt')).toEqual(
    prior,
  );
  expect(
    closed.db
      .all('PRAGMA table_info(platform_environment)')
      .map((row) => (row as { name: string }).name),
  ).not.toContain('deployment_json');
  expect(closed.db.all('PRAGMA foreign_key_check')).toEqual([]);
});

test.each(['BUG_REPAIR', 'UPDATE_BATCH'] as const)(
  'Schema 34 保留已完成业务的 %s 历史交接，当前交接仍阻止切换',
  async (kind) => {
    const f = await setup();
    const { bug, started } = await startCandidateUpdate(
      f,
      '历史人工交接',
      'handoff-repair',
      ['a'.repeat(40)],
      'handoff-update',
    );
    completeSuccessfulExecution(f, started, completedUpdate());
    f.database.run("UPDATE submission_bug SET stage = 'DONE' WHERE id = ?", [bug.id]);
    const batch = latestBatch(f.database, f.item.id);
    const { db, path } = copyCurrentToLegacy(f.directory, 34);
    const execution = db.get<{ id: string }>(
      'SELECT id FROM platform_execution WHERE owner_kind = ? ORDER BY created_at DESC LIMIT 1',
      kind,
    )!;
    db.run("UPDATE platform_execution SET state = 'HANDED_OFF' WHERE id = ?", [
      execution.id,
    ]);
    if (kind === 'BUG_REPAIR')
      db.run("UPDATE submission_bug SET stage = 'REPAIRING' WHERE id = ?", [bug.id]);
    else
      db.run("UPDATE submission_update_batch SET state = 'RUNNING' WHERE id = ?", [
        batch.id,
      ]);
    const keys = fixtureEnvironmentKeys(db);
    expect(() => migrateServerDatabase(path, false, {}, keys)).toThrow('未完成');
    if (kind === 'BUG_REPAIR')
      db.run("UPDATE submission_bug SET stage = 'DONE' WHERE id = ?", [bug.id]);
    else
      db.run("UPDATE submission_update_batch SET state = 'COMPLETED' WHERE id = ?", [
        batch.id,
      ]);
    const before = db.get('SELECT * FROM platform_execution WHERE id = ?', execution.id);
    expect(migrateServerDatabase(path, false, {}, keys).status).toBe('ready');
    expect(migrateServerDatabase(path, true, {}, keys).status).toBe('migrated');
    expect(db.get('SELECT * FROM platform_execution WHERE id = ?', execution.id)).toEqual(
      before,
    );
  },
);
