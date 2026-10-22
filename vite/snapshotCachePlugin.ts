import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * WoWCompare: the shared cache of parsed benchmark logs for the dev/preview server, on disk.
 * Mirrors functions/wc-api/snapshots/[key].js (Cloudflare KV) so both behave the same.
 */
const PREFIX = '/wc-api/snapshots/';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const KEY = /^v\d+-\d+-[0-9a-f]+-[A-Za-z0-9:]+-\d+-[0-9a-f]+$/;
const DIR = path.resolve('node_modules/.cache/wowcompare-snapshots');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BYTES) {
        reject(new Error('Too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith(PREFIX)) {
    return next();
  }
  const key = decodeURIComponent(req.url.slice(PREFIX.length).split('?')[0]);
  const send = (status: number, body?: string, type = 'text/plain') => {
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.end(body);
  };
  if (!KEY.test(key)) {
    return send(400, 'Bad key');
  }
  const file = path.join(DIR, `${key}.json`);
  const fresh = () => fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < TTL_MS;

  if (req.method === 'GET') {
    return fresh() ? send(200, fs.readFileSync(file, 'utf8'), 'application/json') : send(404);
  }
  if (req.method === 'PUT') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed?.results?.entries) || !Array.isArray(parsed?.windows)) {
        return send(400, 'Not a snapshot');
      }
      if (!fresh()) {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(file, body);
      }
      return send(204);
    } catch (err) {
      return send(400, (err as Error).message);
    }
  }
  return send(405);
}

export default function snapshotCachePlugin(): Plugin {
  return {
    name: 'wowcompare-snapshot-cache',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
    },
  };
}
