import { formatDuration, formatNumber } from 'common/format';
import { SpellLink } from 'interface';
import { createContext, ReactNode, useContext, useState } from 'react';

import { median } from '../benchmarks/aggregate';
import { LogSnapshot } from '../metrics/results';
import { CHART_COLORS } from './charts';

/** SVG user units across; charts stretch to the panel's width. */
const WIDTH = 1000;
const LINE_HEIGHT = 120;
const ROW_HEIGHT = 20;
/** How long a cast of a cooldown without a buff window is drawn. */
const CAST_TICK_MS = 2_000;
const LABEL_WIDTH = 160;
/** Bucket size of the band shares and the smoothed DPS and cast lines. */
const BUCKET_MS = 2_000;
/** Buckets averaged either side when smoothing the lines. */
const SMOOTHING = 2;
/** Time ticks are the first of these steps (seconds) giving at most this many ticks. */
const TIME_STEPS = [15, 30, 60, 120, 300];
const MAX_TIME_TICKS = 10;
/** Horizontal grid lines on the line charts, above zero. */
const VALUE_TICKS = 4;
const GRID_COLOR = 'rgba(255, 255, 255, 0.12)';
const CROSSHAIR_COLOR = 'rgba(255, 255, 255, 0.5)';
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

/** Re-buckets a per-second rate on a log's timeline to `BUCKET_MS` and smooths it. */
function smoothed(rates: number[], bucketMs: number, buckets: number): number[] {
  const raw = new Array(buckets).fill(0);
  const per = BUCKET_MS / bucketMs;
  rates.forEach((rate, i) => {
    const j = Math.floor(i / per);
    if (j < buckets) {
      raw[j] += rate / per;
    }
  });
  return raw.map((_, i) => {
    const window = raw.slice(Math.max(0, i - SMOOTHING), i + SMOOTHING + 1);
    return window.reduce((a, b) => a + b, 0) / window.length;
  });
}

const dpsSeries = (log: LogSnapshot, buckets: number): number[] | null =>
  log.timeline ? smoothed(log.timeline.dps, log.timeline.bucketMs, buckets) : null;

/** Casts per second; null for logs from before cast timelines. */
function castSeries(log: LogSnapshot, buckets: number): number[] | null {
  const timeline = log.timeline;
  if (!timeline?.casts) {
    return null;
  }
  const perSecond = 1000 / timeline.bucketMs;
  return smoothed(
    timeline.casts.map((casts) => casts * perSecond),
    timeline.bucketMs,
    buckets,
  );
}

/** Casts per second over the whole fight. */
const fightCastRate = (log: LogSnapshot) =>
  log.durationMs > 0
    ? ((log.timeline?.casts ?? []).reduce((a, b) => a + b, 0) / log.durationMs) * 1000
    : 0;

/** Per bucket, the mean over the logs still fighting, while enough of them are. */
function meanSeries(series: { log: LogSnapshot; values: number[] }[], buckets: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < buckets; i += 1) {
    const alive = series.filter(({ log }) => log.durationMs > i * BUCKET_MS);
    if (alive.length === 0 || alive.length < series.length * MIN_ALIVE) {
      break;
    }
    out.push(alive.reduce((sum, { values }) => sum + values[i], 0) / alive.length);
  }
  return out;
}

/** A round scale top for a pair of charts, and its tick step. */
function scaleOf(...series: number[][]) {
  const peak = Math.max(...series.flat(), Number.EPSILON);
  const step = niceStep(peak, VALUE_TICKS);
  return { max: Math.ceil(peak / step) * step, step };
}

/** What a line chart plots: DPS, or casts per second. */
interface Measure {
  unit: string;
  format: (value: number) => string;
}
const DPS: Measure = { unit: 'DPS', format: (dps) => formatNumber(dps) };
const CASTS: Measure = { unit: 'casts/s', format: (rate) => rate.toFixed(rate < 10 ? 1 : 0) };

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
          />
        )),
      )}
    </>
  );
}

/** Where the mouse is: x across every chart (0..1), y within the chart it's over (0..1). */
interface Hover {
  x: number;
  y: number;
  chart: string;
}

/** What every chart shares: the time axis and the crosshair. */
const Timeline = createContext<{
  /** Time ticks as x positions in SVG units. */
  ticks: number[];
  /** The same ticks in ms from the pull, for the time labels. */
  ticksMs: number[];
  axisMs: number;
  buckets: number;
  hover: Hover | null;
  setHover: (hover: Hover | null) => void;
}>({ ticks: [], ticksMs: [], axisMs: 1, buckets: 1, hover: null, setHover: () => undefined });

