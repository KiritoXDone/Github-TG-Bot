import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { formatEvent } from '../src/format.js';

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
    modules: [
      ...['test/worker.js', ...['index', 'bot', 'delivery', 'format', 'markdown', 'releases', 'security', 'storage', 'targets'].map((name) => `src/${name}.js`)]
        .map((path) => ({ type: 'ESModule', path })),
      // Unbundled workerd resolves the bare import relative to src/markdown.js.
      { type: 'ESModule', path: 'src/marked', contents: await readFile(fileURLToPath(import.meta.resolve('marked')), 'utf8') },
    ],
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
  for (const file of ['0001_init.sql', '0002_destinations.sql', '0003_message_format.sql', '0004_message_parts.sql', '0005_release_states.sql']) {
    const sql = await readFile(`migrations/${file}`, 'utf8');
    for (const statement of sql.split(';').filter((s) => s.trim())) await db.prepare(statement).run();
  }
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch(['subscriptions', 'receipts', 'outbox', 'destinations', 'release_states'].map((table) => db.prepare(`DELETE FROM ${table}`)));
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

async function drain() {
  for (let pass = 0; pass < 20; pass++) {
    const now = Math.floor(Date.now() / 1000);
    await mf.dispatchFetch(`https://worker.test/__flush?now=${now}`);
    if ((await db.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'pending' AND next_attempt_at <= ?").bind(now).first()).n === 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Outbox did not drain');
}

function pushPayload(count = 60) {
  return { repository: { full_name: repo }, sender: { login: 'octocat' }, ref: 'refs/heads/main',
    commits: Array.from({ length: count }, (_, index) => ({
      id: (0x1000000 + index).toString(16).padEnd(40, '0'), message: `commit ${index}: ${'update '.repeat(25)}`,
    })) };
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
  assert.ok(notifications[0].text.includes('[github\\-tg\\-bot\\#1 <b\\>Bug</b\\>]('));
  assert.ok(notifications[0].text.endsWith('\n\nDetails'));
});

test('draft webhooks are acknowledged without queuing; publication renders Markdown through delivery', async () => {
  await command(`/sub ${repo} release --to @release_news`);
  await command(`/sub ${repo} pr`, { chat: -10099 });
  sent = [];
  const release = { draft: true, tag_name: 'v2', body: '## Changes\n\n- **Fix** startup\n- Read [notes](https://example.com/notes)\n\n<details><summary>English</summary>\n\n- **Fix** startup\n- Improve loading\n\n</details>' };
  for (const action of ['created', 'edited', 'deleted']) {
    assert.equal((await github('release', { action, release })).status, 200);
  }
  assert.equal((await github('pull_request', { action: 'opened', pull_request: { number: 2, draft: true } })).status, 200);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM outbox WHERE repo = ?').bind(repo).first()).n, 0);
  assert.equal(sent.length, 0);
  await github('release', { action: 'published', release: { ...release, draft: false } });
  await github('pull_request', { action: 'ready_for_review', pull_request: { number: 2, draft: false, body: '**Ready** for review' } });
  await settled();
  assert.equal(sent.length, 2);
  const channel = sent.find(message => message.chat_id === '-10077');
  assert.equal(channel.parse_mode, 'MarkdownV2');
  assert.ok(channel.text.includes('*Changes*\n\n• *Fix* startup\n• Read [notes](https://example.com/notes)'));
  assert.ok(channel.text.endsWith('**>*English*\n>• *Fix* startup\n>• Improve loading||'));
  assert.ok(sent.find(message => message.chat_id === '-10099').text.endsWith('*Ready* for review'));
});

test('overlapping release actions and distinct delivery IDs announce each publication once', async () => {
  await command(`/sub ${repo} release --to @release_news`);
  sent = [];
  const release = { id: 422499154, tag_name: 'v1.2.55', draft: false, prerelease: false,
    published_at: '2026-10-24T03:50:03Z', body: '**Changes**' };
  for (const action of ['created', 'released', 'prereleased']) {
    assert.equal((await github('release', { action, release })).status, 200);
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM outbox WHERE repo = ?').bind(repo).first()).n, 0);
  const delivery = randomUUID();
  const results = await Promise.all([delivery, delivery, randomUUID(), randomUUID()].map(id =>
    github('release', { action: 'published', release }, id)));
  assert.ok(results.every(result => result.status === 200));
  await settled();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.startsWith('🚀 *New release*'));
  assert.equal((await db.prepare("SELECT count(*) AS n FROM receipts WHERE id LIKE 'release-published:%'").first()).n, 1);
  await github('release', { action: 'edited', release: { ...release, body: '**Updated notes**' } });
  await settled();
  assert.equal(sent.length, 2, 'published release edits remain visible');
  assert.ok(sent[1].text.startsWith('✏️ *Updated release*'));
  await github('release', { action: 'published', release: { ...release, published_at: '2026-10-25T03:50:03Z' } });
  await settled();
  assert.equal(sent.length, 3, 'a later republication is a distinct event');
  await github('release', { action: 'published', release: { ...release, id: 422499155, prerelease: true } });
  await settled();
  assert.equal(sent.length, 4, 'a different release with the same timestamp is distinct');
  assert.ok(sent[3].text.startsWith('🧪 *New pre\\-release*'));
});

test('publication deduplication still respects receipts stored before the upgrade', async () => {
  await command(`/sub ${repo} release --to @release_news`);
  sent = [];
  const delivery = randomUUID();
  const release = { id: 422499154, draft: false, tag_name: 'v1.2.55', published_at: '2026-10-24T03:50:03Z' };
  await db.prepare('INSERT INTO receipts (id, token, created_at) VALUES (?, ?, ?)')
    .bind(`gh:${delivery}`, 'old-worker-token', Math.floor(Date.now() / 1000)).run();
  await github('release', { action: 'published', release }, delivery);
  await settled();
  assert.equal(sent.length, 0, 'an already processed delivery must not be sent again');
  await github('release', { action: 'published', release });
  await settled();
  assert.equal(sent.length, 0, 'the replay also seeds publication deduplication for different IDs');
});

test('release metadata saves are silent and concurrent identical edits notify each destination once', async () => {
  await command(`/sub ${repo} release --to @release_news`);
  await command(`/sub ${repo} release`);
  sent = [];
  const release = { id: 422499154, draft: false, prerelease: false, name: 'Version 2', tag_name: 'v2', body: '**Notes A**',
    published_at: '2026-10-24T03:50:00Z', updated_at: '2026-10-24T03:50:00Z' };
  await github('release', { action: 'published', release }); await settled();
  assert.equal(sent.length, 2);
  for (const extra of [
    { updated_at: '2026-10-24T03:50:01Z' }, { assets: [{ name: 'app.apk', download_count: 100 }] },
    { target_commitish: 'another-commit' }, { body: '\r\n**Notes A**\r\n' },
  ]) {
    await github('release', { action: 'edited', sender: { login: 'another-editor' },
      release: { ...release, ...extra, updated_at: '2026-10-24T03:50:01Z' } });
  }
  await settled();
  assert.equal(sent.length, 2, 'unchanged displayed release content is silent');
  const responses = await Promise.all(Array.from({ length: 8 }, () => github('release', {
    action: 'edited', release: { ...release, body: '**Notes B**', updated_at: '2026-10-24T03:50:02Z' },
  })));
  assert.ok(responses.every(response => response.status === 200));
  await settled();
  assert.equal(sent.length, 4);
  for (const chat of ['123', '-10077']) {
    const updates = sent.filter(message => message.chat_id === chat && message.text.startsWith('✏️ *Updated release*'));
    assert.equal(updates.length, 1);
    assert.ok(updates[0].text.endsWith('*Notes B*'));
  }
});

test('release title, tag, prerelease and body changes notify, including restoring previous content', async () => {
  await command(`/sub ${repo} release --to @release_news`); sent = [];
  const original = { id: 422499154, name: 'Version 2', tag_name: 'v2', body: 'Notes A', prerelease: false };
  let release = { ...original };
  await github('release', { action: 'edited', release }); await settled();
  let expected = 1;
  for (const change of [{ name: 'Version 2 renamed' }, { tag_name: 'v2.0' }, { prerelease: true }, { body: 'Notes B' }, original]) {
    release = { ...release, ...change };
    await github('release', { action: 'edited', release }); await settled();
    assert.equal(sent.length, ++expected);
    await github('release', { action: 'edited', release }); await settled();
    assert.equal(sent.length, expected, 'same content stays silent');
  }
});

test('stale edits and replays cannot reset the release content baseline', async () => {
  await command(`/sub ${repo} release --to @release_news`); sent = [];
  const release = { id: 422499154, tag_name: 'v2', body: 'A', updated_at: '2026-10-24T03:50:00Z' };
  const firstDelivery = randomUUID();
  await github('release', { action: 'edited', release }, firstDelivery); await settled();
  await github('release', { action: 'edited', release: { ...release, body: 'B', updated_at: '2026-10-24T03:50:02Z' } }); await settled();
  assert.equal(sent.length, 2);
  const latest = await db.prepare('SELECT content_hash, claim_token FROM release_states').first();
  await github('release', { action: 'edited', release });
  await github('release', { action: 'edited', release }, firstDelivery);
  await github('release', { action: 'edited', release: { ...release, body: 'B', updated_at: '2026-10-24T03:50:03Z' } });
  // The same content advances the source timestamp, so a delayed different body is ignored.
  await github('release', { action: 'edited', release: { ...release, body: 'C', updated_at: '2026-10-24T03:50:02Z' } });
  await settled();
  assert.equal(sent.length, 2);
  assert.deepEqual(await db.prepare('SELECT content_hash, claim_token FROM release_states').first(), latest);
});

test('a failed edit queue transaction rolls back the baseline and permits a safe retry', async () => {
  await command(`/sub ${repo} release --to @release_news`); sent = [];
  const release = { id: 422499154, tag_name: 'v2', body: 'A' };
  await github('release', { action: 'edited', release }); await settled();
  const before = await db.prepare('SELECT content_hash, claim_token FROM release_states').first();
  const delivery = randomUUID();
  await db.exec("CREATE TRIGGER fail_release_edit BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  try {
    assert.equal((await github('release', { action: 'edited', release: { ...release, body: 'B' } }, delivery)).status, 503);
    assert.deepEqual(await db.prepare('SELECT content_hash, claim_token FROM release_states').first(), before);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM receipts WHERE id = ?').bind(`gh:${delivery}`).first()).n, 0);
  } finally { await db.exec('DROP TRIGGER fail_release_edit'); }
  await github('release', { action: 'edited', release: { ...release, body: 'B' } }, delivery); await settled();
  assert.equal(sent.length, 2);
  assert.ok(sent[1].text.endsWith('\n\nB'));
});

test('large pushes fan out every page, retain topic routing, and deduplicate all pages on replay', async () => {
  await command(`/sub ${repo} commits`);
  await command(`/sub ${repo} commits`, { chat: -10099, thread: 7 });
  await command(`/sub ${repo} release --to @release_news`);
  const payload = pushPayload();
  const expected = formatEvent('push', payload).messages;
  const delivery = randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => github('push', payload, delivery)));
  assert.ok(responses.every(response => response.status === 200));
  await drain();
  for (const chat of ['123', '-10099']) {
    const messages = sent.filter(message => message.parse_mode === 'MarkdownV2' && message.chat_id === chat);
    assert.deepEqual(messages.map(message => message.text), expected);
    assert.ok(messages.every(message => message.text.includes('\n\n**>[') && message.text.endsWith('||')));
    if (chat === '-10099') assert.ok(messages.every(message => message.message_thread_id === 7));
  }
  assert.equal(sent.filter(message => message.chat_id === '-10077').length, 0);
  const rows = await db.prepare('SELECT status, part_index, batch_id FROM outbox WHERE repo = ?').bind(repo).all();
  assert.equal(rows.results.length, expected.length * 2);
  assert.ok(rows.results.every(row => row.status === 'sent'));
  await command(`/sub ${repo} commits --to -10066`);
  await github('push', payload, delivery); await drain();
  assert.equal(sent.filter(message => message.chat_id === '-10066').length, 0);
});

