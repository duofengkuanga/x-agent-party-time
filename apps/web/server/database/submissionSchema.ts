export const SUBMISSION_SCHEMA = `CREATE TABLE test_submission (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES platform_project(id) ON DELETE CASCADE,
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
CREATE INDEX test_submission_project
  ON test_submission(project_id, status, updated_at, id);
CREATE INDEX test_submission_participants
  ON test_submission(tester_user_id, status, updated_at);

CREATE TABLE submission_item (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES test_submission(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  engineering_id TEXT NOT NULL,
  engineering_name TEXT NOT NULL,
  engineering_type TEXT NOT NULL CHECK (engineering_type IN ('FRONTEND', 'BACKEND')),
  engineering_identifier TEXT NOT NULL,
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
CREATE INDEX submission_item_responsible
  ON submission_item(responsible_user_id, submission_id);
CREATE INDEX submission_item_binding
  ON submission_item(binding_id, submission_id);

CREATE TABLE submission_environment_lock (
  deployment_confirmed INTEGER NOT NULL DEFAULT 1 CHECK (deployment_confirmed IN (0, 1)),
  environment_id TEXT PRIMARY KEY REFERENCES platform_environment(id) ON DELETE RESTRICT,
  engineering_id TEXT NOT NULL REFERENCES platform_engineering(id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL REFERENCES test_submission(id) ON DELETE CASCADE,
  submission_item_id TEXT NOT NULL UNIQUE REFERENCES submission_item(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX submission_environment_lock_submission
  ON submission_environment_lock(submission_id, submission_item_id);

CREATE TABLE submission_bug (
  id TEXT PRIMARY KEY,
  short_id INTEGER NOT NULL CHECK (short_id > 0),
  submission_id TEXT NOT NULL REFERENCES test_submission(id) ON DELETE CASCADE,
  submission_item_id TEXT REFERENCES submission_item(id) ON DELETE RESTRICT,
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
  report_locked_at TEXT,
  collaboration_locked INTEGER NOT NULL DEFAULT 0 CHECK (collaboration_locked IN (0, 1)),
  transferred_at TEXT,
  archived_at TEXT,
  archived_by_user_id TEXT REFERENCES platform_user(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(submission_id, short_id),
  CHECK (
    (archived_at IS NULL AND archived_by_user_id IS NULL) OR
    (stage = 'DONE' AND archived_at IS NOT NULL AND archived_by_user_id IS NOT NULL)
  )
) STRICT;
CREATE INDEX submission_bug_submission_stage
  ON submission_bug(submission_id, stage, short_id);
CREATE INDEX submission_bug_item_stage
  ON submission_bug(submission_item_id, stage, short_id);

CREATE TABLE submission_bug_relation (
  id TEXT PRIMARY KEY,
  source_bug_id TEXT REFERENCES submission_bug(id) ON DELETE SET NULL,
  target_bug_id TEXT REFERENCES submission_bug(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('JOINT', 'TRANSFER', 'COLLABORATION')),
  source_short_id INTEGER NOT NULL,
  target_short_id INTEGER NOT NULL,
  source_title TEXT NOT NULL,
  target_title TEXT NOT NULL,
  handoff_text TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX submission_bug_relation_source ON submission_bug_relation(source_bug_id);
CREATE INDEX submission_bug_relation_target ON submission_bug_relation(target_bug_id);

CREATE TABLE submission_bug_lifecycle_event (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES submission_bug(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('CANCELLED', 'RESTORED')),
  actor_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX submission_bug_lifecycle_event_bug
  ON submission_bug_lifecycle_event(bug_id, created_at, id);

CREATE TABLE submission_bug_attachment (
  file_id TEXT NOT NULL REFERENCES platform_file(id) ON DELETE RESTRICT,
  bug_id TEXT NOT NULL REFERENCES submission_bug(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ACTUAL_RESULT', 'EXPECTED_RESULT')),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(bug_id, file_id),
  UNIQUE(bug_id, role, position)
) STRICT;
CREATE INDEX submission_bug_attachment_bug
  ON submission_bug_attachment(bug_id, role, position);

CREATE TABLE submission_bug_repair_context (
  bug_id TEXT PRIMARY KEY REFERENCES submission_bug(id) ON DELETE CASCADE,
  workspace_key TEXT NOT NULL UNIQUE,
  session_id TEXT,
  pending_commits_json TEXT NOT NULL,
  pending_manual_operations_json TEXT NOT NULL,
  last_candidate_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE submission_repair_attempt (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES submission_bug(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(bug_id, attempt)
) STRICT;
CREATE INDEX submission_repair_attempt_bug
  ON submission_repair_attempt(bug_id, attempt, created_at);

CREATE TABLE submission_repair_session_sync (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES submission_bug(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX submission_repair_session_sync_bug
  ON submission_repair_session_sync(bug_id, created_at);
CREATE UNIQUE INDEX submission_repair_session_sync_turn
  ON submission_repair_session_sync(session_id, turn_id)
  WHERE turn_id IS NOT NULL;

CREATE TABLE submission_pending_delivery (
  submission_item_id TEXT PRIMARY KEY REFERENCES submission_item(id) ON DELETE CASCADE,
  last_candidate_at TEXT NOT NULL,
  eligible_at TEXT NOT NULL
) STRICT;
CREATE INDEX submission_pending_delivery_due
  ON submission_pending_delivery(eligible_at, submission_item_id);

CREATE TABLE submission_update_batch (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES test_submission(id) ON DELETE CASCADE,
  submission_item_id TEXT NOT NULL REFERENCES submission_item(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'READY', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED', 'COMPLETED'
  )),
  version INTEGER NOT NULL CHECK (version > 0),
  active_execution_id TEXT REFERENCES platform_execution(id) ON DELETE RESTRICT,
  session_id TEXT,
  deployment_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX submission_update_batch_active_item
  ON submission_update_batch(submission_item_id)
  WHERE state IN ('READY', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED');
CREATE INDEX submission_update_batch_submission
  ON submission_update_batch(submission_id, created_at, id);

CREATE TABLE submission_update_batch_entry (
  batch_id TEXT NOT NULL REFERENCES submission_update_batch(id) ON DELETE CASCADE,
  bug_id TEXT NOT NULL REFERENCES submission_bug(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  commits_json TEXT NOT NULL,
  manual_operations_json TEXT NOT NULL,
  handoffs_json TEXT NOT NULL,
  PRIMARY KEY(batch_id, bug_id),
  UNIQUE(batch_id, position)
) STRICT;
CREATE INDEX submission_update_batch_entry_bug
  ON submission_update_batch_entry(bug_id, batch_id);

CREATE TABLE submission_external_deployment_report (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES submission_update_batch(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK (round > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
  summary TEXT,
  reported_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, round),
  CHECK (
    (outcome = 'SUCCEEDED') OR
    (outcome = 'FAILED' AND summary IS NOT NULL AND length(trim(summary)) > 0)
  )
) STRICT;
CREATE INDEX submission_external_deployment_report_batch
  ON submission_external_deployment_report(batch_id, round, created_at);

CREATE TABLE submission_external_deployment_report_attachment (
  file_id TEXT PRIMARY KEY REFERENCES platform_file(id) ON DELETE RESTRICT,
  report_id TEXT NOT NULL REFERENCES submission_external_deployment_report(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE(report_id, position)
) STRICT;
CREATE INDEX submission_external_deployment_report_attachment_report
  ON submission_external_deployment_report_attachment(report_id, position);

CREATE TABLE submission_update_attempt (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES submission_update_batch(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  continuation_report_id TEXT UNIQUE REFERENCES submission_external_deployment_report(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(batch_id, attempt)
) STRICT;
CREATE INDEX submission_update_attempt_batch
  ON submission_update_attempt(batch_id, attempt, created_at);

CREATE TABLE submission_update_session_sync (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES submission_update_batch(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX submission_update_session_sync_batch
  ON submission_update_session_sync(batch_id, created_at);
CREATE UNIQUE INDEX submission_update_session_sync_turn
  ON submission_update_session_sync(session_id, turn_id)
  WHERE turn_id IS NOT NULL;

CREATE TABLE submission_verification_record (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES submission_bug(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK (round > 0),
  result TEXT NOT NULL CHECK (result IN ('PASSED', 'FAILED')),
  comment TEXT,
  repair_attempt INTEGER CHECK (repair_attempt > 0),
  verified_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(bug_id, round),
  CHECK (
    (result = 'PASSED' AND repair_attempt IS NULL) OR
    (result = 'FAILED' AND comment IS NOT NULL AND repair_attempt IS NOT NULL)
  )
) STRICT;
CREATE INDEX submission_verification_record_bug
  ON submission_verification_record(bug_id, round, created_at);

CREATE TABLE submission_verification_attachment (
  verification_id TEXT NOT NULL REFERENCES submission_verification_record(id) ON DELETE CASCADE,
  file_id TEXT PRIMARY KEY REFERENCES platform_file(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(verification_id, position)
) STRICT;
CREATE INDEX submission_verification_attachment_record
  ON submission_verification_attachment(verification_id, position);

CREATE TABLE submission_reopen_record (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES submission_bug(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK (round > 0),
  feedback TEXT NOT NULL,
  repair_attempt INTEGER NOT NULL CHECK (repair_attempt > 0),
  reopened_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(bug_id, round)
) STRICT;
CREATE INDEX submission_reopen_record_bug
  ON submission_reopen_record(bug_id, round, created_at);

CREATE TABLE submission_reopen_attachment (
  reopen_id TEXT NOT NULL REFERENCES submission_reopen_record(id) ON DELETE CASCADE,
  file_id TEXT PRIMARY KEY REFERENCES platform_file(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(reopen_id, position)
) STRICT;
CREATE INDEX submission_reopen_attachment_record
  ON submission_reopen_attachment(reopen_id, position);

CREATE TABLE submission_cleanup (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES test_submission(id) ON DELETE CASCADE,
  submission_item_id TEXT NOT NULL REFERENCES submission_item(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason = 'SUBMISSION_CLOSED'),
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('READY', 'RUNNING', 'FAILED', 'COMPLETED')),
  version INTEGER NOT NULL CHECK (version > 0),
  active_execution_id TEXT REFERENCES platform_execution(id) ON DELETE RESTRICT,
  session_id TEXT,
  scope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(reason, subject_id, submission_item_id)
) STRICT;
CREATE INDEX submission_cleanup_submission
  ON submission_cleanup(submission_id, created_at, id);
CREATE INDEX submission_cleanup_item_state
  ON submission_cleanup(submission_item_id, state, created_at);

CREATE TABLE submission_cleanup_attempt (
  id TEXT PRIMARY KEY,
  cleanup_id TEXT NOT NULL REFERENCES submission_cleanup(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(cleanup_id, attempt)
) STRICT;
CREATE INDEX submission_cleanup_attempt_cleanup
  ON submission_cleanup_attempt(cleanup_id, attempt, created_at);
`;
