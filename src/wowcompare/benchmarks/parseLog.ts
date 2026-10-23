import { fetchFights, USE_WCL_V2 } from 'common/fetchWclApi';
import makeApiUrl from 'common/makeApiUrl';
import { fetchPlayerDetails } from 'common/wclV2/adapter';
import { getAccessToken } from 'common/wclV2/auth';
import { fetchPlayerEvents } from 'interface/report/hooks/useEvents';
import Config from 'parser/Config';
import CharacterProfile from 'parser/core/CharacterProfile';
import { AnyEvent, CombatantInfoEvent, EventType } from 'parser/core/Events';
import EventEmitter from 'parser/core/modules/EventEmitter';
import { PlayerDetails } from 'parser/core/Player';
import Report from 'parser/core/Report';

import ProfileMetrics from '../metrics/ProfileMetrics';
import { LogSnapshot } from '../metrics/results';
import { setProfile } from '../profile/registry';
import { Profile } from '../profile/types';
import type { ParseRequest, ParseResponse } from './parseWorker';
import { logKey, profileFingerprint } from './published';

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

/** The fight's players with their roles, from WCL directly in v2 mode, else WoWAnalyzer's API. */
async function fetchPlayers(reportCode: string, fightId: number): Promise<PlayerDetails[]> {
  if (USE_WCL_V2) {
    return fetchPlayerDetails(reportCode, fightId);
  }
  const response = await fetch(makeApiUrl(`v2/report/${reportCode}/fight/${fightId}/players`));
  if (!response.ok) {
    throw new Error(`Players of ${reportCode} fight ${fightId}: HTTP ${response.status}`);
  }
  return ((await response.json()) as { players: PlayerDetails[] }).players;
}

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

  const players = await fetchPlayers(ref.reportCode, ref.fightId);
  const named = players.filter((p) => p.name === ref.playerName);
  const player = named.find((p) => p.server === ref.serverName) ?? named[0];
  if (!player) {
    throw new Error(`${ref.playerName} not found in ${ref.reportCode} fight ${ref.fightId}`);
  }

  const events: AnyEvent[] = [];
  for await (const range of fetchPlayerEvents(report, fight, player)) {
    // Not push(...events): a long page would overflow the argument limit.
    range.events.forEach((event) => events.push(event));
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
  profile: Profile;
  ref: LogRef;
  resolve: (snapshot: LogSnapshot | null) => void;
  reject: (err: Error) => void;
  /** Pool slot of the worker handling it. */
  slot: number;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<number, PendingRequest>();

/**
 * A log that hasn't come back by now is treated as failed and its worker replaced: a worker that
 * runs out of memory can die without an error event, which would otherwise stall loading forever.
 */
const PARSE_TIMEOUT_MS = 120_000;

/** A worker that fails to load (e.g. a module touching the DOM) disables the pool for good. */
function abandonWorkers(err: unknown) {
  console.warn('benchmark workers failed, parsing on the main thread', err);
  workers?.forEach((worker) => worker.terminate());
  workers = null;
  const requests = [...pending.values()];
  pending.clear();
  requests.forEach(({ config, profile, ref, resolve, reject, timer }) => {
    clearTimeout(timer);
    parseOnMainThread(config, profile, ref).then(resolve, reject);
  });
}

function createWorker(): Worker {
  const worker = new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<ParseResponse>) => {
    const request = pending.get(data.id);
    if (!request) {
      return;
    }
    pending.delete(data.id);
    clearTimeout(request.timer);
    if ('error' in data) {
      request.reject(new Error(data.error));
    } else {
      request.resolve(data.snapshot);
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    abandonWorkers(`${event.message} (${event.filename}:${event.lineno})`);
  };
  return worker;
}

/** Lazily starts the worker pool; null where workers aren't available (falls back to the main thread). */
function getWorkers(): Worker[] | null {
  if (workers === undefined) {
    try {
      workers = Array.from({ length: WORKER_COUNT }, createWorker);
    } catch (err) {
      abandonWorkers(err);
    }
  }
  return workers ?? null;
}

/** Fails a stuck request and swaps in a fresh worker; the slot's other requests are re-sent. */
function timeOut(id: number) {
  const request = pending.get(id);
  if (!request || !workers) {
    return;
  }
  pending.delete(id);
  request.reject(new Error(`Timed out after ${PARSE_TIMEOUT_MS / 1000}s`));
  workers[request.slot].terminate();
  workers[request.slot] = createWorker();
  for (const [otherId, other] of pending) {
    if (other.slot === request.slot) {
      clearTimeout(other.timer);
      send(otherId, other);
    }
  }
}

function send(id: number, request: Omit<PendingRequest, 'timer'>) {
  const timer = setTimeout(() => timeOut(id), PARSE_TIMEOUT_MS);
  pending.set(id, { ...request, timer });
  workers![request.slot].postMessage({
    id,
    specId: request.config.spec.id,
    profile: request.profile,
    ref: request.ref,
    wclToken: getAccessToken(),
  } satisfies ParseRequest);
}

function parseOnMainThread(config: Config, profile: Profile, ref: LogRef) {
  setProfile(config.spec.id, profile);
  return parseLogSnapshot(config, ref);
}

function parseInWorker(config: Config, profile: Profile, ref: LogRef): Promise<LogSnapshot | null> {
  const pool = getWorkers();
  if (!pool) {
    return parseOnMainThread(config, profile, ref);
  }
  const id = (nextRequestId += 1);
  const slot = nextWorker++ % pool.length;
  return new Promise((resolve, reject) => {
    send(id, { config, profile, ref, resolve, reject, slot });
  });
}

/**
 * Runs one benchmark log through the same parser and profile as the analyzed log, in a Web
 * Worker. Results are kept for the session. (The nightly job's published top-10 snapshots are
 * used instead where they match the profile; see `useBenchmarks`.)
 */
export function parseBenchmarkLog(
  config: Config,
  profile: Profile,
  ref: LogRef,
): Promise<LogSnapshot | null> {
  // By fingerprint, not version: an accepted suggestion changes the profile but not its version.
  const key = `${profileFingerprint(profile)}:${logKey(ref)}`;
  let result = cache.get(key);
  if (!result) {
    result = parseInWorker(config, profile, ref);
    result.catch(() => cache.delete(key));
    cache.set(key, result);
  }
  return result;
}
