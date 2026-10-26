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

function read(
  route: (typeof ROUTES)[number],
  m: RegExpExecArray,
): { body: Buffer; gzip?: boolean } | null {
  const file = fileOf(route.key(m));
  if (route.part && route.fallback) {
    const metaFile = path.join(LOCAL_DIR, `${route.key(m)}.meta.json`);
    const meta: { index?: Record<string, [number, number]>; gzip?: boolean } | null =
      fs.existsSync(file) && fs.existsSync(metaFile)
        ? JSON.parse(fs.readFileSync(metaFile, 'utf8'))
        : null;
    const range = meta?.index?.[route.part(m)];
    if (range) {
      return { body: fs.readFileSync(file).subarray(range[0], range[1]), gzip: meta?.gzip };
    }
    const fallback = fileOf(route.fallback(m));
    return fs.existsSync(fallback) ? { body: fs.readFileSync(fallback) } : null;
  }
  return fs.existsSync(file) ? { body: fs.readFileSync(file) } : null;
}

function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith(PREFIX)) {
    return next();
  }
  const send = (status: number, body?: string | Buffer, type = 'text/plain', gzip = false) => {
    res.statusCode = status;
    res.setHeader('content-type', type);
    if (gzip) {
      res.setHeader('content-encoding', 'gzip');
    }
    res.end(body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(405);
  }
  const route = req.url.slice(PREFIX.length).split('?')[0];
  for (const entry of ROUTES) {
    const match = entry.pattern.exec(route);
    const found = match && read(entry, match);
    if (found) {
      return send(200, found.body, 'application/json', found.gzip);
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
