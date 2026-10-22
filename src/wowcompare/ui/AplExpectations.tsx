import { formatPercentage } from 'common/format';
import { SpellLink } from 'interface';

import { median } from '../benchmarks/aggregate';
import { LogSnapshot, ProfileResults } from '../metrics/results';
import { EntryKind, MetricKind } from '../profile/types';

/** At or above this a log counts as following an expectation. */
const FOLLOWED = 0.9;

/** What the APL implies for each kind of entry, and the metric that measures it. */
const ENTRY_EXPECTATIONS: Record<EntryKind, { metric: MetricKind; says: string }> = {
  cooldown: { metric: 'cooldownUsage', says: 'Use on cooldown' },
  debuff: { metric: 'uptime', says: 'Keep up (refresh when refreshable)' },
  buff: { metric: 'procUsage', says: 'Spend every proc' },
};

interface Row {
  key: string;
  label: React.ReactNode;
  says: string;
  /** Soft expectations (the APL favours rather than requires) get no verdict. */
  soft: boolean;
  you: number | null;
  top: number[];
}

function verdict(row: Row) {
  const mid = median(row.top);
  if (row.soft || mid === null) {
    return { text: row.soft ? 'Context' : '—', color: undefined };
  }
  if (mid >= FOLLOWED) {
    return { text: 'Top parses follow it', color: '#4caf50' };
  }
  if (mid >= 0.7) {
    return { text: 'Partly followed', color: '#ff9800' };
  }
  return { text: 'Top parses deviate', color: '#f44336' };
}

const pct = (value: number | null) => (value === null ? '—' : `${formatPercentage(value, 0)}%`);

/**
 * Each expectation the SimC APL encodes, measured on the player and on the top-10 parses, to show
 * where real top play agrees with the APL and where it doesn't.
 */
export default function AplExpectations({
  player,
  topLogs,
}: {
  player: ProfileResults;
  topLogs: LogSnapshot[];
}) {
  const rows: Row[] = [
    ...player.rules.map((rule, i) => ({
      key: rule.ruleId,
      label: rule.rule.description,
      says: rule.rule.strict === false ? 'Favoured' : 'Always',
      soft: rule.rule.strict === false,
      you: rule.value,
      top: topLogs
        .map((log) => log.results.rules[i])
        .filter((r) => r && r.casts > 0)
        .map((r) => r.value!),
    })),
    ...player.entries.map((entry, i) => {
      // Buffs that turned out to be states (e.g. Eclipse) are measured by uptime, not proc usage.
      const isState =
        entry.kind === 'buff' &&
        [entry, ...topLogs.map((log) => log.results.entries[i])].every(
          (e) => e?.metrics.procUsage === undefined,
        );
      const { metric, says } = isState
        ? { metric: 'uptime' as const, says: 'Keep up' }
        : ENTRY_EXPECTATIONS[entry.kind];
      return {
        key: `${entry.kind}-${entry.token}`,
        label: <SpellLink spell={entry.spellId}>{entry.label}</SpellLink>,
        says,
        // A state has no "right" uptime; it's context, not pass/fail.
        soft: isState,
        you: entry.applicable ? (entry.metrics[metric]?.value ?? null) : null,
        top: topLogs
          .map((log) => log.results.entries[i])
          .filter((e) => e?.applicable)
          .map((e) => e.metrics[metric]?.value)
          .filter((v): v is number => typeof v === 'number'),
      };
    }),
  ].filter((row) => row.you !== null || row.top.length > 0);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table table-condensed">
        <thead>
          <tr>
            <th>Expectation</th>
            <th>APL says</th>
            <th>You</th>
            <th>Top 10 median</th>
            <th>Top 10 range</th>
            <th>Top 10 at ≥{FOLLOWED * 100}%</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { text, color } = verdict(row);
            const followed = row.top.filter((v) => v >= FOLLOWED).length;
            return (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>{row.says}</td>
                <td>{pct(row.you)}</td>
                <td>{pct(median(row.top))}</td>
                <td>
                  {row.top.length > 0
                    ? `${pct(Math.min(...row.top))} – ${pct(Math.max(...row.top))}`
                    : '—'}
                </td>
                <td>{row.top.length > 0 ? `${followed} / ${row.top.length}` : '—'}</td>
                <td style={{ color }}>{text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
