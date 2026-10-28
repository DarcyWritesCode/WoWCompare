import { formatDuration, formatNumber } from 'common/format';
import { SpellLink } from 'interface';
import { createContext, ReactNode, useContext } from 'react';

import { median } from '../benchmarks/aggregate';
import { LogSnapshot } from '../metrics/results';
import { CHART_COLORS } from './charts';

/** SVG user units across; charts stretch to the panel's width. */
const WIDTH = 1000;
const DPS_HEIGHT = 120;
const ROW_HEIGHT = 20;
/** How long a cast of a cooldown without a buff window is drawn. */
const CAST_TICK_MS = 2_000;
const LABEL_WIDTH = 160;
/** Bucket size of the band shares and the smoothed DPS lines. */
const BUCKET_MS = 2_000;
/** Buckets averaged either side when smoothing DPS lines. */
const SMOOTHING = 2;
/** Time ticks are the first of these steps (seconds) giving at most this many ticks. */
const TIME_STEPS = [15, 30, 60, 120, 300];
const MAX_TIME_TICKS = 10;
/** Horizontal grid lines on the DPS charts, above zero. */
const DPS_TICKS = 4;
const GRID_COLOR = 'rgba(255, 255, 255, 0.12)';
/** The reference line stops once fewer than this share of its logs are still fighting. */
const MIN_ALIVE = 0.5;

/** Stacked top to bottom in every chart, so overlapping bands stay visible. */
const BANDS = [
  { key: 'lust', label: 'Bloodlust', color: '#ff5252' },
  { key: 'potion', label: 'Damage potion', color: '#b388ff' },
  { key: 'amp', label: 'Damage amp', color: '#4caf50' },
] as const;
type BandKey = (typeof BANDS)[number]['key'];
/** Per band: the share of logs it's up in, per bucket (1 or 0 for the player's own log). */
type BandShares = Record<BandKey, number[]>;

const spansOf = (log: LogSnapshot, key: BandKey): [number, number][] =>
  key === 'lust'
    ? (log.lust ?? [])
    : key === 'potion'
      ? (log.potions ?? [])
      : (log.damageWindows ?? [])
          .filter((w) => w.kind === 'amp')
          .map((w): [number, number] => [w.startMs, w.endMs]);

/** Per bucket, the share of `logs` where some span is active. */
function shares(logs: [number, number][][], buckets: number): number[] {
  const out = new Array(buckets).fill(0);
  if (logs.length === 0) {
    return out;
  }
  for (const spans of logs) {
    const hit = new Array(buckets).fill(false);
    for (const [start, end] of spans) {
      for (
        let i = Math.floor(start / BUCKET_MS);
        i < Math.min(buckets, Math.ceil(end / BUCKET_MS));
        i += 1
      ) {
        hit[i] = true;
      }
    }
    hit.forEach((h, i) => (out[i] += h ? 1 / logs.length : 0));
  }
  return out;
}

/** When a cooldown was up: its buff windows, else a tick per cast. */
const activeSpans = (set: LogSnapshot['windows'][number] | undefined): [number, number][] =>
  !set
    ? []
    : set.windows.length > 0
      ? set.windows.map((w): [number, number] => [w.startMs, w.startMs + w.durationMs])
      : (set.castMs ?? []).map((t): [number, number] => [t, t + CAST_TICK_MS]);

/** Re-buckets a log's timeline to `BUCKET_MS` and smooths it. */
function dpsSeries(log: LogSnapshot, buckets: number): number[] | null {
  const timeline = log.timeline;
  if (!timeline) {
    return null;
  }
  const raw = new Array(buckets).fill(0);
  const per = BUCKET_MS / timeline.bucketMs;
  timeline.dps.forEach((dps, i) => {
    const j = Math.floor(i / per);
    if (j < buckets) {
      raw[j] += dps / per;
    }
  });
  return raw.map((_, i) => {
    const window = raw.slice(Math.max(0, i - SMOOTHING), i + SMOOTHING + 1);
    return window.reduce((a, b) => a + b, 0) / window.length;
  });
}

