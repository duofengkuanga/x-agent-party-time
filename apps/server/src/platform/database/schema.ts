import type { Database } from 'bun:sqlite';
import { PlatformError } from '@/platform/errors';

export const SERVER_SCHEMA_VERSION = 6;

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

CREATE TABLE platform_runner (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK (version > 0),
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_runner_owner
  ON platform_runner(owner_user_id, revoked_at, created_at);
CREATE INDEX platform_runner_last_seen
  ON platform_runner(last_seen_at);

CREATE TABLE platform_runner_pairing_code (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_runner_pairing_expiry
  ON platform_runner_pairing_code(expires_at, used_at);

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

CREATE TABLE cooking_engineering (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cooking_project(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  repository_url TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX cooking_engineering_active_name
  ON cooking_engineering(project_id, name)
  WHERE archived_at IS NULL;
CREATE INDEX cooking_engineering_project
  ON cooking_engineering(project_id, archived_at, created_at);

CREATE TABLE cooking_engineering_membership (
  engineering_id TEXT NOT NULL REFERENCES cooking_engineering(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(engineering_id, user_id)
) STRICT;
CREATE INDEX cooking_engineering_membership_user
  ON cooking_engineering_membership(user_id, created_at);

CREATE TABLE cooking_environment (
  id TEXT PRIMARY KEY,
  engineering_id TEXT NOT NULL REFERENCES cooking_engineering(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  deployment_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(engineering_id, name)
) STRICT;
CREATE INDEX cooking_environment_engineering
  ON cooking_environment(engineering_id, created_at);

CREATE TABLE cooking_engineering_binding (
  id TEXT PRIMARY KEY,
  engineering_id TEXT NOT NULL REFERENCES cooking_engineering(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  runner_id TEXT NOT NULL REFERENCES platform_runner(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(engineering_id, user_id, runner_id)
) STRICT;
CREATE INDEX cooking_engineering_binding_runner
  ON cooking_engineering_binding(runner_id, created_at);
CREATE INDEX cooking_engineering_binding_engineering
  ON cooking_engineering_binding(engineering_id, created_at);

CREATE TABLE cooking_test_submission (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cooking_project(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  requirement_description TEXT NOT NULL,
  tester_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CLOSED')),
  version INTEGER NOT NULL CHECK (version > 0),
  workspace_revision INTEGER NOT NULL CHECK (workspace_revision > 0),
  created_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;
CREATE INDEX cooking_test_submission_project
  ON cooking_test_submission(project_id, status, updated_at, id);
CREATE INDEX cooking_test_submission_participants
  ON cooking_test_submission(tester_user_id, status, updated_at);

CREATE TABLE cooking_submission_item (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES cooking_test_submission(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  engineering_id TEXT NOT NULL,
  engineering_name TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  responsible_user_id TEXT NOT NULL,
  responsible_username TEXT NOT NULL,
  responsible_display_name TEXT NOT NULL,
  responsible_user_created_at TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  environment_name TEXT NOT NULL,
  deployment_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(submission_id, engineering_id)
) STRICT;
CREATE INDEX cooking_submission_item_responsible
  ON cooking_submission_item(responsible_user_id, submission_id);
CREATE INDEX cooking_submission_item_binding
  ON cooking_submission_item(binding_id, submission_id);

CREATE TABLE cooking_submission_environment_lock (
  environment_id TEXT PRIMARY KEY REFERENCES cooking_environment(id) ON DELETE RESTRICT,
  engineering_id TEXT NOT NULL REFERENCES cooking_engineering(id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL REFERENCES cooking_test_submission(id) ON DELETE CASCADE,
  submission_item_id TEXT NOT NULL UNIQUE REFERENCES cooking_submission_item(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_submission_environment_lock_submission
  ON cooking_submission_environment_lock(submission_id, submission_item_id);

CREATE TABLE cooking_bug (
  id TEXT PRIMARY KEY,
  short_id INTEGER NOT NULL CHECK (short_id > 0),
  submission_id TEXT NOT NULL REFERENCES cooking_test_submission(id) ON DELETE CASCADE,
  submission_item_id TEXT REFERENCES cooking_submission_item(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN (
    'WAITING_FOR_REPAIR',
    'REPAIRING',
    'WAITING_FOR_UPDATE',
    'UPDATING',
    'WAITING_FOR_VERIFICATION',
    'DONE',
    'CANCELLED'
  )),
  title TEXT NOT NULL,
  operation_path TEXT,
  actual_result TEXT,
  expected_result TEXT,
  notes TEXT,
  report_locked_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(submission_id, short_id)
) STRICT;
CREATE INDEX cooking_bug_submission_stage
  ON cooking_bug(submission_id, stage, short_id);
CREATE INDEX cooking_bug_item_stage
  ON cooking_bug(submission_item_id, stage, short_id);

CREATE TABLE cooking_bug_feedback (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'TESTER_FEEDBACK',
    'DEVELOPER_NOTE',
    'EXECUTION_FAILURE'
  )),
  author_user_id TEXT REFERENCES platform_user(id) ON DELETE RESTRICT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_bug_feedback_bug
  ON cooking_bug_feedback(bug_id, created_at, id);

CREATE TABLE cooking_bug_attachment (
  file_id TEXT PRIMARY KEY REFERENCES platform_file(id) ON DELETE RESTRICT,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE CASCADE,
  feedback_id TEXT REFERENCES cooking_bug_feedback(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_bug_attachment_bug
  ON cooking_bug_attachment(bug_id, feedback_id, position);

CREATE TABLE cooking_repair_queue (
  submission_id TEXT PRIMARY KEY REFERENCES cooking_test_submission(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE cooking_repair_queue_entry (
  bug_id TEXT PRIMARY KEY REFERENCES cooking_bug(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES cooking_repair_queue(submission_id) ON DELETE CASCADE,
  submission_item_id TEXT NOT NULL REFERENCES cooking_submission_item(id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  queued_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_repair_queue_entry_order
  ON cooking_repair_queue_entry(submission_id, position, queued_at, bug_id);
CREATE INDEX cooking_repair_queue_entry_binding
  ON cooking_repair_queue_entry(binding_id, position, queued_at, bug_id);
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
