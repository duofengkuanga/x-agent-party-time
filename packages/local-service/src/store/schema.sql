PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS service_heartbeat (
  instance_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0), started_at TEXT NOT NULL, last_beat_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_cursor (
  subscription_id TEXT PRIMARY KEY, source_seq TEXT, source_event_id TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingested_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id TEXT NOT NULL, channel_key TEXT NOT NULL,
  source_seq TEXT NOT NULL, source_event_id TEXT, sender_id TEXT NOT NULL, received_at TEXT NOT NULL,
  message_text TEXT NOT NULL, thread_key TEXT, wake_job_id TEXT, UNIQUE (subscription_id, source_seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS ingested_message_event_identity ON ingested_message(subscription_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS session (
  key TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation > 0), agent_id TEXT NOT NULL,
  channel_key TEXT NOT NULL, workspace_path TEXT NOT NULL, codex_thread_id TEXT, status TEXT NOT NULL,
  invalidated_reason TEXT, revision INTEGER NOT NULL CHECK (revision >= 0), created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (key, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS active_session_per_key ON session(key) WHERE status IN ('pending', 'active');
CREATE TABLE IF NOT EXISTS wake_job (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, trigger_kind TEXT NOT NULL, agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL, task_id TEXT, source_ref TEXT NOT NULL, priority INTEGER NOT NULL, state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  lease_owner_instance_id TEXT, lease_generation INTEGER, lease_acquired_at TEXT, lease_expires_at TEXT,
  next_attempt_at TEXT, deadline_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wake_job_due_queue ON wake_job(state, next_attempt_at, priority DESC, created_at ASC);
CREATE TABLE IF NOT EXISTS run_attempt (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES wake_job(id), attempt INTEGER NOT NULL CHECK (attempt > 0),
  lease_generation INTEGER NOT NULL, runner_name TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, result_summary TEXT, error_json TEXT, usage_json TEXT, UNIQUE (job_id, attempt)
);
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, state TEXT NOT NULL, priority TEXT NOT NULL,
  assignee_json TEXT, creator_json TEXT NOT NULL, parent_task_id TEXT REFERENCES task(id), labels_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_work_queue ON task(state, priority, updated_at DESC);
CREATE TABLE IF NOT EXISTS task_anchor (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE, channel_key TEXT NOT NULL, source_seq TEXT NOT NULL,
  event_id TEXT, PRIMARY KEY (task_id, channel_key, source_seq), UNIQUE (channel_key, source_seq)
);
CREATE TABLE IF NOT EXISTS task_event (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), type TEXT NOT NULL, actor_json TEXT NOT NULL,
  previous_revision INTEGER, next_revision INTEGER NOT NULL, reason TEXT, payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (task_id, next_revision)
);
CREATE TABLE IF NOT EXISTS completion_artifact (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), run_id TEXT REFERENCES run_attempt(id),
  submitted_by_json TEXT NOT NULL, summary TEXT NOT NULL, references_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS completion_review (
  artifact_id TEXT PRIMARY KEY REFERENCES completion_artifact(id), status TEXT NOT NULL, reviewer_json TEXT,
  reason TEXT, replacement_artifact_id TEXT REFERENCES completion_artifact(id), reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS team_lineage (
  worker_agent_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, root_agent_id TEXT NOT NULL, parent_agent_id TEXT,
  role TEXT NOT NULL, depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 4), expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS squad (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, leader_agent_id TEXT NOT NULL, revision INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS squad_member (
  squad_id TEXT NOT NULL REFERENCES squad(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, PRIMARY KEY (squad_id, agent_id)
);
CREATE TABLE IF NOT EXISTS reply_outbox (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run_attempt(id), subscription_id TEXT NOT NULL, channel_key TEXT NOT NULL,
  thread_key TEXT, reply_to_event_id TEXT, text TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0, lease_owner_instance_id TEXT, lease_generation INTEGER,
  lease_acquired_at TEXT, lease_expires_at TEXT, next_attempt_at TEXT, provider_message_id TEXT, last_error_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reply_outbox_due ON reply_outbox(state, next_attempt_at, created_at);
CREATE TABLE IF NOT EXISTS event_journal (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, correlation_id TEXT NOT NULL,
  causation_id TEXT, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, committed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_journal_correlation ON event_journal(correlation_id, cursor);
