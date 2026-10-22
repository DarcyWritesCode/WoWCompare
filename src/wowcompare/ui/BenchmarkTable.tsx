import { SpellLink } from 'interface';

import { ProfileResults, ScoredMetric, ScoredRule } from '../metrics/results';
import { MetricKind } from '../profile/types';
import { formatValue, METRIC_LABELS, STATUS_COLORS } from './ProfileResultsTable';
import { BenchmarkColumn } from './useBenchmarks';

/** The player's results beside the five benchmark columns, one row per entry metric and rule. */
export default function BenchmarkTable({
  playerResults,
  benchmarks,
}: {
  playerResults: ProfileResults;
  benchmarks: BenchmarkColumn[];
}) {
  const columns: BenchmarkColumn[] = [
    { title: 'You', subtitle: 'this log', results: playerResults },
    ...benchmarks,
  ];

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
              </div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {playerResults.entries.flatMap((entry, entryIndex) =>
          (Object.keys(entry.metrics) as MetricKind[]).map((kind) => (
            <tr key={`${entry.kind}-${entry.spellId}-${kind}`}>
              <td>{entry.rank}</td>
              <td>
                <SpellLink spell={entry.spellId}>{entry.label}</SpellLink>
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
  );
}
