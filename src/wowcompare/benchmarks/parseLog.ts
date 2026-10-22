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
import { ProfileResults } from '../metrics/results';

export interface LogRef {
  reportCode: string;
  fightId: number;
  playerName: string;
  serverName?: string;
}

/** Events processed between yields to the browser, so the page stays responsive. */
const BATCH_SIZE = 5000;

const cache = new Map<string, Promise<ProfileResults | null>>();

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

async function parse(config: Config, ref: LogRef): Promise<ProfileResults | null> {
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
  return parser.getModule(ProfileMetrics)?.results() ?? null;
}

/**
 * Runs one benchmark log through the same parser and profile metrics as the analyzed log.
 * Results are cached for the session (Phase 5 moves this to a shared Supabase cache).
 */
export function parseBenchmarkLog(config: Config, ref: LogRef): Promise<ProfileResults | null> {
  const key = `${ref.reportCode}:${ref.fightId}:${ref.playerName}`;
  let result = cache.get(key);
  if (!result) {
    result = parse(config, ref);
    result.catch(() => cache.delete(key));
    cache.set(key, result);
  }
  return result;
}
