import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
let db;
let sent = [];
let responses = [];
let updateId = 0;
const repo = 'kiritoxdone/github-tg-bot';
const bindings = {
  TELEGRAM_BOT_TOKEN: '123:TEST_ONLY', TELEGRAM_WEBHOOK_SECRET: 'test-telegram-secret',
  GITHUB_WEBHOOK_SECRET: 'test-github-secret', ALLOWED_USER_IDS: '123',
  ALLOWED_CHAT_IDS: '123,-10099', BOT_USERNAME: 'test_bot',
};

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['test/worker.js', ...['index', 'bot', 'delivery', 'format', 'security', 'storage'].map((name) => `src/${name}.js`)]
      .map((path) => ({ type: 'ESModule', path })),
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], bindings,
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.hostname, 'api.telegram.org');
      assert.ok(url.pathname.endsWith('/sendMessage'));
      sent.push(await request.json());
      let reply = responses.shift() || { ok: true, result: { message_id: sent.length } };
      if (typeof reply === 'function') reply = await reply();
      return Response.json(reply, { status: reply.error_code || 200 });
    },
  }));
  db = await mf.getD1Database('DB');
  const sql = await readFile('migrations/0001_init.sql', 'utf8');
  for (const statement of sql.split(';').filter((s) => s.trim())) await db.prepare(statement).run();
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch(['subscriptions', 'receipts', 'outbox'].map((table) => db.prepare(`DELETE FROM ${table}`)));
  sent = []; responses = [];
});

async function eventually(predicate) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for persisted delivery state');
}

async function settled() {
  await eventually(async () => (await db.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'pending' AND next_attempt_at <= ?").bind(Math.floor(Date.now() / 1000)).first()).n === 0);
}

function telegram(text, options = {}) {
  const { id = ++updateId, user = 123, chat = 123, thread, secret = bindings.TELEGRAM_WEBHOOK_SECRET, ...extra } = options;
  const body = { update_id: id, message: { text, from: { id: user }, chat: { id: chat },
    ...(thread ? { message_thread_id: thread } : {}), ...extra } };
  return mf.dispatchFetch('https://worker.test/webhooks/telegram', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) });
}

async function command(text, options) {
  const response = await telegram(text, options);
  assert.equal(response.status, 200);
  await settled();
  return response;
}

function github(event = 'issues', extra = {}, delivery = randomUUID(), secret = bindings.GITHUB_WEBHOOK_SECRET) {
  const body = JSON.stringify({ repository: { full_name: repo }, sender: { login: 'octocat' },
    action: 'opened', issue: { number: 1, title: '<b>Bug</b>', body: 'Details', html_url: `https://github.com/${repo}/issues/1` }, ...extra });
  return mf.dispatchFetch('https://worker.test/webhooks/github', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
}

test('health checks the actual D1 schema and unknown routes/methods are rejected', async () => {
  assert.equal((await mf.dispatchFetch('https://worker.test/health')).status, 200);
  assert.equal((await mf.dispatchFetch('https://worker.test/missing')).status, 404);
  assert.equal((await mf.dispatchFetch('https://worker.test/webhooks/github')).status, 405);
});

test('rejects forged GitHub and Telegram webhooks before writing anything', async () => {
  assert.equal((await telegram('/sub a/b', { secret: 'bad' })).status, 401);
  assert.equal((await github('issues', {}, randomUUID(), 'bad')).status, 401);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM receipts').first()).n, 0);
  assert.equal(sent.length, 0);
});

test('ignores unauthorized users, destinations, anonymous senders and commands to other bots', async () => {
  for (const options of [{ user: 666 }, { chat: -666 }, { sender_chat: { id: -10099 } }, { from: { id: 123, is_bot: true } }]) {
    assert.equal((await telegram('/sub a/b', options)).status, 200);
  }
  assert.equal((await telegram('/sub@other_bot a/b')).status, 200);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 0);
  assert.equal(sent.length, 0);
});

test('subscribes, delivers an issue, and deduplicates concurrent GitHub redeliveries', async () => {
  await command(`/sub@TEST_BOT ${repo}`);
  const delivery = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => github('issues', {}, delivery)));
  assert.ok(results.every((r) => r.status === 200));
  await settled();
  const notifications = sent.filter((m) => m.text.includes('Issue #1'));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].chat_id, '123');
  assert.equal(notifications[0].parse_mode, undefined);
  assert.match(notifications[0].text, /<b>Bug<\/b>/);
});

test('routes by repository, category and group topic, preserving independent subscriptions', async () => {
  await command(`/sub ${repo} release`, { chat: -10099, thread: 7 });
  await command(`/sub ${repo} issues`, { chat: -10099, thread: 8 });
  await command('/sub other/repo issues');
  await github(); await settled();
  const issue = sent.filter((m) => m.text.includes('Issue #1'));
  assert.equal(issue.length, 1);
  assert.equal(issue[0].message_thread_id, 8);
  await github('release', { action: 'published', release: { tag_name: 'v1' } }); await settled();
  assert.equal(sent.find((m) => m.text.includes('🚀')).message_thread_id, 7);
});

test('deduplicates Telegram updates and does not restore a subscription on an old replay', async () => {
  const id = ++updateId;
  await command(`/sub ${repo}`, { id });
  await command(`/unsub ${repo}`);
  const before = sent.length;
  await command(`/sub ${repo}`, { id });
  assert.equal(sent.length, before);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 0);
});

