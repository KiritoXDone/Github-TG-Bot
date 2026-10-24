import { escapeMarkdown as md, quoteMarkdown, renderMarkdown, shouldCollapse } from './markdown.js';

export const EVENTS = ['issues', 'pr', 'commits', 'release', 'comments', 'reviews', 'actions', 'stars', 'forks'];
export const DEFAULT_EVENTS = ['issues', 'pr', 'commits', 'release'];

export function repoName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) return null;
  return value.toLowerCase();
}

export function clip(value, max = 500) {
  const text = typeof value === 'string' ? value.replace(/\r/g, '') : '';
  if (max <= 0) return '';
  if (text.length <= max) return text;
  // Avoid splitting a UTF-16 surrogate pair.
  return text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

function url(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password
      && !u.port && u.href.length <= 600 ? u.href : '';
  }
  catch { return ''; }
}

// Titles and commit summaries remain literal; prose bodies render Markdown.
const line = (value, max) => clip(value, max).replace(/\s+/g, ' ').trim();
const bold = (value) => value ? `*${md(value)}*` : '';
const href = (label, target) => `[${md(label)}](${target.replace(/[)\\]/g, '\\$&')})`;
const MAX_MESSAGE = 3900;

const CHANGE_EMOJI = {
  edited: '✏️', deleted: '🗑️', reopened: '🔄',
  assigned: '👤', unassigned: '👤', labeled: '🏷️', unlabeled: '🏷️',
  locked: '🔒', unlocked: '🔓', pinned: '📌', unpinned: '📌',
  milestoned: '🎯', demilestoned: '🎯', transferred: '📦',
};
const pickEmoji = (mapping, key, fallback) => Object.hasOwn(mapping, key) ? mapping[key] : fallback;

function eventEmoji(event, p) {
  switch (event) {
    case 'push':
      if (p.deleted) return '🗑️';
      if (p.forced) return '⚠️';
      if (p.ref?.startsWith('refs/tags/')) return '🏷️';
      return p.created ? '🌱' : '🔨';
    case 'issues':
      if (p.action === 'closed') {
        return pickEmoji({ completed: '✅', not_planned: '🚫' }, p.issue?.state_reason, '🔴');
      }
      return pickEmoji(CHANGE_EMOJI, p.action, '🐛');
    case 'pull_request':
      if (p.action === 'closed') return p.pull_request?.merged ? '🔀' : '🚫';
      return pickEmoji({ ...CHANGE_EMOJI, synchronize: '🔄', ready_for_review: '🔍', review_requested: '🔍' }, p.action, '🔌');
    case 'release':
      if (p.action === 'deleted' || p.action === 'edited') return CHANGE_EMOJI[p.action];
      if (p.action === 'unpublished') return '📥';
      return p.release?.prerelease ? '🧪' : '🚀';
    case 'issue_comment':
    case 'commit_comment':
    case 'pull_request_review_comment':
      return pickEmoji(CHANGE_EMOJI, p.action, '💬');
    case 'pull_request_review':
      // A dismissed approval must not keep its success icon.
      if (p.action === 'dismissed') return '🚫';
      if (p.action === 'edited') return '✏️';
      return pickEmoji({ approved: '✅', changes_requested: '🛠️', commented: '💬', dismissed: '🚫' }, p.review?.state, '🔍');
    case 'workflow_run':
      return pickEmoji({ success: '✅', failure: '❌', startup_failure: '❌', timed_out: '⏱️',
        cancelled: '⏹️', skipped: '⏭️', neutral: '➖', action_required: '⚠️', stale: '⌛' }, p.workflow_run?.conclusion, '⚙️');
    case 'star': return p.action === 'deleted' ? '⭐➖' : '⭐';
    case 'fork': return '🌿';
    default: return '🔔';
  }
}

// Match the observed GitHubBot layouts. Other event types use the same compact
// language and structure; they are not claimed to reproduce undocumented text.
function activity(action, noun) {
  const verbs = {
    opened: 'New', created: 'New', closed: 'Closed', reopened: 'Reopened', edited: 'Updated',
    deleted: 'Deleted', assigned: 'Assigned', unassigned: 'Unassigned', labeled: 'Labeled',
    unlabeled: 'Unlabeled', locked: 'Locked', unlocked: 'Unlocked', pinned: 'Pinned', unpinned: 'Unpinned',
    milestoned: 'Added milestone to', demilestoned: 'Removed milestone from', transferred: 'Transferred',
    typed: 'Changed type of', untyped: 'Removed type from',
  };
  return Object.hasOwn(verbs, action) ? `${verbs[action]} ${noun}` : `${noun[0].toUpperCase()}${noun.slice(1)} updated`;
}

function pullRequestActivity(p) {
  if (p.action === 'closed' && p.pull_request.merged) return 'Merged pull request';
  const phrases = {
    synchronize: 'Updated pull request',
    ready_for_review: 'Pull request ready for review', review_requested: 'Review requested for',
    review_request_removed: 'Review request removed from',
    auto_merge_enabled: 'Auto-merge enabled for', auto_merge_disabled: 'Auto-merge disabled for',
    enqueued: 'Added pull request to merge queue', dequeued: 'Removed pull request from merge queue',
  };
  return Object.hasOwn(phrases, p.action) ? phrases[p.action] : activity(p.action, 'pull request');
}

