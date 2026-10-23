import EVOKER from 'common/SPELLS/evoker';
import { TALENTS_PRIEST } from 'common/TALENTS/priest';

import { LogSnapshot } from '../metrics/results';
import { median } from './aggregate';
import type { RankedParse } from './rankings';

/**
 * What a player is measured against: the median of logs spread over this percentile range of all
 * parses for the spec, boss and difficulty. The top few parses are mostly groups set up to pump one
 * player (Power Infusion, Augmentation, short kills), which makes advice drawn from them
 * unreachable.
 */
export const REFERENCE_BAND = { from: 90, to: 95 } as const;
export const REFERENCE_LABEL = `${REFERENCE_BAND.from}–${REFERENCE_BAND.to}th percentile`;
/**
 * Logs parsed per boss, evenly spread over the band. Parsing the whole band would take thousands
 * of logs per spec, far past WCL's hourly point budget; a median of 20 spread logs lands within a
 * few percent of the band's. About a third are externally buffed (Feral, Heroic, October 2026).
 */
export const REFERENCE_CANDIDATES = 20;
/** With fewer unbuffed candidates than this, the reference keeps the buffed ones. */
export const MIN_UNBUFFED = 5;
/**
 * Kills more than this many (scaled) median absolute deviations shorter than the pool's median
 * are left out: overgeared or stacked groups, whose DPS is inflated by burst.
 */
const SHORT_KILL_MADS = 3;
/** Scales the MAD to a standard deviation for normally distributed data. */
const MAD_TO_SIGMA = 1.4826;

const POWER_INFUSION = TALENTS_PRIEST.POWER_INFUSION_TALENT.id;
const AUGMENTATION_BUFFS = [EVOKER.EBON_MIGHT_BUFF_EXTERNAL.id, EVOKER.PRESCIENCE_BUFF.id];
/** Damage buffs other players cast on one player; logs funnelled these are optionally left out. */
export const EXTERNAL_BUFF_IDS = [POWER_INFUSION, ...AUGMENTATION_BUFFS];
/**
 * Power Infusion (15s every 2 min, so at most 12.5% uptime from one priest) at half its maximum
 * or more: a priest giving it to this player on cooldown, not a one-off.
 */
export const POWER_INFUSION_MIN_UPTIME = 0.0625;
/**
 * Ebon Might and Prescience combined: an Augmentation Evoker keeping them on this player. Measured
 * logs split cleanly into under 16% (none, or PI only) and over 65% (Feral, Heroic, October 2026).
 */
export const AUGMENTATION_MIN_UPTIME = 0.2;

const uptimeOf = (snapshot: LogSnapshot, ids: number[]) =>
  (snapshot.externalBuffs ?? [])
    .filter((buff) => ids.includes(buff.spellId))
    .reduce((sum, buff) => sum + buff.uptime, 0);

export const isExternallyBuffed = (snapshot: LogSnapshot) =>
  uptimeOf(snapshot, [POWER_INFUSION]) >= POWER_INFUSION_MIN_UPTIME ||
  uptimeOf(snapshot, AUGMENTATION_BUFFS) >= AUGMENTATION_MIN_UPTIME;

export interface ReferenceBand {
  /** Ranked parses for the spec, boss and difficulty; null when unknown (v1 mode). */
  totalParses: number | null;
  /** Ranks spanning the band, best first; the deepest fetched when the band is out of reach. */
  ranks: [number, number];
  /** Parses spread evenly over `ranks` (short kills left out), best first. */
  candidates: RankedParse[];
}

/** The rank at `percentile`: e.g. the 90th percentile of 3,000 parses is rank 300. */
const rankAtPercentile = (totalParses: number, percentile: number) =>
  Math.max(1, Math.round(totalParses * (1 - percentile / 100)));

/** Share of parses at or below `rank`, as a percentile. */
export const percentileOfRank = (rank: number, totalParses: number) =>
  Math.max(0, Math.min(100, 100 * (1 - rank / totalParses)));

/**
 * The ranks to take candidates at: `REFERENCE_CANDIDATES` evenly spread over the band, no deeper
 * than `deepest`. Without a total, only `deepest` (the deepest parses stand in for the band).
 */
export function targetRanks(totalParses: number | null, deepest: number): number[] {
  if (totalParses === null) {
    return [deepest];
  }
  const best = Math.min(rankAtPercentile(totalParses, REFERENCE_BAND.to), deepest);
  const worst = Math.min(rankAtPercentile(totalParses, REFERENCE_BAND.from), deepest);
  return Array.from({ length: REFERENCE_CANDIDATES }, (_, i) =>
    Math.round(best + ((worst - best) * i) / (REFERENCE_CANDIDATES - 1)),
  );
}

/** Parses whose kill is far shorter than is typical for the pool. */
function withoutShortKills(pool: RankedParse[]): RankedParse[] {
  const durations = pool.map((parse) => parse.durationMs);
  const mid = median(durations);
  const mad = median(durations.map((d) => Math.abs(d - (mid ?? 0))));
  if (mid === null || !mad) {
    return pool;
  }
  return pool.filter((parse) => parse.durationMs >= mid - SHORT_KILL_MADS * MAD_TO_SIGMA * mad);
}

/**
 * The candidates for the reference median from `pool` (ranked parses covering the band, best
 * first): for each of `targetRanks`, the nearest parse not already taken.
 */
export function selectReference(pool: RankedParse[], totalParses: number | null): ReferenceBand {
  const deepest = pool.reduce((max, parse) => Math.max(max, parse.rank), 0);
  const targets = targetRanks(totalParses, deepest);
  const available = withoutShortKills(pool);
  const candidates: RankedParse[] = [];
  // Several targets can share a nearest parse when the band is narrow; each takes the next one.
  const wanted = targets.length === 1 ? Array(REFERENCE_CANDIDATES).fill(targets[0]) : targets;
  for (const target of wanted) {
    const nearest = available
      .filter((parse) => !candidates.includes(parse))
      .sort((a, b) => Math.abs(a.rank - target) - Math.abs(b.rank - target) || a.rank - b.rank)[0];
    if (nearest) {
      candidates.push(nearest);
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return { totalParses, ranks: [targets[0], targets[targets.length - 1]], candidates };
}

export interface ReferencePick<T> {
  picked: T[];
  /** Externally buffed candidates left out. */
  leftOut: number;
  /** Too few unbuffed candidates, so buffed ones were kept. */
  keptBuffed: boolean;
}

/**
 * The logs the reference median is taken over: every parsed candidate, leaving out externally
 * buffed ones when `excludeBuffed` (unless too few would remain).
 */
export function pickReference<T>(
  candidates: T[],
  snapshotOf: (candidate: T) => LogSnapshot | null | undefined,
  excludeBuffed: boolean,
): ReferencePick<T> {
  const parsed = candidates.filter((candidate) => !!snapshotOf(candidate));
  const unbuffed = parsed.filter((candidate) => !isExternallyBuffed(snapshotOf(candidate)!));
  const leaveOut = excludeBuffed && unbuffed.length < parsed.length;
  const keptBuffed = leaveOut && unbuffed.length < MIN_UNBUFFED;
  const pool = leaveOut && !keptBuffed ? unbuffed : parsed;
  return {
    picked: pool,
    leftOut: pool === unbuffed ? parsed.length - unbuffed.length : 0,
    keptBuffed,
  };
}
