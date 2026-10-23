import { MetricKind, Profile } from '../profile/types';
import {
  entryResult,
  ProfileResults,
  ruleResult,
  ScoredEntry,
  ScoredRule,
  statusFor,
  tokenLabel,
} from '../metrics/results';

export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Metric-by-metric median across several logs' results (not the results of one "median log").
 * Logs where an entry doesn't apply (e.g. not talented) are left out of that entry's median.
 */
export function medianResults(profile: Profile, results: ProfileResults[]): ProfileResults {
  const entries = profile.entries
    .map((entry): ScoredEntry => {
      const matching = results
        .map((r) => entryResult(r, entry))
        .filter((e): e is ScoredEntry => e !== undefined && e.applicable);
      const metrics: ScoredEntry['metrics'] = {};
      for (const kind of entry.metrics as MetricKind[]) {
        const values = matching
          .map((e) => e.metrics[kind]?.value)
          .filter((v): v is number => typeof v === 'number');
        if (values.length === 0) {
          continue;
        }
        const value = median(values);
        metrics[kind] = {
          value,
          detail: { logs: values.length },
          status: statusFor(value, entry.thresholds?.[kind]),
        };
      }
      return {
        token: entry.token,
        spellId: matching[0]?.spellId ?? entry.spellIds[0] ?? 0,
        kind: entry.kind,
        rank: entry.rank,
        label: entry.label ?? tokenLabel(entry),
        applicable: matching.length > 0,
        metrics,
      };
    })
    .sort((a, b) => a.rank - b.rank);

  const rules = profile.rules
    .map((rule): ScoredRule => {
      const matching = results
        .map((r) => ruleResult(r, rule.id))
        .filter((r): r is ScoredRule => r !== undefined && r.casts > 0);
      const value = median(matching.map((r) => r.value!));
      return {
        ruleId: rule.id,
        rule,
        casts: median(matching.map((r) => r.casts)) ?? 0,
        passed: median(matching.map((r) => r.passed)) ?? 0,
        value,
        status: statusFor(value, rule.thresholds),
      };
    })
    .sort((a, b) => a.rule.rank - b.rule.rank);

  return { profileId: profile.id, profileVersion: profile.version, entries, rules };
}

/** Benchmark-derived thresholds: pass at 97% of the reference value, warn at 90%. */
export const PASS_FRACTION = 0.97;
export const WARN_FRACTION = 0.9;

const thresholdsFrom = (reference: number | null | undefined) =>
  typeof reference === 'number'
    ? { pass: reference * PASS_FRACTION, warn: reference * WARN_FRACTION }
    : undefined;

/**
 * Re-scores results against a reference (the top-10 median) instead of profile thresholds,
 * which SimC APLs don't provide.
 */
export function rescoreAgainst(results: ProfileResults, reference: ProfileResults): ProfileResults {
  return {
    ...results,
    entries: results.entries.map((entry) => {
      const referenceEntry = entryResult(reference, entry);
      const metrics: ScoredEntry['metrics'] = {};
      for (const [kind, metric] of Object.entries(entry.metrics) as [
        MetricKind,
        ScoredEntry['metrics'][MetricKind],
      ][]) {
        if (metric) {
          const thresholds = thresholdsFrom(referenceEntry?.metrics[kind]?.value);
          metrics[kind] = { ...metric, status: statusFor(metric.value, thresholds) };
        }
      }
      return { ...entry, metrics };
    }),
    rules: results.rules.map((rule) => ({
      ...rule,
      status: statusFor(rule.value, thresholdsFrom(ruleResult(reference, rule.ruleId)?.value)),
    })),
  };
}
