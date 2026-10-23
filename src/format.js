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

// Telegram MarkdownV2 differs from GitHub Markdown. Escape all untrusted text,
// and only add our own formatting after truncation so entities stay balanced.
const md = (value) => value.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
const line = (value, max) => clip(value, max).replace(/\s+/g, ' ').trim();
const bold = (value) => value ? `*${md(value)}*` : '';
const href = (label, target) => `[${md(label)}](${target.replace(/[)\\]/g, '\\$&')})`;
const quote = (value) => value ? md(value).split('\n').map((s) => `>${s}`).join('\n') : '';
const MAX_MESSAGE = 3900;

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

export function formatEvent(event, p) {
  const repo = repoName(p.repository?.full_name);
  if (!repo) return null;
  const repoUrl = `https://github.com/${repo}`;
  const actor = line(p.sender?.login || 'GitHub', 80);
  const actorLabel = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor)
    ? href(actor, `https://github.com/${actor}`) : md(actor);
  const project = `*${href(p.repository.full_name.split('/')[1], repoUrl)}*`;
  let category;
  let title;
  let subject = '';
  let body = '';
  let details = '';
  const action = md(line(p.action, 60));
  const linkedTitle = (emoji, label, target, state = action) =>
    `${emoji} *${href(label, url(target) || repoUrl)}*${state ? ` · ${state}` : ''}`;

  switch (event) {
    case 'push': {
      category = 'commits';
      const ref = line(p.ref, 180).replace(/^refs\/(heads|tags)\//, '') || 'branch';
      const commits = Array.isArray(p.commits) ? p.commits : [];
      title = `${p.deleted ? '🗑 *删除分支*' : '📦 *Push*'} · ${href(ref, url(p.compare) || repoUrl)}`;
      if (p.forced) details = '⚠️ *Force push*\n';
      let shown = 0;
      for (const c of commits.slice(0, 8)) {
        const commitUrl = url(c.url) || (/^[a-f\d]{7,40}$/i.test(c.id || '') ? `${repoUrl}/commit/${c.id}` : `${repoUrl}/commits`);
        const shortId = line(c.id, 80).slice(0, 7).replace(/[\uD800-\uDBFF]$/, '');
        const prefix = `• ${href(shortId || 'commit', commitUrl)} `;
        // Reserve space for the omitted-count line, even with unusually long URLs.
        const budget = MAX_MESSAGE - project.length - title.length - actorLabel.length - details.length - prefix.length - 80;
        if (budget < 40) break;
        const message = line(typeof c.message === 'string' ? c.message.split('\n')[0] : '', 180);
        details += `${prefix}${fit(message, budget, md)}\n`;
        shown++;
      }
      if (commits.length > shown) details += `…另有 ${commits.length - shown} 个提交`;
      break;
    }
    case 'issues':
      if (!p.issue) return null;
      category = 'issues';
      title = linkedTitle('📝', `Issue #${line(String(p.issue.number ?? '?'), 20)}`, p.issue.html_url);
      subject = bold(line(p.issue.title, 250));
      body = clip(p.issue.body, 1200);
      break;
    case 'pull_request':
      if (!p.pull_request) return null;
      category = 'pr';
      title = linkedTitle('🔀', `PR #${line(String(p.pull_request.number ?? p.number ?? '?'), 20)}`,
        p.pull_request.html_url, p.action === 'closed' && p.pull_request.merged ? 'merged' : action);
      subject = bold(line(p.pull_request.title, 250));
      if (p.pull_request.head?.ref && p.pull_request.base?.ref) {
        subject += `\n${md(line(p.pull_request.head.ref, 100))} → ${md(line(p.pull_request.base.ref, 100))}`;
      }
      body = clip(p.pull_request.body, 1200);
      break;
    case 'release':
      if (!p.release) return null;
      category = 'release';
      title = `🚀 *Release*${action ? ` · ${action}` : ''}${p.release.prerelease ? ' · 预发布' : ''}`;
      subject = `*${href(line(p.release.tag_name || p.release.name, 180) || 'Release', url(p.release.html_url) || `${repoUrl}/releases`)}*`;
      if (p.release.tag_name && p.release.name && p.release.name !== p.release.tag_name) subject += ` · ${bold(line(p.release.name, 250))}`;
      body = clip(p.release.body, 2400);
      break;
    case 'issue_comment':
    case 'commit_comment':
    case 'pull_request_review_comment':
      if (!p.comment) return null;
      category = 'comments';
      title = linkedTitle('💬', `${p.issue?.pull_request || p.pull_request ? 'PR' : p.issue ? 'Issue' : 'Commit'} 评论`, p.comment.html_url);
      subject = bold(line(p.issue?.title || p.pull_request?.title, 250));
      body = clip(p.comment.body, 2000);
      break;
    case 'pull_request_review':
      if (!p.review || !p.pull_request) return null;
      category = 'reviews';
      title = linkedTitle('👀', `PR #${line(String(p.pull_request.number ?? '?'), 20)} Review`, p.review.html_url,
        [md(line(p.review.state, 60)), action].filter(Boolean).join(' · '));
      subject = bold(line(p.pull_request.title, 250));
      body = clip(p.review.body, 2000);
      break;
    case 'workflow_run':
      if (p.action !== 'completed' || !p.workflow_run) return null;
      category = 'actions';
      title = linkedTitle('⚙️', 'Actions', p.workflow_run.html_url, md(line(p.workflow_run.conclusion, 60)));
      subject = [bold(line(p.workflow_run.name, 200)), md(line(p.workflow_run.head_branch, 150))].filter(Boolean).join(' · ');
      break;
    case 'star':
      category = 'stars'; title = linkedTitle('⭐', 'Star', `${repoUrl}/stargazers`); break;
    case 'fork':
      category = 'forks'; title = linkedTitle('🍴', 'Fork', p.forkee?.html_url, ''); break;
    default: return null;
  }
  let text = `${project}\n${title} · ${actorLabel}`;
  if (subject) text += `\n\n${subject}`;
  if (details.trim()) text += `\n\n${details.trim()}`;
  if (body.trim()) text += `\n\n${fit(body.trim(), MAX_MESSAGE - text.length - 2, quote)}`;
  return { repo, category, text, parse_mode: 'MarkdownV2' };
}
