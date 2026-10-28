import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const repo = 'kiritoxdone/github-tg-bot';
const secret = 'activity-test-secret';
const timestamp = seconds => new Date(Date.UTC(2026, 9, 28, 0, 0, seconds)).toISOString();
const issue = { id: 1, number: 7, title: 'Fix startup', body: 'Full description', state: 'open', updated_at: timestamp(0) };
const pr = { ...issue, head: { sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: repo } } };
const cases = [
  ['issues', 'issue', issue, 'opened'],
  ['pull_request', 'pull_request', pr, 'opened'],
  ...['issue_comment', 'commit_comment', 'pull_request_review_comment'].map(event =>
    [event, 'comment', { id: 1, body: 'Looks good', updated_at: timestamp(0) }, 'created']),
  ['pull_request_review', 'review', { id: 1, body: 'Review notes', state: 'approved' }, 'submitted'],
];
let mf;
let db;
let sent = [];

before(async () => {
  const bundled = await build({ entryPoints: ['test/worker.js'], bundle: true, write: false, format: 'esm', target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: [{ type: 'ESModule', path: 'test/worker.js', contents: bundled.outputFiles[0].text }],
    compatibilityDate: '2026-10-01', d1Databases: ['DB'],
    bindings: { TELEGRAM_BOT_TOKEN: '999:TEST_ONLY', TELEGRAM_WEBHOOK_SECRET: 'telegram-test-secret',
      GITHUB_WEBHOOK_SECRET: secret, ALLOWED_USER_IDS: '123', ALLOWED_CHAT_IDS: '123,-10099', BOT_USERNAME: 'test_bot' },
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      assert.ok(new URL(request.url).pathname.endsWith('/sendMessage'));
      sent.push(await request.json());
      return Response.json({ ok: true, result: { message_id: sent.length } });
    },
  }));
  db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(`migrations/${file}`, 'utf8')).split(';').filter(sql => sql.trim())) {
      await db.prepare(sql).run();
    }
  }
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch(['outbox', 'receipts', 'activity_states', 'subscriptions'].map(table => db.prepare(`DELETE FROM ${table}`)));
  for (const [chat, thread] of [['123', 0], ['-10099', 7]]) {
    await db.prepare('INSERT INTO subscriptions (repo, chat_id, thread_id, events) VALUES (?, ?, ?, ?)')
      .bind(repo, chat, thread, '["issues","pr","comments","reviews"]').run();
  }
  sent = [];
});

