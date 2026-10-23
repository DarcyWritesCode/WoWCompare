import { AuraUsage, entryResult, LogSnapshot } from '../metrics/results';
import { MetricKind, Profile, ProfileEntry } from '../profile/types';
import { median } from './aggregate';

/** An aura counts as "kept up" in a log above this uptime. */
const MIN_UPTIME = 0.05;
/** Above this it's a passive or form that's always on; nothing to grade. */
const MAX_MEDIAN_UPTIME = 0.98;
/** Share of top logs that must keep it up for it to be suggested. */
const MIN_TOP_SHARE = 0.7;
const MAX_SUGGESTIONS = 10;
/** Fewer logs than this and a correlation means nothing. */
const MIN_LOGS_FOR_RANK = 6;

export interface MissingAura {
  token: string;
  name: string;
  spellId: number;
  kind: AuraUsage['kind'];
  /** Share of top logs that keep it up. */
  topShare: number;
  medianUptime: number;
  /** The analysed log's uptime, null if the player never had it. */
  playerUptime: number | null;
}

/**
 * Buffs and debuffs most top parses keep up that the profile doesn't track, e.g. Balance's
 * Starlord, which SimC handles internally and so never appears in the APL.
 */
export function missingAuras(
  profile: Profile,
  player: LogSnapshot,
  topLogs: LogSnapshot[],
  /** Keeps class spells only, so trinket/enchant/consumable buffs aren't suggested. */
  isClassSpell: (spellId: number, token: string) => boolean = () => true,
): MissingAura[] {
  if (topLogs.length === 0) {
    return [];
  }
  // Already tracked: by token, or by the spell a log resolved an entry to.
  const tracked = new Set<string>(profile.entries.map((e) => e.token));
  const trackedIds = new Set<number>(
    [player, ...topLogs].flatMap((log) => log.results.entries.map((e) => e.spellId)),
  );

  const byToken = new Map<string, { aura: AuraUsage; uptimes: number[] }>();
  for (const log of topLogs) {
    for (const aura of log.auras) {
      if (
        aura.uptime < MIN_UPTIME ||
        tracked.has(aura.token) ||
        trackedIds.has(aura.spellId) ||
        !isClassSpell(aura.spellId, aura.token)
      ) {
        continue;
      }
      const key = `${aura.kind}:${aura.token}`;
      const entry = byToken.get(key) ?? { aura, uptimes: [] };
      entry.uptimes.push(aura.uptime);
      byToken.set(key, entry);
    }
  }

  return [...byToken.values()]
    .map(({ aura, uptimes }) => ({
      token: aura.token,
      name: aura.name,
      spellId: aura.spellId,
      kind: aura.kind,
      topShare: uptimes.length / topLogs.length,
      medianUptime: median(uptimes) ?? 0,
      playerUptime:
        player.auras.find((a) => a.token === aura.token && a.kind === aura.kind)?.uptime ?? null,
    }))
    .filter((m) => m.topShare >= MIN_TOP_SHARE && m.medianUptime <= MAX_MEDIAN_UPTIME)
    .sort((a, b) => b.medianUptime * b.topShare - a.medianUptime * a.topShare)
    .slice(0, MAX_SUGGESTIONS);
}

/** Pearson correlation; null when either side has no spread. */
export function correlation(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 2) {
    return null;
  }
  const mean = (i: 0 | 1) => pairs.reduce((sum, p) => sum + p[i], 0) / n;
  const [mx, my] = [mean(0), mean(1)];
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

export interface RankSuggestion {
  entry: ProfileEntry;
  metric: MetricKind | null;
  /** Correlation of the metric with fight DPS across the logs; null without enough data. */
  r: number | null;
  logs: number;
  suggestedRank: number;
}

/**
 * Re-ranks entries by how strongly each one's main metric tracks DPS across the parsed logs (the
 * player plus benchmarks). Entries without enough data keep their APL order, after the rest.
 */
export function suggestRanks(profile: Profile, logs: LogSnapshot[]): RankSuggestion[] {
  const scored = profile.entries.map((entry) => {
    const metric =
      entry.metrics.find((kind) =>
        logs.some(
          (log) => typeof entryResult(log.results, entry)?.metrics[kind]?.value === 'number',
        ),
      ) ?? null;
    const pairs: [number, number][] = metric
      ? logs.flatMap((log): [number, number][] => {
          const result = entryResult(log.results, entry);
          const value = result?.metrics[metric]?.value;
          return result?.applicable && typeof value === 'number' ? [[value, log.fightDps]] : [];
        })
      : [];
    const r = pairs.length >= MIN_LOGS_FOR_RANK ? correlation(pairs) : null;
    return { entry, metric, r, logs: pairs.length };
  });

  const ordered = [
    ...scored.filter((s) => s.r !== null).sort((a, b) => b.r! - a.r!),
    ...scored.filter((s) => s.r === null),
  ];
  return ordered.map((s, i) => ({ ...s, suggestedRank: i + 1 }));
}
