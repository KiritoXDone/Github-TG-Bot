import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const repo = 'kiritoxdone/c001apk';
const secret = 'release-ordering-test-secret';
// Same release identity and timestamps as the v1.4.3 publication, with synthetic notes.
const release = { id: 425076956, name: 'v1.4.3', tag_name: 'v1.4.3', body: 'Release notes',
  draft: false, prerelease: false, published_at: '2026-10-27T05:48:32Z', updated_at: '2026-10-27T05:48:32Z' };
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
  for (const file of ['0001_init.sql', '0002_destinations.sql', '0003_message_format.sql', '0004_message_parts.sql', '0005_release_states.sql', '0006_activity_states.sql']) {
    for (const sql of (await readFile(`migrations/${file}`, 'utf8')).split(';').filter(s => s.trim())) {
      await db.prepare(sql).run();
    }
  }
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch(['outbox', 'receipts', 'release_states', 'subscriptions'].map(table => db.prepare(`DELETE FROM ${table}`)));
  for (const chat of ['123', '-10099']) {
    await db.prepare('INSERT INTO subscriptions (repo, chat_id, thread_id, events) VALUES (?, ?, 0, ?)')
      .bind(repo, chat, '["release"]').run();
  }
  sent = [];
});

function github(action, value = release, changes = {}, delivery = randomUUID()) {
  const body = JSON.stringify({ repository: { full_name: repo }, sender: { login: 'octocat' }, action,
    release: value, ...(action === 'edited' ? { changes } : {}) });
  return mf.dispatchFetch('https://worker.test/webhooks/github', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'release', 'X-GitHub-Delivery': delivery,
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

for (const order of ['edit-first', 'publish-first', 'concurrent']) {
  test(`publication metadata edits notify once per destination: ${order}`, async () => {
    const editId = randomUUID();
    const publishId = randomUUID();
    const edit = () => github('edited', release, {}, editId);
    const publish = () => github('published', release, {}, publishId);
    if (order === 'concurrent') {
      assert.ok((await Promise.all([edit(), publish(), edit(), publish()])).every(r => r.status === 200));
    } else {
      for (const call of order === 'edit-first' ? [edit, publish] : [publish, edit]) {
        assert.equal((await call()).status, 200);
        await settled();
      }
    }
    // Both redelivery of the same request and duplicates with new delivery IDs stay silent.
    assert.ok((await Promise.all([edit(), publish(), github('edited'), github('published'),
      github('created'), github('released'), github('prereleased')])).every(r => r.status === 200));
    await settled();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map(m => m.chat_id).sort(), ['-10099', '123']);
    assert.ok(sent.every(m => m.text.startsWith('🚀 *New release*')));
    assert.equal((await db.prepare("SELECT count(*) AS n FROM receipts WHERE id LIKE 'release-published:%'").first()).n, 1);
  });
}

test('an initial metadata edit records a silent baseline even if publication is delayed', async () => {
  assert.equal((await github('edited')).status, 200);
  await settled();
  assert.equal(sent.length, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_states').first()).n, 1);
  assert.equal((await github('edited', { ...release, updated_at: '2026-10-27T06:00:00Z' },
    { assets: { from: [] } })).status, 200);
  await settled();
  assert.equal(sent.length, 0);
  assert.equal((await github('published')).status, 200);
  await settled();
  assert.equal(sent.length, 2);
});

test('first edits with explicit content changes are still announced without a stored baseline', async () => {
  const changes = [{ name: 'Renamed' }, { tag_name: 'v1.4.4' }, { body: 'New release notes' }, { prerelease: true }];
  for (const [index, fields] of changes.entries()) {
    const field = Object.keys(fields)[0];
    const value = { ...release, ...fields, id: release.id + index };
    assert.equal((await github('edited', value, { [field]: { from: release[field] } })).status, 200);
    await settled();
    assert.equal(sent.length, (index + 1) * 2);
  }
  assert.ok(sent.every(m => m.text.startsWith('✏️ *Updated')));
});

test('formatting-only changes on a first edit do not count as new release content', async () => {
  assert.equal((await github('edited', release, { name: { from: '  v1.4.3  ' },
    body: { from: '\r\nRelease notes\r\n' }, tag_name: { from: 'v1.4.3' } })).status, 200);
  await settled();
  assert.equal(sent.length, 0);
});

test('a stored baseline still detects real changes when changes metadata is empty', async () => {
  const firstId = randomUUID();
  assert.equal((await github('edited', release, {}, firstId)).status, 200);
  await settled();
  assert.equal(sent.length, 0);
  let value = release;
  for (const [index, fields] of [{ body: 'New notes' }, { name: 'Renamed' }, { tag_name: 'v1.4.4' }, { prerelease: true }].entries()) {
    value = { ...value, ...fields, updated_at: `2026-10-27T05:48:${33 + index}Z` };
    assert.equal((await github('edited', value)).status, 200);
    await settled();
    assert.equal(sent.length, (index + 1) * 2);
    assert.equal((await github('edited', value)).status, 200);
  }
  const latest = await db.prepare('SELECT content_hash, claim_token FROM release_states').first();
  await github('edited', release, {}, firstId);
  await github('edited', release);
  await settled();
  assert.equal(sent.length, 8);
  assert.deepEqual(await db.prepare('SELECT content_hash, claim_token FROM release_states').first(), latest);
});

test('publication queue failure rolls back receipts and allows one retry after a silent edit', async () => {
  assert.equal((await github('edited')).status, 200);
  await settled();
  assert.equal(sent.length, 0);
  const delivery = randomUUID();
  await db.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  try {
    assert.equal((await github('published', release, {}, delivery)).status, 503);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM receipts WHERE id = ?').bind(`gh:${delivery}`).first()).n, 0);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM receipts WHERE id LIKE 'release-published:%'").first()).n, 0);
  } finally {
    await db.exec('DROP TRIGGER fail_publication');
  }
  assert.equal((await github('published', release, {}, delivery)).status, 200);
  await settled();
  assert.equal(sent.length, 2);
  assert.ok(sent.every(m => m.text.startsWith('🚀 *New release*')));
});