test('a failed multipart insert rolls back all pages and the receipt before a safe redelivery', async () => {
  await command(`/sub ${repo} commits`);
  const delivery = randomUUID();
  const payload = pushPayload();
  await db.prepare("CREATE TRIGGER fail_second_part BEFORE INSERT ON outbox WHEN NEW.part_index = 1 BEGIN SELECT RAISE(ABORT, 'test page insert failure'); END").run();
  try {
    assert.equal((await github('push', payload, delivery)).status, 503);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM outbox WHERE repo = ?').bind(repo).first()).n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM receipts WHERE id = ?').bind(`gh:${delivery}`).first()).n, 0);
  } finally { await db.prepare('DROP TRIGGER fail_second_part').run(); }
  assert.equal((await github('push', payload, delivery)).status, 200);
  await drain();
  assert.deepEqual(sent.filter(message => message.parse_mode).map(message => message.text), formatEvent('push', payload).messages);
});

test('rate-limited pages resume in order without blocking unrelated notifications', async () => {
  await command(`/sub ${repo}`);
  const payload = pushPayload(150);
  const expected = formatEvent('push', payload).messages;
  responses.push({ ok: true, result: { message_id: 1 } }, { ok: false, error_code: 429, parameters: { retry_after: 120 } });
  await github('push', payload);
  await eventually(async () => Boolean(await db.prepare("SELECT id FROM outbox WHERE part_index = 1 AND last_error = 'Telegram error 429'").first()));
  const retry = await db.prepare('SELECT * FROM outbox WHERE repo = ? AND part_index = 1').bind(repo).first();
  assert.ok(retry.next_attempt_at >= retry.created_at + 120);
  const before = sent.length;
  await mf.dispatchFetch(`https://worker.test/__flush?now=${Math.floor(Date.now() / 1000)}`);
  assert.equal(sent.length, before, 'later pages wait for the rate-limited page');
  await github();
  await eventually(() => sent.some(message => message.text.includes('/issues/1)')));
  await db.prepare('UPDATE outbox SET next_attempt_at = 0 WHERE id = ?').bind(retry.id).run();
  await drain();
  const pushes = sent.filter(message => message.text.startsWith('🔨 ')).map(message => message.text);
  assert.deepEqual(pushes, [expected[0], expected[1], ...expected.slice(1)]);
  assert.equal((await db.prepare('SELECT status FROM outbox WHERE id = ?').bind(retry.id).first()).status, 'sent');
});

