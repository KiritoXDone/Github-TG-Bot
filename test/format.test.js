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
  assert.match(event.messages[0], /🔀 \*Merged pull request\*/);
  const closed = formatEvent('pull_request', payload({ action: 'closed', pull_request: { number: 7, title: 'Feature', merged: false } }));
  assert.match(closed.messages[0], /🚫 \*Closed pull request\*/);
});

test('limits large push and release messages without cutting inline links or Markdown entities', () => {
  const push = formatEvent('push', payload({ ref: 'refs/heads/main', forced: true, commits: Array.from({ length: 20 }, () => ({ id: 'abcdef123', message: 'new commit' })) }));
  assert.equal(push.messages.join('\n').match(/\[abcdef1\]/g).length, 20);
  assert.ok(push.messages.every(message => message.length <= 3900));
  assert.doesNotMatch(push.messages.join('\n'), /另有/);
  assert.match(push.messages[0], /Forced push/);
  const release = formatEvent('release', payload({ action: 'published', release: { name: '<b>1.0</b>', body: '🧑'.repeat(5000), html_url: `${repository.html_url}/releases/tag/v1` } }));
  assert.ok(release.messages[0].length < 4096);
  assert.ok(release.messages[0].includes('[Github\\-TG\\-Bot <b\\>1\\.0</b\\>](https://github.com/KiritoXDone/Github-TG-Bot/releases/tag/v1)'));
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
    '🚀 *New release* [Github\\-TG\\-Bot Spring update v1\\.2\\.3](https://github.com/KiritoXDone/Github-TG-Bot/releases/tag/v1.2.3)',
    'by [@octocat](https://github.com/octocat)',
    '', 'Fix startup', 'Improve performance',
  ].join('\n'));
  assert.doesNotMatch(release.messages[0], /^https?:/m);
  for (const name of ['Miaopu 2.3.3', '2.3.3', '']) {
    const text = formatEvent('release', payload({ repository: { full_name: 'KiritoXDone/Miaopu' },
      action: 'published', release: { name, tag_name: '2.3.3' } })).messages[0];
    assert.ok(text.startsWith('🚀 *New release* [Miaopu 2\\.3\\.3]('));
  }
});

test('push links its count to the comparison and includes each commit author, not the pusher', () => {
  const push = formatEvent('push', payload({ ref: 'refs/heads/feature_v2',
    compare: `${repository.html_url}/compare/abc...def`,
    commits: [{ id: 'abcdef123456', message: 'fix: handle [brackets] & *stars*\nLong explanation', url: `${repository.html_url}/commit/abcdef123456`, author: { name: 'Timeline', username: 'TimelineDev' } }],
  }));
  assert.equal(push.messages[0], [
    '🔨 [1 new commit](https://github.com/KiritoXDone/Github-TG-Bot/compare/abc...def) to *Github\\-TG\\-Bot:feature\\_v2*:',
    '',
    '[abcdef1](https://github.com/KiritoXDone/Github-TG-Bot/commit/abcdef123456): fix: handle \\[brackets\\] & \\*stars\\* by [Timeline](https://github.com/TimelineDev)',
  ].join('\n'));
  assert.doesNotMatch(push.messages[0], /octocat|Long explanation|^https?:/m);
});

test('escapes literal title characters and body punctuation while preserving URL parentheses', () => {
  const event = formatEvent('issues', payload({ action: 'opened', issue: { number: 1,
    title: '*boom* [click](https://evil.example)',
    body: '_ * [ ] ( ) ~ ` > # + - = | { } . ! \\',
    html_url: 'https://github.com/a/b/issues/1?label=(bug)',
  } }));
  assert.ok(event.messages[0].startsWith('🐛 *New issue* [Github\\-TG\\-Bot\\#1 '));
  assert.ok(event.messages[0].includes('\\*boom\\* \\[click\\]\\(https://evil\\.example\\)](https://github.com/a/b/issues/1?label=(bug\\))'));
  assert.ok(event.messages[0].endsWith('\\_ \\* \\[ \\] \\( \\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\! \\\\'));
  for (const target of ['javascript:alert(1)', 'https://evil.example/x', 'https://github.com@evil.example/x', 'https://user:pass@github.com/a/b', `https://github.com/${'a'.repeat(700)}`]) {
    const result = formatEvent('release', payload({ release: { tag_name: 'v1', html_url: target } }));
    assert.ok(result.messages[0].includes('[Github\\-TG\\-Bot v1](https://github.com/kiritoxdone/github-tg-bot/releases)'));
  }
});

