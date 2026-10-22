// Cloudflare Pages Function: shared cache of parsed benchmark logs (see
// src/wowcompare/benchmarks/snapshotCache.ts). Needs a KV namespace bound as SNAPSHOTS; without
// it every request is a miss and the app simply parses logs itself.
const TTL_SECONDS = 24 * 60 * 60;
const MAX_BYTES = 2 * 1024 * 1024;
const KEY = /^v\d+-\d+-[0-9a-f]+-[A-Za-z0-9:]+-\d+-[0-9a-f]+$/;

const isSnapshot = (value) =>
  value && Array.isArray(value.results?.entries) && Array.isArray(value.windows);

export async function onRequest({ request, params, env }) {
  const key = String(params.key);
  if (!KEY.test(key)) {
    return new Response('Bad key', { status: 400 });
  }
  if (!env.SNAPSHOTS) {
    return new Response('Cache not configured', { status: 404 });
  }

  if (request.method === 'GET') {
    const cached = await env.SNAPSHOTS.get(key);
    return cached
      ? new Response(cached, { headers: { 'content-type': 'application/json' } })
      : new Response('Not cached', { status: 404 });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > MAX_BYTES) {
      return new Response('Too large', { status: 413 });
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }
    if (!isSnapshot(parsed)) {
      return new Response('Not a snapshot', { status: 400 });
    }
    // First writer wins for the day, so one bad upload can't keep replacing good data.
    if (!(await env.SNAPSHOTS.get(key))) {
      await env.SNAPSHOTS.put(key, body, { expirationTtl: TTL_SECONDS });
    }
    return new Response(null, { status: 204 });
  }

  return new Response('Method not allowed', { status: 405 });
}
