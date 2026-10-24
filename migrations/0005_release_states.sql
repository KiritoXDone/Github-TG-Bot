CREATE TABLE release_states (
  repo TEXT NOT NULL,
  release_id INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (repo, release_id)
);
CREATE INDEX release_states_seen ON release_states(seen_at);
