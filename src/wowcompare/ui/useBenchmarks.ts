import { formatDuration, formatNumber, formatPercentage } from 'common/format';
import Config from 'parser/Config';
import { useState } from 'react';

import { medianResults } from '../benchmarks/aggregate';
import { parseBenchmarkLog } from '../benchmarks/parseLog';
import { fetchRankings, RankedParse, RankingsQuery } from '../benchmarks/rankings';
import { PlayerContext, SAME_BUILD_THRESHOLD, selectBenchmarks } from '../benchmarks/select';
import { LogSnapshot, ProfileResults } from '../metrics/results';
import { Profile } from '../profile/types';

/** Benchmark logs fetched and parsed at once. */
const CONCURRENCY = 3;

export interface BenchmarkInputs {
  config: Config;
  profile: Profile;
  player: PlayerContext;
  query: RankingsQuery;
}

/** A column of the comparison table: one parse, or a median over several. */
export interface BenchmarkColumn {
  title: string;
  subtitle: string;
  results: ProfileResults | null;
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
          await parseBenchmarkLog(config, {
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
      const parsed = await parseAll(config, unique, () => {
        done += 1;
        setStatus(`Parsing benchmark logs: ${done} / ${unique.length}`);
      });
      const resultsOf = (parses: RankedParse[]) =>
        parses.map((p) => parsed.get(p)?.results).filter((r): r is ProfileResults => !!r);
      const single = (parse: RankedParse | undefined) =>
        (parse && parsed.get(parse)?.results) ?? null;
      const closeCount = selection.top10Close.filter((c) => c.withinBounds).length;

      setColumns([
        {
          title: '#1',
          subtitle: selection.top ? describeParse(selection.top) : 'none',
          results: single(selection.top),
        },
        {
          title: 'Top 10 median',
          subtitle: `${resultsOf(selection.top10).length} logs`,
          results: medianResults(profile, resultsOf(selection.top10)),
        },
        {
          title: 'Same build',
          subtitle: selection.sameBuild
            ? `${describeParse(selection.sameBuild.parse)} · ${formatPercentage(selection.sameBuild.similarity, 0)}% talents match${selection.sameBuild.similarity < SAME_BUILD_THRESHOLD ? ' (closest)' : ''}`
            : 'none',
          results: single(selection.sameBuild?.parse),
        },
        {
          title: 'Best close',
          subtitle: selection.bestClose
            ? `${describeParse(selection.bestClose.parse)}${selection.bestClose.withinBounds ? '' : ' (nearest, outside bounds)'}`
            : 'none',
          results: single(selection.bestClose?.parse),
        },
        {
          title: 'Top 10 close median',
          subtitle: `${resultsOf(closeParses).length} logs, ${closeCount} within bounds`,
          results: medianResults(profile, resultsOf(closeParses)),
        },
      ]);

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

  return { status, columns, logs, load };
}