/** Consecutive buckets with the same non-zero value, as one run each (drawn without seams). */
function runs(values: number[]) {
  const out: { from: number; to: number; share: number }[] = [];
  values.forEach((share, i) => {
    const last = out.at(-1);
    if (share <= 0) {
      return;
    }
    if (last && last.to === i && Math.abs(last.share - share) < 1e-9) {
      last.to = i + 1;
    } else {
      out.push({ from: i, to: i + 1, share });
    }
  });
  return out;
}

/** The player's own bands: on or off. */
const OWN_BAND_OPACITY = 0.5;
/** The player's cooldowns, translucent so the bands under them still show. */
const OWN_COOLDOWN_OPACITY = 0.8;
/** Reference bands and cooldowns: one log barely shows, every log is near solid. */
const shareOpacity = (share: number) => 0.08 + 0.82 * share;

/** Band lanes behind a chart: each band in its own horizontal strip, opacity by share. */
function BandLanes({
  bands,
  buckets,
  height,
  logs,
}: {
  bands: BandShares;
  buckets: number;
  height: number;
  /** How many logs the shares are over; undefined for the player's own log. */
  logs?: number;
}) {
  const lane = height / BANDS.length;
  const w = WIDTH / buckets;
  return (
    <>
      {BANDS.map((band, b) =>
        runs(bands[band.key]).map(({ from, to, share }) => (
          <rect
            key={`${band.key}-${from}`}
            x={from * w}
            y={b * lane}
            width={(to - from) * w}
            height={lane}
            fill={band.color}
            opacity={logs === undefined ? OWN_BAND_OPACITY : shareOpacity(share)}
          >
            {logs !== undefined && (
              <title>
                {band.label}: {Math.round(share * logs)} of {logs} logs
              </title>
            )}
          </rect>
        )),
      )}
    </>
  );
}

/** The time ticks as x positions in SVG units, shared by every chart's grid. */
const TimeTicks = createContext<number[]>([]);

/** Time ticks for a span: every step from the pull, the step chosen to keep them readable. */
function timeTicks(spanMs: number): number[] {
  const step =
    TIME_STEPS.find((seconds) => spanMs / (seconds * 1000) <= MAX_TIME_TICKS) ??
    TIME_STEPS[TIME_STEPS.length - 1];
  const ticks: number[] = [];
  for (let ms = 0; ms <= spanMs; ms += step * 1000) {
    ticks.push(ms);
  }
  return ticks;
}

/** A round step (1, 2, 2.5 or 5 × 10ⁿ) splitting `max` into about `count` parts. */
function niceStep(max: number, count: number): number {
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * magnitude >= raw) ?? 10;
  return step * magnitude;
}

