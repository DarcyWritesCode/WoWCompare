import EVOKER from 'common/SPELLS/evoker';
import { TALENTS_PRIEST } from 'common/TALENTS/priest';

import { LogSnapshot } from '../metrics/results';
import { median } from './aggregate';
import type { RankedParse } from './rankings';

/**
 * What a player is measured against: the median of logs around this percentile of all parses for
 * the spec, boss and difficulty. The top few parses are mostly groups set up to pump one player
 * (Power Infusion, Augmentation, short kills), which makes advice drawn from them unreachable.
 */
export const REFERENCE_PERCENTILE = 90;
/** Logs the reference median is taken over. */
export const REFERENCE_SIZE = 10;
/**
 * Parses picked around the target rank, so `REFERENCE_SIZE` are left after leaving out
 * externally buffed logs (when the viewer asks) and logs that fail to parse. About a third of
 * 90th-percentile logs are buffed (Feral, Heroic, October 2026).
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
  percentile: number;
  /** Ranked parses for the spec, boss and difficulty; null when unknown (v1 mode). */
  totalParses: number | null;
  /** The rank aimed for; the deepest fetched rank when the target is out of reach. */
  targetRank: number;
  /** Parses nearest `targetRank` (short kills left out), nearest first. */
  candidates: RankedParse[];
}

/** The rank at `percentile`: e.g. the 90th percentile of 3,000 parses is rank 300. */
export const rankAtPercentile = (totalParses: number, percentile: number) =>
  Math.max(1, Math.round(totalParses * (1 - percentile / 100)));

/** Share of parses at or below `rank`, as a percentile. */
export const percentileOfRank = (rank: number, totalParses: number) =>
  Math.max(0, Math.min(100, 100 * (1 - rank / totalParses)));

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
 * The candidates for the reference median from `pool` (ranked parses around the target rank, best
 * first). Without a total, or when the target is past the deepest fetched rank (WCL serves 2,000
 * at most), the deepest parses stand in.
 */
export function selectReference(
  pool: RankedParse[],
  totalParses: number | null,
  percentile = REFERENCE_PERCENTILE,
): ReferenceBand {
  const deepest = pool.reduce((max, parse) => Math.max(max, parse.rank), 0);
  const targetRank =
    totalParses === null ? deepest : Math.min(rankAtPercentile(totalParses, percentile), deepest);
  const candidates = withoutShortKills(pool)
    .map((parse) => ({ parse, distance: Math.abs(parse.rank - targetRank) }))
    .sort((a, b) => a.distance - b.distance || a.parse.rank - b.parse.rank)
    .slice(0, REFERENCE_CANDIDATES)
    .map(({ parse }) => parse);
  return { percentile, totalParses, targetRank, candidates };
}

export interface ReferencePick<T> {
  picked: T[];
  /** Externally buffed candidates left out. */
  leftOut: number;
  /** Too few unbuffed candidates, so buffed ones were kept. */
  keptBuffed: boolean;
}

/**
 * The logs the reference median is taken over: the first `REFERENCE_SIZE` parsed candidates,
 * leaving out externally buffed ones when `excludeBuffed` (unless too few would remain).
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
    picked: pool.slice(0, REFERENCE_SIZE),
    leftOut: pool === unbuffed ? parsed.length - unbuffed.length : 0,
    keptBuffed,
  };
}