test('permanent page failures pause the remaining pages until /retry', async () => {
  await command(`/sub ${repo}`);
  const payload = pushPayload(30);
  const expected = formatEvent('push', payload).messages;
  responses.push({ ok: true, result: { message_id: 1 } }, { ok: false, error_code: 403 });
  await github('push', payload);
  await eventually(async () => Boolean(await db.prepare("SELECT id FROM outbox WHERE status = 'failed' AND part_index = 1").first()));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM outbox WHERE repo = ? AND part_index > 1 AND attempts > 0').bind(repo).first()).n, 0);
  await command('/retry');
  await drain();
  assert.deepEqual(sent.filter(message => message.text.startsWith('🔨 ')).map(message => message.text), [expected[0], expected[1], ...expected.slice(1)]);
});

test('a burst of forty independent pushes drains without dropping or duplicating commits', async () => {
  await command(`/sub ${repo} commits`);
  const payloads = pushPayload(40).commits.map(commit => ({ ref: 'refs/heads/main', commits: [commit] }));
  const results = await Promise.all(payloads.map(payload => github('push', payload)));
  assert.ok(results.every(result => result.status === 200));
  await drain();
  const messages = sent.filter(message => message.text.startsWith('🔨 '));
  assert.equal(messages.length, 40);
  const ids = messages.flatMap(message => [...message.text.matchAll(/\/commit\/([a-f\d]{40})\)/g)].map(match => match[1])).sort();
  assert.deepEqual(ids, payloads.map(payload => payload.commits[0].id).sort());
});

