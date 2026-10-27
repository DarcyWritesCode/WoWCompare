import { formatDuration, formatNumber } from 'common/format';
import Config from 'parser/Config';
import { useEffect, useMemo, useRef, useState } from 'react';

import { medianResults, rescoreAgainst } from '../benchmarks/aggregate';
import { parseBenchmarkLog } from '../benchmarks/parseLog';
import { BuffEffects } from '../benchmarks/buffEffects';
import {
  fetchBenchmarkBundle,
  fetchBuffEffects,
  logKey,
  profileFingerprint,
} from '../benchmarks/published';
import { fetchRankingsPool, RankedParse, RankingsQuery } from '../benchmarks/rankings';
import {
  inBand,
  percentileOfRank,
  pickReference,
  REFERENCE_LABEL,
  ReferencePick,
} from '../benchmarks/reference';
import {
  BenchmarkSelection,
  PlayerContext,
  SAME_BUILD_THRESHOLD,
  selectBenchmarks,
} from '../benchmarks/select';
import { LogSnapshot, ProfileResults } from '../metrics/results';
import { Profile } from '../profile/types';
import { describeBuild, describeComp, describeHeroTrees } from './build';

/** Benchmark logs fetched and parsed at once. */
const CONCURRENCY = 3;

export interface BenchmarkInputs {
  config: Config;
  profile: Profile;
  player: PlayerContext;
  query: RankingsQuery;
  playerResults: ProfileResults;
}

/** A column of the comparison table: one parse, or a median over several. */
export interface BenchmarkColumn {
  title: string;
  subtitle: string;
  results: ProfileResults | null;
  /** Hero tree and talent differences (single logs) or the hero tree mix (medians). */
  build?: string;
  buildTooltip?: string;
  comp?: string;
  /** The parsed log(s) behind the column: one for a single parse, several for a median. */
  snapshots: LogSnapshot[];
}

/** One parsed benchmark log, selectable in the window timelines. */
export interface BenchmarkLog {
  key: string;
  reportCode: string;
  fightId: number;
  playerName: string;
  /** Which benchmarks this log is, e.g. "#1, Same build". */
  roles: string[];
  description: string;
  snapshot: LogSnapshot;
}

const parseKey = (parse: RankedParse) => logKey({ ...parse, playerName: parse.name });

export function describeParse(parse: RankedParse) {
  return `${parse.name} · ${formatNumber(parse.amount)} · ilvl ${parse.ilvl} · ${formatDuration(parse.durationMs)} · ${parse.raidSize}p`;
}

