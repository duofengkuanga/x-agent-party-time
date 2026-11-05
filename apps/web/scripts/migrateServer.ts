import {
  EnvironmentKeySchema,
  ExecutionWorkspacesSchema,
} from '@agent-party-time/execution-contract';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  realpathSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PLATFORM_SCHEMA } from '@/server/database/platformSchema';
import { PROJECT_SCHEMA } from '@/server/database/projectSchema';
import { SUBMISSION_SCHEMA } from '@/server/database/submissionSchema';
import { BUG_DEPLOYMENT_SCHEMA } from '@/server/database/bugDeploymentSchema';
import { OBSERVATION_SCHEMA } from '@/server/database/observationSchema';
import { SERVER_SCHEMA_VERSION } from '@/server/database/schema';
import { AppDatabase } from '@/server/database/index';
import { rewriteHistoricalResults, type ResultRewrite } from './migrateServerResults';

import {
  DeploymentCommandsSchema,
  migrateSchema32Deployment,
  planScriptCutover,
} from './schema32Migration';
import { migrateSchema31Names, SCHEMA_31_TABLE_NAMES } from './schema31Migration';

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };
type TableSnapshot = { name: string; columns: string[]; rows: number; hash: string };
type MigrationReport = {
  status: 'ready' | 'migrated' | 'current';
  database: string;
  from: number;
  to: number;
  backupPath: string | null;
  rewrittenResults: number;
  historicalConfirmations: number;
  tables: Array<{ name: string; rows: number }>;
};

const targetSchema =
  PLATFORM_SCHEMA + PROJECT_SCHEMA + SUBMISSION_SCHEMA + OBSERVATION_SCHEMA;
export const schema34 =
  PLATFORM_SCHEMA +
  PROJECT_SCHEMA.replace(
    'environment_key TEXT NOT NULL',
    'deployment_json TEXT NOT NULL',
  ).replace(',\n  UNIQUE(engineering_id, environment_key)', '') +
  SUBMISSION_SCHEMA.replace('environment_key TEXT NOT NULL', 'deployment_json TEXT')
    .replace(
      '  historical_delivery_json TEXT',
      "  deployment_json TEXT CHECK (deployment_json IS NOT NULL OR state = 'COMPLETED'),\n  historical_delivery_json TEXT",
    )
    .replaceAll('delivery_scope_json', 'person_agent_scope_json') +
  BUG_DEPLOYMENT_SCHEMA +
  OBSERVATION_SCHEMA;
