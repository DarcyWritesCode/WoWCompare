/**
 * WoWCompare: the SimulationCraft build sims run on. voidsim.io's WebAssembly build of unmodified
 * upstream SimC (GPLv3): source and build recipe at https://github.com/PwogSoupe/voidsim-simc,
 * binaries at https://github.com/PwogSoupe/voidsim-wasm. Pinned so results stay comparable; bump
 * it deliberately (class and APL changes move numbers) and re-download with
 * `pnpm exec tsx scripts/wowcompare/fetch-simc.ts`.
 */
export const SIMC_RELEASE = {
  tag: 'simc-wasm-r359',
  /** Upstream SimC commit (midnight branch) the release was built from. */
  simcCommit: '426ad85ecb1c5d9a1af166931478dabf29b42fdd',
  /** Game data the build carries. */
  gameVersion: '12.1.5.70575',
};

/**
 * Where the page loads the engine from: functions/simc/ in production, vite/simcPlugin.ts on the
 * dev server. The tag is in the path so a new release is a new URL, cached for good.
 */
export const SIMC_BASE = `/simc/${SIMC_RELEASE.tag}/`;
export const SIMC_FILES = { script: 'simc_wasm.js', wasm: 'simc_wasm.wasm' };
