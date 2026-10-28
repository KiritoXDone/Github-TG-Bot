const line = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const body = value => typeof value === 'string' ? value.replace(/\r/g, '').trim() : '';

function subject(event, payload) {
  if (event === 'issues') return payload.issue;
  if (event === 'pull_request') return payload.pull_request;
  if (event === 'pull_request_review') return payload.review;
  if (['issue_comment', 'commit_comment', 'pull_request_review_comment'].includes(event)) return payload.comment;
  return null;
}

function content(event, value) {
  if (event === 'issues') return JSON.stringify([line(value.title), body(value.body)]);
  if (event === 'pull_request') return JSON.stringify([line(value.title), body(value.body),
    line(value.base?.ref), line(value.base?.repo?.full_name).toLowerCase()]);
  return JSON.stringify([body(value.body)]);
}

function initialChange(event, payload, value) {
  if (payload.action === 'synchronize') {
    return typeof payload.before !== 'string' || typeof payload.after !== 'string' || payload.before !== payload.after;
  }
  if (payload.action !== 'edited') return true;
  const changes = payload.changes;
  // Older payloads without before-values retain their first edit notification.
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return true;
  const before = { ...value };
  for (const field of ['title', 'body']) {
    if (changes[field] && Object.hasOwn(changes[field], 'from')) before[field] = changes[field].from;
  }
  if (event === 'pull_request' && changes.base?.ref && Object.hasOwn(changes.base.ref, 'from')) {
    before.base = { ...value.base, ref: changes.base.ref.from };
  }
  return content(event, before) !== content(event, value);
}

export async function activitySnapshot(event, payload) {
  const value = subject(event, payload);
  if (!Number.isSafeInteger(value?.id) || value.id <= 0) return null;
  const updated = typeof value.updated_at === 'string' ? Date.parse(value.updated_at) : NaN;
  const key = `${event}:${value.id}`;
  const check = payload.action === 'edited' ? 'content'
    : event === 'pull_request' && payload.action === 'synchronize' ? 'revision' : null;
  // Creation has one identity; reopen/close/ready-for-review can happen again.
  const creation = (event === 'issues' || event === 'pull_request') ? payload.action === 'opened'
    : event === 'pull_request_review' ? payload.action === 'submitted' : payload.action === 'created';
  // Other actions must not consume a concurrent edit/commit as an incidental
  // snapshot. Ready-for-review seeds the first visible version of a draft PR.
  if (!check && !creation && !(event === 'pull_request' && payload.action === 'ready_for_review')) return null;
  const facets = { content: content(event, value) };
  if (event === 'pull_request' && typeof value.head?.sha === 'string') facets.revision = value.head.sha;
  // An edit must not consume an unseen commit, or a synchronize consume an
  // unseen title/body edit. Each facet has its own baseline and source clock.
  const states = [];
  for (const [facet, text] of Object.entries(facets)) {
    if (check && facet !== check) continue;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    states.push({ key: `${key}:${facet}`,
      hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      updated: Number.isFinite(updated) ? updated : 0,
      notifyInitial: initialChange(event, payload, value) });
  }
  return {
    key, states, creation, check: check && states.length ? `${key}:${check}` : null,
  };
}

export function rememberActivity(db, repo, snapshot, delivery, occurrence, token, now) {
  // Receipts, the latest baseline and all recipients commit atomically. Only
  // edits/synchronizations use this claim; lifecycle actions stay independent.
  return db.prepare(`INSERT INTO activity_states
    (repo, object_key, content_hash, source_updated_at, claim_token, seen_at)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM receipts WHERE id = ? AND token = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM receipts WHERE id = ? AND token = ?))
    ON CONFLICT (repo, object_key) DO UPDATE SET
      content_hash = excluded.content_hash,
      source_updated_at = MAX(activity_states.source_updated_at, excluded.source_updated_at),
      claim_token = CASE WHEN activity_states.content_hash != excluded.content_hash
        THEN ? ELSE activity_states.claim_token END,
      seen_at = excluded.seen_at
    WHERE excluded.source_updated_at = 0 OR excluded.source_updated_at >= activity_states.source_updated_at`)
    .bind(repo, snapshot.key, snapshot.hash, snapshot.updated, snapshot.notifyInitial ? token : '', now,
      delivery, token, occurrence, occurrence, token, token);
}
