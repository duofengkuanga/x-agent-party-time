export const PLATFORM_SCHEMA = `
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
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  uploaded_by_user_id TEXT NOT NULL REFERENCES platform_user(id),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_file_uploader ON platform_file(uploaded_by_user_id, created_at);

CREATE TABLE platform_runner (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  installation_id TEXT CHECK (
    installation_id IS NULL OR length(installation_id) = 36
  ),
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK (version > 0),
  available_slots INTEGER NOT NULL DEFAULT 3 CHECK (available_slots BETWEEN 0 AND 3),
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_runner_owner
  ON platform_runner(owner_user_id, revoked_at, created_at);
CREATE UNIQUE INDEX platform_runner_owner_installation
  ON platform_runner(owner_user_id, installation_id)
  WHERE installation_id IS NOT NULL;
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

CREATE TABLE platform_runner_authorization_request (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL CHECK (length(installation_id) = 36),
  verifier_hash TEXT NOT NULL UNIQUE CHECK (length(verifier_hash) = 64),
  fingerprint TEXT NOT NULL,
  suggested_name TEXT NOT NULL,
  approved_name TEXT,
  owner_user_id TEXT REFERENCES platform_user(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'CONSUMED'
  )),
  approval_token_hash TEXT CHECK (
    approval_token_hash IS NULL OR length(approval_token_hash) = 64
  ),
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  last_polled_at TEXT,
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_runner_authorization_expiry
  ON platform_runner_authorization_request(state, expires_at);
CREATE INDEX platform_runner_authorization_created
  ON platform_runner_authorization_request(created_at);

CREATE TABLE platform_execution (
  id TEXT PRIMARY KEY,
  owner_namespace TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  previous_execution_id TEXT REFERENCES platform_execution(id) ON DELETE RESTRICT,
  runner_id TEXT NOT NULL REFERENCES platform_runner(id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  approval_policy TEXT NOT NULL CHECK (approval_policy IN ('never', 'on-request')),
  state TEXT NOT NULL CHECK (state IN (
    'QUEUED',
    'CLAIMED',
    'RUNNING',
    'WAITING_FOR_INTERACTION',
    'WAITING_TO_RESUME',
    'CANCEL_REQUESTED',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED'
  )),
  codex_turn_json TEXT CHECK (
    codex_turn_json IS NULL OR json_valid(codex_turn_json)
  ),
  skill_name TEXT,
  skill_bundle_hash TEXT CHECK (
    skill_bundle_hash IS NULL OR length(skill_bundle_hash) = 64
  ),
  skill_source_revision TEXT CHECK (
    skill_source_revision IS NULL OR length(skill_source_revision) = 40
  ),
  workspace_json TEXT CHECK (
    workspace_json IS NULL OR json_valid(workspace_json)
  ),
  session_id TEXT,
  lease_token_hash TEXT,
  lease_expires_at TEXT,
  outcome_json TEXT,
  reported_outcome_json TEXT,
  cancellation_requested INTEGER NOT NULL DEFAULT 0
    CHECK (cancellation_requested IN (0, 1)),
  resume_requested_at TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  started_at TEXT,
  finished_at TEXT
) STRICT;
CREATE UNIQUE INDEX platform_execution_binding_reservation
  ON platform_execution(binding_id)
  WHERE state IN (
    'CLAIMED',
    'RUNNING',
    'CANCEL_REQUESTED'
  );
CREATE INDEX platform_execution_runner_claim
  ON platform_execution(runner_id, state, created_at, id);
CREATE INDEX platform_execution_lease_expiry
  ON platform_execution(state, lease_expires_at);
CREATE INDEX platform_execution_owner
  ON platform_execution(owner_namespace, owner_kind, owner_id, attempt);

CREATE TABLE platform_execution_attachment (
  execution_id TEXT NOT NULL REFERENCES platform_execution(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES platform_file(id) ON DELETE RESTRICT,
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY(execution_id, file_id),
  UNIQUE(execution_id, position)
) STRICT;
CREATE INDEX platform_execution_attachment_file
  ON platform_execution_attachment(file_id, execution_id);

CREATE TABLE platform_execution_interaction (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES platform_execution(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('APPROVAL', 'USER_INPUT')),
  method TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'RESOLVED', 'INVALIDATED')),
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;
CREATE UNIQUE INDEX platform_execution_interaction_pending
  ON platform_execution_interaction(execution_id)
  WHERE state = 'PENDING';
CREATE INDEX platform_execution_interaction_execution
  ON platform_execution_interaction(execution_id, created_at, id);

`;
