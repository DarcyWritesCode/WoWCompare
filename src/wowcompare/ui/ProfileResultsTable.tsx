import { formatNumber, formatPercentage } from 'common/format';
import { SpellLink } from 'interface';

import { MetricKind } from '../profile/types';
import { LogSnapshot, ProfileResults, ScoredMetric, Status } from '../metrics/results';
import { CompareBar, CompareLegend, tint } from './charts';

export const METRIC_ORDER: MetricKind[] = ['uptime', 'procUsage', 'cooldownUsage', 'windowDps'];

export const METRIC_LABELS: Record<MetricKind, string> = {
  uptime: 'Uptime',
  procUsage: 'Proc usage',
  cooldownUsage: 'Cooldown usage',
  windowDps: 'DPS in window',
};

export const STATUS_COLORS: Record<Status, string> = {
  pass: '#4caf50',
  warn: '#ff9800',
  fail: '#f44336',
  unknown: 'inherit',
};

export function formatValue(kind: MetricKind | 'rule', value: number | null) {
  if (value === null) {
    return '—';
  }
  return kind === 'windowDps' ? `×${value.toFixed(2)}` : `${formatPercentage(value, 0)}%`;
}

/** Tooltip text listing the raw counts behind a metric. */
function describeDetail(detail: ScoredMetric['detail']) {
  return Object.entries(detail)
    .map(([key, value]) => `${key}: ${value === null ? '—' : formatNumber(value)}`)
    .join('\n');
}

/** The reference median and the top logs' range for one entry metric. */
interface Comparison {
  median: number | null;
  range?: [number, number];
}

function MetricCell({
  kind,
  metric,
  comparison,
}: {
  kind: MetricKind;
  metric?: ScoredMetric;
  comparison?: Comparison;
}) {
  if (!metric) {
    return <td />;
  }
  const color = STATUS_COLORS[metric.status];
  // Window DPS is a ratio with no natural maximum; it gets the reference as text only.
  const bar = comparison && kind !== 'windowDps' && metric.value !== null;
  return (
    <td style={{ whiteSpace: 'nowrap' }} title={describeDetail(metric.detail)}>
      <span style={{ ...tint(color), display: 'inline-block', minWidth: 44 }}>
        {formatValue(kind, metric.value)}
      </span>
      {bar && (
        <CompareBar
          value={metric.value}
          reference={comparison.median}
          range={comparison.range}
          color={metric.status === 'unknown' ? undefined : color}
          width={110}
          title={`You ${formatValue(kind, metric.value)}, reference ${formatValue(kind, comparison.median)}`}
        />
      )}
      {comparison && kind === 'windowDps' && (
        <span className="text-muted"> vs {formatValue(kind, comparison.median)}</span>
      )}
    </td>
  );
}

/** One log's profile results: entries by rank, then cast rules. */
export default function ProfileResultsTable({
  results,
  reference,
}: {
  results: ProfileResults;
  /** Median results and logs to draw each value against, once benchmarks have loaded. */
  reference?: { label: string; results: ProfileResults; logs: LogSnapshot[] };
}) {
  const compare = (token: string, kind: MetricKind): Comparison | undefined => {
    if (!reference) {
      return undefined;
    }
    const values = reference.logs
      .map((log) => log.results.entries.find((e) => e.token === token))
      .filter((e) => e?.applicable)
      .map((e) => e!.metrics[kind]?.value)
      .filter((v): v is number => typeof v === 'number');
    const median =
      reference.results.entries.find((e) => e.token === token)?.metrics[kind]?.value ?? null;
    return {
      median,
      range: values.length > 1 ? [Math.min(...values), Math.max(...values)] : undefined,
    };
  };
  const hidden = results.entries.filter((entry) => !entry.applicable).length;
  const usedMetrics = METRIC_ORDER.filter((kind) =>
    results.entries.some((entry) => entry.metrics[kind]),
  );

  return (
    <>
      {reference && <CompareLegend referenceLabel={reference.label} />}
      <table className="table table-condensed">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Buff / cooldown</th>
            {usedMetrics.map((kind) => (
              <th key={kind}>{METRIC_LABELS[kind]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.entries
            .filter((entry) => entry.applicable)
            .map((entry) => (
              <tr
                key={`${entry.kind}-${entry.token}`}
                style={{ opacity: entry.applicable ? 1 : 0.4 }}
              >
                <td>{entry.rank}</td>
                <td>
                  <SpellLink spell={entry.spellId}>{entry.label}</SpellLink>
                  {!entry.applicable && ' (not talented)'}
                </td>
                {usedMetrics.map((kind) => (
                  <MetricCell
                    key={kind}
                    kind={kind}
                    metric={entry.metrics[kind]}
                    comparison={compare(entry.token, kind)}
                  />
                ))}
              </tr>
            ))}
        </tbody>
      </table>

      {hidden > 0 && (
        <p className="text-muted">
          {hidden} more APL {hidden === 1 ? 'entry' : 'entries'} not used in this log (not talented,
          or not a real cooldown).
        </p>
      )}

      {results.rules.length > 0 && (
        <table className="table table-condensed">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Rule</th>
              <th>Casts that followed it</th>
            </tr>
          </thead>
          <tbody>
            {results.rules.map((rule) => (
              <tr key={rule.ruleId}>
                <td>{rule.rule.rank}</td>
                <td>{rule.rule.description}</td>
                <td style={tint(STATUS_COLORS[rule.status])}>
                  {rule.casts === 0
                    ? 'no casts'
                    : `${rule.passed} / ${rule.casts} (${formatValue('rule', rule.value)})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-muted">
        Hover a value for the counts behind it. Window DPS is damage per second inside the
        buff/cooldown divided by damage per second outside it.
      </p>
    </>
  );
}
