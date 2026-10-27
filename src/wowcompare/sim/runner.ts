import { useSyncExternalStore } from 'react';

import { SIMC_BASE, SIMC_RELEASE } from './engine';

/**
 * WoWCompare: the page's one SimC worker (public/simc-worker.js). The engine downloads and starts
 * once and then serves every sim; results are cached in this browser by the SimC input and engine
 * release, so reopening a log doesn't sim it again.
 */

export interface SimResult {
  /** The baseline profile's DPS. */
  baseline: number;
  sets: { name: string; mean: number; error: number }[];
}

export type EngineState =
  | { state: 'idle' }
  | { state: 'downloading'; loaded: number; total: number }
  | { state: 'ready' }
  | { state: 'error'; error: string };

const AUTO_KEY = 'wowcompare:autoSim';
const CACHE_PREFIX = `wowcompare:sim:${SIMC_RELEASE.tag}:`;
/** Devices with less memory than this (GB, where the browser says) don't sim unless asked. */
const MIN_DEVICE_MEMORY = 4;

/** Whether this browser can run the engine at all: it needs cross-origin isolation. */
export const canSim = () => typeof window !== 'undefined' && window.crossOriginIsolated === true;

let engineState: EngineState = { state: 'idle' };
const listeners = new Set<() => void>();
const setEngineState = (next: EngineState) => {
  engineState = next;
  listeners.forEach((listener) => listener());
};
export const useEngineState = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => engineState,
  );

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (result: SimResult) => void;
    reject: (err: Error) => void;
    onProgress: (done: number) => void;
  }
>();

function getWorker(): Worker {
  if (worker) {
    return worker;
  }
  worker = new Worker('/simc-worker.js');
  worker.onerror = (event) => {
    const error = event.message || 'The sim worker failed to load';
    setEngineState({ state: 'error', error });
    pending.forEach((job) => job.reject(new Error(error)));
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    const job = data.id !== undefined ? pending.get(data.id) : undefined;
    switch (data.type) {
      case 'download':
        setEngineState({ state: 'downloading', loaded: data.loaded, total: data.total });
        break;
      case 'ready':
        setEngineState({ state: 'ready' });
        break;
      case 'progress':
        job?.onProgress(data.done);
        break;
      case 'done':
        pending.delete(data.id);
        job?.resolve({ baseline: data.baseline.mean, sets: data.sets });
        break;
      case 'error':
        if (job) {
          pending.delete(data.id);
          job.reject(new Error(data.error));
        } else {
          setEngineState({ state: 'error', error: data.error });
        }
        break;
    }
  };
  return worker;
}

/** Downloads and starts the engine ahead of the first sim. */
export function preloadEngine() {
  if (canSim() && engineState.state === 'idle') {
    setEngineState({ state: 'downloading', loaded: 0, total: 0 });
    getWorker().postMessage({ type: 'preload', base: SIMC_BASE });
  }
}

/** A short, stable key for a SimC input (FNV-1a). */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cachedSim(input: string): SimResult | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + hash(input));
    return raw ? (JSON.parse(raw) as SimResult) : null;
  } catch {
    return null;
  }
}

/** Sims `input`, or returns the cached result for it. */
export function runSim(input: string, onProgress: (done: number) => void): Promise<SimResult> {
  const cached = cachedSim(input);
  if (cached) {
    return Promise.resolve(cached);
  }
  const id = nextId++;
  return new Promise<SimResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ type: 'run', id, base: SIMC_BASE, input });
  }).then((result) => {
    try {
      localStorage.setItem(CACHE_PREFIX + hash(input), JSON.stringify(result));
    } catch {
      // Not cached; it still shows on this page.
    }
    return result;
  });
}

/** Whether to sim automatically: on by default, off on low-memory devices, remembered once set. */
export function autoSim(): boolean {
  try {
    const stored = localStorage.getItem(AUTO_KEY);
    if (stored !== null) {
      return stored === '1';
    }
  } catch {
    // Fall through to the default.
  }
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return memory === undefined || memory >= MIN_DEVICE_MEMORY;
}

export function setAutoSim(on: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, on ? '1' : '0');
  } catch {
    // Not remembered; it applies on this page.
  }
}