const schema30 = readFileSync(
  new URL('./fixtures/serverV30.sql', import.meta.url),
  'utf8',
);
const schema31 = readFileSync(
  new URL('./fixtures/serverV31.sql', import.meta.url),
  'utf8',
);
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
const schema33 = readFileSync(
  new URL('./fixtures/serverV33.sql', import.meta.url),
  'utf8',
);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function schemaObjects(db: Database): SchemaObject[] {
  return db
    .query<SchemaObject, []>(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`,
    )
    .all();
}

function assertSchema(db: Database, version: number): void {
  const reference = new Database(':memory:');
  try {
    let sql =
      version < 31
        ? schema30
        : version === 31
          ? schema31
          : version === 32
            ? schema32
            : version === 33
              ? schema33
              : version === 34
                ? schema34
                : targetSchema;
    if (version < 30) sql = sql.replace(OBSERVATION_SCHEMA, '');
    if (version < 29) sql = sql.replace('  handoffs_json TEXT NOT NULL,\n', '');
    if (version === 27) sql = sql.replace(",\n    'HANDED_OFF'", '');
    reference.exec(sql);
    const normalize = (objects: SchemaObject[]) =>
      JSON.stringify(
        objects.map((row) => ({
          ...row,
          sql: row.sql
            .replace(/"([a-z_]+)"/gu, '$1')
            .replace(/\s+/gu, ' ')
            .trim(),
        })),
      );
    const actual = schemaObjects(db);
    const expected = schemaObjects(reference);
    if (normalize(actual) !== normalize(expected)) {
      const names = new Set([...actual, ...expected].map(({ name }) => name));
      const differences = [...names].filter(
        (name) =>
          normalize(actual.filter((row) => row.name === name)) !==
          normalize(expected.filter((row) => row.name === name)),
      );
      throw new Error(
        `数据库结构与对应版本不一致，原数据已保留。差异：${differences.join('、')}`,
      );
    }
  } finally {
    reference.close();
  }
}

function assertIntegrity(db: Database): void {
  const checks = db
    .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
    .all();
  if (
    checks.length !== 1 ||
    checks[0]?.integrity_check !== 'ok' ||
    db.query('PRAGMA foreign_key_check').all().length
  )
    throw new Error('数据库完整性检查失败，迁移未提交，原数据已保留。');
}

function assertSettled(db: Database): void {
  const blockers = [
    [
      '执行',
      "SELECT count(*) n FROM platform_execution WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED')",
    ],
    [
      '交互',
      "SELECT count(*) n FROM platform_execution_interaction WHERE state='PENDING'",
    ],
    [
      '更新批次',
      "SELECT count(*) n FROM cooking_update_batch WHERE state <> 'COMPLETED'",
    ],
    ['待交付项', 'SELECT count(*) n FROM cooking_pending_delivery'],
    [
      '候选提交',
      `SELECT count(*) n FROM cooking_bug_repair_context
      WHERE json_array_length(pending_commits_json)>0
         OR json_array_length(pending_manual_operations_json)>0`,
    ],
    [
      '修复流程',
      `SELECT count(*) n FROM cooking_bug b WHERE b.stage <> 'DONE'
      AND EXISTS (SELECT 1 FROM cooking_repair_attempt a WHERE a.bug_id=b.id)`,
    ],
  ] as const;
  const active = blockers.flatMap(([label, sql]) => {
    const count = db.query<{ n: number }, []>(sql).get()!.n;
    return count ? [`${label} ${count}`] : [];
  });
  if (active.length)
    throw new Error(
      `存在未完成的旧流程（${active.join('、')}），请先在旧 Server 完成；迁移未执行，数据已保留。`,
    );
}

function snapshot(
  db: Database,
  original?: TableSnapshot[],
  rewrites: Array<Omit<ResultRewrite, 'before'> & { before: string | null }> = [],
  renamed = false,
): TableSnapshot[] {
  const tables =
    original ??
    schemaObjects(db)
      .filter((row) => row.type === 'table')
      .map((row) => ({
        name: row.name,
        columns: db
          .query<{ name: string }, []>(`PRAGMA table_info(${quote(row.name)})`)
          .all()
          .map((c) => c.name),
      }));
  const changes = new Map<string, typeof rewrites>();
  for (const change of rewrites) {
    const key = `${change.table}:${change.rowid}`;
    const current = changes.get(key);
    if (current) current.push(change);
    else changes.set(key, [change]);
  }
  return tables.map(({ name, columns }) => {
    const currentName = renamed ? (SCHEMA_31_TABLE_NAMES[name] ?? name) : name;
    const hash = createHash('sha256');
    let rows = 0;
    for (const row of db
      .query<Record<string, unknown>, []>(
        `SELECT rowid AS __migration_rowid, ${columns.map(quote).join(',')} FROM ${quote(currentName)} ORDER BY rowid`,
      )
      .iterate()) {
      const { __migration_rowid: rowid, ...values } = row;
      for (const change of changes.get(`${currentName}:${rowid}`) ?? []) {
        if (values[change.column] !== change.after)
          throw new Error('历史结果转换校验失败。');
        values[change.column] = change.before;
      }
      hash.update(JSON.stringify(values));
      hash.update('\n');
      rows++;
    }
    return { name, columns, rows, hash: hash.digest('hex') };
  });
}

function assertUnchanged(
  db: Database,
  before: TableSnapshot[],
  rewrites: Array<Omit<ResultRewrite, 'before'> & { before: string | null }> = [],
  renamed = false,
): void {
  if (JSON.stringify(snapshot(db, before, rewrites, renamed)) !== JSON.stringify(before))
    throw new Error('原有记录校验失败，迁移未提交。');
}

function backupDatabase(path: string, before: TableSnapshot[]): string {
  const directory = mkdtempSync(`${path}.backup-`);
  chmodSync(directory, 0o700);
  const backupPath = join(directory, 'server.sqlite');
  const reader = new Database(path, { readonly: true });
  try {
    // The caller holds BEGIN IMMEDIATE: no writer can change this snapshot.
    // VACUUM INTO includes committed WAL pages and produces a standalone backup.
    reader.query('VACUUM INTO ?').run(backupPath);
  } finally {
    reader.close();
  }
  chmodSync(backupPath, 0o600);
  const backup = new Database(backupPath, { readonly: true });
  try {
    assertIntegrity(backup);
    assertUnchanged(backup, before);
  } finally {
    backup.close();
  }
  for (const path of [backupPath, directory]) {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return backupPath;
}

function rebuildTable(db: Database, reference: Database, table: string): void {
  const objects = schemaObjects(reference).filter((row) => row.tbl_name === table);
  const ddl = objects.find((row) => row.type === 'table')!.sql;
  const next = `${table}_migrating`;
  const columns = db
    .query<{ name: string }, []>(`PRAGMA table_info(${quote(table)})`)
    .all()
    .map((c) => c.name);
  const existingColumns = columns.map(quote).join(', ');
  db.exec(ddl.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${next}`));
  const hasHandoffs = table === 'cooking_update_batch_entry';
  db.exec(`INSERT INTO ${quote(next)} (rowid, ${existingColumns}${hasHandoffs ? ', handoffs_json' : ''})
    SELECT rowid, ${existingColumns}${hasHandoffs ? ", '[]'" : ''} FROM ${quote(table)}`);
  db.exec(`DROP TABLE ${quote(table)}`);
  db.exec(`ALTER TABLE ${quote(next)} RENAME TO ${quote(table)}`);
  for (const object of objects.filter((row) => row.type === 'index')) db.exec(object.sql);
}

