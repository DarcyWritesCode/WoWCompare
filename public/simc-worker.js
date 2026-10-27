/* eslint-disable */
// WoWCompare: runs SimulationCraft jobs (src/wowcompare/sim/). A classic worker because the
// engine's Emscripten glue loads with importScripts. The page must be cross-origin isolated: the
// engine is multi-threaded and needs SharedArrayBuffer. One worker serves a page's sims, so the
// engine downloads and starts once.
//
// In:  { type: 'preload', base }       download and start the engine
//      { type: 'run', id, base, input } sim a SimC profile with profilesets
// Out: { type: 'download', loaded, total }, { type: 'ready' },
//      { type: 'progress', id, done: 0..1 }, { type: 'done', id, baseline, sets },
//      { type: 'error', id?, error }

let engine = null;
/**
 * Progress across the baseline and profilesets, from the line the engine prints as each one
 * finishes: "Generating : 1/9 [...]", then "Generating Profileset: name 2/9 [...]".
 */
let setsDone = 0;
let setCount = 0;

/** The engine binary, with download progress (the glue would fetch it silently). */
async function fetchEngine(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Couldn't download the sim engine: HTTP ${response.status}`);
  }
  // Compressed responses report the compressed length; progress then shows bytes only.
  const total = response.headers.get('content-encoding')
    ? 0
    : Number(response.headers.get('content-length') ?? 0);
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.length;
    if (performance.now() - last > 250) {
      last = performance.now();
      postMessage({ type: 'download', loaded, total });
    }
  }
  const binary = new Uint8Array(loaded);
  let offset = 0;
  chunks.forEach((chunk) => {
    binary.set(chunk, offset);
    offset += chunk.length;
  });
  return binary;
}

function start(base) {
  if (!engine) {
    const script = new URL(`${base}simc_wasm.js`, self.location.href).href;
    importScripts(script);
    engine = fetchEngine(new URL(`${base}simc_wasm.wasm`, self.location.href).href).then(
      (wasmBinary) =>
        // Without mainScriptUrlOrBlob the engine can't find its own script to start its thread
        // pool from inside a worker, and hangs.
        createSimC({
          mainScriptUrlOrBlob: script,
          wasmBinary,
          print: (line) => {
            const m = /^Generating.* (\d+)\/(\d+) \[/.exec(line);
            if (m) {
              setsDone = Number(m[1]);
              setCount = Number(m[2]);
            }
          },
          printErr: () => {},
        }),
    );
    engine.then(() => postMessage({ type: 'ready' }));
  }
  return engine;
}

/** Runs one job at a time: the engine holds a single sim. */
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  if (data.type === 'preload') {
    start(data.base).catch((err) => postMessage({ type: 'error', error: String(err) }));
    return;
  }
  queue = queue.then(() => run(data));
};

async function run({ id, base, input }) {
  try {
    const Module = await start(base);
    const sim = new Module.SimC();
    const error = sim.configure(input);
    if (error) {
      postMessage({ type: 'error', id, error });
      return;
    }
    setsDone = 0;
    setCount = 0;
    Module._sf_execute_async();
    while (!Module._sf_is_finished()) {
      const total = Module._sf_get_total_iterations();
      const within = total > 0 ? Module._sf_get_iteration() / total : 0;
      // The baseline first, then each profileset: count them all as equal steps.
      const done = setCount > 0 ? Math.min(1, (setsDone + within) / setCount) : within * 0.15;
      postMessage({ type: 'progress', id, done });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!Module._sf_get_success()) {
      postMessage({ type: 'error', id, error: sim.getLastError() });
      return;
    }
    const json = JSON.parse(sim.getResultsJSON());
    sim.delete();
    const dps = json.sim.players[0].collected_data.dps;
    postMessage({
      type: 'done',
      id,
      baseline: { mean: dps.mean, error: dps.mean_std_dev * 1.96 },
      sets: (json.sim.profilesets?.results ?? []).map((set) => ({
        name: set.name,
        mean: set.mean,
        error: set.mean_error,
      })),
    });
  } catch (err) {
    postMessage({ type: 'error', id, error: String(err) });
  }
}
