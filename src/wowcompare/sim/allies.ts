import { captureException } from 'common/errorLogger';
import { fetchCombatants } from 'common/fetchWclApi';
import { CombatantInfoEvent, EventType } from 'parser/core/Events';
import { useEffect, useRef, useState } from 'react';

import type { TalentTree } from '../benchmarks/talents';
import { loadTalentTree } from '../talentTrees';
import { allyFromCombatantInfo, SimAlly } from './profileFromLog';

/**
 * WoWCompare: Augmentation sims, which need other players to buff. Warcraft Logs credits an
 * Augmentation with the damage its Ebon Might and Prescience add to others, which a sim of the
 * player alone can't see. Standard sims use the raid SimC builds around a lone Augmentation (eight
 * generic players); high accuracy sims the players from the log it buffed most, with their own
 * gear and talents, which takes several minutes.
 */

export type AugSimMode = 'standard' | 'raid';

/** Ebon Might buffs four allies at a time; the ones buffed most are the ones simmed. */
export const MAX_ALLIES = 4;

const MODE_KEY = 'wowcompare:augSimMode';
const ASK_KEY = 'wowcompare:augSimAsk';

/** The mode to use without asking, when the player ticked "don't ask again"; else null. */
export function rememberedAugMode(): AugSimMode | null {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return localStorage.getItem(ASK_KEY) === 'no' && (mode === 'standard' || mode === 'raid')
      ? mode
      : null;
  } catch {
    return null;
  }
}

export function lastAugMode(): AugSimMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'raid' ? 'raid' : 'standard';
  } catch {
    return 'standard';
  }
}

export function rememberAugMode(mode: AugSimMode, ask: boolean) {
  try {
    localStorage.setItem(MODE_KEY, mode);
    localStorage.setItem(ASK_KEY, ask ? 'yes' : 'no');
  } catch {
    // Not remembered; it still applies on this page.
  }
}

/** Where sims read the fight and its players from (ProfileMetrics). */
export interface SimSource {
  reportCode: string;
  /** The analyzed range, in report timestamps. */
  fightStart: number;
  fightEnd: number;
  /** Augmentation: allies by time with the player's Ebon Might or Prescience, most first. */
  buffedAllies: { id: number; name: string; buffedMs: number }[];
}

export type SimAllies =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; allies: { ally: SimAlly; tree: TalentTree }[] };

/** The allies to sim with, from their combatantinfo; only fetched when `enabled`. */
export function useSimAllies(source: SimSource | undefined, enabled: boolean): SimAllies {
  const [result, setResult] = useState<SimAllies>({ state: 'idle' });
  // The source is rebuilt on every render; refetch only when what it names changes.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const key =
    source &&
    [
      source.reportCode,
      source.fightStart,
      source.fightEnd,
      ...source.buffedAllies.slice(0, MAX_ALLIES).map((a) => a.id),
    ].join(':');
  useEffect(() => {
    const source = sourceRef.current;
    if (!enabled || !source || !key) {
      setResult({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setResult({ state: 'loading' });
    loadAllies(source).then(
      (allies) => !cancelled && setResult({ state: 'done', allies }),
      (err) => {
        captureException(err as Error);
        if (!cancelled) {
          setResult({ state: 'done', allies: [] });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, enabled]);
  return result;
}

async function loadAllies(source: SimSource) {
  const wanted = source.buffedAllies.slice(0, MAX_ALLIES);
  if (wanted.length === 0) {
    return [];
  }
  const events = await fetchCombatants(source.reportCode, source.fightStart, source.fightEnd);
  const infos = events.filter(
    (event): event is CombatantInfoEvent => event.type === EventType.CombatantInfo,
  );
  const allies = await Promise.all(
    wanted.map(async ({ id, name }) => {
      const info = infos.find((event) => event.sourceID === id);
      const ally = info && allyFromCombatantInfo(info, name);
      const tree = ally && (await loadTalentTree(ally.specId));
      return ally && tree ? [{ ally, tree }] : [];
    }),
  );
  return allies.flat();
}
