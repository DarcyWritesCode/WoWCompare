import { CastRule, EntryKind, entryKey, MetricKind, Profile, Thresholds } from '../profile/types';

export type Status = 'pass' | 'warn' | 'fail' | 'unknown';

export interface MetricValue {
  /** Normalized so higher is better (see `MetricKind`); null when it can't be computed. */
  value: number | null;
  /** Raw counts behind the value, for tooltips and debugging. */
  detail: Record<string, number | null>;
}

export interface RawEntryMetrics {
  token: string;
  /** The spell this log actually used for the entry (for display). */
  spellId: number;
  kind: EntryKind;
  /** False when the entry doesn't apply to this player (e.g. cooldown not talented). */
  applicable: boolean;
  metrics: Partial<Record<MetricKind, MetricValue>>;
}

export interface RawRuleResult {
  ruleId: string;
  casts: number;
  passed: number;
}

export interface ScoredMetric extends MetricValue {
  status: Status;
}

export interface ScoredEntry {
  token: string;
  spellId: number;
  kind: EntryKind;
  rank: number;
  label?: string;
  applicable: boolean;
  metrics: Partial<Record<MetricKind, ScoredMetric>>;
}

export interface ScoredRule extends RawRuleResult {
  rule: CastRule;
  /** passed / casts, null with no casts. */
  value: number | null;
  status: Status;
}

/** Everything one log produced for one profile. Plain data, so it can be cached and compared. */
export interface ProfileResults {
  profileId: string;
  profileVersion: number;
  entries: ScoredEntry[];
  rules: ScoredRule[];
}

/**
 * A log's result for a profile entry. Look results up by key, never by position: a log's entries
 * are ordered by rank, which needn't match another profile's or log's order.
 */
export function entryResult(
  results: ProfileResults | null | undefined,
  entry: { kind: EntryKind; token: string },
): ScoredEntry | undefined {
  const key = entryKey(entry);
  return results?.entries.find((e) => entryKey(e) === key);
}

/** A log's result for a cast rule, by rule ID. */
export function ruleResult(
  results: ProfileResults | null | undefined,
  ruleId: string,
): ScoredRule | undefined {
  return results?.rules.find((r) => r.ruleId === ruleId);
}

export function statusFor(value: number | null, thresholds: Thresholds | undefined): Status {
  if (value === null || !thresholds) {
    return 'unknown';
  }
  if (value >= thresholds.pass) {
    return 'pass';
  }
  return value >= thresholds.warn ? 'warn' : 'fail';
}

export function scoreProfile(
  profile: Profile,
  entryMetrics: RawEntryMetrics[],
  ruleResults: RawRuleResult[],
): ProfileResults {
  const entries = profile.entries
    .map((entry): ScoredEntry => {
      const raw = entryMetrics.find((m) => entryKey(m) === entryKey(entry));
      const metrics: ScoredEntry['metrics'] = {};
      for (const kind of entry.metrics) {
        const metric = raw?.metrics[kind];
        if (metric) {
          metrics[kind] = { ...metric, status: statusFor(metric.value, entry.thresholds?.[kind]) };
        }
      }
      return {
        token: entry.token,
        spellId: raw?.spellId ?? entry.spellIds[0] ?? 0,
        kind: entry.kind,
        rank: entry.rank,
        label: entry.label ?? tokenLabel(entry),
        applicable: raw?.applicable ?? false,
        metrics,
      };
    })
    .sort((a, b) => a.rank - b.rank);

  const rules = profile.rules
    .map((rule): ScoredRule => {
      const raw = ruleResults.find((r) => r.ruleId === rule.id) ?? {
        ruleId: rule.id,
        casts: 0,
        passed: 0,
      };
      const value = raw.casts > 0 ? raw.passed / raw.casts : null;
      return { ...raw, rule, value, status: statusFor(value, rule.thresholds) };
    })
    .sort((a, b) => a.rule.rank - b.rule.rank);

  return { profileId: profile.id, profileVersion: profile.version, entries, rules };
}

export interface WindowCast {
  /** ms from the timeline's start (window start minus padding). */
  offsetMs: number;
  spellId: number;
}

