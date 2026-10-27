import { formatDuration, formatNumber } from 'common/format';
import { SpellLink } from 'interface';
import { ReactNode } from 'react';

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

function Frame({
  label,
  height,
  children,
}: {
  label: ReactNode;
  height: number;
  children: ReactNode;
}) {
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
  bands,
  buckets,
  color,
  logs,
}: {
  title: ReactNode;
  series: number[];
  average: number;
  maxDps: number;
  bands: BandShares;
  buckets: number;
  color: string;
  /** How many logs the bands are over; undefined for the player's own log. */
  logs?: number;
}) {
  const x = (i: number) => ((i + 0.5) / buckets) * WIDTH;
  const y = (dps: number) => DPS_HEIGHT - (Math.min(dps, maxDps) / maxDps) * DPS_HEIGHT;
  const points = series.map((dps, i) => `${x(i)},${y(dps)}`);
  return (
    <>
      <h4 style={{ marginBottom: 4 }}>{title}</h4>
      <Frame
        label={<span className="text-muted">{formatNumber(maxDps)} DPS</span>}
        height={DPS_HEIGHT}
      >
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
              opacity={logs === undefined ? 1 : shareOpacity(share)}
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
  const maxDps = Math.max(1, ...playerDps, ...referenceDps);

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
    <>
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
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>0:00</span>
        <span>{formatDuration(spanMs / 2)}</span>
        <span>{formatDuration(spanMs)}</span>
      </div>
    </>
  );
}
