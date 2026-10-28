CREATE TABLE activity_states (
  repo TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (repo, object_key)
);
CREATE INDEX activity_states_seen ON activity_states(seen_at);
