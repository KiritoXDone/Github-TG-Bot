import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
let db;
let sent = [];
let responses = [];
let chats;
let members;
let apiCalls;
let apiFailure;
let updateId = 0;
const repo = 'kiritoxdone/github-tg-bot';
const bindings = {
  TELEGRAM_BOT_TOKEN: '999:TEST_ONLY', TELEGRAM_WEBHOOK_SECRET: 'test-telegram-secret',
  GITHUB_WEBHOOK_SECRET: 'test-github-secret', ALLOWED_USER_IDS: '123',
  ALLOWED_CHAT_IDS: '123,-10099', BOT_USERNAME: 'test_bot',
};

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['test/worker.js', ...['index', 'bot', 'delivery', 'format', 'security', 'storage', 'targets'].map((name) => `src/${name}.js`)]
      .map((path) => ({ type: 'ESModule', path })),
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], bindings,
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.hostname, 'api.telegram.org');
      const method = url.pathname.split('/').at(-1);
      const body = await request.json();
      if (method !== 'sendMessage') {
        apiCalls.push({ method, body });
        if (apiFailure) return Response.json({ ok: false, error_code: apiFailure }, { status: apiFailure });
        if (method === 'getChat') {
          const chat = chats[String(body.chat_id)] || Object.values(chats).find((c) => `@${c.username}` === body.chat_id);
          return chat ? Response.json({ ok: true, result: chat }) : Response.json({ ok: false, error_code: 400 }, { status: 400 });
        }
        assert.equal(method, 'getChatMember');
        const member = members[`${body.chat_id}:${body.user_id}`] || { status: 'administrator', can_post_messages: true };
        return Response.json({ ok: true, result: member });
      }
      sent.push(body);
      let reply = responses.shift() || { ok: true, result: { message_id: sent.length } };
      if (typeof reply === 'function') reply = await reply();
      return Response.json(reply, { status: reply.error_code || 200 });
    },
  }));
  db = await mf.getD1Database('DB');
  for (const file of ['0001_init.sql', '0002_destinations.sql', '0003_message_format.sql']) {
    const sql = await readFile(`migrations/${file}`, 'utf8');
    for (const statement of sql.split(';').filter((s) => s.trim())) await db.prepare(statement).run();
  }
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch(['subscriptions', 'receipts', 'outbox', 'destinations'].map((table) => db.prepare(`DELETE FROM ${table}`)));
  sent = []; responses = [];
  chats = {
    '-10099': { id: -10099, type: 'supergroup', title: 'Team group', is_forum: true },
    '-10077': { id: -10077, type: 'channel', title: 'Release channel', username: 'release_news' },
    '-10088': { id: -10088, type: 'channel', title: 'Private channel' },
    '-10066': { id: -10066, type: 'supergroup', title: 'New group', is_forum: true },
  };
  members = {}; apiCalls = []; apiFailure = undefined;
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
  const body = { update_id: id, message: { text, from: { id: user }, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' },
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

test('messages queued without a format remain plain text after the migration', async () => {
  const text = 'Legacy *text* with [brackets] and https://github.com/a/b';
  await db.prepare(`INSERT INTO outbox (id, repo, chat_id, text, next_attempt_at, created_at)
    VALUES ('legacy-format', ?, '123', ?, 0, 0)`).bind(repo, text).run();
  await mf.dispatchFetch('https://worker.test/__flush');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, text);
  assert.equal(sent[0].parse_mode, undefined);
  assert.equal((await db.prepare("SELECT status FROM outbox WHERE id = 'legacy-format'").first()).status, 'sent');
});

test('rejects forged GitHub and Telegram webhooks before writing anything', async () => {
  assert.equal((await telegram('/sub a/b', { secret: 'bad' })).status, 401);
  assert.equal((await github('issues', {}, randomUUID(), 'bad')).status, 401);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM receipts').first()).n, 0);
  assert.equal(sent.length, 0);
});

test('ignores unauthorized users, anonymous senders and commands to other bots', async () => {
  for (const options of [{ user: 666 }, { sender_chat: { id: -10099 } }, { from: { id: 123, is_bot: true } }]) {
    assert.equal((await telegram('/sub a/b', options)).status, 200);
  }
  assert.equal((await telegram('/sub@other_bot a/b')).status, 200);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 0);
  assert.equal(sent.length, 0);
  assert.equal(apiCalls.length, 0);
});

test('subscribes, delivers an issue, and deduplicates concurrent GitHub redeliveries', async () => {
  await command(`/sub@TEST_BOT ${repo}`);
  const delivery = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => github('issues', {}, delivery)));
  assert.ok(results.every((r) => r.status === 200));
  await settled();
  const notifications = sent.filter((m) => m.text.includes('/issues/1)'));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].chat_id, '123');
  assert.equal(notifications[0].parse_mode, 'MarkdownV2');
  assert.equal(sent[0].parse_mode, undefined, 'command replies remain plain text');
  assert.ok(notifications[0].text.includes('*<b\\>Bug</b\\>*'));
  assert.ok(notifications[0].text.includes('>Details'));
});

