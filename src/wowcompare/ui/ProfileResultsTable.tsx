import { formatNumber, formatPercentage } from 'common/format';
import { SpellLink } from 'interface';

import { MetricKind } from '../profile/types';
import { ProfileResults, ScoredMetric, Status } from '../metrics/results';

const METRIC_ORDER: MetricKind[] = ['uptime', 'procUsage', 'cooldownUsage', 'windowDps'];

const METRIC_LABELS: Record<MetricKind, string> = {
  uptime: 'Uptime',
  procUsage: 'Proc usage',
  cooldownUsage: 'Cooldown usage',
  windowDps: 'DPS in window',
};

const STATUS_COLORS: Record<Status, string> = {
  pass: '#4caf50',
  warn: '#ff9800',
  fail: '#f44336',
  unknown: 'inherit',
};

function formatValue(kind: MetricKind | 'rule', value: number | null) {
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

function MetricCell({ kind, metric }: { kind: MetricKind; metric?: ScoredMetric }) {
  if (!metric) {
    return <td />;
  }
  return (
    <td style={{ color: STATUS_COLORS[metric.status] }} title={describeDetail(metric.detail)}>
      {formatValue(kind, metric.value)}
    </td>
  );
}

/** One log's profile results: entries by rank, then cast rules. */
export default function ProfileResultsTable({ results }: { results: ProfileResults }) {
  const usedMetrics = METRIC_ORDER.filter((kind) =>
    results.entries.some((entry) => entry.metrics[kind]),
  );

  return (
    <>
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
          {results.entries.map((entry) => (
            <tr
              key={`${entry.kind}-${entry.spellId}`}
              style={{ opacity: entry.applicable ? 1 : 0.4 }}
            >
              <td>{entry.rank}</td>
              <td>
                <SpellLink spell={entry.spellId}>{entry.label}</SpellLink>
                {!entry.applicable && ' (not talented)'}
              </td>
              {usedMetrics.map((kind) => (
                <MetricCell key={kind} kind={kind} metric={entry.metrics[kind]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>

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
                <td style={{ color: STATUS_COLORS[rule.status] }}>
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
