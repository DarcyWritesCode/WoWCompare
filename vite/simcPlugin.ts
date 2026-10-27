import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import zlib from 'node:zlib';
import type { Plugin } from 'vite';

/**
 * WoWCompare: serves the SimC WebAssembly build (scripts/wowcompare/fetch-simc.ts downloads it) at
 * /simc/<release tag>/ on the dev server (functions/simc/ does it in production), too large for the
 * repo or a Pages asset. Serves whatever release was downloaded, whatever the tag.
 */
const PREFIX = '/simc/';
const LOCAL_DIR = path.resolve('node_modules/.cache/simc-wasm');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm' };

/**
 * The engine's thread workers load its script; they're only isolated (and can share memory with
 * the page) if it carries the same policy as the page.
 */
function setIsolation(res: ServerResponse) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export default function simcPlugin(): Plugin {
  return {
    name: 'wowcompare-simc',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith(PREFIX)) {
          return next();
        }
        const file = path.join(LOCAL_DIR, path.basename(url));
        if (!fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end('SimC build missing: run pnpm exec tsx scripts/wowcompare/fetch-simc.ts');
        }
        res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        // Gzipped the engine is ~16 MB instead of 111: compressed once, then served from disk.
        if (file.endsWith('.wasm') && /\bgzip\b/.test(String(req.headers['accept-encoding']))) {
          const gz = `${file}.gz`;
          if (!fs.existsSync(gz) || fs.statSync(gz).mtimeMs < fs.statSync(file).mtimeMs) {
            fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(file), { level: 6 }));
          }
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          setIsolation(res);
          return fs.createReadStream(gz).pipe(res);
        }
        res.setHeader('Cache-Control', 'public, max-age=86400');
        setIsolation(res);
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