function migrateWorkspaceCollections(db: AppDatabase): void {
  const reference = new Database(':memory:');
  try {
    reference.exec(schema34);
    const table = 'platform_execution';
    const objects = schemaObjects(reference).filter((row) => row.tbl_name === table);
    const ddl = objects.find((row) => row.type === 'table')!.sql;
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map(({ name }) => name);
    const rows = db.all<{
      rowid: number;
      binding_id: string;
      workspace_json: string | null;
    }>(`SELECT rowid, binding_id, workspace_json FROM ${table}`);
    const workspaceRewrites = rows.map(({ rowid, binding_id, workspace_json }) => ({
      table,
      rowid,
      column: 'workspace_json',
      before: workspace_json,
      after: JSON.stringify([
        {
          bindingId: binding_id,
          workspace: workspace_json ? JSON.parse(workspace_json) : null,
        },
      ]),
    }));
    for (const change of workspaceRewrites)
      if (!ExecutionWorkspacesSchema.safeParse(JSON.parse(change.after)).success)
        throw new Error('旧工作区记录结构无效，原数据已保留。');
    const before = snapshot(db);
    db.exec(
      ddl.replace(
        'CREATE TABLE platform_execution',
        'CREATE TABLE platform_execution_migrating',
      ),
    );
    db.exec(`INSERT INTO platform_execution_migrating (rowid, ${columns.join(', ')})
      SELECT rowid, ${columns
        .map((column) =>
          column === 'workspace_json'
            ? "json_array(json_object('bindingId', binding_id, 'workspace', json(workspace_json)))"
            : quote(column),
        )
        .join(', ')}
      FROM platform_execution`);
    db.exec(
      'DROP TABLE platform_execution; ALTER TABLE platform_execution_migrating RENAME TO platform_execution',
    );
    for (const object of objects) if (object.type !== 'table') db.exec(object.sql);
    // Compare parsed contents rather than serialization differences in historical JSON.
    const stored = db.prepare<{ workspace_json: string }, [number]>(
      'SELECT workspace_json FROM platform_execution WHERE rowid = ?',
    );
    const verified = workspaceRewrites.map((change) => {
      const after = stored.get(change.rowid)?.workspace_json;
      if (!after || JSON.stringify(JSON.parse(after)) !== change.after)
        throw new Error('旧工作区转换校验失败。');
      return { ...change, after };
    });
    assertUnchanged(db, before, verified);
  } finally {
    reference.close();
  }
}

