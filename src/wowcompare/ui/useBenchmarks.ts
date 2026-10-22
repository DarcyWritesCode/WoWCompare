import { formatDuration, formatNumber } from 'common/format';
import Config from 'parser/Config';
import { useState } from 'react';

import { medianResults, rescoreAgainst } from '../benchmarks/aggregate';
import { parseBenchmarkLog } from '../benchmarks/parseLog';
import { fetchRankings, RankedParse, RankingsQuery } from '../benchmarks/rankings';
import { PlayerContext, SAME_BUILD_THRESHOLD, selectBenchmarks } from '../benchmarks/select';
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

/** Fetches rankings, picks the five benchmarks and parses their logs on demand. */
export default function useBenchmarks(inputs: BenchmarkInputs | undefined) {
  const [status, setStatus] = useState<string | null>(null);
  const [columns, setColumns] = useState<BenchmarkColumn[] | null>(null);
  const [logs, setLogs] = useState<BenchmarkLog[]>([]);
  /** The player's results scored against the top-10 median, once benchmarks are in. */
  const [playerResults, setPlayerResults] = useState<ProfileResults | null>(null);

  const load = async () => {
    if (!inputs) {
      return;
    }
    const { config, profile, player, query } = inputs;
    try {
      setStatus('Fetching rankings…');
      const rankings = await fetchRankings(query);
      const selection = selectBenchmarks(rankings, player);
      const closeParses = selection.top10Close.map((c) => c.parse);
      const unique = [
        ...new Set(
          [...selection.top10, selection.sameBuild?.parse, ...closeParses].filter(
            (p): p is RankedParse => p !== undefined,
          ),
        ),
      ];

      let done = 0;
      setStatus(`Parsing benchmark logs: 0 / ${unique.length}`);
      const parsed = await parseAll(config, profile, unique, () => {
        done += 1;
        setStatus(`Parsing benchmark logs: ${done} / ${unique.length}`);
      });
      const snapshotsOf = (parses: RankedParse[]) =>
        parses.map((p) => parsed.get(p)).filter((r): r is LogSnapshot => !!r);
      const single = (
        title: string,
        parse: RankedParse | undefined,
        note = '',
      ): BenchmarkColumn => {
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

      const reference = medianResults(
        profile,
        snapshotsOf(selection.top10).map((s) => s.results),
      );
      const rescore = (column: BenchmarkColumn): BenchmarkColumn => ({
        ...column,
        results: column.results && rescoreAgainst(column.results, reference),
      });
      setPlayerResults(rescoreAgainst(inputs.playerResults, reference));
      setColumns(
        [
          single('#1', selection.top),
          median('Top 10 median', selection.top10),
          single(
            'Same build',
            selection.sameBuild?.parse,
            selection.sameBuild && selection.sameBuild.similarity < SAME_BUILD_THRESHOLD
              ? ' (closest build)'
              : '',
          ),
          single(
            'Best close',
            selection.bestClose?.parse,
            selection.bestClose?.withinBounds ? '' : ' (nearest, outside bounds)',
          ),
          median('Top 10 close median', closeParses, `, ${closeCount} within bounds`),
        ].map(rescore),
      );

      // Individual logs for the window timelines, the single-parse benchmarks first.
      const rolesOf = (parse: RankedParse) =>
        [
          parse === selection.top && '#1',
          parse === selection.sameBuild?.parse && 'Same build',
          parse === selection.bestClose?.parse && 'Best close',
          selection.top10.includes(parse) && `Top 10 #${parse.rank}`,
          closeParses.includes(parse) && 'Close',
        ].filter((role): role is string => !!role);
      setLogs(
        unique
          .map((parse) => ({ parse, snapshot: parsed.get(parse) }))
          .filter(
            (entry): entry is { parse: RankedParse; snapshot: LogSnapshot } => !!entry.snapshot,
          )
          .map(({ parse, snapshot }) => ({
            key: `${parse.reportCode}:${parse.fightId}:${parse.name}`,
            roles: rolesOf(parse),
            description: describeParse(parse),
            snapshot,
            order: [selection.top, selection.sameBuild?.parse, selection.bestClose?.parse].includes(
              parse,
            )
              ? 0
              : parse.rank,
          }))
          .sort((a, b) => a.order - b.order)
          .map(({ order: _order, ...log }) => log),
      );
      setStatus(
        `Compared against ${rankings.length} ranked parses. Close = ilvl ±5, kill time ±20%, raid size ±5.`,
      );
    } catch (err) {
      setStatus(`Failed to load benchmarks: ${(err as Error).message}`);
    }
  };

  return { status, columns, logs, playerResults, load };
}
