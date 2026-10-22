import { LogSnapshot } from '../metrics/results';
import { Profile } from '../profile/types';

/**
 * Bump whenever `LogSnapshot` or the metrics behind it change, so stale cached results from
 * older code are never used.
 */
export const SNAPSHOT_VERSION = 5;

/**
 * Server-side cache of parsed benchmark logs; entries expire after 24 hours on the server. Served
 * by the dev server (vite.config.ts) and by a Cloudflare Pages Function (functions/wc-api/).
 */
const ENDPOINT = '/wc-api/snapshots';

/** FNV-1a, hex: a short fingerprint of the profile so customised profiles get their own entries. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function snapshotKey(
  profile: Profile,
  ref: { reportCode: string; fightId: number; playerName: string },
): string {
  const profileHash = fingerprint(JSON.stringify({ e: profile.entries, r: profile.rules }));
  return [
    `v${SNAPSHOT_VERSION}`,
    profile.specId,
    profileHash,
    ref.reportCode,
    ref.fightId,
    fingerprint(ref.playerName),
  ].join('-');
}

const url = (key: string) => `${ENDPOINT}/${key}`;

/** A cached snapshot, or null on a miss or any error (the caller just parses the log). */
export async function getCachedSnapshot(key: string): Promise<LogSnapshot | null> {
  try {
    const response = await fetch(url(key));
    return response.ok ? ((await response.json()) as LogSnapshot) : null;
  } catch {
    return null;
  }
}

/** Shares a freshly parsed snapshot; failures are ignored (caching is best effort). */
export function putCachedSnapshot(key: string, snapshot: LogSnapshot): void {
  fetch(url(key), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  }).catch(() => undefined);
}
