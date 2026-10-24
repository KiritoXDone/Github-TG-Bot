// Compare the release's displayed content, not transport metadata, actor,
// timestamps, asset downloads or the deployment pipeline's repeated saves.
export async function releaseSnapshot(release) {
  if (!Number.isSafeInteger(release?.id) || release.id <= 0) return null;
  const line = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const content = JSON.stringify([
    line(release.name), line(release.tag_name),
    typeof release.body === 'string' ? release.body.replace(/\r/g, '').trim() : '',
    release.prerelease === true,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const updated = typeof release.updated_at === 'string' ? Date.parse(release.updated_at) : NaN;
  return { id: release.id, hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
    updated: Number.isFinite(updated) ? updated : 0 };
}

export function rememberRelease(db, repo, snapshot, delivery, publication, token, now) {
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
        THEN excluded.claim_token ELSE release_states.claim_token END,
      seen_at = excluded.seen_at
    WHERE excluded.source_updated_at >= release_states.source_updated_at`)
    .bind(repo, snapshot.id, snapshot.hash, snapshot.updated, token, now, delivery, token, publication, publication, token);
}