/** One cooldown window as plain data, for the window timelines. */
export interface CooldownWindow {
  /** Window start, ms from fight start. */
  startMs: number;
  durationMs: number;
  /** Context shown before and after the window, ms (shorter at the fight's edges). */
  leadMs: number;
  trailMs: number;
  bucketMs: number;
  /** DPS per bucket from `startMs - leadMs` to `startMs + durationMs + trailMs`. */
  buckets: number[];
  /** DPS inside the window itself. */
  dps: number;
  casts: WindowCast[];
}

/** One ability's damage inside a cooldown's windows, summed over all of them. */
export interface WindowAbility {
  /** Name token, to match the same ability across logs whose spell IDs differ. */
  token: string;
  name: string;
  /** The ID that did the most damage under this name (for icons/links). */
  spellId: number;
  casts: number;
  damage: number;
}

/** The player's state as a cooldown starts: resources and the buffs they lined up. */
export interface WindowEntryState {
  /** Resource name → fraction of its maximum at the cast. */
  resources: Record<string, number>;
  /** Self-applied buffs already up, by name token. */
  buffs: Record<string, { name: string; spellId: number; stacks: number }>;
  /**
   * Share of the window each buff on the player was up (any source, e.g. Bloodlust), by name
   * token; only shares of 1% or more. Catches buffs pressed just after the cooldown.
   */
  overlap?: Record<string, number>;
}

export interface CooldownWindowSet {
  token: string;
  spellId: number;
  rank: number;
  label?: string;
  windows: CooldownWindow[];
  /** The biggest damage abilities inside the windows. */
  abilities: WindowAbility[];
  /** State going into each window, in window order. */
  entryStates: WindowEntryState[];
}

/** The talents behind a log, for showing how a benchmark's build differs. */
export interface BuildInfo {
  /** `talentEntryId:rank`, sorted; same format as ranked parses. */
  talents: string[];
  heroTree?: string;
}

export interface RaidComp {
  tank: number;
  healer: number;
  dps: number;
}

/** A buff the player applied to themselves, or a debuff they applied to enemies. */
export interface AuraUsage {
  token: string;
  name: string;
  spellId: number;
  kind: 'buff' | 'debuff';
  /** Fraction of the fight it was up (debuffs: on any enemy). */
  uptime: number;
  /** DPS while it was up divided by DPS while it wasn't; null if never or always up. */
  dpsRatio: number | null;
}

/** An ability's damage over the whole fight, grouped by name across spell IDs. */
export interface AbilityTotal {
  token: string;
  name: string;
  spellIds: number[];
  casts: number;
  damage: number;
}

/** What a resource is worth to this player: max, and damage per point spent on spenders. */
export interface ResourceValue {
  max: number;
  damagePerPoint: number;
}

/** A damage buff someone else put on the player, e.g. Power Infusion. */
export interface ExternalBuff {
  spellId: number;
  name: string;
  /** Fraction of the fight it was up. */
  uptime: number;
}

/** Everything a parsed log contributes to the comparison. */
export interface LogSnapshot {
  /** By resource name. */
  resourceValues: Record<string, ResourceValue>;
  durationMs: number;
  /** Damage and casts per ability over the whole fight. */
  abilities: AbilityTotal[];
  /** Every self-applied buff and player debuff, for suggesting entries the profile lacks. */
  auras: AuraUsage[];
  results: ProfileResults;
  build: BuildInfo;
  comp: RaidComp;
  /** Buffs from `EXTERNAL_BUFF_IDS` that other players cast on this one. */
  externalBuffs: ExternalBuff[];
  windows: CooldownWindowSet[];
  fightDps: number;
  /** Average equipped item level. */
  ilvl?: number;
  /** The boss's max HP (the largest enemy the player hit). */
  bossHp?: number;
}

/**
 * Fallback display name for entries no spell was found for (SimC-only tokens such as a
 * pseudo-buff): the token in title case. Undefined when a spell is known, so links show its name.
 */
export function tokenLabel(entry: { token: string; spellIds: number[] }): string | undefined {
  return entry.spellIds.length > 0
    ? undefined
    : entry.token.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
