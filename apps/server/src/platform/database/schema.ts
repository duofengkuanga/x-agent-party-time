import type { Database } from 'bun:sqlite';
import { PlatformError } from '@/platform/errors';

export const SERVER_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE platform_user (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE platform_session (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_session_user ON platform_session(user_id, expires_at);
CREATE INDEX platform_session_expiry ON platform_session(expires_at);

CREATE TABLE platform_file (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  uploaded_by_user_id TEXT NOT NULL REFERENCES platform_user(id),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_file_uploader ON platform_file(uploaded_by_user_id, created_at);
`;

export function initializeSchema(database: Database): void {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');

  const versionRow = database
    .query<{ user_version: number }, []>('PRAGMA user_version')
    .get();
  const currentVersion = Number(versionRow?.user_version ?? 0);
  if (currentVersion === SERVER_SCHEMA_VERSION) return;

  if (currentVersion !== 0)
    throw schemaMismatch(currentVersion, SERVER_SCHEMA_VERSION);

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
    `Server 数据库版本不匹配（当前 ${current}，需要 ${expected}）。当前处于开发阶段，请停止服务并清空 Server 数据目录后重试。`,
  );
}