function Frame({
  label,
  height,
  children,
}: {
  label: ReactNode;
  height: number;
  children: ReactNode;
}) {
  const ticks = useContext(TimeTicks);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginBottom: 2 }}>
      <div
        style={{
          width: LABEL_WIDTH,
          flex: '0 0 auto',
          fontSize: '0.9em',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          lineHeight: `${Math.min(height, 20)}px`,
        }}
      >
        {label}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        style={{ flex: 1, minWidth: 0, background: CHART_COLORS.track, display: 'block' }}
      >
        {ticks.map((x) => (
          <line
            key={x}
            x1={x}
            x2={x}
            y1={0}
            y2={height}
            stroke={GRID_COLOR}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {children}
      </svg>
    </div>
  );
}

function DpsChart({
  title,
  series,
  average,
  maxDps,
  dpsStep,
  bands,
  buckets,
  color,
  logs,
}: {
  title: ReactNode;
  series: number[];
  average: number;
  /** The scale's top, a multiple of `dpsStep`; shared by both DPS charts. */
  maxDps: number;
  dpsStep: number;
  bands: BandShares;
  buckets: number;
  color: string;
  /** How many logs the bands are over; undefined for the player's own log. */
  logs?: number;
}) {
  const x = (i: number) => ((i + 0.5) / buckets) * WIDTH;
  const y = (dps: number) => DPS_HEIGHT - (Math.min(dps, maxDps) / maxDps) * DPS_HEIGHT;
  const points = series.map((dps, i) => `${x(i)},${y(dps)}`);
  const dpsTicks = Array.from({ length: Math.round(maxDps / dpsStep) + 1 }, (_, i) => i * dpsStep);
  return (
    <>
      <h4 style={{ marginBottom: 4 }}>
        {title} <small className="text-muted">{formatNumber(average)} DPS over the fight</small>
      </h4>
      {/* An axis, not a value: both charts share the scale, which tops out above the higher peak. */}
      <Frame
        label={
          <span
            className="text-muted"
            style={{ position: 'relative', display: 'block', height: '100%', fontSize: '0.9em' }}
          >
            {dpsTicks.map((dps) => (
              <span
                key={dps}
                style={{
                  position: 'absolute',
                  right: 0,
                  top: y(dps),
                  transform: `translateY(${dps === 0 ? -100 : dps === maxDps ? 0 : -50}%)`,
                  lineHeight: 1,
                }}
              >
                {formatNumber(dps)}
              </span>
            ))}
          </span>
        }
        height={DPS_HEIGHT}
      >
        {dpsTicks.map((dps) => (
          <line
            key={dps}
            x1={0}
            x2={WIDTH}
            y1={y(dps)}
            y2={y(dps)}
            stroke={GRID_COLOR}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <BandLanes bands={bands} buckets={buckets} height={DPS_HEIGHT} logs={logs} />
        {points.length > 1 && (
          <>
            <polygon
              points={`${x(0)},${DPS_HEIGHT} ${points.join(' ')} ${x(series.length - 1)},${DPS_HEIGHT}`}
              fill={color}
              opacity={0.15}
            />
            <polyline
              points={points.join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        <line
          x1={0}
          x2={WIDTH}
          y1={y(average)}
          y2={y(average)}
          stroke={CHART_COLORS.reference}
          strokeDasharray="4 4"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          opacity={0.6}
        />
      </Frame>
    </>
  );
}

function CooldownChart({
  title,
  rows,
  bands,
  buckets,
  logs,
  bandLogs,
}: {
  title: ReactNode;
  rows: { token: string; spellId: number; label?: string; active: number[] }[];
  bands: BandShares;
  buckets: number;
  /** How many logs the rows' shares are over; undefined for the player's own log. */
  logs?: number;
  /** Likewise for the bands (only logs with timelines have them). */
  bandLogs?: number;
}) {
  const w = WIDTH / buckets;
  return (
    <>
      <h4 style={{ marginBottom: 4 }}>{title}</h4>
      {rows.map((row) => (
        <Frame
          key={row.token}
          label={<SpellLink spell={row.spellId}>{row.label}</SpellLink>}
          height={ROW_HEIGHT}
        >
          <BandLanes bands={bands} buckets={buckets} height={ROW_HEIGHT} logs={bandLogs} />
          {runs(row.active).map(({ from, to, share }) => (
            <rect
              key={from}
              x={from * w}
              y={ROW_HEIGHT * 0.2}
              width={(to - from) * w}
              height={ROW_HEIGHT * 0.6}
              fill={CHART_COLORS.you}
              opacity={logs === undefined ? OWN_COOLDOWN_OPACITY : shareOpacity(share)}
            />
          ))}
        </Frame>
      ))}
    </>
  );
}

/**
 * The fight as four aligned timelines: the player's DPS and the reference logs' mean DPS, then the
 * player's cooldowns and how often the reference logs had each up. Every chart carries Bloodlust,
 * damage potion and damage amp bands in stacked lanes; on the reference charts their strength is
 * the share of logs with the band up at that moment. Time runs from the pull in every chart.
 */
export default function FightTimelines({
  player,
  playerAmpWindows,
  references,
  referenceLabel,
}: {
  player: LogSnapshot;
  /** The player's amp windows, ms from the pull; undefined while loading or without any. */
  playerAmpWindows?: [number, number][];
  references: LogSnapshot[];
  referenceLabel: string;
}) {
  const withTimeline = references.filter((log) => log.timeline);
  const spanMs = Math.max(
    player.durationMs,
    median(withTimeline.map((log) => log.durationMs)) ?? 0,
  );
  const buckets = Math.max(1, Math.ceil(spanMs / BUCKET_MS));

  const playerBands: BandShares = {
    lust: shares([player.lust ?? []], buckets),
    potion: shares([player.potions ?? []], buckets),
    amp: shares([playerAmpWindows ?? spansOf(player, 'amp')], buckets),
  };
  const referenceBands: BandShares = {
    lust: shares(
      withTimeline.map((log) => spansOf(log, 'lust')),
      buckets,
    ),
    potion: shares(
      withTimeline.map((log) => spansOf(log, 'potion')),
      buckets,
    ),
    amp: shares(
      withTimeline.map((log) => spansOf(log, 'amp')),
      buckets,
    ),
  };

  const playerDps = dpsSeries(player, buckets) ?? [];
  const referenceSeries = withTimeline.map((log) => ({ log, dps: dpsSeries(log, buckets)! }));
  // Mean over the logs still fighting at each moment, while enough of them are.
  const referenceDps: number[] = [];
  for (let i = 0; i < buckets; i += 1) {
    const alive = referenceSeries.filter(({ log }) => log.durationMs > i * BUCKET_MS);
    if (alive.length < Math.max(1, withTimeline.length * MIN_ALIVE)) {
      break;
    }
    referenceDps.push(alive.reduce((sum, { dps }) => sum + dps[i], 0) / alive.length);
  }
  const referenceAverage = median(withTimeline.map((log) => log.fightDps)) ?? 0;
  // A round scale top, so the evenly spaced ticks land on round numbers.
  const peak = Math.max(1, ...playerDps, ...referenceDps);
  const dpsStep = niceStep(peak, DPS_TICKS);
  const maxDps = Math.ceil(peak / dpsStep) * dpsStep;
  const axisMs = buckets * BUCKET_MS;
  const ticksMs = timeTicks(spanMs);

  // Cooldowns the player has, in their order; reference share per bucket among logs that use it.
  const cooldownRows = player.windows.filter(
    (set) => set.windows.length > 0 || (set.castMs?.length ?? 0) > 0,
  );
  const activeShare = (logs: LogSnapshot[], token: string) =>
    shares(
      logs.map((log) => activeSpans(log.windows.find((set) => set.token === token))),
      buckets,
    );

  return (
    <TimeTicks.Provider value={ticksMs.map((ms) => (ms / axisMs) * WIDTH)}>
      <div
        className="text-muted"
        style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 8 }}
      >
        {BANDS.map((band) => (
          <span key={band.key}>
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                background: band.color,
                marginRight: 6,
              }}
            />
            {band.label}
          </span>
        ))}
        <span>Bands are stacked in that order, top to bottom. Dashed line: fight average.</span>
      </div>

      <DpsChart
        title="Your DPS"
        series={playerDps}
        average={player.fightDps}
        maxDps={maxDps}
        dpsStep={dpsStep}
        bands={playerBands}
        buckets={buckets}
        color={CHART_COLORS.you}
      />
      {withTimeline.length > 0 ? (
        <DpsChart
          title={`${referenceLabel}: mean DPS of ${withTimeline.length} logs`}
          series={referenceDps}
          average={referenceAverage}
          maxDps={maxDps}
          dpsStep={dpsStep}
          bands={referenceBands}
          buckets={buckets}
          color={CHART_COLORS.reference}
          logs={withTimeline.length}
        />
      ) : (
        <p className="text-muted">
          {referenceLabel} timelines appear once this spec's benchmarks are next rebuilt.
        </p>
      )}

      <CooldownChart
        title="Your cooldowns"
        rows={cooldownRows.map((set) => ({ ...set, active: activeShare([player], set.token) }))}
        bands={playerBands}
        buckets={buckets}
      />
      {references.length > 0 && (
        <CooldownChart
          title={`${referenceLabel}: share of ${references.length} logs with each cooldown up`}
          rows={cooldownRows.map((set) => ({ ...set, active: activeShare(references, set.token) }))}
          bands={referenceBands}
          buckets={buckets}
          logs={references.length}
          bandLogs={withTimeline.length}
        />
      )}
      <div
        className="text-muted"
        style={{
          fontSize: '0.85em',
          marginLeft: LABEL_WIDTH + 8,
          position: 'relative',
          height: 18,
        }}
      >
        {ticksMs.map((ms, i) => (
          <span
            key={ms}
            style={{
              position: 'absolute',
              left: `${(ms / axisMs) * 100}%`,
              transform: i === 0 ? undefined : 'translateX(-50%)',
              whiteSpace: 'nowrap',
            }}
          >
            {formatDuration(ms)}
          </span>
        ))}
      </div>
    </TimeTicks.Provider>
  );
}
