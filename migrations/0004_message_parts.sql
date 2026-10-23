-- Existing messages remain independent with a NULL batch_id.
ALTER TABLE outbox ADD COLUMN batch_id TEXT;
ALTER TABLE outbox ADD COLUMN part_index INTEGER NOT NULL DEFAULT 0 CHECK (part_index >= 0);
CREATE INDEX outbox_batch_parts ON outbox(batch_id, part_index, status);