test('routes by repository, category and group topic, preserving independent subscriptions', async () => {
  await command(`/sub ${repo} release`, { chat: -10099, thread: 7 });
  await command(`/sub ${repo} issues`, { chat: -10099, thread: 8 });
  await command('/sub other/repo issues');
  await github(); await settled();
  const issue = sent.filter((m) => m.text.includes('/issues/1)'));
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
  assert.equal(sent.filter((m) => m.text.includes('/issues/1)')).length, 0);
});

test('honors Telegram retry_after and recovers via the scheduled handler', async () => {
  await command(`/sub ${repo}`);
  responses.push({ ok: false, error_code: 429, parameters: { retry_after: 120 } });
  await github(); await settled();
  const row = await db.prepare("SELECT * FROM outbox WHERE status = 'pending'").first();
  assert.equal(row.attempts, 1);
  assert.equal(row.parse_mode, 'MarkdownV2');
  assert.ok(row.next_attempt_at >= row.created_at + 120);
  // The scheduled handler uses current time; move the retry cursor into the past.
  await db.prepare('UPDATE outbox SET next_attempt_at = 0 WHERE id = ?').bind(row.id).run();
  assert.equal((await mf.dispatchFetch(`https://worker.test/__scheduled?time=${Date.now()}`)).status, 200);
  assert.equal((await db.prepare('SELECT status FROM outbox WHERE id = ?').bind(row.id).first()).status, 'sent');
  assert.equal(sent.at(-1).parse_mode, 'MarkdownV2');
  assert.equal(sent.at(-1).text, row.text);
});

