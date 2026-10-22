import { SpellLink } from 'interface';

import { LogSnapshot, ScoredMetric, ScoredRule } from '../metrics/results';
import { MetricKind } from '../profile/types';
import { formatValue, METRIC_LABELS, METRIC_ORDER, STATUS_COLORS } from './ProfileResultsTable';
import { describeComp } from './build';
import { BenchmarkColumn } from './useBenchmarks';

/** The player's results beside the five benchmark columns, one row per entry metric and rule. */
export default function BenchmarkTable({
  player,
  benchmarks,
}: {
  player: LogSnapshot;
  benchmarks: BenchmarkColumn[];
}) {
  const playerResults = player.results;
  const columns: BenchmarkColumn[] = [
    {
      title: 'You',
      subtitle: 'this log',
      results: playerResults,
      build: player.build.heroTree,
      comp: describeComp(player.comp),
    },
    ...benchmarks,
  ];

  // Rows with no value in any column (e.g. a talent nobody took) are left out.
  const kindsFor = (entryIndex: number) =>
    METRIC_ORDER.filter((kind) =>
      columns.some((column) => {
        const entry = column.results?.entries[entryIndex];
        return entry?.applicable && typeof entry.metrics[kind]?.value === 'number';
      }),
    );

  const metricCell = (column: BenchmarkColumn, entryIndex: number, kind: MetricKind) => {
    const entry = column.results?.entries[entryIndex];
    const metric: ScoredMetric | undefined = entry?.applicable ? entry.metrics[kind] : undefined;
    return (
      <td key={column.title} style={{ color: metric ? STATUS_COLORS[metric.status] : undefined }}>
        {metric ? formatValue(kind, metric.value) : '—'}
      </td>
    );
  };

  const ruleCell = (column: BenchmarkColumn, ruleIndex: number) => {
    const rule: ScoredRule | undefined = column.results?.rules[ruleIndex];
    return (
      <td key={column.title} style={{ color: rule ? STATUS_COLORS[rule.status] : undefined }}>
        {rule ? formatValue('rule', rule.value) : '—'}
      </td>
    );
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table table-condensed">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Buff / cooldown</th>
            <th>Metric</th>
            {columns.map((column) => (
              <th key={column.title} title={column.subtitle}>
                {column.title}
                <div className="text-muted" style={{ fontWeight: 'normal', fontSize: '0.8em' }}>
                  {column.subtitle}
                  {column.build && (
                    <div
                      title={column.buildTooltip || undefined}
                      style={
                        column.buildTooltip ? { textDecoration: 'underline dotted' } : undefined
                      }
                    >
                      {column.build}
                    </div>
                  )}
                  {column.comp && <div>{column.comp}</div>}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {playerResults.entries.flatMap((entry, entryIndex) =>
            kindsFor(entryIndex).map((kind) => (
              <tr
                key={`${entry.kind}-${entry.token}-${kind}`}
                style={{ opacity: entry.applicable ? 1 : 0.4 }}
              >
                <td>{entry.rank}</td>
                <td>
                  <SpellLink spell={entry.spellId}>{entry.label}</SpellLink>
                  {!entry.applicable && ' (not talented)'}
                </td>
                <td>{METRIC_LABELS[kind]}</td>
                {columns.map((column) => metricCell(column, entryIndex, kind))}
              </tr>
            )),
          )}
          {playerResults.rules.map((rule, ruleIndex) => (
            <tr key={rule.ruleId}>
              <td>{rule.rule.rank}</td>
              <td colSpan={2}>{rule.rule.description}</td>
              {columns.map((column) => ruleCell(column, ruleIndex))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