function migrateSubmissionModes(db: AppDatabase): void {
  const reference = new Database(':memory:');
  try {
    reference.exec(schema34);
    const additions = {
      test_submission: { mode: "'AGENT_PARTY'" },
      submission_item: { target_branch_locked_at: 'NULL' },
      submission_update_batch: { person_agent_scope_json: 'NULL' },
      submission_cleanup: { expected_heads_json: 'NULL' },
    };
    for (const [table, extra] of Object.entries(additions)) {
      const objects = schemaObjects(reference).filter((row) => row.tbl_name === table);
      const ddl = objects.find((row) => row.type === 'table')!.sql;
      const columns = db
        .all<{ name: string }>(`PRAGMA table_info(${quote(table)})`)
        .map(({ name }) => quote(name));
      const next = `${table}_migrating`;
      db.exec(ddl.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${next}`));
      db.exec(`INSERT INTO ${next} (rowid, ${[...columns, ...Object.keys(extra)].join(', ')})
        SELECT rowid, ${[...columns, ...Object.values(extra)].join(', ')} FROM ${table}`);
      db.exec(`DROP TABLE ${table}; ALTER TABLE ${next} RENAME TO ${table};`);
      for (const object of objects) if (object.type !== 'table') db.exec(object.sql);
    }
    db.exec(`UPDATE platform_mutation SET result_json = json_set(result_json, '$.mode', 'AGENT_PARTY')
      WHERE operation IN ('SUBMISSION_CREATE', 'SUBMISSION_ADD_ITEMS', 'SUBMISSION_ENVIRONMENT_CHANGE', 'SUBMISSION_UPDATE')`);
  } finally {
    reference.close();
  }
}

function planEngineeringCutover(db: AppDatabase, mapping: unknown) {
  const unfinished = db.get(`SELECT 1 FROM platform_execution execution
    WHERE execution.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
      AND NOT (
        execution.state = 'HANDED_OFF' AND execution.finished_at IS NOT NULL
        AND execution.owner_namespace = 'submissions' AND (
          (execution.owner_kind = 'UPDATE_BATCH' AND EXISTS (
            SELECT 1 FROM submission_update_attempt attempt
            JOIN submission_update_batch batch ON batch.id = attempt.batch_id
            WHERE attempt.execution_id = execution.id AND batch.state = 'COMPLETED'
          )) OR
          (execution.owner_kind = 'BUG_REPAIR' AND EXISTS (
            SELECT 1 FROM submission_repair_attempt attempt
            JOIN submission_bug bug ON bug.id = attempt.bug_id
            WHERE attempt.execution_id = execution.id AND bug.stage = 'DONE'
          ))
        )
      )
    UNION ALL SELECT 1 FROM submission_update_batch WHERE state <> 'COMPLETED'
    UNION ALL SELECT 1 FROM platform_execution_interaction WHERE state = 'PENDING'
    LIMIT 1`);
  if (unfinished)
    throw new Error(
      '存在未完成执行、交互或更新批次，请使用 Schema 34 对应版本完成后再切换',
    );
  const keys = z.record(z.uuid(), EnvironmentKeySchema).parse(mapping);
  const environments = db.all<{ id: string; engineering_id: string }>(
    'SELECT id, engineering_id FROM platform_environment ORDER BY id',
  );
  const missing = environments.filter(({ id }) => !keys[id]);
  if (missing.length)
    throw new Error(
      `请为以下环境提供已与工程约定核对的标识（--environment-keys）：${missing.map(({ id }) => id).join('、')}`,
    );
  if (Object.keys(keys).length !== environments.length)
    throw new Error('环境标识映射包含未知环境');
  const identities = new Set(
    environments.map(({ id, engineering_id }) => `${engineering_id}:${keys[id]}`),
  );
  if (identities.size !== environments.length) throw new Error('同工程环境标识不能重复');
  return keys;
}

function applyEngineeringCutover(db: AppDatabase, keys: Record<string, string>) {
  const reference = new Database(':memory:');
  try {
    reference.exec(targetSchema);
    db.exec(
      'CREATE TEMP TABLE cutover_environment (id TEXT PRIMARY KEY, key TEXT NOT NULL)',
    );
    const insert = db.prepare('INSERT INTO cutover_environment VALUES (?, ?)');
    for (const [id, key] of Object.entries(keys)) insert.run(id, key);
    const fields: Record<string, Record<string, string>> = {
      platform_environment: {
        environment_key:
          '(SELECT key FROM cutover_environment WHERE id = platform_environment.id)',
      },
      submission_item: {
        environment_key:
          'COALESCE((SELECT key FROM cutover_environment WHERE id = submission_item.environment_id), environment_id)',
      },
      submission_update_batch: { delivery_scope_json: 'person_agent_scope_json' },
    };
    const original = snapshot(db)
      .filter(
        ({ name }) => !['submission_bug_deployment', 'platform_mutation'].includes(name),
      )
      .map(({ name, columns, ...rest }) => ({
        name,
        columns: columns.filter(
          (column) => !['deployment_json', 'person_agent_scope_json'].includes(column),
        ),
        ...rest,
      }));
    const before = snapshot(db, original);
    for (const [table, expressions] of Object.entries(fields)) {
      const objects = schemaObjects(reference).filter((row) => row.tbl_name === table);
      const ddl = objects.find((row) => row.type === 'table')!.sql;
      const columns = reference
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map(({ name }) => name);
      const next = `${table}_migrating`;
      db.exec(ddl.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${next}`));
      db.exec(`INSERT INTO ${next} (rowid, ${columns.map(quote).join(', ')})
        SELECT rowid, ${columns.map((column) => expressions[column] ?? quote(column)).join(', ')} FROM ${table}`);
      db.exec(`DROP TABLE ${table}; ALTER TABLE ${next} RENAME TO ${table}`);
      for (const object of objects) if (object.type !== 'table') db.exec(object.sql);
    }
    db.exec(`DROP TABLE submission_bug_deployment;
      UPDATE platform_mutation SET operation = 'HISTORICAL_' || operation
        WHERE operation IN ('ENVIRONMENT_CREATE', 'ENVIRONMENT_UPDATE');
      DROP TABLE cutover_environment;`);
    assertUnchanged(db, before);
  } finally {
    reference.close();
  }
}

