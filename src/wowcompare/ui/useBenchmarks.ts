import { formatDuration, formatNumber } from 'common/format';
import Config from 'parser/Config';
import { useEffect, useMemo, useRef, useState } from 'react';

import { medianResults, rescoreAgainst } from '../benchmarks/aggregate';
import { parseBenchmarkLog } from '../benchmarks/parseLog';
import { fetchRankings, RankedParse, RankingsQuery } from '../benchmarks/rankings';
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
  /** Which benchmarks this log is, e.g. "#1, Same build". */
  roles: string[];
  description: string;
  snapshot: LogSnapshot;
}

export function describeParse(parse: RankedParse) {
  return `${parse.name} · ${formatNumber(parse.amount)} · ilvl ${parse.ilvl} · ${formatDuration(parse.durationMs)} · ${parse.raidSize}p`;
}

async function parseAll(
  config: Config,
  profile: Profile,
  parses: RankedParse[],
  onDone: () => void,
): Promise<Map<RankedParse, LogSnapshot | null>> {
  const snapshots = new Map<RankedParse, LogSnapshot | null>();
  const queue = [...parses];
  const worker = async () => {
    for (let parse = queue.shift(); parse; parse = queue.shift()) {
      try {
        snapshots.set(
          parse,
          await parseBenchmarkLog(config, profile, {
            reportCode: parse.reportCode,
            fightId: parse.fightId,
            playerName: parse.name,
            serverName: parse.serverName,
          }),
        );
      } catch (err) {
        console.error('benchmark parse failed', parse, err);
        snapshots.set(parse, null);
      }
      onDone();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return snapshots;
}

export type BenchmarkKind = 'top' | 'top10' | 'sameBuild' | 'bestClose' | 'top10Close';

/** Benchmarks in column order. */
export const BENCHMARK_KINDS: BenchmarkKind[] = [
  'top',
  'top10',
  'sameBuild',
  'bestClose',
  'top10Close',
];

/** Loaded with the tab; the rest are offered as buttons. */
const AUTO_LOADED: BenchmarkKind[] = ['top', 'top10'];

export const BENCHMARK_LABELS: Record<BenchmarkKind, string> = {
  top: '#1',
  top10: 'Top 10 median',
  sameBuild: 'Same build',
  bestClose: 'Best close',
  top10Close: 'Top 10 close median',
};

/** What the player is measured against: the top-10 median once loaded, else the #1 parse. */
export interface BenchmarkReference {
  /** e.g. "the top-10 median", "the #1 parse". */
  label: string;
  logs: LogSnapshot[];
}

function parsesFor(selection: BenchmarkSelection, kind: BenchmarkKind): RankedParse[] {
  switch (kind) {
    case 'top':
      return selection.top ? [selection.top] : [];
    case 'top10':
      return selection.top10;
    case 'sameBuild':
      return selection.sameBuild ? [selection.sameBuild.parse] : [];
    case 'bestClose':
      return selection.bestClose ? [selection.bestClose.parse] : [];
    case 'top10Close':
      return selection.top10Close.map((c) => c.parse);
  }
}

/**
 * Fetches rankings, the #1 parse and the top 10 straight away; the other benchmarks load on
 * request, since each can cost full log parses.
 */
export default function useBenchmarks(inputs: BenchmarkInputs | undefined) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rankingCount, setRankingCount] = useState(0);
  const [selection, setSelection] = useState<BenchmarkSelection | null>(null);
  const [parsed, setParsed] = useState<Map<RankedParse, LogSnapshot | null>>(new Map());
  const [loaded, setLoaded] = useState<BenchmarkKind[]>([]);
  const started = useRef(false);

  const load = async (kind: BenchmarkKind, current = selection) => {
    if (!inputs || !current || busy) {
      return;
    }
    const parses = parsesFor(current, kind).filter((p) => !parsed.has(p));
    setBusy(true);
    try {
      let done = 0;
      setStatus(`Loading ${BENCHMARK_LABELS[kind]}: 0 / ${parses.length} logs`);
      const fresh = await parseAll(inputs.config, inputs.profile, parses, () => {
        done += 1;
        setStatus(`Loading ${BENCHMARK_LABELS[kind]}: ${done} / ${parses.length} logs`);
      });
      setParsed((previous) => new Map([...previous, ...fresh]));
      setLoaded((previous) => (previous.includes(kind) ? previous : [...previous, kind]));
      setStatus(null);
    } catch (err) {
      setStatus(`Failed to load ${BENCHMARK_LABELS[kind]}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Rankings, the #1 parse and the top 10 load as soon as the tab opens.
  useEffect(() => {
    if (!inputs || started.current) {
      return;
    }
    started.current = true;
    (async () => {
      try {
        setStatus('Fetching rankings…');
        const rankings = await fetchRankings(inputs.query);
        const next = selectBenchmarks(rankings, inputs.player);
        setRankingCount(rankings.length);
        setSelection(next);
        // #1 first so something shows quickly, then the top 10 (usually cached server-side).
        await load('top', next);
        await load('top10', next);
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
    const snapshotsOf = (parses: RankedParse[]) =>
      parses.map((p) => parsed.get(p)).filter((r): r is LogSnapshot => !!r);

    const single = (title: string, parse: RankedParse | undefined, note = ''): BenchmarkColumn => {
      const snapshot = parse && parsed.get(parse);
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
    const closeCount = selection.top10Close.filter((c) => c.withinBounds).length;
    const build: Record<BenchmarkKind, () => BenchmarkColumn> = {
      top: () => single(BENCHMARK_LABELS.top, selection.top),
      top10: () => median(BENCHMARK_LABELS.top10, selection.top10),
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
      top10Close: () =>
        median(
          BENCHMARK_LABELS.top10Close,
          selection.top10Close.map((c) => c.parse),
          `, ${closeCount} within bounds`,
        ),
    };

    // The reference everything is scored against: the top-10 median if loaded, else #1.
    const referenceLogs = loaded.includes('top10')
      ? snapshotsOf(selection.top10)
      : snapshotsOf(selection.top ? [selection.top] : []);
    const reference: BenchmarkReference = {
      label: loaded.includes('top10') ? 'the top-10 median' : 'the #1 parse',
      logs: referenceLogs,
    };
    const referenceResults = medianResults(
      profile,
      referenceLogs.map((s) => s.results),
    );
    const rescore = (column: BenchmarkColumn): BenchmarkColumn => ({
      ...column,
      results: column.results && rescoreAgainst(column.results, referenceResults),
    });
    const columns = BENCHMARK_KINDS.filter((kind) => loaded.includes(kind)).map((kind) =>
      rescore(build[kind]()),
    );

    // Individual logs for the window timelines, the single-parse benchmarks first.
    const closeParses = selection.top10Close.map((c) => c.parse);
    const rolesOf = (parse: RankedParse) =>
      [
        parse === selection.top && '#1',
        parse === selection.sameBuild?.parse && 'Same build',
        parse === selection.bestClose?.parse && 'Best close',
        selection.top10.includes(parse) && `Top 10 #${parse.rank}`,
        closeParses.includes(parse) && 'Close',
      ].filter((role): role is string => !!role);
    const headline = [selection.top, selection.sameBuild?.parse, selection.bestClose?.parse];
    const logs: BenchmarkLog[] = [...parsed.entries()]
      .filter((entry): entry is [RankedParse, LogSnapshot] => !!entry[1])
      .sort(([a], [b]) => (headline.includes(a) ? 0 : a.rank) - (headline.includes(b) ? 0 : b.rank))
      .map(([parse, snapshot]) => ({
        key: `${parse.reportCode}:${parse.fightId}:${parse.name}`,
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
  }, [inputs, selection, parsed, loaded]);

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
    rankingCount,
    columns: derived?.columns ?? null,
    logs: derived?.logs ?? [],
    reference: derived?.reference ?? null,
    playerResults: derived?.playerResults ?? null,
  };
}
