export const PROJECT_SCHEMA = `CREATE TABLE platform_project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_by_user_id TEXT NOT NULL REFERENCES platform_user(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_project_creator ON platform_project(created_by_user_id, created_at);

CREATE TABLE platform_project_membership (
  project_id TEXT NOT NULL REFERENCES platform_project(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, user_id)
) STRICT;
CREATE INDEX platform_project_membership_user
  ON platform_project_membership(user_id, created_at);

CREATE TABLE platform_project_invitation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES platform_project(id) ON DELETE CASCADE,
  invited_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  invited_by_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  responded_at TEXT
) STRICT;
CREATE UNIQUE INDEX platform_project_invitation_pending
  ON platform_project_invitation(project_id, invited_user_id)
  WHERE status = 'PENDING';
CREATE INDEX platform_project_invitation_recipient
  ON platform_project_invitation(invited_user_id, status, created_at);

CREATE TABLE platform_mutation (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_mutation_actor ON platform_mutation(actor_user_id, created_at);

CREATE TABLE platform_audit_event (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES platform_project(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX platform_audit_project ON platform_audit_event(project_id, created_at, id);

CREATE TABLE platform_engineering (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES platform_project(id) ON DELETE CASCADE,
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
CREATE UNIQUE INDEX platform_engineering_active_name
  ON platform_engineering(project_id, name)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX platform_engineering_project_identifier
  ON platform_engineering(project_id, identifier);
CREATE INDEX platform_engineering_project
  ON platform_engineering(project_id, archived_at, created_at);

CREATE TABLE platform_engineering_membership (
  engineering_id TEXT NOT NULL REFERENCES platform_engineering(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(engineering_id, user_id)
) STRICT;
CREATE INDEX platform_engineering_membership_user
  ON platform_engineering_membership(user_id, created_at);

CREATE TABLE platform_environment (
  id TEXT PRIMARY KEY,
  engineering_id TEXT NOT NULL REFERENCES platform_engineering(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  deployment_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(engineering_id, name)
) STRICT;
CREATE INDEX platform_environment_engineering
  ON platform_environment(engineering_id, created_at);

CREATE TABLE platform_engineering_binding (
  id TEXT PRIMARY KEY,
  engineering_id TEXT NOT NULL REFERENCES platform_engineering(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_user(id) ON DELETE RESTRICT,
  runner_id TEXT NOT NULL REFERENCES platform_runner(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(engineering_id, user_id)
) STRICT;
CREATE INDEX platform_engineering_binding_runner
  ON platform_engineering_binding(runner_id, created_at);
CREATE INDEX platform_engineering_binding_engineering
  ON platform_engineering_binding(engineering_id, created_at);

CREATE TABLE platform_binding_request (
  id TEXT PRIMARY KEY,
  engineering_id TEXT NOT NULL REFERENCES platform_engineering(id) ON DELETE CASCADE,
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
CREATE UNIQUE INDEX platform_binding_request_active
  ON platform_binding_request(engineering_id, user_id)
  WHERE state IN ('PENDING', 'PROCESSING');
CREATE INDEX platform_binding_request_runner
  ON platform_binding_request(runner_id, state, expires_at, created_at);

`;
