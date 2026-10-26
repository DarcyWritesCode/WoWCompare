// Cloudflare Pages Function: serves what the benchmark job (scripts/benchmarks/) publishes
// to the KV namespace bound as SNAPSHOTS. Read-only: only the job writes, with an API token, so
// viewers can't plant data (see src/wowcompare/benchmarks/published.ts). Without the binding
// every request is a miss and the app parses benchmark logs itself.
const ROUTES = [
  { pattern: /^profiles\/(\d+)$/, key: (m) => `profile-${m[1]}` },
  // One boss out of the spec's pack for the difficulty, by the byte range in the pack's metadata.
  {
    pattern: /^benchmarks\/(\d+)\/(\d+)\/(\d+)$/,
    key: (m) => `pack-${m[1]}-${m[3]}`,
    part: (m) => m[2],
    // Until the per-boss values written before packs expire (KV TTL: 2026-11-15).
    fallback: (m) => `bench-${m[1]}-${m[2]}-${m[3]}`,
  },
  { pattern: /^status$/, key: () => 'status' },
  { pattern: /^effects\/(\d+)$/, key: (m) => `effects-${m[1]}` },
];

/**
 * The route's value, or null. A pack is sliced by its index without parsing it; in a gzipped pack
 * each part is a gzip stream of its own, served as is for the browser to decompress.
 */
async function read(kv, route, m) {
  if (!route.part) {
    return { body: await kv.get(route.key(m)) };
  }
  const { value, metadata } = await kv.getWithMetadata(route.key(m), 'arrayBuffer');
  const range = metadata?.index?.[route.part(m)];
  if (value && range) {
    return { body: value.slice(range[0], range[1]), gzip: metadata.gzip === true };
  }
  return { body: await kv.get(route.fallback(m)) };
}
/** Each entry changes at most daily (most weekly); let the edge and browsers reuse answers. */
const CACHE_SECONDS = 3600;

export async function onRequest({ request, params, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  const path = [].concat(params.path ?? []).join('/');
  const route = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).find(({ m }) => m);
  if (!route) {
    return new Response('Not found', { status: 404 });
  }
  const { body, gzip } = env.SNAPSHOTS ? await read(env.SNAPSHOTS, route.r, route.m) : {};
  if (!body) {
    return new Response('Not published', { status: 404 });
  }
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
      ...(gzip && { 'content-encoding': 'gzip' }),
    },
    // Already gzipped: without this the runtime would compress it again.
    ...(gzip && { encodeBody: 'manual' }),
  });
}
