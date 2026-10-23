export const EVENTS = ['issues', 'pr', 'commits', 'release', 'comments', 'reviews', 'actions', 'stars', 'forks'];
export const DEFAULT_EVENTS = ['issues', 'pr', 'commits', 'release'];

export function repoName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) return null;
  return value.toLowerCase();
}

export function clip(value, max = 500) {
  const text = typeof value === 'string' ? value.replace(/\r/g, '') : '';
  if (text.length <= max) return text;
  // Avoid splitting a UTF-16 surrogate pair.
  return text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

function url(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'github.com' ? u.href : ''; }
  catch { return ''; }
}

export function formatEvent(event, p) {
  const repo = repoName(p.repository?.full_name);
  if (!repo) return null;
  const actor = clip(p.sender?.login || 'GitHub', 80);
  let category;
  let title;
  let details = '';
  let link = url(p.repository?.html_url) || `https://github.com/${repo}`;
  const action = clip(p.action, 60);

  switch (event) {
    case 'push': {
      category = 'commits';
      const ref = clip(p.ref, 180).replace(/^refs\/(heads|tags)\//, '');
      const commits = Array.isArray(p.commits) ? p.commits : [];
      title = p.deleted ? `🗑 删除 ${ref}` : `📦 Push · ${ref}`;
      details = commits.slice(0, 8).map((c) => `${clip(c.id, 7)} ${clip(c.message?.split('\n')[0], 180)}`).join('\n');
      if (commits.length > 8) details += `\n…另有 ${commits.length - 8} 个提交`;
      if (p.forced) details = `⚠️ Force push\n${details}`;
      link = url(p.compare) || link;
      break;
    }
    case 'issues':
      if (!p.issue) return null;
      category = 'issues';
      title = `📝 Issue #${p.issue.number} · ${action}`;
      details = `${clip(p.issue.title, 250)}\n${clip(p.issue.body, 1200)}`;
      link = url(p.issue.html_url) || link;
      break;
    case 'pull_request':
      if (!p.pull_request) return null;
      category = 'pr';
      title = `🔀 PR #${p.pull_request.number ?? p.number} · ${p.action === 'closed' && p.pull_request.merged ? 'merged' : action}`;
      details = `${clip(p.pull_request.title, 250)}\n${clip(p.pull_request.head?.ref, 100)} → ${clip(p.pull_request.base?.ref, 100)}\n${clip(p.pull_request.body, 1200)}`;
      link = url(p.pull_request.html_url) || link;
      break;
    case 'release':
      if (!p.release) return null;
      category = 'release';
      title = `🚀 Release · ${action}${p.release.prerelease ? ' · pre-release' : ''}`;
      details = `${clip(p.release.name || p.release.tag_name, 250)}\n${clip(p.release.body, 2400)}`;
      link = url(p.release.html_url) || link;
      break;
    case 'issue_comment':
    case 'commit_comment':
    case 'pull_request_review_comment':
      if (!p.comment) return null;
      category = 'comments';
      title = `💬 ${p.issue?.pull_request || p.pull_request ? 'PR' : p.issue ? 'Issue' : 'Commit'} 评论 · ${action}`;
      details = `${clip(p.issue?.title || p.pull_request?.title, 250)}\n${clip(p.comment.body, 2000)}`;
      link = url(p.comment.html_url) || link;
      break;
    case 'pull_request_review':
      if (!p.review || !p.pull_request) return null;
      category = 'reviews';
      title = `👀 PR #${p.pull_request.number} Review · ${clip(p.review.state, 60)} · ${action}`;
      details = `${clip(p.pull_request.title, 250)}\n${clip(p.review.body, 2000)}`;
      link = url(p.review.html_url) || link;
      break;
    case 'workflow_run':
      if (p.action !== 'completed' || !p.workflow_run) return null;
      category = 'actions';
      title = `⚙️ Actions · ${clip(p.workflow_run.conclusion, 60)}`;
      details = `${clip(p.workflow_run.name, 200)} · ${clip(p.workflow_run.head_branch, 150)}`;
      link = url(p.workflow_run.html_url) || link;
      break;
    case 'star':
      category = 'stars'; title = `⭐ Star · ${action}`; break;
    case 'fork':
      category = 'forks'; title = '🍴 Fork'; link = url(p.forkee?.html_url) || link; break;
    default: return null;
  }
  // Plain text deliberately avoids interpreting issue text as Telegram markup.
  const content = `${title}\n${repo} · ${actor}\n\n${details.trim()}`.trim();
  return { repo, category, text: `${clip(content, 3300)}\n\n${clip(link, 600)}` };
}
