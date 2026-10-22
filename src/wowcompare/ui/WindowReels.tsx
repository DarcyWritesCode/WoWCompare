import { formatDuration, formatNumber } from 'common/format';
import { SpellIcon, SpellLink } from 'interface';
import { useId, useState } from 'react';

import { CooldownWindow, CooldownWindowSet, LogSnapshot } from '../metrics/results';
import { BenchmarkLog } from './useBenchmarks';

/** Horizontal scale shared by every card, so window lengths compare at a glance. */
const PX_PER_SECOND = 18;
const CHART_HEIGHT = 110;
const CAST_LANE_HEIGHT = 20;
const ICON_SIZE = 14;

const COLORS = {
  inWindow: '#fab700',
  inWindowFill: 'rgba(250, 183, 0, 0.18)',
  outside: 'rgba(255, 255, 255, 0.35)',
  outsideFill: 'rgba(255, 255, 255, 0.06)',
  windowShade: 'rgba(250, 183, 0, 0.1)',
  average: 'rgba(255, 255, 255, 0.6)',
};

/** SVG path through the points as a monotone cubic spline (Fritsch–Carlson). */
function monotonePath(points: [number, number][]): string {
  const n = points.length;
  if (n === 0) {
    return '';
  }
  if (n === 1) {
    return `M${points[0][0]},${points[0][1]}`;
  }
  const slopes = points.slice(1).map(([x1, y1], i) => (y1 - points[i][1]) / (x1 - points[i][0]));
  const tangents = points.map((_, i) => {
    if (i === 0) {
      return slopes[0];
    }
    if (i === n - 1) {
      return slopes[n - 2];
    }
    const [a, b] = [slopes[i - 1], slopes[i]];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const dx = (x1 - x0) / 3;
    d += ` C${x0 + dx},${y0 + tangents[i] * dx} ${x1 - dx},${y1 - tangents[i + 1] * dx} ${x1},${y1}`;
  }
  return d;
}

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
  const clipId = `wc-window-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;

  // One point per bucket at its midpoint, joined with a monotone spline (no overshoot below 0).
  const points: [number, number][] = window.buckets.map((dps, i) => [
    x(Math.min(totalMs, i * window.bucketMs + window.bucketMs / 2)),
    y(dps),
  ]);
  const line = monotonePath(points);
  const area =
    points.length > 0
      ? `${line} L${points[points.length - 1][0]},${CHART_HEIGHT} L${points[0][0]},${CHART_HEIGHT} Z`
      : '';
  const slot = x(window.bucketMs);

  return (
    <div className="wc-avoid-break" style={{ flex: '0 0 auto', width }}>
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
        <defs>
          <clipPath id={clipId}>
            <rect
              x={x(windowStart)}
              y={-2}
              width={x(windowEnd) - x(windowStart)}
              height={CHART_HEIGHT + 4}
            />
          </clipPath>
        </defs>
        <path className="wc-reel-outside-fill" d={area} fill={COLORS.outsideFill} />
        <path
          className="wc-reel-outside"
          d={line}
          fill="none"
          stroke={COLORS.outside}
          strokeWidth={2}
        />
        <g clipPath={`url(#${clipId})`}>
          <path d={area} fill={COLORS.inWindowFill} />
          <path d={line} fill="none" stroke={COLORS.inWindow} strokeWidth={2} />
        </g>
        {points.map(([px, py], i) => (
          // Invisible hit targets, one per second, wider than the line.
          <rect
            key={i}
            x={px - slot / 2}
            y={0}
            width={slot}
            height={CHART_HEIGHT}
            fill="transparent"
          >
            <title>
              {`${((i * window.bucketMs + window.bucketMs / 2 - windowStart) / 1000).toFixed(0)}s: ${formatNumber(window.buckets[i])} DPS`}
            </title>
          </rect>
        ))}
        <line
          x1={0}
          x2={width}
          y1={y(fightDps)}
          y2={y(fightDps)}
          className="wc-reel-average"
          stroke={COLORS.average}
          strokeDasharray="4 3"
        >
          <title>{`Fight average: ${formatNumber(fightDps)} DPS`}</title>
        </line>
      </svg>
      <div style={{ position: 'relative', height: CAST_LANE_HEIGHT, marginTop: 4 }}>
        {window.casts.map((cast, i) => (
          <span
            key={`${cast.offsetMs}-${cast.spellId}-${i}`}
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
        <div
          className="wc-reel"
          style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8 }}
        >
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
        const benchSet = benchmark?.snapshot.windows.find((s) => s.token === set.token);
        const maxDps = Math.max(1, peak(set), peak(benchSet));
        return (
          <div key={set.token} style={{ marginBottom: 20 }}>
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
