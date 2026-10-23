CREATE TABLE destinations (
  chat_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('private', 'group', 'supergroup', 'channel')),
  title TEXT NOT NULL,
  username TEXT,
  is_forum INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  registered_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
