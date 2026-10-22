import { CastRule, EntryKind, MetricKind, Profile, Thresholds } from '../profile/types';

export type Status = 'pass' | 'warn' | 'fail' | 'unknown';

export interface MetricValue {
  /** Normalized so higher is better (see `MetricKind`); null when it can't be computed. */
  value: number | null;
  /** Raw counts behind the value, for tooltips and debugging. */
  detail: Record<string, number | null>;
}

export interface RawEntryMetrics {
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
      const raw = entryMetrics.find((m) => m.spellId === entry.spellId && m.kind === entry.kind);
      const metrics: ScoredEntry['metrics'] = {};
      for (const kind of entry.metrics) {
        const metric = raw?.metrics[kind];
        if (metric) {
          metrics[kind] = { ...metric, status: statusFor(metric.value, entry.thresholds?.[kind]) };
        }
      }
      return {
        spellId: entry.spellId,
        kind: entry.kind,
        rank: entry.rank,
        label: entry.label,
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

export interface CooldownWindowSet {
  spellId: number;
  rank: number;
  label?: string;
  windows: CooldownWindow[];
}

/** Everything a parsed log contributes to the comparison. */
export interface LogSnapshot {
  results: ProfileResults;
  windows: CooldownWindowSet[];
  fightDps: number;
}