test('cleanup retains a failed page needed by pending later pages instead of silently skipping it', async () => {
  const time = new Date();
  time.setUTCHours(3, 0, 0, 0);
  const old = Math.floor(time.getTime() / 1000) - 31 * 86400;
  await db.prepare(`INSERT INTO outbox (id, chat_id, text, status, batch_id, part_index, next_attempt_at, created_at, finished_at) VALUES
    ('blocked-head', '123', 'First page', 'failed', 'old-push', 0, 0, ?, ?),
    ('blocked-tail', '123', 'Second page', 'pending', 'old-push', 1, 0, ?, NULL),
    ('unrelated-old', '123', 'Old failure', 'failed', NULL, 0, 0, ?, ?)`)
    .bind(old, old, old, old, old).run();
  await mf.dispatchFetch(`https://worker.test/__scheduled?time=${time.getTime()}`);
  assert.equal((await db.prepare("SELECT status FROM outbox WHERE id = 'blocked-head'").first()).status, 'failed');
  assert.equal((await db.prepare("SELECT attempts FROM outbox WHERE id = 'blocked-tail'").first()).attempts, 0);
  assert.equal(await db.prepare("SELECT id FROM outbox WHERE id = 'unrelated-old'").first(), null);
  assert.equal(sent.length, 0);
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
