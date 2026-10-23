-- NULL keeps command replies and messages queued before this migration plain.
ALTER TABLE outbox ADD COLUMN parse_mode TEXT
  CHECK (parse_mode IS NULL OR parse_mode = 'MarkdownV2');
