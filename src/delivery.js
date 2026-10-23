import { allowedChat, allowedUser } from './security.js';

export async function flushOutbox(env, { limit = 10, now = Math.floor(Date.now() / 1000) } = {}) {
  const rows = await env.DB.prepare(`SELECT id FROM outbox
    WHERE status = 'pending' AND next_attempt_at <= ? AND lease_until <= ?
    ORDER BY next_attempt_at, created_at LIMIT ?`).bind(now, now, limit).all();
  // Keep one pass bounded so the immediate waitUntil task fits Workers' lifetime.
  for (let offset = 0; offset < rows.results.length; offset += 5) {
    await Promise.all(rows.results.slice(offset, offset + 5).map(({ id }) => deliver(env, id, now)));
  }
}

async function deliver(env, id, now) {
  const token = crypto.randomUUID();
  const row = await env.DB.prepare(`UPDATE outbox SET lease_until = ?, lease_token = ?, attempts = attempts + 1
    WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? AND lease_until <= ?
    RETURNING *, (SELECT enabled FROM destinations WHERE destinations.chat_id = outbox.chat_id) AS destination_enabled`)
    .bind(now + 120, token, id, now, now).first();
  if (!row) return; // Another request/cron invocation owns this delivery.
  const controlReply = row.repo === null && allowedUser(env, row.chat_id);
  const destinationAllowed = row.destination_enabled === null ? allowedChat(env, row.chat_id) : row.destination_enabled === 1;
  if (!controlReply && !destinationAllowed) {
    await finish(env.DB, id, token, 'cancelled', now, 'Destination removed from allowlist');
    return;
  }
  let retryAfter = 0;
  let error = 'Telegram network error';
  let permanent = false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: row.chat_id, text: row.text,
        ...(row.parse_mode ? { parse_mode: row.parse_mode } : {}),
        ...(row.thread_id ? { message_thread_id: row.thread_id } : {}),
        link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.ok === true) {
      await finish(env.DB, id, token, 'sent', now, null);
      return;
    }
    const code = Number(result.error_code) || response.status;
    // Never persist the request URL, bot token or arbitrary upstream error text.
    error = `Telegram error ${code}`;
    retryAfter = Math.min(86400, Math.max(0, Number(result.parameters?.retry_after) || 0));
    permanent = code >= 400 && code < 500 && code !== 429 && code !== 408;
  } catch { /* A timeout may mean Telegram accepted the message; retries are at-least-once. */ }
  if (permanent || row.attempts >= 12) {
    await finish(env.DB, id, token, 'failed', now, error);
    console.warn('telegram_delivery_failed', { delivery: id, attempts: row.attempts, reason: error });
    return;
  }
  const delay = Math.max(retryAfter, Math.min(3600, 30 * 2 ** (row.attempts - 1)));
  await env.DB.prepare(`UPDATE outbox SET lease_until = 0, lease_token = NULL, next_attempt_at = ?, last_error = ?
    WHERE id = ? AND lease_token = ? AND status = 'pending'`).bind(now + delay, error, id, token).run();
}

async function finish(db, id, token, status, now, error) {
  await db.prepare(`UPDATE outbox SET status = ?, finished_at = ?, last_error = ?,
    text = CASE WHEN ? = 'failed' THEN text ELSE '' END,
    lease_until = 0, lease_token = NULL WHERE id = ? AND lease_token = ? AND status = 'pending'`)
    .bind(status, now, error, status, id, token).run();
}
