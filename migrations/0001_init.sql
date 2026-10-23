CREATE TABLE subscriptions (
  repo TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  events TEXT NOT NULL,
  PRIMARY KEY (repo, chat_id, thread_id)
);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  repo TEXT,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX outbox_pending ON outbox(status, next_attempt_at, lease_until);
CREATE INDEX receipts_created ON receipts(created_at);
CREATE INDEX outbox_finished ON outbox(status, finished_at);