async function parseAll(
  config: Config,
  profile: Profile,
  parses: RankedParse[],
  onDone: () => void,
): Promise<Map<string, LogSnapshot | null>> {
  const snapshots = new Map<string, LogSnapshot | null>();
  const queue = [...parses];
  const worker = async () => {
    for (let parse = queue.shift(); parse; parse = queue.shift()) {
      try {
        snapshots.set(
          parseKey(parse),
          await parseBenchmarkLog(config, profile, {
            reportCode: parse.reportCode,
            fightId: parse.fightId,
            playerName: parse.name,
            serverName: parse.serverName,
          }),
        );
      } catch (err) {
        console.error('benchmark parse failed', parse, err);
        snapshots.set(parseKey(parse), null);
      }
      onDone();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return snapshots;
}

export type BenchmarkKind = 'top' | 'reference' | 'sameBuild' | 'bestClose' | 'close';

/** Benchmarks in column order. */
export const BENCHMARK_KINDS: BenchmarkKind[] = [
  'top',
  'reference',
  'sameBuild',
  'bestClose',
  'close',
];

/** Loaded with the tab; the rest are offered as buttons. */
const AUTO_LOADED: BenchmarkKind[] = ['top', 'reference'];

export const BENCHMARK_LABELS: Record<BenchmarkKind, string> = {
  top: '#1',
  reference: `${REFERENCE_LABEL} median`,
  sameBuild: 'Same build',
  bestClose: 'Best close',
  close: 'Close median',
};

/**
 * What the player is measured against: the median of the reference logs (around
 * `REFERENCE_BAND`) once loaded, else the #1 parse.
 */
export interface BenchmarkReference {
  /** e.g. "the 90–95th percentile median", "the #1 parse". */
  label: string;
  /** Which logs, e.g. "14 logs, ranks 160–318 of 3,183 (90–95th percentile)". */
  description: string;
  logs: LogSnapshot[];
  /** Metric-by-metric medians of `logs`. */
  results: ProfileResults;
}

function parsesFor(selection: BenchmarkSelection, kind: BenchmarkKind): RankedParse[] {
  switch (kind) {
    case 'top':
      return selection.top ? [selection.top] : [];
    case 'reference':
      return selection.reference.candidates;
    case 'sameBuild':
      return selection.sameBuild ? [selection.sameBuild.parse] : [];
    case 'bestClose':
      return selection.bestClose ? [selection.bestClose.parse] : [];
    case 'close':
      return selection.close.map((c) => c.parse);
  }
}

/** e.g. "14 logs, ranks 160–318 of 3,183 (90–95th percentile); 6 with PI/Aug buffs left out". */
function describeReference(
  selection: BenchmarkSelection,
  pick: ReferencePick<RankedParse>,
  excludeBuffed: boolean,
) {
  const { totalParses } = selection.reference;
  const ranks = pick.picked.map((p) => p.rank);
  const parts = [`${pick.picked.length} logs`];
  if (ranks.length > 0) {
    const low = Math.min(...ranks);
    const high = Math.max(...ranks);
    parts[0] += `, ranks ${low}–${high}`;
    if (totalParses) {
      const pct = (rank: number) => Math.floor(percentileOfRank(rank, totalParses));
      parts[0] += ` of ${formatNumber(totalParses)} (${pct(high)}–${pct(low)}th percentile)`;
    } else {
      parts[0] += ' (the deepest ranks available; total parses unknown)';
    }
  }
  if (pick.leftOut > 0) {
    parts.push(`${pick.leftOut} with PI/Aug buffs left out`);
  } else if (pick.keptBuffed) {
    parts.push('PI/Aug-buffed logs kept: too few without');
  } else if (!excludeBuffed) {
    parts.push('PI/Aug-buffed logs included');
  }
  return parts.join('; ');
}

/**
 * Fetches rankings, the #1 parse and the reference logs straight away; the other benchmarks load
 * on request, since each can cost full log parses. `excludeBuffed` leaves externally buffed logs
 * out of the reference (see `pickReference`); changing it needs no new parses.
 */
export default function useBenchmarks(inputs: BenchmarkInputs | undefined, excludeBuffed: boolean) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<BenchmarkSelection | null>(null);
  const [poolSize, setPoolSize] = useState(0);
  const [talents, setTalents] = useState<{ pool: string[][]; top: string[][] } | null>(null);
  const [effects, setEffects] = useState<BuffEffects | null>(null);
  /** Parsed logs by `parseKey`; null when parsing failed. */
  const [parsed, setParsed] = useState<Map<string, LogSnapshot | null>>(new Map());
  const [loaded, setLoaded] = useState<BenchmarkKind[]>([]);
  const started = useRef(false);
  // Read by `load`, which the mount effect calls from its first render's closure.
  const parsedRef = useRef(parsed);
  const busyRef = useRef(false);

  const addParsed = (fresh: Map<string, LogSnapshot | null>) => {
    parsedRef.current = new Map([...parsedRef.current, ...fresh]);
    setParsed(parsedRef.current);
  };

  const load = async (kind: BenchmarkKind, current = selection) => {
    if (!inputs || !current || busyRef.current) {
      return;
    }
    const parses = parsesFor(current, kind).filter((p) => !parsedRef.current.has(parseKey(p)));
    busyRef.current = true;
    setBusy(true);
    try {
      let done = 0;
      setStatus(`Loading ${BENCHMARK_LABELS[kind]}: 0 / ${parses.length} logs`);
      const fresh = await parseAll(inputs.config, inputs.profile, parses, () => {
        done += 1;
        setStatus(`Loading ${BENCHMARK_LABELS[kind]}: ${done} / ${parses.length} logs`);
      });
      addParsed(fresh);
      setLoaded((previous) => (previous.includes(kind) ? previous : [...previous, kind]));
      setStatus(null);
    } catch (err) {
      setStatus(`Failed to load ${BENCHMARK_LABELS[kind]}: ${(err as Error).message}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Rankings, the #1 parse and the reference logs load as soon as the tab opens.
  useEffect(() => {
    if (!inputs || started.current) {
      return;
    }
    started.current = true;
    (async () => {
      try {
        setStatus('Fetching rankings…');
        const { config, profile, query } = inputs;
        fetchBuffEffects(config.spec.id).then(setEffects);
        // The benchmark job's rankings and parsed logs, when it has covered this boss.
        const bundle = await fetchBenchmarkBundle(
          config.spec.id,
          query.encounterId,
          query.difficulty,
        );
        const rankings = bundle?.top ? bundle : await fetchRankingsPool(query);
        let next = selectBenchmarks(rankings, inputs.player);
        if (bundle?.top) {
          // The candidates the job parsed, even if selection has changed since (but only those in
          // the band: bundles built before it was enforced held near-top parses on small bosses).
          const { totalParses } = bundle.reference;
          const deepest = bundle.pool.reduce((max, p) => Math.max(max, p.rank), 0);
          next = {
            ...next,
            reference: {
              ...bundle.reference,
              candidates: bundle.reference.candidates.filter(
                (p) => totalParses === null || inBand(p, totalParses, deepest),
              ),
            },
          };
          // Its snapshots only count if they were parsed with this exact profile.
          if (bundle.profileFingerprint === profileFingerprint(profile)) {
            addParsed(new Map(Object.entries(bundle.snapshots)));
          }
        }
        setPoolSize(rankings.pool.length);
        setTalents({
          pool: rankings.pool.map((p) => p.talents),
          top: rankings.topTalents ?? [],
        });
        setSelection(next);
        // #1 first so something shows quickly, then the reference (usually already published).
        await load('top', next);
        await load('reference', next);
      } catch (err) {
        setStatus(`Failed to fetch rankings: ${(err as Error).message}`);
      }
    })();
    // load() is recreated each render; this runs once per mount on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs]);

  const derived = useMemo(() => {
    if (!inputs || !selection || loaded.length === 0) {
      return null;
    }
    const { profile, player } = inputs;
    const snapshotOf = (parse: RankedParse) => parsed.get(parseKey(parse));
    const snapshotsOf = (parses: RankedParse[]) =>
      parses.map(snapshotOf).filter((r): r is LogSnapshot => !!r);

    const single = (title: string, parse: RankedParse | undefined, note = ''): BenchmarkColumn => {
      const snapshot = parse && snapshotOf(parse);
      if (!parse || !snapshot) {
        return {
          title,
          subtitle: parse ? `${describeParse(parse)} · failed to load` : 'none',
          results: null,
          snapshots: [],
        };
      }
      const build = describeBuild(snapshot.build, player.talents);
      return {
        title,
        subtitle: describeParse(parse) + note,
        results: snapshot.results,
        build: build.summary,
        buildTooltip: build.tooltip,
        comp: describeComp(snapshot.comp),
        snapshots: [snapshot],
      };
    };
    const median = (title: string, parses: RankedParse[], note = ''): BenchmarkColumn => {
      const snapshots = snapshotsOf(parses);
      return {
        title,
        subtitle: `${snapshots.length} logs${note}`,
        results: medianResults(
          profile,
          snapshots.map((s) => s.results),
        ),
        build: describeHeroTrees(snapshots),
        snapshots,
      };
    };

    const pick = pickReference(selection.reference.candidates, snapshotOf, excludeBuffed);
    const closeCount = selection.close.filter((c) => c.withinBounds).length;
    const build: Record<BenchmarkKind, () => BenchmarkColumn> = {
      top: () => single(BENCHMARK_LABELS.top, selection.top),
      reference: () =>
        median(
          BENCHMARK_LABELS.reference,
          pick.picked,
          pick.leftOut > 0 ? `, ${pick.leftOut} with PI/Aug left out` : '',
        ),
      sameBuild: () =>
        single(
          BENCHMARK_LABELS.sameBuild,
          selection.sameBuild?.parse,
          selection.sameBuild && selection.sameBuild.similarity < SAME_BUILD_THRESHOLD
            ? ' (closest build)'
            : '',
        ),
      bestClose: () =>
        single(
          BENCHMARK_LABELS.bestClose,
          selection.bestClose?.parse,
          selection.bestClose?.withinBounds ? '' : ' (nearest, outside bounds)',
        ),
      close: () =>
        median(
          BENCHMARK_LABELS.close,
          selection.close.map((c) => c.parse),
          `, ${closeCount} within bounds`,
        ),
    };

    // The reference everything is scored against: the reference median if loaded, else #1. A
    // boss with too few parses to fill the band (early Mythic) has none: #1 there is the ceiling.
    const useBand = loaded.includes('reference') && pick.picked.length > 0;
    const { totalParses } = selection.reference;
    const tooFew = totalParses !== null && selection.reference.candidates.length === 0;
    const referenceLogs = useBand
      ? snapshotsOf(pick.picked)
      : snapshotsOf(selection.top && !tooFew ? [selection.top] : []);
    const referenceResults = medianResults(
      profile,
      referenceLogs.map((s) => s.results),
    );
    const reference: BenchmarkReference = {
      label: useBand
        ? `the ${BENCHMARK_LABELS.reference}`
        : tooFew
          ? `the ${REFERENCE_LABEL}`
          : 'the #1 parse',
      description: useBand
        ? describeReference(selection, pick, excludeBuffed)
        : tooFew
          ? `Only ${formatNumber(totalParses)} parses so far: too few to have any in the ${REFERENCE_LABEL}`
          : selection.top
            ? describeParse(selection.top)
            : '',
      logs: referenceLogs,
      results: referenceResults,
    };
    const rescore = (column: BenchmarkColumn): BenchmarkColumn => ({
      ...column,
      results: column.results && rescoreAgainst(column.results, referenceResults),
    });
    const columns = BENCHMARK_KINDS.filter((kind) => loaded.includes(kind)).map((kind) =>
      rescore(build[kind]()),
    );

    // Individual logs for the window timelines, the single-parse benchmarks first.
    const parses = new Map<string, RankedParse>();
    [
      selection.top,
      ...selection.reference.candidates,
      selection.sameBuild?.parse,
      ...selection.close.map((c) => c.parse),
    ].forEach((parse) => parse && parses.set(parseKey(parse), parse));
    const is = (parse: RankedParse, other: RankedParse | undefined) =>
      !!other && parseKey(parse) === parseKey(other);
    const inList = (parse: RankedParse, list: RankedParse[]) => list.some((p) => is(parse, p));
    const rolesOf = (parse: RankedParse) =>
      [
        is(parse, selection.top) && '#1',
        is(parse, selection.sameBuild?.parse) && 'Same build',
        is(parse, selection.bestClose?.parse) && 'Best close',
        inList(parse, pick.picked) && `Reference #${parse.rank}`,
        inList(
          parse,
          selection.close.map((c) => c.parse),
        ) && 'Close',
      ].filter((role): role is string => !!role);
    const headline = [selection.top, selection.sameBuild?.parse, selection.bestClose?.parse];
    const order = (parse: RankedParse) => (headline.some((h) => is(parse, h)) ? 0 : parse.rank);
    const logs: BenchmarkLog[] = [...parses.entries()]
      .flatMap(([key, parse]) => {
        const snapshot = parsed.get(key);
        return snapshot ? [{ key, parse, snapshot }] : [];
      })
      .sort((a, b) => order(a.parse) - order(b.parse))
      .map(({ key, parse, snapshot }) => ({
        key,
        reportCode: parse.reportCode,
        fightId: parse.fightId,
        playerName: parse.name,
        roles: rolesOf(parse),
        description: describeParse(parse),
        snapshot,
      }));

    return {
      columns,
      logs,
      reference,
      playerResults: rescoreAgainst(inputs.playerResults, referenceResults),
    };
  }, [inputs, selection, parsed, loaded, excludeBuffed]);

  return {
    status,
    busy,
    load,
    loaded,
    /** Benchmarks that can still be loaded. */
    available: selection
      ? BENCHMARK_KINDS.filter(
          (kind) =>
            !AUTO_LOADED.includes(kind) &&
            !loaded.includes(kind) &&
            parsesFor(selection, kind).length > 0,
        )
      : [],
    /** Ranked parses that same build and close benchmarks are chosen from. */
    poolSize,
    /** Talents of the ranked parses: the pool, and the top 100 when published. */
    talents,
    /** The spec's measured buff effects, for buff line-up estimates. */
    effects,
    columns: derived?.columns ?? null,
    logs: derived?.logs ?? [],
    reference: derived?.reference ?? null,
    playerResults: derived?.playerResults ?? null,
  };
}