test('records permanent failures and /retry sends them after the problem is fixed', async () => {
  await command(`/sub ${repo}`);
  responses.push({ ok: false, error_code: 403 });
  await github(); await settled();
  let row = await db.prepare("SELECT * FROM outbox WHERE status = 'failed'").first();
  assert.ok(row.text.includes('/issues/1)'));
  assert.equal(row.parse_mode, 'MarkdownV2');
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
  assert.equal(sent.filter((m) => m.text.includes('/issues/1)')).length, 0);
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
    assert.equal((await db.prepare('SELECT count(*) AS n FROM destinations').first()).n, 0);
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
  await eventually(() => sent.some((m) => m.text.includes('/issues/1)')));
  await command(`/unsub ${repo}`);
  release();
  // Wait for the old sender to observe its cancellation before attempting /retry.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await command('/retry');
  const row = await db.prepare('SELECT status FROM outbox WHERE id = ?').bind(`gh:${delivery}:123:0`).first();
  assert.equal(row.status, 'cancelled');
  assert.equal(sent.filter((m) => m.text.includes('/issues/1)')).length, 1);
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

test('one repository can independently notify personal, group topic and channel destinations', async () => {
  await command(`/sub ${repo} --to me`);
  await command(`/sub ${repo} --to -10066 --topic 7`);
  await command(`/sub ${repo} --to @release_news`);
  assert.ok(sent.every((m) => m.chat_id === '123'), 'remote management confirmations stay private');
  const rows = await db.prepare('SELECT chat_id, type FROM destinations ORDER BY chat_id').all();
  assert.deepEqual(rows.results.map((r) => r.type).sort(), ['channel', 'private', 'supergroup']);
  await github(); await settled();
  const notifications = sent.filter((m) => m.text.includes('/issues/1)'));
  assert.deepEqual(notifications.map((m) => m.chat_id).sort(), ['-10066', '-10077', '123']);
  assert.equal(notifications.find((m) => m.chat_id === '-10066').message_thread_id, 7);
  assert.equal(notifications.find((m) => m.chat_id === '-10077').message_thread_id, undefined);
});

test('private channels connect by numeric ID and public channel usernames resolve to stable IDs', async () => {
  await command(`/sub ${repo} --to @release_news`);
  await command(`/sub ${repo} release --to -10088`);
  chats['-10077'].username = 'new_channel_name';
  await github(); await settled();
  assert.equal(sent.find((m) => m.text.includes('/issues/1)')).chat_id, '-10077');
  await command('/targets');
  assert.match(sent.at(-1).text, /个人/);
  assert.match(sent.at(-1).text, /频道 · Private channel \(-10088\)/);
});

test('connecting a channel requires the user to be an admin and the bot to have posting rights', async () => {
  members['-10077:123'] = { status: 'member' };
  await command(`/sub ${repo} --to @release_news`);
  assert.match(sent.at(-1).text, /你需要是目标群\/频道的管理员/);
  members['-10077:123'] = { status: 'creator' };
  members['-10077:999'] = { status: 'administrator', can_post_messages: false };
  await command('/target add @release_news');
  assert.match(sent.at(-1).text, /发布消息/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM destinations').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 0);
});

test('group subscriptions work without editing ALLOWED_CHAT_IDS after admin verification', async () => {
  await command(`/sub ${repo}`, { chat: -10066, thread: 9 });
  assert.equal(sent.at(-1).chat_id, '-10066');
  assert.equal(sent.at(-1).message_thread_id, 9);
  await github(); await settled();
  assert.equal(sent.find((m) => m.text.includes('/issues/1)')).chat_id, '-10066');
});

test('an inaccessible group gets a private error and cannot become a notification target', async () => {
  await command(`/sub ${repo}`, { chat: -666 });
  assert.equal(sent.at(-1).chat_id, '123');
  assert.match(sent.at(-1).text, /无法访问目标/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM destinations').first()).n, 0);
});

test('remote list, events and unsubscribe operate on only the selected destination', async () => {
  await command(`/sub ${repo} --to me`);
  await command(`/sub ${repo} --to @release_news`);
  await command(`/events ${repo} release --to @release_news`);
  await command('/list --to @release_news');
  assert.match(sent.at(-1).text, /频道.*Release channel/s);
  assert.match(sent.at(-1).text, /release/);
  await command(`/unsub ${repo} --to @release_news`);
  const remaining = await db.prepare('SELECT chat_id FROM subscriptions').all();
  assert.deepEqual(remaining.results, [{ chat_id: '123' }]);
  assert.ok(sent.every((m) => m.chat_id === '123'));
});

test('removing a destination cancels all its topics and retries without affecting other destinations', async () => {
  await command(`/sub ${repo} --to -10066 --topic 1`);
  await command(`/sub ${repo} --to -10066 --topic 2`);
  await command(`/sub ${repo} --to @release_news`);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO outbox (id, repo, chat_id, thread_id, text, next_attempt_at, created_at)
    VALUES ('group-pending', ?, '-10066', 1, 'pending', ?, ?)`).bind(repo, now + 600, now).run();
  delete chats['-10066']; // Removal still works after Telegram access is lost.
  await command('/target remove -10066');
  assert.equal((await db.prepare("SELECT status FROM outbox WHERE id = 'group-pending'").first()).status, 'cancelled');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM subscriptions WHERE chat_id = '-10066'").first()).n, 0);
  await github(); await settled();
  assert.deepEqual(sent.filter((m) => m.text.includes('/issues/1)')).map((m) => m.chat_id), ['-10077']);
});

test('a disabled destination overrides legacy allowlists and can be explicitly reconnected', async () => {
  await command(`/sub ${repo}`, { chat: -10099 });
  await command('/target remove -10099');
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO outbox (id, repo, chat_id, text, next_attempt_at, created_at)
    VALUES ('disabled-target', ?, '-10099', 'must not send', 0, ?)`).bind(repo, now).run();
  await mf.dispatchFetch(`https://worker.test/__flush?now=${now}`);
  assert.equal((await db.prepare("SELECT status FROM outbox WHERE id = 'disabled-target'").first()).status, 'cancelled');
  await command(`/sub ${repo} --to -10099`);
  await github(); await settled();
  assert.equal(sent.filter((m) => m.text.includes('/issues/1)')).length, 1);
});

test('private controls remain usable after personal notification target is disabled', async () => {
  await command(`/sub ${repo}`);
  await command('/target remove me');
  assert.match(sent.at(-1).text, /已停用/);
  await command('/targets');
  assert.match(sent.at(-1).text, /停用 个人/);
  await command(`/sub ${repo} --to me`);
  assert.match(sent.at(-1).text, /已订阅/);
});

test('cross-chat controls and target inventory are restricted to private chats', async () => {
  await command('/target add @release_news');
  await command(`/sub ${repo} --to @release_news`, { chat: -10099 });
  assert.match(sent.at(-1).text, /跨聊天管理请在 Bot 私聊/);
  await command('/targets', { chat: -10099 });
  assert.doesNotMatch(sent.at(-1).text, /Release channel/);
  await command(`/sub ${repo} --to 666`);
  assert.match(sent.at(-1).text, /自己的私聊/);
});

test('invalid target options and non-forum topics never create subscriptions', async () => {
  for (const options of ['--to', '--to me --to here', '--topic 0', '--topic -1', '--to me --topic 7', '--to @release_news --topic 7', '--unknown foo']) {
    await command(`/sub ${repo} ${options}`);
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM destinations').first()).n, 0);
});

test('temporary Telegram validation failures return 503 without claiming the update', async () => {
  apiFailure = 429;
  const id = ++updateId;
  assert.equal((await telegram(`/sub ${repo} --to @release_news`, { id })).status, 503);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM receipts').first()).n, 0);
  apiFailure = undefined;
  await command(`/sub ${repo} --to @release_news`, { id });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 1);
});

test('legacy subscriptions keep routing without destination records after the additive migration', async () => {
  await db.prepare('INSERT INTO subscriptions (repo, chat_id, thread_id, events) VALUES (?, ?, 0, ?)').bind(repo, '123', '["issues"]').run();
  await github(); await settled();
  assert.equal(sent.filter((m) => m.text.includes('/issues/1)')).length, 1);
});
