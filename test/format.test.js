import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEvent, repoName } from '../src/format.js';
import { validGitHubSignature } from '../src/security.js';

const repository = { full_name: 'KiritoXDone/Github-TG-Bot', html_url: 'https://github.com/KiritoXDone/Github-TG-Bot' };
const sender = { login: 'octocat' };
const payload = (extra) => ({ repository, sender, ...extra });

test('verifies the official GitHub HMAC test vector', async () => {
  const body = new TextEncoder().encode('Hello, World!');
  assert.equal(await validGitHubSignature("It's a Secret to Everybody", body,
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'), true);
  assert.equal(await validGitHubSignature('wrong', body,
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'), false);
  assert.equal(await validGitHubSignature('x', body, 'sha256=bad'), false);
});

test('normalizes repository names and rejects URLs or SQL-shaped input', () => {
  assert.equal(repoName('KiritoXDone/Github-TG-Bot'), 'kiritoxdone/github-tg-bot');
  for (const name of ['https://github.com/a/b', "a/b'; DROP TABLE x;", 'a/b/c', '', null]) assert.equal(repoName(name), null);
});

test('distinguishes merged PRs from closed PRs', () => {
  const event = formatEvent('pull_request', payload({ action: 'closed', pull_request: { number: 7, title: 'Feature', merged: true } }));
  assert.equal(event.category, 'pr');
  assert.match(event.messages[0], /merged/);
});

test('limits large push and release messages without cutting inline links or Markdown entities', () => {
  const push = formatEvent('push', payload({ ref: 'refs/heads/main', forced: true, commits: Array.from({ length: 20 }, () => ({ id: 'abcdef123', message: 'new commit' })) }));
  assert.equal(push.messages.join('\n').match(/• /g).length, 20);
  assert.ok(push.messages.every(message => message.length <= 3900));
  assert.doesNotMatch(push.messages.join('\n'), /另有/);
  assert.match(push.messages[0], /Force push/);
  const release = formatEvent('release', payload({ action: 'published', release: { name: '<b>1.0</b>', body: '🧑'.repeat(5000), html_url: `${repository.html_url}/releases/tag/v1` } }));
  assert.ok(release.messages[0].length < 4096);
  assert.ok(release.messages[0].includes('*[<b\\>1\\.0</b\\>](https://github.com/KiritoXDone/Github-TG-Bot/releases/tag/v1)*'));
  assert.ok(release.messages[0].endsWith('…'));
  assert.equal(release.parse_mode, 'MarkdownV2');
  assert.ok(release.messages[0].isWellFormed());
});

test('release layout uses one linked title without repeating its version or adding a standalone URL', () => {
  const release = formatEvent('release', payload({ action: 'published', release: {
    tag_name: 'v1.2.3', name: 'Spring update v1.2.3', body: 'Fix startup\nImprove performance',
    html_url: `${repository.html_url}/releases/tag/v1.2.3`,
  } }));
  assert.equal(release.messages[0], [
    '*[KiritoXDone/Github\\-TG\\-Bot](https://github.com/kiritoxdone/github-tg-bot)*',
    '🚀 *Release* · 已发布 · [octocat](https://github.com/octocat)',
    '',
    '*[Spring update v1\\.2\\.3](https://github.com/KiritoXDone/Github-TG-Bot/releases/tag/v1.2.3)*',
    '', '>Fix startup', '>Improve performance',
  ].join('\n'));
  assert.doesNotMatch(release.messages[0], /^https?:/m);
});

test('push links the branch to its comparison and each short hash to its commit', () => {
  const push = formatEvent('push', payload({ ref: 'refs/heads/feature_v2',
    compare: `${repository.html_url}/compare/abc...def`,
    commits: [{ id: 'abcdef123456', message: 'fix: handle [brackets] & *stars*\nLong explanation', url: `${repository.html_url}/commit/abcdef123456` }],
  }));
  assert.ok(push.messages[0].includes('[feature\\_v2](https://github.com/KiritoXDone/Github-TG-Bot/compare/abc...def)'));
  assert.ok(push.messages[0].includes('• [abcdef1](https://github.com/KiritoXDone/Github-TG-Bot/commit/abcdef123456) fix: handle \\[brackets\\] & \\*stars\\*'));
  assert.doesNotMatch(push.messages[0], /Long explanation|^https?:/m);
});

test('escapes untrusted Markdown and URL parentheses without allowing injected formatting', () => {
  const event = formatEvent('issues', payload({ action: 'opened', issue: { number: 1,
    title: '*boom* [click](https://evil.example)',
    body: '_ * [ ] ( ) ~ ` > # + - = | { } . ! \\',
    html_url: 'https://github.com/a/b/issues/1?label=(bug)',
  } }));
  assert.ok(event.messages[0].includes('\n🎫 *[Issue \\#1](https://github.com/a/b/issues/1?label=(bug\\))*'));
  assert.ok(event.messages[0].includes('*\\*boom\\* \\[click\\]\\(https://evil\\.example\\)*'));
  assert.ok(event.messages[0].endsWith('>\\_ \\* \\[ \\] \\( \\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\! \\\\'));
  for (const target of ['javascript:alert(1)', 'https://evil.example/x', 'https://github.com@evil.example/x', 'https://user:pass@github.com/a/b', `https://github.com/${'a'.repeat(700)}`]) {
    const result = formatEvent('release', payload({ release: { tag_name: 'v1', html_url: target } }));
    assert.ok(result.messages[0].includes('*[v1](https://github.com/kiritoxdone/github-tg-bot/releases)*'));
  }
});

test('bounds punctuation-heavy text, many quoted lines and long commit links', () => {
  const fixtures = [
    ['release', { release: { tag_name: '*'.repeat(180), name: '!'.repeat(250), body: '#\n'.repeat(5000) } }],
    ['issues', { issue: { number: 1, title: '*'.repeat(250), body: '*'.repeat(5000) } }],
    ['push', { ref: '*'.repeat(180), compare: `https://github.com/${'x'.repeat(550)}`, commits: Array.from({ length: 20 }, (_, i) => ({ id: `abcdef${i}1234`, message: '*'.repeat(180), url: `https://github.com/${'x'.repeat(550)}` })) }],
  ];
  for (const [type, data] of fixtures) {
    const result = formatEvent(type, payload(data));
    for (const message of result.messages) {
      assert.ok(message.length <= 3900, `${type}: ${message.length}`);
      assert.ok(message.isWellFormed());
      assert.doesNotMatch(message, /^https?:/m);
    }
  }
});

test('paginates every commit in order, including large webhook arrays, without cutting links', () => {
  for (const count of [0, 1, 50, 2048]) {
    const commits = Array.from({ length: count }, (_, index) => ({
      id: (0x1000000 + index).toString(16).padEnd(40, '0'),
      message: `change ${index}: 🧑 ${'*_[brackets]'.repeat(12)}`,
    }));
    const result = formatEvent('push', payload({ ref: 'refs/heads/main', commits }));
    assert.ok(result.messages.length > 0);
    if (count >= 50) assert.ok(result.messages.length > 1);
    for (const [index, message] of result.messages.entries()) {
      assert.ok(message.length <= 3900);
      assert.ok(message.isWellFormed());
      assert.ok(message.startsWith('*[KiritoXDone/Github\\-TG\\-Bot]('));
      if (result.messages.length > 1) assert.ok(message.includes(`第 ${index + 1}/${result.messages.length} 页 · 共 ${count} 个提交`));
    }
    const text = result.messages.join('\n');
    const ids = [...text.matchAll(/\/commit\/([a-f\d]{40})\)/g)].map(match => match[1]);
    assert.deepEqual(ids, commits.map(commit => commit.id));
    assert.doesNotMatch(text, /另有/);
  }
});

test('covers comments, reviews, completed workflows, stars and forks', () => {
  const fixtures = [
    ['issue_comment', { comment: { body: 'hi' }, issue: { title: 'bug' } }, 'comments'],
    ['commit_comment', { comment: { body: 'hi' } }, 'comments'],
    ['pull_request_review_comment', { comment: { body: 'hi' } }, 'comments'],
    ['pull_request_review', { review: { state: 'approved' }, pull_request: { number: 3 } }, 'reviews'],
    ['workflow_run', { action: 'completed', workflow_run: { conclusion: 'success' } }, 'actions'],
    ['star', { action: 'created' }, 'stars'],
    ['fork', {}, 'forks'],
  ];
  for (const [type, data, category] of fixtures) assert.equal(formatEvent(type, payload(data)).category, category);
  assert.equal(formatEvent('workflow_run', payload({ action: 'requested', workflow_run: {} })), null);
  assert.equal(formatEvent('unknown', payload({})), null);
  assert.equal(formatEvent('issues', { repository: { full_name: 'bad' } }), null);
});
