// Cloudflare Pages Function: serves what the nightly benchmark job (scripts/benchmarks/) publishes
// to the KV namespace bound as SNAPSHOTS. Read-only: only the job writes, with an API token, so
// viewers can't plant data (see src/wowcompare/benchmarks/published.ts). Without the binding
// every request is a miss and the app parses benchmark logs itself.
const ROUTES = [
  { pattern: /^profiles\/(\d+)$/, key: (m) => `profile-${m[1]}` },
  { pattern: /^benchmarks\/(\d+)\/(\d+)\/(\d+)$/, key: (m) => `bench-${m[1]}-${m[2]}-${m[3]}` },
];
/** The job runs daily; let the edge and browsers reuse an answer for a while. */
const CACHE_SECONDS = 600;

export async function onRequest({ request, params, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  const path = [].concat(params.path ?? []).join('/');
  const route = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).find(({ m }) => m);
  if (!route) {
    return new Response('Not found', { status: 404 });
  }
  const value = env.SNAPSHOTS ? await env.SNAPSHOTS.get(route.r.key(route.m)) : null;
  if (!value) {
    return new Response('Not published', { status: 404 });
  }
  return new Response(request.method === 'HEAD' ? null : value, {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
    },
  });
}
