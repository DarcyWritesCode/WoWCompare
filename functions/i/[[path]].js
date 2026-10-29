// Cloudflare Pages Function: forwards /i/* to the WoWAnalyzer API server-side, since its CORS
// policy only admits localhost. Read-only (GET/HEAD), and responses are cached at the edge
// briefly so repeat views of a report don't hit WoWAnalyzer again.
const UPSTREAM = 'https://wowanalyzer.com';
const CACHE_SECONDS = 300;
/** Rankings move slowly; keep them for a day like the parsed-log cache. */
const RANKINGS_CACHE_SECONDS = 24 * 60 * 60;
/**
 * A report's fight list grows while it's live-logged. WoWAnalyzer tells browsers to keep it for a
 * week, so a list fetched mid-raid stuck; keep it briefly everywhere instead.
 */
const FIGHTS_CACHE_SECONDS = 30;

export async function onRequest({ request }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  const url = new URL(request.url);
  const fights = url.pathname.includes('/report/fights/');
  // The page's Refresh button asks for no-cache; WoWAnalyzer then re-reads the report from
  // Warcraft Logs, so pass that on and skip the edge cache rather than serve its copy.
  const noCache = /no-cache/i.test(
    `${request.headers.get('cache-control') ?? ''} ${request.headers.get('pragma') ?? ''}`,
  );
  const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
    method: request.method,
    headers: {
      accept: request.headers.get('accept') ?? '*/*',
      ...(noCache && { 'cache-control': 'no-cache', pragma: 'no-cache' }),
    },
    cf: noCache
      ? { cacheTtl: -1 }
      : {
          cacheTtl: url.pathname.includes('/rankings/')
            ? RANKINGS_CACHE_SECONDS
            : fights
              ? FIGHTS_CACHE_SECONDS
              : CACHE_SECONDS,
          cacheEverything: true,
        },
  });
  const headers = new Headers(upstream.headers);
  headers.delete('set-cookie');
  if (fights) {
    headers.set('cache-control', `max-age=${FIGHTS_CACHE_SECONDS}`);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
