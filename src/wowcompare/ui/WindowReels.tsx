import { formatDuration, formatNumber } from 'common/format';
import { SpellIcon, SpellLink } from 'interface';
import { useState } from 'react';

import { CooldownWindow, CooldownWindowSet, LogSnapshot } from '../metrics/results';
import { BenchmarkLog } from './useBenchmarks';

/** Horizontal scale shared by every card, so window lengths compare at a glance. */
const PX_PER_SECOND = 18;
const CHART_HEIGHT = 110;
const CAST_LANE_HEIGHT = 20;
const ICON_SIZE = 14;

const COLORS = {
  inWindow: '#fab700',
  outside: 'rgba(255, 255, 255, 0.25)',
  windowShade: 'rgba(250, 183, 0, 0.1)',
  average: 'rgba(255, 255, 255, 0.6)',
};

interface CardProps {
  index: number;
  window: CooldownWindow;
  fightDps: number;
  maxDps: number;
}

function WindowCard({ index, window, fightDps, maxDps }: CardProps) {
  const totalMs = window.leadMs + window.durationMs + window.trailMs;
  const width = Math.max(120, (totalMs / 1000) * PX_PER_SECOND);
  const x = (ms: number) => (ms / totalMs) * width;
  const y = (dps: number) => CHART_HEIGHT - (Math.min(dps, maxDps) / maxDps) * CHART_HEIGHT;
  const windowStart = window.leadMs;
  const windowEnd = window.leadMs + window.durationMs;

  return (
    <div style={{ flex: '0 0 auto', width }}>
      <div style={{ fontSize: '0.85em', whiteSpace: 'nowrap' }}>
        <strong>#{index + 1}</strong> at {formatDuration(window.startMs)} ·{' '}
        {(window.durationMs / 1000).toFixed(1)}s
      </div>
      <div className="text-muted" style={{ fontSize: '0.8em', whiteSpace: 'nowrap' }}>
        {formatNumber(window.dps)} DPS
        {fightDps > 0 && ` · ×${(window.dps / fightDps).toFixed(2)} fight avg`}
      </div>
      <svg width={width} height={CHART_HEIGHT} style={{ display: 'block', overflow: 'visible' }}>
        <rect
          x={x(windowStart)}
          y={0}
          width={x(windowEnd) - x(windowStart)}
          height={CHART_HEIGHT}
          fill={COLORS.windowShade}
        />
        {window.buckets.map((dps, i) => {
          const start = i * window.bucketMs;
          const end = Math.min(totalMs, start + window.bucketMs);
          const mid = (start + end) / 2;
          const inside = mid >= windowStart && mid < windowEnd;
          return (
            <rect
              key={start}
              x={x(start) + 1}
              y={y(dps)}
              width={Math.max(1, x(end) - x(start) - 2)}
              height={CHART_HEIGHT - y(dps)}
              rx={2}
              fill={inside ? COLORS.inWindow : COLORS.outside}
            >
              <title>
                {`${((start - windowStart) / 1000).toFixed(0)}s: ${formatNumber(dps)} DPS`}
              </title>
            </rect>
          );
        })}
        <line
          x1={0}
          x2={width}
          y1={y(fightDps)}
          y2={y(fightDps)}
          stroke={COLORS.average}
          strokeDasharray="4 3"
        >
          <title>{`Fight average: ${formatNumber(fightDps)} DPS`}</title>
        </line>
      </svg>
      <div style={{ position: 'relative', height: CAST_LANE_HEIGHT, marginTop: 4 }}>
        {window.casts.map((cast) => (
          <span
            key={`${cast.offsetMs}-${cast.spellId}`}
            style={{ position: 'absolute', left: x(cast.offsetMs) - ICON_SIZE / 2, top: 0 }}
          >
            <SpellIcon spell={cast.spellId} style={{ width: ICON_SIZE, height: ICON_SIZE }} />
          </span>
        ))}
      </div>
    </div>
  );
}

function Reel({
  title,
  set,
  fightDps,
  maxDps,
}: {
  title: string;
  set: CooldownWindowSet | undefined;
  fightDps: number;
  maxDps: number;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="text-muted" style={{ fontSize: '0.85em', marginBottom: 4 }}>
        {title}
      </div>
      {!set || set.windows.length === 0 ? (
        <div className="text-muted">No windows.</div>
      ) : (
        <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8 }}>
          {set.windows.map((window, i) => (
            <WindowCard
              key={window.startMs}
              index={i}
              window={window}
              fightDps={fightDps}
              maxDps={maxDps}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const peak = (set: CooldownWindowSet | undefined) =>
  Math.max(0, ...(set?.windows.flatMap((w) => w.buckets) ?? []));

/**
 * One scrollable reel of windows per cooldown for this log, with the selected benchmark's reel
 * underneath on the same scale.
 */
export default function WindowReels({
  player,
  benchmarks,
}: {
  player: LogSnapshot;
  benchmarks: BenchmarkLog[];
}) {
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const benchmark = benchmarks.find((b) => b.key === selectedKey) ?? benchmarks[0];

  if (player.windows.length === 0) {
    return null;
  }

  return (
    <div>
      {benchmarks.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          Compare with{' '}
          <select
            className="form-control"
            style={{ display: 'inline-block', width: 'auto', maxWidth: '100%' }}
            value={benchmark?.key}
            onChange={(e) => setSelectedKey(e.target.value)}
          >
            {benchmarks.map((b) => (
              <option key={b.key} value={b.key}>
                {b.roles.join(', ')} — {b.description}
              </option>
            ))}
          </select>
        </div>
      )}
      {player.windows.map((set) => {
        const benchSet = benchmark?.snapshot.windows.find((s) => s.spellId === set.spellId);
        const maxDps = Math.max(1, peak(set), peak(benchSet));
        return (
          <div key={set.spellId} style={{ marginBottom: 20 }}>
            <h3>
              <SpellLink spell={set.spellId}>{set.label}</SpellLink>
            </h3>
            <Reel title="You" set={set} fightDps={player.fightDps} maxDps={maxDps} />
            {benchmark && (
              <Reel
                title={`Benchmark: ${benchmark.roles.join(', ')}`}
                set={benchSet}
                fightDps={benchmark.snapshot.fightDps}
                maxDps={maxDps}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
