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
const ROUTES: {
  pattern: RegExp;
  key: (m: RegExpExecArray) => string;
  /** A pack's part: the encounter ID to slice out by the pack's index. */
  part?: (m: RegExpExecArray) => string;
  /** Read when the pack has no such part: the per-boss file written before packs. */
  fallback?: (m: RegExpExecArray) => string;
}[] = [
  { pattern: /^profiles\/(\d+)$/, key: (m) => `profile-${m[1]}` },
  {
    pattern: /^benchmarks\/(\d+)\/(\d+)\/(\d+)$/,
    key: (m) => `pack-${m[1]}-${m[3]}`,
    part: (m) => m[2],
    fallback: (m) => `bench-${m[1]}-${m[2]}-${m[3]}`,
  },
  { pattern: /^status$/, key: () => 'status' },
  { pattern: /^effects\/(\d+)$/, key: (m) => `effects-${m[1]}` },
];

const fileOf = (key: string) => path.join(LOCAL_DIR, `${key}.json`);

function read(route: (typeof ROUTES)[number], m: RegExpExecArray): string | null {
  const file = fileOf(route.key(m));
  if (route.part && route.fallback) {
    const meta = path.join(LOCAL_DIR, `${route.key(m)}.meta.json`);
    const range: [number, number] | undefined =
      fs.existsSync(file) && fs.existsSync(meta)
        ? JSON.parse(fs.readFileSync(meta, 'utf8')).index?.[route.part(m)]
        : undefined;
    if (range) {
      return fs.readFileSync(file).subarray(range[0], range[1]).toString('utf8');
    }
    const fallback = fileOf(route.fallback(m));
    return fs.existsSync(fallback) ? fs.readFileSync(fallback, 'utf8') : null;
  }
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

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
  for (const entry of ROUTES) {
    const match = entry.pattern.exec(route);
    const body = match && read(entry, match);
    if (body !== null) {
      return send(200, body, 'application/json');
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