/** Explicit offline migration; application startup never invokes this entry point. */
export function migrateServerDatabase(
  databasePath: string,
  apply = false,
  deploymentCommands: unknown = {},
  environmentKeys: unknown = {},
): MigrationReport {
  const path = realpathSync(databasePath);
  if (!statSync(path).isFile()) throw new Error('请指定现有数据库文件。');
  const db = new AppDatabase(
    path,
    apply ? { readwrite: true, create: false } : { readonly: true },
  );
  let transaction = false;
  try {
    db.exec('PRAGMA busy_timeout=1000');
    if (apply) db.exec('PRAGMA foreign_keys=OFF');
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transaction = true;
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!
      .user_version;
    if (![27, 28, 29, 30, 31, 32, 33, 34, SERVER_SCHEMA_VERSION].includes(version))
      throw new Error(`不支持从版本 ${version} 迁移；原数据已保留。`);
    assertSchema(db, version);
    assertIntegrity(db);
    if (version < 29) assertSettled(db);
    const scripts =
      version >= 33
        ? new Map<string, string>()
        : planScriptCutover(
            db,
            version,
            DeploymentCommandsSchema.parse(deploymentCommands),
          );
    const keys = version === 34 ? planEngineeringCutover(db, environmentKeys) : null;
    const before = snapshot(db);
    const report: MigrationReport = {
      status: version === SERVER_SCHEMA_VERSION ? 'current' : 'ready',
      database: path,
      from: version,
      to: version < 34 ? 34 : SERVER_SCHEMA_VERSION,
      backupPath: null,
      rewrittenResults: 0,
      historicalConfirmations: 0,
      tables: before.map(({ name, rows }) => ({ name, rows })),
    };
    if (apply && version !== SERVER_SCHEMA_VERSION) {
      report.backupPath = backupDatabase(path, before);
      if (version < 33) {
        const reference = new Database(':memory:');
        try {
          reference.exec(schema30);
          if (version === 27) rebuildTable(db, reference, 'platform_execution');
          if (version < 29) rebuildTable(db, reference, 'cooking_update_batch_entry');
          if (version < 30) db.exec(OBSERVATION_SCHEMA);
          const current = new Database(':memory:');
          let renamed: ResultRewrite[];
          try {
            current.exec(schema32);
            const renamedTables = new Set(Object.values(SCHEMA_31_TABLE_NAMES));
            const indexes = schemaObjects(current)
              .filter((row) => row.type === 'index' && renamedTables.has(row.tbl_name))
              .map((row) => row.sql);
            renamed = version < 31 ? migrateSchema31Names(db, indexes) : [];
            if (version < 32) {
              db.exec('DROP INDEX platform_execution_binding_reservation');
              for (const index of schemaObjects(current).filter((row) =>
                [
                  'platform_execution_binding_reservation',
                  'platform_execution_workspace_reservation',
                ].includes(row.name),
              ))
                db.exec(index.sql);
            }
          } finally {
            current.close();
          }
          const rewrites = version < 29 ? rewriteHistoricalResults(db) : [];
          assertSchema(db, 32);
          assertIntegrity(db);
          assertUnchanged(db, before, [...renamed, ...rewrites], version < 31);
          report.rewrittenResults = rewrites.length;
          report.historicalConfirmations = migrateSchema32Deployment(
            db,
            schema33,
            scripts,
          );
          assertSchema(db, 33);
          assertIntegrity(db);
        } finally {
          reference.close();
        }
      }
      if (keys) applyEngineeringCutover(db, keys);
      else {
        migrateWorkspaceCollections(db);
        migrateSubmissionModes(db);
      }
      assertSchema(db, report.to);
      assertIntegrity(db);
      db.exec(`PRAGMA user_version=${report.to}`);
      report.status = 'migrated';
    }
    db.exec('COMMIT');
    transaction = false;
    return report;
  } finally {
    if (transaction) db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys=ON');
    db.close();
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2).filter((arg) => arg !== '--'),
      options: {
        database: { type: 'string' },
        apply: { type: 'boolean' },
        'deployment-commands': { type: 'string' },
        'environment-keys': { type: 'string' },
      },
    });
    if (!values.database)
      throw new Error(
        '用法：bun run migrate:server -- --database /绝对路径/server.sqlite [--deployment-commands 配置.json] [--environment-keys 标识.json] [--apply]；默认仅预检，应用前停止 Server。',
      );
    const commandPath = values['deployment-commands'];
    const commands: unknown = commandPath
      ? JSON.parse(readFileSync(commandPath, 'utf8'))
      : {};
    const keysPath = values['environment-keys'];
    const keys: unknown = keysPath ? JSON.parse(readFileSync(keysPath, 'utf8')) : {};
    console.log(
      JSON.stringify(
        migrateServerDatabase(values.database, values.apply, commands, keys),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      `迁移失败：${error instanceof Error ? error.message : '未知错误'}。下一步：检查数据库路径和未完成流程后重试；原库未被清空。`,
    );
    process.exitCode = 1;
  }
}
