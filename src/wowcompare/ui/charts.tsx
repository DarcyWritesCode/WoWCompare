import { formatNumber } from 'common/format';
import { CSSProperties, ReactNode } from 'react';

import './print.css';

/** Shared chart colours: the player in gold (as in the window reels), the reference in white. */
export const CHART_COLORS = {
  you: '#fab700',
  reference: 'rgba(255, 255, 255, 0.85)',
  referenceFill: 'rgba(255, 255, 255, 0.35)',
  band: 'rgba(255, 255, 255, 0.14)',
  track: 'rgba(255, 255, 255, 0.06)',
  loss: '#f44336',
};

/**
 * Inline text colour that survives printing: Bootstrap's print styles force all text black, and
 * print.css puts back colours set through `--wc-color`.
 */
export const tint = (color?: string): CSSProperties =>
  color ? ({ color, '--wc-color': color } as CSSProperties) : {};

/** Inline background that survives printing, via `--wc-fill` (see `tint`). */
export const fill = (color: string): CSSProperties =>
  ({ background: color, '--wc-fill': color }) as CSSProperties;

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/**
 * A bullet bar: the player's value as a filled bar, the reference median as a tick and the
 * reference logs' range as a band behind them. Values are fractions of `max`.
 */
export function CompareBar({
  value,
  reference,
  range,
  max = 1,
  color = CHART_COLORS.you,
  title,
  width = 140,
}: {
  value: number | null;
  reference?: number | null;
  range?: [number, number];
  max?: number;
  color?: string;
  title?: string;
  width?: number;
}) {
  const height = 14;
  const x = (v: number) => clamp(v / max) * width;
  return (
    <svg
      width={width}
      height={height}
      style={{ verticalAlign: 'middle', overflow: 'visible' }}
      role="img"
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <rect className="wc-track" width={width} height={height} rx={2} fill={CHART_COLORS.track} />
      {range && (
        <rect
          className="wc-band"
          x={x(range[0])}
          width={Math.max(2, x(range[1]) - x(range[0]))}
          height={height}
          fill={CHART_COLORS.band}
        />
      )}
      {value !== null && <rect y={3} width={x(value)} height={height - 6} rx={2} fill={color} />}
      {reference != null && (
        <rect
          className="wc-ref"
          x={x(reference) - 1}
          y={-2}
          width={2}
          height={height + 4}
          fill={CHART_COLORS.reference}
        />
      )}
    </svg>
  );
}

/** A small legend for CompareBar, shown once above a table of them. */
export function CompareLegend({
  referenceLabel,
  range = true,
}: {
  referenceLabel: string;
  /** Whether the bars show the top logs' range. */
  range?: boolean;
}) {
  const swatch = (style: CSSProperties, className?: string) => (
    <span
      className={className}
      style={{ display: 'inline-block', width: 14, height: 8, marginRight: 4, ...style }}
      aria-hidden
    />
  );
  return (
    <p className="text-muted" style={{ fontSize: '0.9em' }}>
      {swatch({ ...fill(CHART_COLORS.you), borderRadius: 2 })}You{' '}
      {swatch(
        { width: 2, height: 12, ...fill(CHART_COLORS.reference), marginLeft: 12 },
        'wc-ref-fill',
      )}
      {referenceLabel}
      {range && (
        <>
          {' '}
          {swatch({ ...fill(CHART_COLORS.band), marginLeft: 12 }, 'wc-band-fill')}range of the top
          logs
        </>
      )}
    </p>
  );
}

/** A headline number in the style of WoWAnalyzer's statistic boxes. */
export function StatTile({
  label,
  value,
  sub,
  color,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
}) {
  return (
    <div
      style={{
        flex: '1 1 160px',
        padding: '10px 14px',
        background: 'rgba(255, 255, 255, 0.04)',
        borderRadius: 4,
        borderLeft: `3px solid ${color ?? CHART_COLORS.reference}`,
      }}
    >
      <div className="text-muted" style={{ fontSize: '0.85em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.8em', fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
      {sub && <div className="text-muted">{sub}</div>}
    </div>
  );
}

/**
 * Where the player's DPS falls among the reference logs: one dot per log, the player as a gold
 * marker with its value labelled, on a shared axis.
 */
export function DpsStrip({
  you,
  others,
  format = formatNumber,
  unit = 'DPS',
}: {
  you: number;
  others: number[];
  format?: (value: number) => string;
  unit?: string;
}) {
  const width = 600;
  const height = 54;
  const pad = 30;
  const values = [you, ...others];
  const lo = Math.min(...values) * 0.97;
  const hi = Math.max(...values) * 1.01;
  const x = (v: number) => pad + ((v - lo) / (hi - lo || 1)) * (width - 2 * pad);
  const axisY = 30;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width, display: 'block' }}
      role="img"
      aria-label={`Your ${unit} ${format(you)} among the top logs`}
    >
      <line
        className="wc-axis"
        x1={pad}
        x2={width - pad}
        y1={axisY}
        y2={axisY}
        stroke={CHART_COLORS.band}
      />
      {others.map((v, i) => (
        <circle
          className="wc-ref-dot"
          key={i}
          cx={x(v)}
          cy={axisY}
          r={5}
          fill={CHART_COLORS.referenceFill}
          stroke="#222"
          strokeWidth={2}
        >
          <title>
            {format(v)} {unit}
          </title>
        </circle>
      ))}
      <path
        d={`M${x(you)},${axisY - 8} l7,8 l-7,8 l-7,-8 z`}
        fill={CHART_COLORS.you}
        stroke="#222"
        strokeWidth={2}
      >
        <title>
          You: {format(you)} {unit}
        </title>
      </path>
      <text x={x(you)} y={12} textAnchor="middle" fontSize={12} fill="currentColor">
        You {format(you)}
      </text>
      <text x={pad} y={height - 2} fontSize={11} fill="currentColor" opacity={0.6}>
        {format(lo)}
      </text>
      <text
        x={width - pad}
        y={height - 2}
        fontSize={11}
        fill="currentColor"
        opacity={0.6}
        textAnchor="end"
      >
        {format(hi)}
      </text>
    </svg>
  );
}

/** A horizontal bar sized by share of the largest value, for ranked lists. */
export function ImpactBar({
  fraction,
  color = CHART_COLORS.loss,
}: {
  fraction: number;
  color?: string;
}) {
  return (
    <div
      className="wc-track-fill"
      style={{ height: 6, ...fill(CHART_COLORS.track), borderRadius: 2, marginTop: 4 }}
    >
      <div
        style={{
          width: `${clamp(fraction) * 100}%`,
          height: '100%',
          ...fill(color),
          borderRadius: 2,
        }}
      />
    </div>
  );
}
