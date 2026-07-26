import type { Database } from 'bun:sqlite';
import { PlatformError } from '@/platform/errors';

export const SERVER_SCHEMA_VERSION = 2;

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

CREATE TABLE cooking_project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_by_user_id TEXT NOT NULL REFERENCES platform_user(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_project_creator ON cooking_project(created_by_user_id, created_at);

CREATE TABLE cooking_project_membership (
  project_id TEXT NOT NULL REFERENCES cooking_project(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, user_id)
) STRICT;
CREATE INDEX cooking_project_membership_user
  ON cooking_project_membership(user_id, created_at);

CREATE TABLE cooking_project_invitation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cooking_project(id) ON DELETE CASCADE,
  invited_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  invited_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  responded_at TEXT
) STRICT;
CREATE UNIQUE INDEX cooking_project_invitation_pending
  ON cooking_project_invitation(project_id, invited_user_id)
  WHERE status = 'PENDING';
CREATE INDEX cooking_project_invitation_recipient
  ON cooking_project_invitation(invited_user_id, status, created_at);

CREATE TABLE cooking_mutation (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_mutation_actor ON cooking_mutation(actor_user_id, created_at);

CREATE TABLE cooking_audit_event (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cooking_project(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_audit_project ON cooking_audit_event(project_id, created_at, id);
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