test('bounds punctuation-heavy titles, bodies, author names and long commit links', () => {
  const fixtures = [
    ['release', { release: { tag_name: '*'.repeat(180), name: '!'.repeat(250), body: '#\n'.repeat(5000) } }],
    ['issues', { issue: { number: 1, title: '*'.repeat(250), body: '*'.repeat(5000) } }],
    ['push', { ref: '*'.repeat(180), compare: `https://github.com/${'x'.repeat(550)}`, commits: Array.from({ length: 20 }, (_, i) => ({ id: `abcdef${i}1234`, message: '*'.repeat(180), author: { name: '_'.repeat(500) }, url: `https://github.com/${'x'.repeat(550)}` })) }],
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
      author: { name: '*Timeline*', username: 'TimelineDev' },
    }));
    const result = formatEvent('push', payload({ ref: 'refs/heads/main', commits }));
    assert.ok(result.messages.length > 0);
    if (count >= 50) assert.ok(result.messages.length > 1);
    for (const [index, message] of result.messages.entries()) {
      assert.ok(message.length <= 3900);
      assert.ok(message.isWellFormed());
      assert.ok(message.startsWith(`🔨 [${count} new commit${count === 1 ? '' : 's'}](`));
      if (result.messages.length > 1) assert.ok(message.includes(`Page ${index + 1}/${result.messages.length}`));
    }
    const text = result.messages.join('\n');
    const ids = [...text.matchAll(/\/commit\/([a-f\d]{40})\)/g)].map(match => match[1]);
    assert.deepEqual(ids, commits.map(commit => commit.id));
    assert.equal(text.split('by [\\*Timeline\\*](https://github.com/TimelineDev)').length - 1, count);
    assert.doesNotMatch(text, /另有/);
  }
});

test('issues, pull requests and all comments share the compact linked subject layout', () => {
  const subject = { number: 28, title: 'Fix startup', html_url: `${repository.html_url}/issues/28`, body: 'Description' };
  const cases = [
    ['issues', { action: 'opened', issue: subject }, '🐛 *New issue*', subject.html_url, 'by', 'Description'],
    ['pull_request', { action: 'opened', pull_request: subject }, '🔌 *New pull request*', subject.html_url, 'by:', 'Description'],
    ...['issue_comment', 'pull_request_review_comment'].map(type => [type,
      { action: 'created', ...(type === 'issue_comment' ? { issue: subject } : { pull_request: subject }),
        comment: { html_url: `${subject.html_url}#issuecomment-99`, body: 'Looks good' } },
      '💬 *New comment on*', `${subject.html_url}#issuecomment-99`, 'by', 'Looks good']),
  ];
  for (const [type, data, headline, target, by, body] of cases) {
    assert.equal(formatEvent(type, payload(data)).messages[0],
      `${headline} [Github\\-TG\\-Bot\\#28 Fix startup](${target})\n${by} [@octocat](https://github.com/octocat)\n\n${body}`);
  }
  const comment = formatEvent('commit_comment', payload({ action: 'created', comment: {
    commit_id: 'abcdef123456', html_url: `${repository.html_url}/commit/abcdef123456#commitcomment-1`, body: 'Review this',
  } }));
  assert.ok(comment.messages[0].includes('[Github\\-TG\\-Bot@abcdef1]('));
  assert.doesNotMatch(comment.messages[0], /Reply to this message/);
});

test('all event states use descriptive headlines and keep their correct link destinations', () => {
  const pr = { number: 3, title: 'Feature' };
  const fixtures = [
    ['issues', { action: 'closed', issue: { number: 3, state_reason: 'not_planned' } }, '🚫 *Closed issue*'],
    ['pull_request', { action: 'ready_for_review', pull_request: { ...pr, draft: false } }, '🔍 *Pull request ready for review*'],
    ['pull_request', { action: 'review_requested', pull_request: pr }, '🔍 *Review requested for*'],
    ['release', { action: 'prereleased', release: { tag_name: 'v2' } }, '🧪 *New pre\\-release*'],
    ['release', { action: 'unpublished', release: { tag_name: 'v2' } }, '📥 *Unpublished release*'],
    ['pull_request_review', { action: 'submitted', review: { state: 'approved' }, pull_request: pr }, '✅ *Approved pull request*'],
    ['pull_request_review', { action: 'submitted', review: { state: 'changes_requested' }, pull_request: pr }, '🛠️ *Changes requested on*'],
    ['pull_request_review', { action: 'dismissed', review: { state: 'approved' }, pull_request: pr }, '🚫 *Dismissed review on*'],
    ['workflow_run', { action: 'completed', workflow_run: { conclusion: 'timed_out' } }, '⏱️ *Workflow timed out*'],
    ['star', { action: 'deleted' }, '⭐➖ *Star removed from*'],
    ['fork', { forkee: { full_name: 'octocat/fork', html_url: 'https://github.com/octocat/fork' } }, '🌿 *New fork of*'],
  ];
  for (const [type, data, headline] of fixtures) {
    const text = formatEvent(type, payload(data)).messages[0];
    assert.ok(text.startsWith(`${headline} [`), `${type}: ${text}`);
    assert.doesNotMatch(text, /Reply to this message/);
  }
  const fork = formatEvent('fork', payload(fixtures.at(-1)[1])).messages[0];
  assert.ok(fork.includes('*New fork of* [Github\\-TG\\-Bot](https://github.com/kiritoxdone/github-tg-bot)'));
  assert.ok(fork.endsWith('[octocat/fork](https://github.com/octocat/fork)'));
});

