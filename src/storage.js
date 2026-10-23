export function receiptStatements(db, id, token, now) {
  return [db.prepare('INSERT OR IGNORE INTO receipts (id, token, created_at) VALUES (?, ?, ?)').bind(id, token, now)];
}

export async function prune(db, now) {
  const cutoff = now - 30 * 86400;
  await db.batch([
    db.prepare('DELETE FROM receipts WHERE created_at < ?').bind(cutoff),
    db.prepare("DELETE FROM outbox WHERE status != 'pending' AND finished_at < ?").bind(cutoff),
  ]);
}
