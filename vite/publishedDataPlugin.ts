import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * WoWCompare: the benchmark job's data for the dev/preview server, read from the directory the
 * job writes with `--local` (see scripts/benchmarks/README.md). Mirrors functions/wc-api/ so both
 * behave the same; read-only like it.
 */
const PREFIX = '/wc-api/';
const LOCAL_DIR = path.resolve('node_modules/.cache/wowcompare-published');
const ROUTES: { pattern: RegExp; key: (m: RegExpExecArray) => string }[] = [
  { pattern: /^profiles\/(\d+)$/, key: (m) => `profile-${m[1]}` },
  { pattern: /^benchmarks\/(\d+)\/(\d+)\/(\d+)$/, key: (m) => `bench-${m[1]}-${m[2]}-${m[3]}` },
  { pattern: /^status$/, key: () => 'status' },
  { pattern: /^effects\/(\d+)$/, key: (m) => `effects-${m[1]}` },
];

function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith(PREFIX)) {
    return next();
  }
  const send = (status: number, body?: string, type = 'text/plain') => {
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.end(body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(405);
  }
  const route = req.url.slice(PREFIX.length).split('?')[0];
  for (const { pattern, key } of ROUTES) {
    const match = pattern.exec(route);
    const file = match && path.join(LOCAL_DIR, `${key(match)}.json`);
    if (file && fs.existsSync(file)) {
      return send(200, fs.readFileSync(file, 'utf8'), 'application/json');
    }
  }
  return send(404);
}

export default function publishedDataPlugin(): Plugin {
  return {
    name: 'wowcompare-published-data',
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}
