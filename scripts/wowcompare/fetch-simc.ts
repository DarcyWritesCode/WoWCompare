/**
 * WoWCompare: downloads the pinned SimC WebAssembly release (src/wowcompare/sim/engine.ts) into
 * node_modules/.cache/simc-wasm/, which the dev server serves at /simc/ (vite/simcPlugin.ts):
 *
 *   pnpm exec tsx scripts/wowcompare/fetch-simc.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { SIMC_FILES, SIMC_RELEASE } from '../../src/wowcompare/sim/engine';

const REPO = 'PwogSoupe/voidsim-wasm';
const OUT_DIR = path.resolve('node_modules/.cache/simc-wasm');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of Object.values(SIMC_FILES)) {
    const url = `https://github.com/${REPO}/releases/download/${SIMC_RELEASE.tag}/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(await response.arrayBuffer()));
    console.log(`${name}: ${(fs.statSync(path.join(OUT_DIR, name)).size / 1e6).toFixed(1)} MB`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'release.json'), `${JSON.stringify(SIMC_RELEASE)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
