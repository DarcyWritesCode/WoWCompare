/** Re-fetch the APL at most this often per browser; SimC regenerates them a few times a week. */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Don't hold up an analysis for long on GitHub; the bundled APL is a fine fallback. */
const FETCH_TIMEOUT_MS = 4_000;

interface CachedApl {
  text: string;
  retrievedAt: number;
}

function readCache(key: string): CachedApl | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as CachedApl) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: CachedApl) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: just skip caching
  }
}

/** The current APL text from SimC's GitHub, or null if it can't be fetched in time. */
export async function fetchLiveApl(url: string): Promise<CachedApl | null> {
  if (import.meta.env.MODE === 'test') {
    return null;
  }
  const key = `wowcompare:apl:${url}`;
  const cached = readCache(key);
  if (cached && Date.now() - cached.retrievedAt < CACHE_TTL_MS) {
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return cached;
    }
    const fresh = { text: await response.text(), retrievedAt: Date.now() };
    writeCache(key, fresh);
    return fresh;
  } catch {
    return cached;
  } finally {
    clearTimeout(timer);
  }
}
