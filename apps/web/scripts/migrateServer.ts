import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PLATFORM_SCHEMA } from '@/platform/database/platformSchema';
import { COOKING_SCHEMA } from '@/platform/database/cookingSchema';
import { BUG_DEPLOYMENT_SCHEMA } from '@/platform/database/bugDeploymentSchema';
import { OBSERVATION_SCHEMA } from '@/platform/database/observationSchema';
import { SERVER_SCHEMA_VERSION } from '@/platform/database/schema';
import { AppDatabase } from '@/platform/database';
import { rewriteHistoricalResults, type ResultRewrite } from './migrateServerResults';

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };
type TableSnapshot = { name: string; columns: string[]; rows: number; hash: string };
type MigrationReport = {
  status: 'ready' | 'migrated' | 'current';
  database: string;
  from: number;
  to: number;
  backupPath: string | null;
  rewrittenResults: number;
  tables: Array<{ name: string; rows: number }>;
};

const targetSchema =
  PLATFORM_SCHEMA + COOKING_SCHEMA + BUG_DEPLOYMENT_SCHEMA + OBSERVATION_SCHEMA;
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
    let sql = targetSchema;
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
    if (normalize(schemaObjects(db)) !== normalize(schemaObjects(reference)))
      throw new Error('数据库结构与对应版本不一致，原数据已保留，请核对结构差异。');
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
  rewrites: ResultRewrite[] = [],
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
  return tables.map(({ name, columns }) => {
    const hash = createHash('sha256');
    let rows = 0;
    for (const row of db
      .query<Record<string, unknown>, []>(
        `SELECT rowid AS __migration_rowid, ${columns.map(quote).join(',')} FROM ${quote(name)} ORDER BY rowid`,
      )
      .iterate()) {
      const { __migration_rowid: rowid, ...values } = row;
      for (const change of rewrites.filter(
        (change) => change.table === name && change.rowid === rowid,
      )) {
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
  rewrites: ResultRewrite[] = [],
): void {
  if (JSON.stringify(snapshot(db, before, rewrites)) !== JSON.stringify(before))
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

/** Explicit offline migration; application startup never invokes this entry point. */
export function migrateServerDatabase(
  databasePath: string,
  apply = false,
): MigrationReport {
  if (SERVER_SCHEMA_VERSION !== 30) throw new Error('此迁移只适用于 Server Schema 30。');
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
    if (![27, 28, 29, 30].includes(version))
      throw new Error(`不支持从版本 ${version} 迁移；原数据已保留。`);
    assertSchema(db, version);
    assertIntegrity(db);
    if (version < 29) assertSettled(db);
    const before = snapshot(db);
    const report: MigrationReport = {
      status: version === 30 ? 'current' : 'ready',
      database: path,
      from: version,
      to: 30,
      backupPath: null,
      rewrittenResults: 0,
      tables: before.map(({ name, rows }) => ({ name, rows })),
    };
    if (apply && version !== 30) {
      report.backupPath = backupDatabase(path, before);
      const reference = new Database(':memory:');
      try {
        reference.exec(targetSchema);
        if (version === 27) rebuildTable(db, reference, 'platform_execution');
        if (version < 29) rebuildTable(db, reference, 'cooking_update_batch_entry');
        const rewrites = version < 29 ? rewriteHistoricalResults(db) : [];
        db.exec(OBSERVATION_SCHEMA);
        assertSchema(db, 30);
        assertIntegrity(db);
        assertUnchanged(db, before, rewrites);
        report.rewrittenResults = rewrites.length;
        db.exec('PRAGMA user_version=30');
        report.status = 'migrated';
      } finally {
        reference.close();
      }
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
      options: { database: { type: 'string' }, apply: { type: 'boolean' } },
    });
    if (!values.database)
      throw new Error(
        '用法：bun run migrate:server -- --database /绝对路径/server.sqlite [--apply]；默认仅预检，应用前停止 Server。',
      );
    console.log(
      JSON.stringify(migrateServerDatabase(values.database, values.apply), null, 2),
    );
  } catch (error) {
    console.error(
      `迁移失败：${error instanceof Error ? error.message : '未知错误'}。下一步：检查数据库路径和未完成流程后重试；原库未被清空。`,
    );
    process.exitCode = 1;
  }
}