test('suppresses draft releases and PR activity, then allows published and ready events', () => {
  for (const action of ['created', 'edited', 'deleted', 'published']) {
    assert.equal(formatEvent('release', payload({ action, release: { draft: true, tag_name: 'v2' } })), null);
  }
  for (const action of ['opened', 'edited', 'synchronize', 'closed', 'converted_to_draft']) {
    assert.equal(formatEvent('pull_request', payload({ action, pull_request: { draft: true, number: 1 } })), null);
  }
  assert.equal(formatEvent('pull_request', payload({ action: 'converted_to_draft', pull_request: { number: 1 } })), null);
  for (const event of ['pull_request_review', 'pull_request_review_comment']) {
    assert.equal(formatEvent(event, payload({ pull_request: { draft: true }, review: {}, comment: {} })), null);
  }
  assert.equal(formatEvent('release', payload({ action: 'published', release: { draft: false, prerelease: true, tag_name: 'v2-beta' } })).category, 'release');
  assert.equal(formatEvent('pull_request', payload({ action: 'ready_for_review', pull_request: { draft: false, number: 1 } })).category, 'pr');
});

test('all prose bodies render GitHub Markdown, with literal metadata and commit summaries', () => {
  const body = '## Changes\n\n**Fixed** startup with `--safe` and [details](https://example.com/docs).';
  const cases = [
    ['release', { release: { body } }], ['issues', { issue: { body } }],
    ['pull_request', { pull_request: { body } }],
    ...['issue_comment', 'commit_comment', 'pull_request_review_comment'].map(event => [event, { comment: { body } }]),
    ['pull_request_review', { review: { body }, pull_request: {} }],
  ];
  for (const [event, data] of cases) {
    const message = formatEvent(event, payload(data)).messages[0];
    assert.ok(message.endsWith('*Changes*\n\n*Fixed* startup with `--safe` and [details](https://example.com/docs)\\.'), event);
  }
});

test('push keeps ref changes explicit, escapes author fields and never attributes missing authors to the pusher', () => {
  for (const kind of ['heads', 'tags']) {
    for (const deleted of [false, true]) {
      const text = formatEvent('push', payload({ ref: `refs/${kind}/feature/a`, created: !deleted, deleted })).messages[0];
      assert.ok(text.includes(`*${deleted ? 'Deleted' : 'New'} ${kind === 'tags' ? 'tag' : 'branch'}*`));
      assert.ok(text.includes('by [@octocat]'));
    }
  }
  const text = formatEvent('push', payload({ commits: [
    { id: 'abcdef1234', message: 'One', author: { name: '*Fake* [link](https://evil.example)' } },
    { id: 'abcdee1234', message: 'Two' },
  ] })).messages[0];
  assert.ok(text.includes('by \\*Fake\\* \\[link\\]\\(https://evil\\.example\\)'));
  assert.ok(text.endsWith('Two by Unknown author'));
  assert.doesNotMatch(text, /octocat/);
  for (const username of [undefined, 'https://evil.example', 'user/path', 'a'.repeat(40)]) {
    const message = formatEvent('push', payload({ commits: [{ id: 'abcdef1234', message: 'Fix',
      author: { name: 'Timeline', username } }] })).messages[0];
    assert.ok(message.endsWith('by Timeline'));
    assert.doesNotMatch(message, /github\.com\/(Timeline|octocat)/);
  }
  const fromApi = formatEvent('push', payload({ commits: [{ id: 'abcdef1234', message: 'Fix',
    author: { login: 'TimelineDev' } }] })).messages[0];
  assert.ok(fromApi.endsWith('by [TimelineDev](https://github.com/TimelineDev)'));
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
