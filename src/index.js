import { handleTelegram } from './bot.js';
import { flushOutbox } from './delivery.js';
import { formatEvent } from './format.js';
import { configured, equalSecret, HttpError, ids, parseBody, readBody, validGitHubSignature } from './security.js';
import { prune, receiptStatements } from './storage.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/') return json({ name: 'Github-TG-Bot', source: 'https://github.com/KiritoXDone/Github-TG-Bot' });
      if (!['/health', '/webhooks/github', '/webhooks/telegram'].includes(path)) return json({ error: 'Not found' }, 404);
      if (request.method !== (path === '/health' ? 'GET' : 'POST')) return json({ error: 'Method not allowed' }, 405);
      if (!configured(env)) return json({ error: 'Worker configuration incomplete' }, 503);
      if (path === '/health') {
        await env.DB.prepare('SELECT 1 FROM subscriptions LEFT JOIN destinations USING (chat_id) LIMIT 1').first();
        return json({ ok: true });
      }
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use application/json');
      const now = Math.floor(Date.now() / 1000);
      if (path === '/webhooks/telegram') {
        if (!await equalSecret(env.TELEGRAM_WEBHOOK_SECRET, request.headers.get('x-telegram-bot-api-secret-token'))) throw new HttpError(401, 'Invalid Telegram secret');
        const update = parseBody(await readBody(request, 256 * 1024));
        await handleTelegram(env, update, now);
      } else {
        const body = await readBody(request, 1024 * 1024);
        if (!await validGitHubSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256'))) throw new HttpError(401, 'Invalid GitHub signature');
        const event = request.headers.get('x-github-event');
        const delivery = request.headers.get('x-github-delivery');
        if (!event || !/^[A-Za-z0-9-]{1,128}$/.test(delivery || '')) throw new HttpError(400, 'Missing or invalid GitHub headers');
        const payload = parseBody(body);
        if (event === 'ping') return json({ ok: true, message: 'pong' });
        const notification = formatEvent(event, payload);
        if (notification) {
          const id = `gh:${delivery}`;
          const token = crypto.randomUUID();
          const chats = ids(env.ALLOWED_CHAT_IDS).length ? ids(env.ALLOWED_CHAT_IDS) : ids(env.ALLOWED_USER_IDS);
          const statements = receiptStatements(env.DB, id, token, now);
          // Fan-out and receipt are one transaction. A replay cannot add new recipients.
          statements.push(env.DB.prepare(`INSERT OR IGNORE INTO outbox
            (id, repo, chat_id, thread_id, text, parse_mode, next_attempt_at, created_at)
            SELECT ? || ':' || s.chat_id || ':' || s.thread_id, s.repo, s.chat_id, s.thread_id, ?, ?, ?, ?
            FROM subscriptions s LEFT JOIN destinations d ON d.chat_id = s.chat_id WHERE s.repo = ?
              AND (d.enabled = 1 OR (d.chat_id IS NULL AND s.chat_id IN (SELECT value FROM json_each(?))))
              AND EXISTS (SELECT 1 FROM json_each(s.events) WHERE value = ?)
              AND EXISTS (SELECT 1 FROM receipts WHERE id = ? AND token = ?)`)
            .bind(id, notification.text, notification.parse_mode, now, now, notification.repo, JSON.stringify(chats), notification.category, id, token));
          await env.DB.batch(statements);
        }
      }
      // Acknowledge only after persistence; cron recovers interrupted waitUntil work.
      ctx.waitUntil(flushOutbox(env).catch(() => console.error('outbox_flush_failed')));
      return json({ ok: true });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('webhook_processing_failed'); // Do not log secrets or private payloads.
      return json({ error: 'Temporary processing failure' }, 503);
    }
  },
  async scheduled(controller, env, ctx) {
    if (!configured(env)) { console.error('worker_configuration_incomplete'); return; }
    // 1 scan + 20 claims + 20 outcomes leaves room for cleanup under D1's free-tier query limit.
    await flushOutbox(env, { limit: 20 });
    // Cleanup once daily; all schedules are UTC.
    const time = new Date(controller.scheduledTime);
    if (time.getUTCHours() === 3 && time.getUTCMinutes() === 0) {
      await prune(env.DB, Math.floor(controller.scheduledTime / 1000));
    }
  },
};
