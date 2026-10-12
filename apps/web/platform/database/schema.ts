import type { Database } from 'bun:sqlite';
import { PlatformError } from '@/platform/errors';
import { PLATFORM_SCHEMA } from './platform-schema';
import { COOKING_SCHEMA } from './cooking-schema';
import { BUG_DEPLOYMENT_SCHEMA } from './bug-deployment-schema';
import { migrateManualHandoff } from './manual-handoff-migration';

export const SERVER_SCHEMA_VERSION = 28;

const SCHEMA = PLATFORM_SCHEMA + COOKING_SCHEMA + BUG_DEPLOYMENT_SCHEMA;

export function initializeSchema(database: Database): void {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');

  const versionRow = database
    .query<{ user_version: number }, []>('PRAGMA user_version')
    .get();
  const currentVersion = Number(versionRow?.user_version ?? 0);
  if (currentVersion === SERVER_SCHEMA_VERSION) return;

  if (currentVersion === 26) {
    database.transaction(() => {
      database.exec(BUG_DEPLOYMENT_SCHEMA);
      database.exec(`INSERT INTO cooking_bug_deployment(bug_id, deployment_json)
        SELECT bug.id, item.deployment_json
        FROM cooking_bug bug
        JOIN cooking_submission_item item ON item.id = bug.submission_item_id
        WHERE bug.report_locked_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM cooking_bug_repair_context context WHERE context.bug_id = bug.id)`);
      database.exec('PRAGMA user_version = 27');
    })();
    migrateManualHandoff(database);
    return;
  }

  if (currentVersion === 27) {
    migrateManualHandoff(database);
    return;
  }

  if (currentVersion !== 0) throw schemaMismatch(currentVersion, SERVER_SCHEMA_VERSION);

  const existingTables = database
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all();
  if (existingTables.length > 0)
    throw schemaMismatch(currentVersion, SERVER_SCHEMA_VERSION);

  database.transaction(() => {
    database.exec(SCHEMA);
    database.exec(`PRAGMA user_version = ${SERVER_SCHEMA_VERSION}`);
  })();
}

function schemaMismatch(current: number, expected: number): PlatformError {
  return new PlatformError(
    'SCHEMA_VERSION_MISMATCH',
    `Server 数据库版本不匹配（当前 ${current}，需要 ${expected}）。数据已保留，请先备份并提供对应版本的迁移方案。`,
  );
}
