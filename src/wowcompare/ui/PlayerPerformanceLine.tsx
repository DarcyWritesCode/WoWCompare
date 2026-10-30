import { formatDuration, formatNumber, formatThousands } from 'common/format';
import rankingColor from 'common/getRankingColor';

import { PlayerPerformance, REFERENCE_PERCENTILE } from '../groupPerformance';

/**
 * WoWCompare: a player tile's DPS (HPS for healers), colored by their parse, against their spec's
 * 95th percentile (groupPerformance.ts).
 */
export default function PlayerPerformanceLine({
  performance,
  specName,
}: {
  performance: PlayerPerformance;
  specName?: string;
}) {
  const { metric, amount, parse, reference, deaths } = performance;
  const unit = metric.toUpperCase();
  const title = [
    `${unit} ${formatThousands(amount)}`,
    parse !== null ? `parse ${Math.floor(parse)}` : 'no parse (not a ranked kill)',
    reference !== null &&
      `${REFERENCE_PERCENTILE}th percentile${specName ? ` ${specName}` : ''}: ${formatThousands(reference)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <div className="text-small" title={title}>
        {/* Five colors: a 99 or 100 parse stays orange. */}
        <span className={parse !== null ? rankingColor(Math.min(parse, 99) / 100) : undefined}>
          {formatNumber(amount)}
        </span>{' '}
        <span className="text-muted">{unit}</span>
      </div>
      {reference !== null && (
        <div className="text-small text-muted" style={{ whiteSpace: 'nowrap' }}>
          {REFERENCE_PERCENTILE}th percentile: {formatNumber(reference)}
        </div>
      )}
      {deaths && (
        <div className="text-small text-muted">
          {deaths.length === 0
            ? 'Lived'
            : `Died at ${deaths.map((at) => formatDuration(at)).join(', ')}`}
        </div>
      )}
    </>
  );
}
