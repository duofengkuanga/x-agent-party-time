export const COOKING_SCHEMA = `CREATE TABLE cooking_project (
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
  type TEXT NOT NULL CHECK (type IN ('FRONTEND', 'BACKEND')),
  identifier TEXT NOT NULL COLLATE NOCASE,
  repository_state TEXT NOT NULL CHECK (repository_state IN ('PENDING', 'CONFIRMED')),
  repository_url TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (repository_state = 'PENDING' AND repository_url IS NULL) OR
    (repository_state = 'CONFIRMED' AND repository_url IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX cooking_engineering_active_name
  ON cooking_engineering(project_id, name)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX cooking_engineering_project_identifier
  ON cooking_engineering(project_id, identifier);
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
  UNIQUE(engineering_id, user_id)
) STRICT;
CREATE INDEX cooking_engineering_binding_runner
  ON cooking_engineering_binding(runner_id, created_at);
CREATE INDEX cooking_engineering_binding_engineering
  ON cooking_engineering_binding(engineering_id, created_at);

CREATE TABLE cooking_binding_request (
  id TEXT PRIMARY KEY,
  engineering_id TEXT NOT NULL REFERENCES cooking_engineering(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  runner_id TEXT NOT NULL REFERENCES platform_runner(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED'
  )),
  error_message TEXT,
  repository_url TEXT,
  binding_id TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (state = 'SUCCEEDED' AND repository_url IS NOT NULL) OR
    (state <> 'SUCCEEDED' AND repository_url IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX cooking_binding_request_active
  ON cooking_binding_request(engineering_id, user_id)
  WHERE state IN ('PENDING', 'PROCESSING');
CREATE INDEX cooking_binding_request_runner
  ON cooking_binding_request(runner_id, state, expires_at, created_at);

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
CREATE INDEX cooking_submission_item_responsible
  ON cooking_submission_item(responsible_user_id, submission_id);
CREATE INDEX cooking_submission_item_binding
  ON cooking_submission_item(binding_id, submission_id);

CREATE TABLE cooking_submission_environment_lock (
  deployment_confirmed INTEGER NOT NULL DEFAULT 1 CHECK (deployment_confirmed IN (0, 1)),
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
CREATE INDEX cooking_bug_submission_stage
  ON cooking_bug(submission_id, stage, short_id);
CREATE INDEX cooking_bug_item_stage
  ON cooking_bug(submission_item_id, stage, short_id);

CREATE TABLE cooking_bug_relation (
  id TEXT PRIMARY KEY,
  source_bug_id TEXT REFERENCES cooking_bug(id) ON DELETE SET NULL,
  target_bug_id TEXT REFERENCES cooking_bug(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('JOINT', 'TRANSFER', 'COLLABORATION')),
  source_short_id INTEGER NOT NULL,
  target_short_id INTEGER NOT NULL,
  source_title TEXT NOT NULL,
  target_title TEXT NOT NULL,
  handoff_text TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_bug_relation_source ON cooking_bug_relation(source_bug_id);
CREATE INDEX cooking_bug_relation_target ON cooking_bug_relation(target_bug_id);

CREATE TABLE cooking_bug_lifecycle_event (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('CANCELLED', 'RESTORED')),
  actor_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_bug_lifecycle_event_bug
  ON cooking_bug_lifecycle_event(bug_id, created_at, id);

CREATE TABLE cooking_bug_attachment (
  file_id TEXT NOT NULL REFERENCES platform_file(id) ON DELETE RESTRICT,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ACTUAL_RESULT', 'EXPECTED_RESULT')),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(bug_id, file_id),
  UNIQUE(bug_id, role, position)
) STRICT;
CREATE INDEX cooking_bug_attachment_bug
  ON cooking_bug_attachment(bug_id, role, position);

CREATE TABLE cooking_bug_repair_context (
  bug_id TEXT PRIMARY KEY REFERENCES cooking_bug(id) ON DELETE CASCADE,
  workspace_key TEXT NOT NULL UNIQUE,
  session_id TEXT,
  pending_commits_json TEXT NOT NULL,
  pending_manual_operations_json TEXT NOT NULL,
  last_candidate_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE cooking_repair_attempt (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(bug_id, attempt)
) STRICT;
CREATE INDEX cooking_repair_attempt_bug
  ON cooking_repair_attempt(bug_id, attempt, created_at);

CREATE TABLE cooking_repair_session_sync (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_repair_session_sync_bug
  ON cooking_repair_session_sync(bug_id, created_at);
CREATE UNIQUE INDEX cooking_repair_session_sync_turn
  ON cooking_repair_session_sync(session_id, turn_id)
  WHERE turn_id IS NOT NULL;

CREATE TABLE cooking_pending_delivery (
  submission_item_id TEXT PRIMARY KEY REFERENCES cooking_submission_item(id) ON DELETE CASCADE,
  last_candidate_at TEXT NOT NULL,
  eligible_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_pending_delivery_due
  ON cooking_pending_delivery(eligible_at, submission_item_id);

CREATE TABLE cooking_update_batch (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES cooking_test_submission(id) ON DELETE CASCADE,
  submission_item_id TEXT NOT NULL REFERENCES cooking_submission_item(id) ON DELETE RESTRICT,
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
CREATE UNIQUE INDEX cooking_update_batch_active_item
  ON cooking_update_batch(submission_item_id)
  WHERE state IN ('READY', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED');
CREATE INDEX cooking_update_batch_submission
  ON cooking_update_batch(submission_id, created_at, id);

CREATE TABLE cooking_update_batch_entry (
  batch_id TEXT NOT NULL REFERENCES cooking_update_batch(id) ON DELETE CASCADE,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  commits_json TEXT NOT NULL,
  manual_operations_json TEXT NOT NULL,
  PRIMARY KEY(batch_id, bug_id),
  UNIQUE(batch_id, position)
) STRICT;
CREATE INDEX cooking_update_batch_entry_bug
  ON cooking_update_batch_entry(bug_id, batch_id);

CREATE TABLE cooking_external_deployment_report (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES cooking_update_batch(id) ON DELETE CASCADE,
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
CREATE INDEX cooking_external_deployment_report_batch
  ON cooking_external_deployment_report(batch_id, round, created_at);

CREATE TABLE cooking_external_deployment_report_attachment (
  file_id TEXT PRIMARY KEY REFERENCES platform_file(id) ON DELETE RESTRICT,
  report_id TEXT NOT NULL REFERENCES cooking_external_deployment_report(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE(report_id, position)
) STRICT;
CREATE INDEX cooking_external_deployment_report_attachment_report
  ON cooking_external_deployment_report_attachment(report_id, position);

CREATE TABLE cooking_update_attempt (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES cooking_update_batch(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  continuation_report_id TEXT UNIQUE REFERENCES cooking_external_deployment_report(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(batch_id, attempt)
) STRICT;
CREATE INDEX cooking_update_attempt_batch
  ON cooking_update_attempt(batch_id, attempt, created_at);

CREATE TABLE cooking_update_session_sync (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES cooking_update_batch(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cooking_update_session_sync_batch
  ON cooking_update_session_sync(batch_id, created_at);
CREATE UNIQUE INDEX cooking_update_session_sync_turn
  ON cooking_update_session_sync(session_id, turn_id)
  WHERE turn_id IS NOT NULL;

CREATE TABLE cooking_verification_record (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE CASCADE,
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
CREATE INDEX cooking_verification_record_bug
  ON cooking_verification_record(bug_id, round, created_at);

CREATE TABLE cooking_verification_attachment (
  verification_id TEXT NOT NULL REFERENCES cooking_verification_record(id) ON DELETE CASCADE,
  file_id TEXT PRIMARY KEY REFERENCES platform_file(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(verification_id, position)
) STRICT;
CREATE INDEX cooking_verification_attachment_record
  ON cooking_verification_attachment(verification_id, position);

CREATE TABLE cooking_reopen_record (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES cooking_bug(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK (round > 0),
  feedback TEXT NOT NULL,
  repair_attempt INTEGER NOT NULL CHECK (repair_attempt > 0),
  reopened_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(bug_id, round)
) STRICT;
CREATE INDEX cooking_reopen_record_bug
  ON cooking_reopen_record(bug_id, round, created_at);

CREATE TABLE cooking_reopen_attachment (
  reopen_id TEXT NOT NULL REFERENCES cooking_reopen_record(id) ON DELETE CASCADE,
  file_id TEXT PRIMARY KEY REFERENCES platform_file(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(reopen_id, position)
) STRICT;
CREATE INDEX cooking_reopen_attachment_record
  ON cooking_reopen_attachment(reopen_id, position);

CREATE TABLE cooking_cleanup (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES cooking_test_submission(id) ON DELETE CASCADE,
  submission_item_id TEXT NOT NULL REFERENCES cooking_submission_item(id) ON DELETE RESTRICT,
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
CREATE INDEX cooking_cleanup_submission
  ON cooking_cleanup(submission_id, created_at, id);
CREATE INDEX cooking_cleanup_item_state
  ON cooking_cleanup(submission_item_id, state, created_at);

CREATE TABLE cooking_cleanup_attempt (
  id TEXT PRIMARY KEY,
  cleanup_id TEXT NOT NULL REFERENCES cooking_cleanup(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES platform_execution(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(cleanup_id, attempt)
) STRICT;
CREATE INDEX cooking_cleanup_attempt_cleanup
  ON cooking_cleanup_attempt(cleanup_id, attempt, created_at);
`;
