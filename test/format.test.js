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
  assert.match(event.text, /merged/);
});

test('limits large push and release messages, preserves links, and leaves markup as plain text', () => {
  const push = formatEvent('push', payload({ ref: 'refs/heads/main', forced: true, commits: Array.from({ length: 20 }, () => ({ id: 'abcdef123', message: 'new commit' })) }));
  assert.match(push.text, /另有 12/);
  assert.match(push.text, /Force push/);
  const release = formatEvent('release', payload({ action: 'published', release: { name: '<b>1.0</b>', body: '🧑'.repeat(5000), html_url: `${repository.html_url}/releases/tag/v1` } }));
  assert.ok(release.text.length < 4096);
  assert.match(release.text, /<b>1.0<\/b>/);
  assert.ok(release.text.endsWith('/releases/tag/v1'));
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
