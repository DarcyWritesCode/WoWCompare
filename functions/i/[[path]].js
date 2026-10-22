// Cloudflare Pages Function: forwards /i/* to the WoWAnalyzer API server-side, since its CORS
// policy only admits localhost. Read-only (GET/HEAD), and responses are cached at the edge
// briefly so repeat views of a report don't hit WoWAnalyzer again.
const UPSTREAM = 'https://wowanalyzer.com';
const CACHE_SECONDS = 300;

export async function onRequest({ request }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  const url = new URL(request.url);
  const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
    method: request.method,
    headers: { accept: request.headers.get('accept') ?? '*/*' },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  const headers = new Headers(upstream.headers);
  headers.delete('set-cookie');
  return new Response(upstream.body, { status: upstream.status, headers });
}