function releaseActivity(p) {
  const kind = p.release.prerelease ? 'pre-release' : 'release';
  const verbs = { published: 'New',
    edited: 'Updated', deleted: 'Deleted', unpublished: 'Unpublished' };
  return `${Object.hasOwn(verbs, p.action) ? verbs[p.action] : 'Updated'} ${kind}`;
}

function reviewActivity(p) {
  if (p.action === 'dismissed') return 'Dismissed review on';
  if (p.action === 'edited') return 'Updated review on';
  const phrases = { approved: 'Approved pull request', changes_requested: 'Changes requested on',
    commented: 'New review on', dismissed: 'Dismissed review on' };
  return Object.hasOwn(phrases, p.review.state) ? phrases[p.review.state] : 'New review on';
}

function workflowActivity(conclusion) {
  const phrases = { success: 'Workflow succeeded', failure: 'Workflow failed', startup_failure: 'Workflow failed to start',
    timed_out: 'Workflow timed out', cancelled: 'Workflow cancelled', skipped: 'Workflow skipped',
    neutral: 'Workflow completed with neutral result', action_required: 'Workflow requires action', stale: 'Workflow became stale' };
  return Object.hasOwn(phrases, conclusion) ? phrases[conclusion] : 'Workflow completed';
}

function fit(value, budget, render) {
  if (render(value).length <= budget) return render(value);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (render(clip(value, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  return render(clip(value, low));
}

function pushMessages(header, commits, repoUrl) {
  if (!commits.length) return [header];
  const pageLabel = (page, total) => `Page ${page}/${total}`;
  const entries = commits.map(commit => {
    const c = commit || {};
    const commitUrl = url(c.url) || (/^[a-f\d]{7,40}$/i.test(c.id || '') ? `${repoUrl}/commit/${c.id}` : `${repoUrl}/commits`);
    const shortId = line(c.id, 80).slice(0, 7).replace(/[\uD800-\uDBFF]$/, '');
    const prefix = `${href(shortId || 'commit', commitUrl)}: `;
    const message = line(typeof c.message === 'string' ? c.message.split('\n')[0] : '', 180);
    // The commit author can differ from the user who pushed the branch.
    const login = c.author?.username || c.author?.login;
    const author = line(c.author?.name, 80) || line(login, 80) || 'Unknown author';
    const profile = typeof login === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)
      ? `https://github.com/${login}` : '';
    const suffix = ` by ${profile ? href(author, profile) : md(author)}`;
    return { prefix, message, suffix, plain: `${shortId || 'commit'}: ${message} by ${author}` };
  });
  const folded = commits.length > 5 || shouldCollapse(entries.map(entry => entry.plain).join('\n'));
  // Reserve page labels plus quote markers and a '>' for every complete line.
  const budget = MAX_MESSAGE - header.length - pageLabel(commits.length, commits.length).length - 3 - (folded ? 4 : 0);
  const pages = [];
  let current = '';
  let used = 0;
  for (const { prefix, message, suffix } of entries) {
    const entry = prefix + fit(message, budget - prefix.length - suffix.length - (folded ? 1 : 0), md) + suffix;
    const cost = entry.length + (folded ? 1 : 0);
    if (current && used + cost + 1 > budget) {
      pages.push(current);
      current = '';
      used = 0;
    }
    used += cost + (current ? 1 : 0);
    current += `${current ? '\n' : ''}${entry}`;
  }
  if (current) pages.push(current);
  return pages.map((body, index) => `${header}${pages.length > 1 ? `\n${pageLabel(index + 1, pages.length)}` : ''}\n\n${folded ? quoteMarkdown(body) : body}`);
}

export function formatEvent(event, p) {
  const repo = repoName(p.repository?.full_name);
  if (!repo) return null;
  if (event === 'release' && p.release?.draft) return null;
  // GitHub emits overlapping release actions for one publication. published
  // covers stable releases and pre-releases, including publication from drafts.
  if (event === 'release' && ['created', 'released', 'prereleased'].includes(p.action)) return null;
  if (p.pull_request?.draft || (event === 'pull_request' && p.action === 'converted_to_draft')) return null;
  const repoUrl = `https://github.com/${repo}`;
  const project = p.repository.full_name.split('/')[1];
  const actor = line(p.sender?.login || 'GitHub', 80);
  const actorUrl = url(p.sender?.html_url) || (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor) ? `https://github.com/${actor}` : '');
  const actorLabel = actorUrl ? href(`@${actor}`, actorUrl) : md(`@${actor}`);
  const emoji = eventEmoji(event, p);
  let category;
  let title;
  let body = '';
  let bodyLimit = 1200;
  let details = '';
  let by = 'by';
  const linkedTitle = (phrase, label, target) => `${emoji} ${bold(phrase)} ${href(label, url(target) || repoUrl)}`;
  const issueLabel = (issue) => `${project}#${line(String(issue.number ?? p.number ?? '?'), 20)}${issue.title ? ` ${line(issue.title, 250)}` : ''}`;

  switch (event) {
    case 'push': {
      category = 'commits';
      const ref = line(p.ref, 180).replace(/^refs\/(heads|tags)\//, '') || 'branch';
      const commits = Array.isArray(p.commits) ? p.commits : [];
      const isTag = p.ref?.startsWith('refs/tags/');
      const kind = isTag ? 'tag' : 'branch';
      if (p.deleted || (p.created && !commits.length)) {
        const target = p.deleted ? repoUrl : `${repoUrl}/tree/${encodeURIComponent(ref)}`;
        title = linkedTitle(`${p.deleted ? 'Deleted' : 'New'} ${kind}`, `${project}:${ref}`, target);
        title += `\nby ${actorLabel}`;
      } else {
        title = `🔨 ${href(`${commits.length} new commit${commits.length === 1 ? '' : 's'}`, url(p.compare) || repoUrl)} to ${bold(`${project}:${ref}`)}:`;
        if (p.forced) title += `\n⚠️ Forced push by ${actorLabel}`;
        else if (p.created || isTag) title += `\n${isTag ? '🏷️' : '🌱'} ${p.created ? 'New' : 'Updated'} ${kind} by ${actorLabel}`;
      }
      return { repo, category, messages: pushMessages(title, commits, repoUrl), parse_mode: 'MarkdownV2' };
    }
    case 'issues':
      if (!p.issue) return null;
      category = 'issues';
      title = linkedTitle(activity(p.action, 'issue'), issueLabel(p.issue), p.issue.html_url);
      body = p.issue.body;
      break;
    case 'pull_request':
      if (!p.pull_request) return null;
      category = 'pr';
      title = linkedTitle(pullRequestActivity(p), issueLabel(p.pull_request), p.pull_request.html_url);
      by = 'by:';
      body = p.pull_request.body;
      break;
    case 'release': {
      if (!p.release) return null;
      category = 'release';
      const name = line(p.release.name, 250);
      const tag = line(p.release.tag_name, 180);
      const label = name && tag && !name.includes(tag) ? `${name} · ${tag}` : name || tag || 'Release';
      const subject = label.toLowerCase().includes(project.toLowerCase()) ? label : `${project} ${label}`;
      title = linkedTitle(releaseActivity(p), subject, url(p.release.html_url) || `${repoUrl}/releases`);
      body = p.release.body;
      bodyLimit = 2400;
      break;
    }
    case 'issue_comment':
    case 'commit_comment':
    case 'pull_request_review_comment': {
      if (!p.comment) return null;
      category = 'comments';
      const issue = p.issue || p.pull_request;
      const commit = line(p.comment.commit_id, 80).slice(0, 7);
      const subject = issue ? issueLabel(issue) : `${project}${commit ? `@${commit}` : ''}`;
      title = linkedTitle(`${activity(p.action, 'comment')} on`, subject, p.comment.html_url);
      body = p.comment.body;
      bodyLimit = 2000;
      break;
    }
    case 'pull_request_review':
      if (!p.review || !p.pull_request) return null;
      category = 'reviews';
      title = linkedTitle(reviewActivity(p), issueLabel(p.pull_request), p.review.html_url);
      body = p.review.body;
      bodyLimit = 2000;
      break;
    case 'workflow_run': {
      if (p.action !== 'completed' || !p.workflow_run) return null;
      category = 'actions';
      const branch = line(p.workflow_run.head_branch, 150);
      const name = line(p.workflow_run.name, 200);
      const run = p.workflow_run.run_number == null ? '' : ` #${line(String(p.workflow_run.run_number), 20)}`;
      const subject = `${project}${branch ? `:${branch}` : ''}${name ? ` · ${name}` : ''}${run}`;
      title = linkedTitle(workflowActivity(p.workflow_run.conclusion), subject, p.workflow_run.html_url);
      break;
    }
    case 'star':
      category = 'stars'; title = linkedTitle(p.action === 'deleted' ? 'Star removed from' : 'New star on', project, `${repoUrl}/stargazers`); break;
    case 'fork':
      category = 'forks'; title = linkedTitle('New fork of', project, repoUrl);
      if (p.forkee?.full_name && url(p.forkee.html_url)) details = href(line(p.forkee.full_name, 150), url(p.forkee.html_url));
      break;
    default: return null;
  }
  let text = `${title}\n${by} ${actorLabel}`;
  if (details) text += `\n\n${details}`;
  const renderedBody = renderMarkdown(body, { budget: MAX_MESSAGE - text.length - 2, maxText: bodyLimit, base: `${repoUrl}/`, compact: true });
  if (renderedBody) text += `\n\n${renderedBody}`;
  return { repo, category, messages: [text], parse_mode: 'MarkdownV2' };
}
