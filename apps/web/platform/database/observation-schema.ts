export const OBSERVATION_SCHEMA = `
CREATE TABLE platform_observation_batch (
  execution_id TEXT NOT NULL REFERENCES platform_execution(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest)=64),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(execution_id, batch_id)
) STRICT;
CREATE INDEX platform_observation_batch_age ON platform_observation_batch(accepted_at);

CREATE TABLE platform_observation_event (
  execution_id TEXT NOT NULL REFERENCES platform_execution(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(execution_id,event_id),
  UNIQUE(execution_id,segment_id,sequence)
) STRICT;
CREATE INDEX platform_observation_event_age ON platform_observation_event(accepted_at);

CREATE TABLE platform_observation_report (
  execution_id TEXT NOT NULL REFERENCES platform_execution(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision>0),
  parent_report_id TEXT,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
  detail_until TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(execution_id,revision)
) STRICT;
CREATE INDEX platform_observation_report_age ON platform_observation_report(accepted_at);

CREATE TABLE platform_observation_head (
  execution_id TEXT PRIMARY KEY REFERENCES platform_execution(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;

CREATE TABLE platform_observation_tombstone (
  execution_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER platform_observation_deleted AFTER DELETE ON platform_execution
BEGIN
  INSERT OR IGNORE INTO platform_observation_tombstone(execution_id,deleted_at)
  VALUES(old.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
`;