test('changes events, lists subscriptions, rejects invalid options and reports delivery state', async () => {
  await command(`/sub ${repo}`);
  await command(`/events ${repo} release,actions`);
  await command(`/events ${repo} typo`);
  const row = await db.prepare('SELECT events FROM subscriptions').first();
  assert.deepEqual(JSON.parse(row.events), ['release', 'actions']);
  await command('/list'); assert.match(sent.at(-1).text, /release,actions/);
  await command('/status'); assert.match(sent.at(-1).text, /聊天 ID：123/);
  await github(); await settled();
  assert.equal(sent.filter((m) => m.text.includes('Issue #1')).length, 0);
});

test('honors Telegram retry_after and recovers via the scheduled handler', async () => {
  await command(`/sub ${repo}`);
  responses.push({ ok: false, error_code: 429, parameters: { retry_after: 120 } });
  await github(); await settled();
  const row = await db.prepare("SELECT * FROM outbox WHERE status = 'pending'").first();
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at >= row.created_at + 120);
  // The scheduled handler uses current time; move the retry cursor into the past.
  await db.prepare('UPDATE outbox SET next_attempt_at = 0 WHERE id = ?').bind(row.id).run();
  assert.equal((await mf.dispatchFetch(`https://worker.test/__scheduled?time=${Date.now()}`)).status, 200);
  assert.equal((await db.prepare('SELECT status FROM outbox WHERE id = ?').bind(row.id).first()).status, 'sent');
});

test('records permanent failures and /retry sends them after the problem is fixed', async () => {
  await command(`/sub ${repo}`);
  responses.push({ ok: false, error_code: 403 });
  await github(); await settled();
  let row = await db.prepare("SELECT * FROM outbox WHERE status = 'failed'").first();
  assert.match(row.text, /Issue #1/);
  await command('/retry');
  row = await db.prepare('SELECT * FROM outbox WHERE id = ?').bind(row.id).first();
  assert.equal(row.status, 'sent');
  assert.equal(row.text, '');
});

test('unsubscribe cancels queued GitHub messages without touching other topics', async () => {
  await command(`/sub ${repo}`, { chat: -10099, thread: 1 });
  responses.push({ ok: false, error_code: 429, parameters: { retry_after: 500 } });
  await github(); await settled();
  await command(`/unsub ${repo}`, { chat: -10099, thread: 2 });
  assert.equal((await db.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'pending'").first()).n, 1);
  await command(`/unsub ${repo}`, { chat: -10099, thread: 1 });
  assert.equal((await db.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'pending'").first()).n, 0);
});

test('replayed events never send to newly added subscriptions', async () => {
  const id = randomUUID();
  await github('issues', {}, id);
  await command(`/sub ${repo}`);
  await github('issues', {}, id); await settled();
  assert.equal(sent.filter((m) => m.text.includes('Issue #1')).length, 0);
});

test('rejects invalid content types, oversized payloads and malformed JSON', async () => {
  assert.equal((await mf.dispatchFetch('https://worker.test/webhooks/github', { method: 'POST', body: 'x' })).status, 415);
  const response = await mf.dispatchFetch('https://worker.test/webhooks/telegram', { method: 'POST', body: '{', headers: {
    'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': bindings.TELEGRAM_WEBHOOK_SECRET,
  } });
  assert.equal(response.status, 400);
  assert.equal((await mf.dispatchFetch('https://worker.test/webhooks/github', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), headers: { 'Content-Type': 'application/json' } })).status, 413);
});

test('a storage failure rolls back the receipt and subscription, allowing a safe retry', async () => {
  await db.prepare("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test storage failure'); END").run();
  const id = ++updateId;
  try {
    assert.equal((await telegram(`/sub ${repo}`, { id })).status, 503);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM receipts').first()).n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 0);
  } finally { await db.prepare('DROP TRIGGER fail_outbox').run(); }
  await command(`/sub ${repo}`, { id });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 1);
});

test('an in-flight failure cannot revive a message cancelled by unsubscribe', async () => {
  await command(`/sub ${repo}`);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  responses.push(async () => { await blocked; return { ok: false, error_code: 403 }; });
  const delivery = randomUUID();
  await github('issues', {}, delivery);
  await eventually(() => sent.some((m) => m.text.includes('Issue #1')));
  await command(`/unsub ${repo}`);
  release();
  // Wait for the old sender to observe its cancellation before attempting /retry.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await command('/retry');
  const row = await db.prepare('SELECT status FROM outbox WHERE id = ?').bind(`gh:${delivery}:123:0`).first();
  assert.equal(row.status, 'cancelled');
  assert.equal(sent.filter((m) => m.text.includes('Issue #1')).length, 1);
});

test('expired delivery leases recover after interruption and repeated failures stop at 12 attempts', async () => {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO outbox (id, chat_id, text, attempts, next_attempt_at, lease_until, lease_token, created_at)
    VALUES ('interrupted', '123', 'Recovery', 11, 0, ?, 'old-worker', ?)`).bind(now - 1, now).run();
  responses.push({ ok: false, error_code: 500 });
  await mf.dispatchFetch(`https://worker.test/__flush?now=${now}`);
  const row = await db.prepare("SELECT * FROM outbox WHERE id = 'interrupted'").first();
  assert.equal(row.attempts, 12);
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error, 'Telegram error 500');
});

test('queued messages for a removed destination are cancelled without sending', async () => {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO outbox (id, chat_id, text, next_attempt_at, created_at)
    VALUES ('revoked', '-1234', 'Private content', 0, ?)`).bind(now).run();
  await mf.dispatchFetch(`https://worker.test/__flush?now=${now}`);
  const row = await db.prepare("SELECT * FROM outbox WHERE id = 'revoked'").first();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.text, '');
  assert.equal(sent.length, 0);
});