function github(event, payload, delivery = randomUUID()) {
  const body = JSON.stringify({ repository: { full_name: repo }, sender: { login: 'octocat' }, pull_request: pr, ...payload });
  return mf.dispatchFetch('https://worker.test/webhooks/github', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
}

async function settled() {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await db.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'pending'").first()).n === 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for test deliveries');
}

async function send(event, payload, delivery) {
  const response = await github(event, payload, delivery);
  assert.equal(response.status, 200, await response.text());
  await settled();
}

test('labels never enqueue notifications, even without a baseline', async () => {
  for (const event of ['issues', 'pull_request']) {
    for (const action of ['labeled', 'unlabeled']) {
      await send(event, { action, issue, label: { name: 'bug' } });
    }
  }
  assert.equal(sent.length, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM outbox').first()).n, 0);
});

for (const [event, field, value, creation] of cases) {
  test(`${event}: duplicate creations and unchanged edits notify once per destination`, async () => {
    await send(event, { action: creation, [field]: value });
    await send(event, { action: creation, [field]: value, sender: { login: 'someone-else' } });
    await send(event, { action: 'edited', [field]: { ...value, updated_at: timestamp(1),
      labels: [{ name: 'bug' }], reactions: { total_count: 10 } }, changes: {} });
    await send(event, { action: 'edited', [field]: { ...value, body: `\r\n${value.body}\r\n`, updated_at: timestamp(2) } });
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map(message => message.chat_id).sort(), ['-10099', '123']);
    assert.equal(sent.find(message => message.chat_id === '-10099').message_thread_id, 7);
  });

  test(`${event}: real edits and restoration of earlier content still notify`, async () => {
    await send(event, { action: creation, [field]: value });
    const edited = { ...value, body: `${value.body}\nUpdated`, updated_at: timestamp(1) };
    // Even a sparse changes object cannot hide a difference from our baseline.
    await send(event, { action: 'edited', [field]: edited, changes: {} });
    await send(event, { action: 'edited', [field]: edited });
    await send(event, { action: 'edited', [field]: { ...value, updated_at: timestamp(2) } });
    assert.equal(sent.length, 6);
  });

  test(`${event}: first no-op edit seeds a silent baseline`, async () => {
    await send(event, { action: 'edited', [field]: value, changes: {} });
    await send(event, { action: 'edited', [field]: value });
    assert.equal(sent.length, 0);
    await send(event, { action: 'edited', [field]: { ...value, body: 'Actual change', updated_at: timestamp(1) },
      changes: { body: { from: value.body } } });
    assert.equal(sent.length, 2);
  });
}

test('first edit compares before-values and preserves legacy missing-changes behavior', async () => {
  for (const changes of [{ body: { from: '\r\nFull description\r\n' } }, { labels: { from: [] } }, { title: { from: ' Fix   startup ' } }]) {
    await send('issues', { action: 'edited', issue, changes });
  }
  assert.equal(sent.length, 0);
  await send('issues', { action: 'edited', issue: { ...issue, id: 2 }, changes: { body: { from: 'Old description' } } });
  await send('issues', { action: 'edited', issue: { ...issue, id: 3 } });
  assert.equal(sent.length, 4);
});

test('PR synchronizations compare head SHA while edits compare title, body and target branch', async () => {
  await send('pull_request', { action: 'opened' });
  await send('pull_request', { action: 'synchronize', before: pr.head.sha, after: pr.head.sha });
  await send('pull_request', { action: 'edited', pull_request: { ...pr, base: { ...pr.base, sha: 'c'.repeat(40) } }, changes: {} });
  assert.equal(sent.length, 2, 'base branch movement is metadata');
  const updated = { ...pr, head: { sha: 'd'.repeat(40) }, updated_at: timestamp(1) };
  await send('pull_request', { action: 'synchronize', pull_request: updated, before: pr.head.sha, after: updated.head.sha });
  await send('pull_request', { action: 'synchronize', pull_request: updated });
  await send('pull_request', { action: 'edited', pull_request: updated, changes: {} });
  assert.equal(sent.length, 4);
  const retargeted = { ...updated, base: { ...pr.base, ref: 'stable' }, updated_at: timestamp(2) };
  await send('pull_request', { action: 'edited', pull_request: retargeted, changes: { base: { ref: { from: 'main' } } } });
  await send('pull_request', { action: 'edited', pull_request: { ...retargeted, title: 'New title', updated_at: timestamp(3) } });
  assert.equal(sent.length, 8);
});

test('initial synchronization with unchanged SHA is silent; initial retargeting is meaningful', async () => {
  await send('pull_request', { action: 'synchronize', before: pr.head.sha, after: pr.head.sha });
  assert.equal(sent.length, 0);
  await send('pull_request', { action: 'edited', pull_request: { ...pr, id: 2, base: { ...pr.base, ref: 'stable' } },
    changes: { base: { ref: { from: 'main' } } } });
  assert.equal(sent.length, 2);
});

test('PR edits and commit synchronizations keep independent baselines and timestamps', async () => {
  await send('pull_request', { action: 'opened' });
  const committed = { ...pr, head: { sha: 'd'.repeat(40) }, updated_at: timestamp(1) };
  await send('pull_request', { action: 'edited', pull_request: { ...committed, updated_at: timestamp(2) }, changes: {} });
  assert.equal(sent.length, 2, 'an empty edit stays silent even if its snapshot contains an unseen commit');
  await send('pull_request', { action: 'synchronize', pull_request: committed });
  assert.equal(sent.length, 4, 'the later-arriving commit notification is still delivered');
  const edited = { ...committed, title: 'Actual title change', updated_at: timestamp(3) };
  await send('pull_request', { action: 'synchronize', pull_request: { ...edited, updated_at: timestamp(4) } });
  assert.equal(sent.length, 4, 'an unchanged head stays silent even if its snapshot contains an unseen edit');
  await send('pull_request', { action: 'edited', pull_request: edited });
  assert.equal(sent.length, 6);
});

test('legacy missing object IDs and missing head SHAs retain delivery-ID fallback', async () => {
  const delivery = randomUUID();
  await send('issues', { action: 'edited', issue: { ...issue, id: undefined } }, delivery);
  await send('issues', { action: 'edited', issue: { ...issue, id: undefined } }, delivery);
  await send('pull_request', { action: 'synchronize', pull_request: { ...pr, head: undefined } });
  assert.equal(sent.length, 4);
});

test('incidental snapshots in other actions do not consume an unseen edit or commit', async () => {
  await send('pull_request', { action: 'opened' });
  const updated = { ...pr, title: 'Changed title', head: { sha: 'd'.repeat(40) }, updated_at: timestamp(1) };
  await send('pull_request', { action: 'assigned', pull_request: { ...updated, updated_at: timestamp(2) } });
  await send('pull_request', { action: 'edited', pull_request: updated });
  await send('pull_request', { action: 'synchronize', pull_request: updated });
  assert.equal(sent.length, 8);
});

test('lifecycle actions stay visible even when content is unchanged', async () => {
  for (const action of ['opened', 'closed', 'reopened', 'closed']) await send('issues', { action, issue });
  for (const action of ['opened', 'closed', 'reopened', 'ready_for_review']) await send('pull_request', { action });
  for (const action of ['submitted', 'dismissed']) await send('pull_request_review', { action, review: { id: 99, body: 'Fine', state: 'approved' } });
  for (const action of ['created', 'deleted']) await send('issue_comment', { action, issue, comment: { id: 99, body: 'Fine' } });
  assert.equal(sent.length, 24);
  await send('issues', { action: 'edited', issue, changes: {} });
  assert.equal(sent.length, 24);
});

test('concurrent duplicates with distinct delivery IDs claim one edit for every destination', async () => {
  await send('issues', { action: 'opened', issue });
  const payload = { action: 'edited', issue: { ...issue, title: 'Changed title', updated_at: timestamp(1) } };
  const sameDelivery = randomUUID();
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => github('issues', payload, index < 4 ? sameDelivery : randomUUID())));
  assert.ok(responses.every(response => response.status === 200));
  await settled();
  assert.equal(sent.length, 4);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM outbox').first()).n, 4);
});