/** The bands up in a bucket, for tooltips: on or off for the player, a share of the logs otherwise. */
function bandsAt(bands: BandShares, bucket: number, logs?: number): ReactNode[] {
  return BANDS.filter((band) => (bands[band.key][bucket] ?? 0) > 0).map((band) => (
    <div key={band.key} style={{ color: band.color }}>
      {band.label}
      {logs !== undefined && ` in ${Math.round(bands[band.key][bucket] * logs)} of ${logs} logs`}
    </div>
  ));
}

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
  id,
  label,
  height,
  tooltip,
  children,
}: {
  /** Names the chart for the crosshair: its horizontal line and tooltip show only on this one. */
  id: string;
  label: ReactNode;
  height: number;
  /** What the tooltip says at a bucket, under the time. */
  tooltip: (bucket: number) => ReactNode;
  children: ReactNode;
}) {
  const { ticks, axisMs, buckets, hover, setHover } = useContext(Timeline);
  const here = hover?.chart === id ? hover : null;
  const bucket = here ? Math.min(buckets - 1, Math.floor(here.x * buckets)) : 0;
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
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          preserveAspectRatio="none"
          width="100%"
          height={height}
          style={{ background: CHART_COLORS.track, display: 'block' }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHover({
              x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
              y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
              chart: id,
            });
          }}
          onMouseLeave={() => setHover(null)}
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
          {hover && (
            <line
              x1={hover.x * WIDTH}
              x2={hover.x * WIDTH}
              y1={0}
              y2={height}
              stroke={CROSSHAIR_COLOR}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
          {here && (
            <line
              x1={0}
              x2={WIDTH}
              y1={here.y * height}
              y2={here.y * height}
              stroke={CROSSHAIR_COLOR}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
        </svg>
        {here && (
          <div
            style={{
              position: 'absolute',
              top: here.y * height + 12,
              // Flips to the left of the cursor past the middle, so it stays on the chart.
              ...(here.x < 0.5
                ? { left: `calc(${here.x * 100}% + 12px)` }
                : { right: `calc(${(1 - here.x) * 100}% + 12px)` }),
              zIndex: 10,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              background: 'rgba(20, 20, 20, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: 3,
              padding: '4px 8px',
              fontSize: '0.85em',
            }}
          >
            <div className="text-muted">{formatDuration(here.x * axisMs)}</div>
            {tooltip(bucket)}
          </div>
        )}
      </div>
    </div>
  );
}

function LineChart({
  id,
  title,
  measure,
  series,
  average,
  scale,
  bands,
  buckets,
  color,
  logs,
}: {
  id: string;
  title: ReactNode;
  measure: Measure;
  series: number[];
  average: number;
  /** The scale's top, a multiple of `step`; shared by the pair of charts. */
  scale: { max: number; step: number };
  bands: BandShares;
  buckets: number;
  color: string;
  /** How many logs the bands are over; undefined for the player's own log. */
  logs?: number;
}) {
  const x = (i: number) => ((i + 0.5) / buckets) * WIDTH;
  const { max, step } = scale;
  const y = (value: number) => LINE_HEIGHT - (Math.min(value, max) / max) * LINE_HEIGHT;
  const points = series.map((value, i) => `${x(i)},${y(value)}`);
  const valueTicks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  return (
    <>
      <h4 style={{ marginBottom: 4 }}>
        {title}{' '}
        <small className="text-muted">
          {measure.format(average)} {measure.unit} over the fight
        </small>
      </h4>
      {/* An axis, not a value: both charts share the scale, which tops out above the higher peak. */}
      <Frame
        id={id}
        tooltip={(bucket) => (
          <>
            <div style={{ color }}>
              {bucket < series.length
                ? `${measure.format(series[bucket])} ${measure.unit}`
                : 'Fight over'}
            </div>
            {bandsAt(bands, bucket, logs)}
          </>
        )}
        label={
          <span
            className="text-muted"
            style={{ position: 'relative', display: 'block', height: '100%', fontSize: '0.9em' }}
          >
            {valueTicks.map((value) => (
              <span
                key={value}
                style={{
                  position: 'absolute',
                  right: 0,
                  top: y(value),
                  transform: `translateY(${value === 0 ? -100 : value === max ? 0 : -50}%)`,
                  lineHeight: 1,
                }}
              >
                {measure.format(value)}
              </span>
            ))}
          </span>
        }
        height={LINE_HEIGHT}
      >
        {valueTicks.map((value) => (
          <line
            key={value}
            x1={0}
            x2={WIDTH}
            y1={y(value)}
            y2={y(value)}
            stroke={GRID_COLOR}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <BandLanes bands={bands} buckets={buckets} height={LINE_HEIGHT} logs={logs} />
        {points.length > 1 && (
          <>
            <polygon
              points={`${x(0)},${LINE_HEIGHT} ${points.join(' ')} ${x(series.length - 1)},${LINE_HEIGHT}`}
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

/** Steps the reference charts between the logs' mean and each log on its own. */
function ReferencePicker({
  picked,
  count,
  onPick,
}: {
  /** The log shown, or null for the mean. */
  picked: number | null;
  count: number;
  onPick: (picked: number | null) => void;
}) {
  // The mean, then each log, wrapping around.
  const step = (by: number) => {
    const next = ((picked === null ? 0 : picked + 1) + by + count + 1) % (count + 1);
    onPick(next === 0 ? null : next - 1);
  };
  const button = (label: string, title: string, by: number) => (
    <button
      type="button"
      title={title}
      onClick={() => step(by)}
      style={{
        background: 'transparent',
        color: 'inherit',
        border: '1px solid rgba(255, 255, 255, 0.3)',
        borderRadius: 3,
        width: 24,
        lineHeight: '18px',
        padding: 0,
      }}
    >
      {label}
    </button>
  );
  return (
    <span style={{ whiteSpace: 'nowrap', marginRight: 10 }}>
      {button('‹', 'Previous log', -1)}
      <span
        className="text-muted"
        style={{ display: 'inline-block', minWidth: 64, textAlign: 'center' }}
      >
        {picked === null ? 'Mean' : `${picked + 1} / ${count}`}
      </span>
      {button('›', 'Next log', 1)}
    </span>
  );
}

/** Time labels under a pair of charts. */
function TimeAxis() {
  const { ticksMs, axisMs } = useContext(Timeline);
  return (
    <div
      className="text-muted"
      style={{
        fontSize: '0.85em',
        marginLeft: LABEL_WIDTH + 8,
        marginBottom: 12,
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
  );
}

function CooldownChart({
  id,
  title,
  rows,
  bands,
  buckets,
  logs,
  bandLogs,
}: {
  id: string;
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
          id={`${id}:${row.token}`}
          tooltip={(bucket) => (
            <>
              <div style={{ color: CHART_COLORS.you }}>
                <SpellLink spell={row.spellId}>{row.label}</SpellLink>{' '}
                {logs === undefined
                  ? row.active[bucket] > 0
                    ? 'up'
                    : 'not up'
                  : `up in ${Math.round((row.active[bucket] ?? 0) * logs)} of ${logs} logs`}
              </div>
              {bandsAt(bands, bucket, bandLogs)}
            </>
          )}
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
 * The fight as aligned pairs of timelines, the player's over the reference logs': DPS (the logs'
 * mean), casts per second (the logs' mean, so the player's downtime shows against the references'
 * uptime), then cooldowns (how often the logs had each up). Every chart carries Bloodlust,
 * damage potion and damage amp bands in stacked lanes; on the reference charts their strength is
 * the share of logs with the band up at that moment. Time runs from the pull in every chart. The
 * reference charts step together from the mean to each reference log on its own.
 */
export default function FightTimelines({
  player,
  playerAmpWindows,
  references: allReferences,
  referenceNames = [],
  referenceLabel,
  castParsing,
}: {
  player: LogSnapshot;
  /** The player's amp windows, ms from the pull; undefined while loading or without any. */
  playerAmpWindows?: [number, number][];
  references: LogSnapshot[];
  /** Each reference log's name for its own charts, e.g. "Name (#463)"; in `references`' order. */
  referenceNames?: string[];
  referenceLabel: string;
  /** Reference logs without casts (published before cast timelines), and parsing them here. */
  castParsing?: { missing: number; load: () => void; busy: boolean; status: string | null };
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [pickedState, setPicked] = useState<number | null>(null);
  // The reference logs can change under the picker (e.g. a cooldown filter); fall back to the mean.
  const picked = pickedState !== null && pickedState < allReferences.length ? pickedState : null;
  const references = picked === null ? allReferences : [allReferences[picked]];
  const withTimeline = references.filter((log) => log.timeline);
  // Shares for the mean; a single log shows on or off, like the player's.
  const logCount = (logs: LogSnapshot[]) => (picked === null ? logs.length : undefined);
  const pickedName =
    picked === null ? null : referenceNames[picked] || `${referenceLabel} log ${picked + 1}`;
  /** `mean` describes the logs' mean, `single` one log's own chart. */
  const referenceTitle = (mean: string, single: string) => (
    <>
      {allReferences.length > 1 && (
        <ReferencePicker picked={picked} count={allReferences.length} onPick={setPicked} />
      )}
      {pickedName === null ? `${referenceLabel}: ${mean}` : `${pickedName}: ${single}`}
    </>
  );
  const spanMs = Math.max(
    player.durationMs,
    median(allReferences.filter((log) => log.timeline).map((log) => log.durationMs)) ?? 0,
    picked === null ? 0 : allReferences[picked].durationMs,
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
  const referenceDps = meanSeries(
    withTimeline.map((log) => ({ log, values: dpsSeries(log, buckets)! })),
    buckets,
  );
  const referenceAverage = median(withTimeline.map((log) => log.fightDps)) ?? 0;
  // A round scale top, so the evenly spaced ticks land on round numbers.
  const dpsScale = scaleOf(playerDps, referenceDps);

  const playerCasts = castSeries(player, buckets);
  const withCasts = withTimeline.filter((log) => log.timeline?.casts);
  const referenceCasts = meanSeries(
    withCasts.map((log) => ({ log, values: castSeries(log, buckets)! })),
    buckets,
  );
  const castScale = scaleOf(playerCasts ?? [], referenceCasts);
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
    <Timeline.Provider
      value={{
        ticks: ticksMs.map((ms) => (ms / axisMs) * WIDTH),
        ticksMs,
        axisMs,
        buckets,
        hover,
        setHover,
      }}
    >
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

      <LineChart
        id="you"
        title="Your DPS"
        measure={DPS}
        series={playerDps}
        average={player.fightDps}
        scale={dpsScale}
        bands={playerBands}
        buckets={buckets}
        color={CHART_COLORS.you}
      />
      {withTimeline.length > 0 && (
        <LineChart
          id="reference"
          title={referenceTitle(`mean DPS of ${withTimeline.length} logs`, 'DPS')}
          measure={DPS}
          series={referenceDps}
          average={referenceAverage}
          scale={dpsScale}
          bands={referenceBands}
          buckets={buckets}
          color={CHART_COLORS.reference}
          logs={logCount(withTimeline)}
        />
      )}
      <TimeAxis />
      {withTimeline.length === 0 && (
        <p className="text-muted">
          {referenceLabel} timelines appear once this spec's benchmarks are next rebuilt.
        </p>
      )}

      {playerCasts && (
        <>
          <LineChart
            id="your-casts"
            title="Your casts per second"
            measure={CASTS}
            series={playerCasts}
            average={fightCastRate(player)}
            scale={castScale}
            bands={playerBands}
            buckets={buckets}
            color={CHART_COLORS.you}
          />
          {withCasts.length > 0 && (
            <LineChart
              id="reference-casts"
              title={referenceTitle(
                `mean casts per second of ${withCasts.length} logs`,
                'casts per second',
              )}
              measure={CASTS}
              series={referenceCasts}
              average={median(withCasts.map(fightCastRate)) ?? 0}
              scale={castScale}
              bands={referenceBands}
              buckets={buckets}
              color={CHART_COLORS.reference}
              logs={logCount(withTimeline)}
            />
          )}
          <TimeAxis />
          {castParsing && castParsing.missing > 0 && (
            <p className="text-muted">
              {castParsing.missing} {referenceLabel} logs were published before cast timelines;
              they'll have casts when this spec's benchmarks are next rebuilt.{' '}
              {castParsing.status ?? (
                <button
                  type="button"
                  className="btn btn-default btn-sm"
                  disabled={castParsing.busy}
                  onClick={castParsing.load}
                >
                  Parse them in your browser now
                </button>
              )}
            </p>
          )}
        </>
      )}

      <CooldownChart
        id="your-cooldowns"
        title="Your cooldowns"
        rows={cooldownRows.map((set) => ({ ...set, active: activeShare([player], set.token) }))}
        bands={playerBands}
        buckets={buckets}
      />
      {references.length > 0 && (
        <CooldownChart
          id="reference-cooldowns"
          title={referenceTitle(
            `share of ${references.length} logs with each cooldown up`,
            'cooldowns',
          )}
          rows={cooldownRows.map((set) => ({ ...set, active: activeShare(references, set.token) }))}
          bands={referenceBands}
          buckets={buckets}
          logs={logCount(references)}
          bandLogs={logCount(withTimeline)}
        />
      )}
      <TimeAxis />
    </Timeline.Provider>
  );
}
