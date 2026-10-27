// Cloudflare Pages Function: serves the SimC WebAssembly build (src/wowcompare/sim/engine.ts) at
// /simc/<release tag>/<file>, from voidsim's GitHub release (GPLv3; source at
// https://github.com/PwogSoupe/voidsim-simc). Too large for a Pages asset, and it must be
// same-origin: the engine starts its thread workers from this script. Each release tag never
// changes, so the first request caches it at the edge for good.
const REPO = 'PwogSoupe/voidsim-wasm';
const FILES = { 'simc_wasm.js': 'text/javascript', 'simc_wasm.wasm': 'application/wasm' };
const YEAR = 365 * 24 * 60 * 60;

export async function onRequest({ request, params, waitUntil }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  const [tag, file, ...rest] = [params.path].flat();
  if (rest.length > 0 || !/^simc-wasm-r\d+$/.test(tag ?? '') || !FILES[file]) {
    return new Response('Not found', { status: 404 });
  }
  const cache = caches.default;
  const key = new Request(new URL(`/simc/${tag}/${file}`, request.url).href);
  const cached = await cache.match(key);
  if (cached) {
    return cached;
  }
  const upstream = await fetch(`https://github.com/${REPO}/releases/download/${tag}/${file}`);
  if (!upstream.ok) {
    return new Response(`SimC ${tag}/${file}: upstream HTTP ${upstream.status}`, { status: 502 });
  }
  const response = new Response(upstream.body, {
    headers: {
      'Content-Type': FILES[file],
      'Cache-Control': `public, max-age=${YEAR}, immutable`,
      // The engine's thread workers load the script; they share memory with the page only if it
      // carries the same isolation policy (public/_headers).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
  waitUntil(cache.put(key, response.clone()));
  return response;
}
