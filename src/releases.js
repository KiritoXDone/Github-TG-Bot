// Compare the release's displayed content, not transport metadata, actor,
// timestamps, asset downloads or the deployment pipeline's repeated saves.
function releaseContent(release) {
  const line = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return JSON.stringify([
    line(release.name), line(release.tag_name),
    typeof release.body === 'string' ? release.body.replace(/\r/g, '').trim() : '',
    release.prerelease === true,
  ]);
}

export function initialEditHasContentChange(release, changes) {
  // Preserve legacy payload handling when no before-values were supplied.
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return true;
  const before = { ...release };
  for (const field of ['name', 'tag_name', 'body', 'prerelease']) {
    if (changes[field] && Object.hasOwn(changes[field], 'from')) before[field] = changes[field].from;
  }
  // Publishing a draft also emits edited with changes: {}. It can arrive before
  // published, so the first such edit must seed a baseline without a notification.
  return releaseContent(before) !== releaseContent(release);
}

export async function releaseSnapshot(release) {
  if (!Number.isSafeInteger(release?.id) || release.id <= 0) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(releaseContent(release)));
  const updated = typeof release.updated_at === 'string' ? Date.parse(release.updated_at) : NaN;
  return { id: release.id, hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
    updated: Number.isFinite(updated) ? updated : 0 };
}

export function rememberRelease(db, repo, snapshot, delivery, publication, token, now, notifyInitial = true) {
  // A duplicate receipt cannot change the baseline. Repeated identical content
  // may advance its timestamp, but only a content change takes the claim token.
  return db.prepare(`INSERT INTO release_states
    (repo, release_id, content_hash, source_updated_at, claim_token, seen_at)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM receipts WHERE id = ? AND token = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM receipts WHERE id = ? AND token = ?))
    ON CONFLICT (repo, release_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      source_updated_at = excluded.source_updated_at,
      claim_token = CASE WHEN release_states.content_hash != excluded.content_hash
        THEN ? ELSE release_states.claim_token END,
      seen_at = excluded.seen_at
    WHERE excluded.source_updated_at >= release_states.source_updated_at`)
    .bind(repo, snapshot.id, snapshot.hash, snapshot.updated, notifyInitial ? token : '', now,
      delivery, token, publication, publication, token, token);
}
