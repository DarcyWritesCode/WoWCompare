import { fetchFights } from 'common/fetchWclApi';
import makeApiUrl from 'common/makeApiUrl';
import { fetchPlayerEvents } from 'interface/report/hooks/useEvents';
import Config from 'parser/Config';
import CharacterProfile from 'parser/core/CharacterProfile';
import { AnyEvent, CombatantInfoEvent, EventType } from 'parser/core/Events';
import EventEmitter from 'parser/core/modules/EventEmitter';
import { PlayerDetails } from 'parser/core/Player';
import Report from 'parser/core/Report';

import ProfileMetrics from '../metrics/ProfileMetrics';
import { LogSnapshot } from '../metrics/results';
import type { ParseRequest, ParseResponse } from './parseWorker';

export interface LogRef {
  reportCode: string;
  fightId: number;
  playerName: string;
  serverName?: string;
}

/** Events processed between yields to the browser, so the page stays responsive. */
const BATCH_SIZE = 5000;

const cache = new Map<string, Promise<LogSnapshot | null>>();

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fetches and parses one log in the current thread. */
export async function parseLogSnapshot(config: Config, ref: LogRef): Promise<LogSnapshot | null> {
  const report: Report = {
    ...(await fetchFights(ref.reportCode)),
    code: ref.reportCode,
    isAnonymous: false,
  };
  const fight = report.fights.find((f) => f.id === ref.fightId);
  if (!fight) {
    throw new Error(`Fight ${ref.fightId} not found in ${ref.reportCode}`);
  }

  const { players }: { players: PlayerDetails[] } = await fetch(
    makeApiUrl(`v2/report/${ref.reportCode}/fight/${ref.fightId}/players`),
  ).then((res) => res.json());
  const named = players.filter((p) => p.name === ref.playerName);
  const player = named.find((p) => p.server === ref.serverName) ?? named[0];
  if (!player) {
    throw new Error(`${ref.playerName} not found in ${ref.reportCode} fight ${ref.fightId}`);
  }

  let events: AnyEvent[] = [];
  for await (const range of fetchPlayerEvents(report, fight, player)) {
    events = events.concat(range.events);
  }
  const combatantInfo = events.find(
    (event): event is CombatantInfoEvent =>
      event.type === EventType.CombatantInfo && event.sourceID === player.id,
  );
  if (!combatantInfo) {
    throw new Error(`No combatantinfo for ${ref.playerName} in ${ref.reportCode}`);
  }

  const parserClass = await config.parser!();
  const parser = new parserClass(
    config,
    report,
    player,
    { ...fight, offset_time: 0, original_end_time: fight.end_time, filtered: false },
    combatantInfo,
    null as unknown as CharacterProfile, // optional; the live analysis also passes null when unavailable
    players,
  );
  parser.normalizedEvents = parser.normalize(events).sort((a, b) => a.timestamp - b.timestamp);

  const emitter = parser.getModule(EventEmitter);
  for (let i = 0; i < parser.normalizedEvents.length; i += 1) {
    emitter.triggerEvent(parser.normalizedEvents[i]);
    if (i % BATCH_SIZE === BATCH_SIZE - 1) {
      await yieldToBrowser();
    }
  }
  parser.finish();
  return parser.getModule(ProfileMetrics)?.snapshot() ?? null;
}

const WORKER_COUNT = 3;
let workers: Worker[] | null | undefined;
let nextWorker = 0;
let nextRequestId = 0;
interface PendingRequest {
  config: Config;
  ref: LogRef;
  resolve: (snapshot: LogSnapshot | null) => void;
  reject: (err: Error) => void;
}
const pending = new Map<number, PendingRequest>();

/** A worker that fails to load (e.g. a module touching the DOM) disables the pool for good. */
function abandonWorkers(err: unknown) {
  console.warn('benchmark workers failed, parsing on the main thread', err);
  workers?.forEach((worker) => worker.terminate());
  workers = null;
  const requests = [...pending.values()];
  pending.clear();
  requests.forEach(({ config, ref, resolve, reject }) =>
    parseLogSnapshot(config, ref).then(resolve, reject),
  );
}

/** Lazily starts the worker pool; null where workers aren't available (falls back to the main thread). */
function getWorkers(): Worker[] | null {
  if (workers === undefined) {
    try {
      workers = Array.from({ length: WORKER_COUNT }, () => {
        const worker = new Worker(new URL('./parseWorker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = ({ data }: MessageEvent<ParseResponse>) => {
          const request = pending.get(data.id);
          pending.delete(data.id);
          if ('error' in data) {
            request?.reject(new Error(data.error));
          } else {
            request?.resolve(data.snapshot);
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          abandonWorkers(`${event.message} (${event.filename}:${event.lineno})`);
        };
        return worker;
      });
    } catch (err) {
      abandonWorkers(err);
    }
  }
  return workers ?? null;
}

function parseInWorker(config: Config, ref: LogRef): Promise<LogSnapshot | null> {
  const pool = getWorkers();
  if (!pool) {
    return parseLogSnapshot(config, ref);
  }
  const id = (nextRequestId += 1);
  const worker = pool[nextWorker++ % pool.length];
  return new Promise((resolve, reject) => {
    pending.set(id, { config, ref, resolve, reject });
    worker.postMessage({ id, specId: config.spec.id, ref } satisfies ParseRequest);
  });
}

/**
 * Runs one benchmark log through the same parser and profile metrics as the analyzed log, in a
 * Web Worker. Results are cached for the session (Phase 5 moves this to a shared Supabase cache).
 */
export function parseBenchmarkLog(config: Config, ref: LogRef): Promise<LogSnapshot | null> {
  const key = `${ref.reportCode}:${ref.fightId}:${ref.playerName}`;
  let result = cache.get(key);
  if (!result) {
    result = parseInWorker(config, ref);
    result.catch(() => cache.delete(key));
    cache.set(key, result);
  }
  return result;
}