test('old events and replayed creation receipts cannot roll the content baseline back', async () => {
  const creation = randomUUID();
  await send('issues', { action: 'opened', issue }, creation);
  const latest = { ...issue, body: 'Latest description', updated_at: timestamp(2) };
  await send('issues', { action: 'edited', issue: latest });
  const baseline = await db.prepare('SELECT * FROM activity_states').first();
  await send('issues', { action: 'edited', issue: { ...issue, updated_at: timestamp(1) } });
  await send('issues', { action: 'opened', issue: { ...issue, updated_at: timestamp(3) } }, creation);
  await send('issues', { action: 'opened', issue: { ...issue, updated_at: timestamp(3) } });
  assert.deepEqual(await db.prepare('SELECT * FROM activity_states').first(), baseline);
  await send('issues', { action: 'edited', issue: latest });
  assert.equal(sent.length, 4);
});

test('first no-op edit arriving before creation does not swallow the creation notification', async () => {
  await send('issues', { action: 'edited', issue, changes: {} });
  await send('issues', { action: 'opened', issue });
  await send('issues', { action: 'opened', issue });
  assert.equal(sent.length, 2);
});

test('missing source timestamps use arrival order without erasing the last known source clock', async () => {
  await send('issues', { action: 'opened', issue: { ...issue, updated_at: timestamp(2) } });
  const edited = { ...issue, body: 'Untimed update', updated_at: undefined };
  await send('issues', { action: 'edited', issue: edited });
  await send('issues', { action: 'edited', issue: edited });
  await send('issues', { action: 'edited', issue: { ...issue, updated_at: timestamp(1) } });
  assert.equal(sent.length, 4);
  assert.equal((await db.prepare('SELECT source_updated_at FROM activity_states').first()).source_updated_at, Date.parse(timestamp(2)));
});

test('deduplication separates repositories, objects and event types, and compares untruncated bodies', async () => {
  await db.prepare("INSERT INTO subscriptions (repo, chat_id, thread_id, events) VALUES ('other/repo', '123', 0, '[\"issues\"]')").run();
  await send('issues', { action: 'opened', issue });
  await send('issues', { action: 'opened', issue: { ...issue, id: 2 } });
  await send('issues', { action: 'opened', issue, repository: { full_name: 'other/repo' } });
  await send('pull_request', { action: 'opened' });
  const long = { ...issue, body: 'x'.repeat(5000), updated_at: timestamp(1) };
  await send('issues', { action: 'edited', issue: long });
  await send('issues', { action: 'edited', issue: { ...long, body: `${long.body}changed`, updated_at: timestamp(2) } });
  assert.equal(sent.length, 11);
});

test('a failed transaction rolls back both fingerprints and receipts before a retry', async () => {
  await db.prepare("CREATE TRIGGER fail_activity_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test storage failure'); END").run();
  const delivery = randomUUID();
  try {
    assert.equal((await github('issues', { action: 'opened', issue }, delivery)).status, 503);
    for (const table of ['activity_states', 'outbox', 'receipts']) {
      assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n, 0);
    }
  } finally { await db.prepare('DROP TRIGGER fail_activity_outbox').run(); }
  await send('issues', { action: 'opened', issue }, delivery);
  await send('issues', { action: 'edited', issue });
  assert.equal(sent.length, 2);
});

test('daily cleanup removes only inactive activity fingerprints', async () => {
  await send('issues', { action: 'opened', issue });
  await send('issues', { action: 'opened', issue: { ...issue, id: 2 } });
  const now = new Date();
  now.setUTCHours(3, 0, 0, 0);
  const old = Math.floor(now.getTime() / 1000) - 31 * 86400;
  await db.prepare("UPDATE activity_states SET seen_at = ? WHERE object_key = 'issues:1:content'").bind(old).run();
  assert.equal((await mf.dispatchFetch(`https://worker.test/__scheduled?time=${now.getTime()}`)).status, 200);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM activity_states').first()).n, 1);
  assert.equal((await db.prepare('SELECT object_key FROM activity_states').first()).object_key, 'issues:2:content');
});
