import { formatDuration, formatNumber, formatPercentage } from 'common/format';
import { SpellLink } from 'interface';
import Config from 'parser/Config';
import { useState } from 'react';

import { medianResults } from '../benchmarks/aggregate';
import { parseBenchmarkLog } from '../benchmarks/parseLog';
import { fetchRankings, RankedParse, RankingsQuery } from '../benchmarks/rankings';
import { PlayerContext, SAME_BUILD_THRESHOLD, selectBenchmarks } from '../benchmarks/select';
import { ProfileResults, ScoredMetric, ScoredRule } from '../metrics/results';
import { MetricKind, Profile } from '../profile/types';
import { formatValue, METRIC_LABELS, STATUS_COLORS } from './ProfileResultsTable';

/** Benchmark logs fetched and parsed at once. */
const CONCURRENCY = 3;

interface Column {
  title: string;
  /** Who/what the column is: a single parse, or a median over several. */
  subtitle: string;
  results: ProfileResults | null;
}

interface Props {
  config: Config;
  profile: Profile;
  player: PlayerContext;
  playerResults: ProfileResults;
  query: RankingsQuery;
}

function describeParse(parse: RankedParse) {
  return `${parse.name} · ${formatNumber(parse.amount)} · ilvl ${parse.ilvl} · ${formatDuration(parse.durationMs)} · ${parse.raidSize}p`;
}

async function parseAll(
  config: Config,
  parses: RankedParse[],
  onDone: () => void,
): Promise<Map<RankedParse, ProfileResults | null>> {
  const results = new Map<RankedParse, ProfileResults | null>();
  const queue = [...parses];
  const worker = async () => {
    for (let parse = queue.shift(); parse; parse = queue.shift()) {
      try {
        results.set(
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
        results.set(parse, null);
      }
      onDone();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

/** Fetches the five benchmarks for this fight and shows them next to the player's results. */
export default function BenchmarkComparison({
  config,
  profile,
  player,
  playerResults,
  query,
}: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [columns, setColumns] = useState<Column[] | null>(null);

  const load = async () => {
    try {
      setStatus('Fetching rankings…');
      const rankings = await fetchRankings(query);
      const selection = selectBenchmarks(rankings, player);
      const unique = [
        ...new Set(
          [
            ...selection.top10,
            selection.sameBuild?.parse,
            ...selection.top10Close.map((c) => c.parse),
          ].filter((p): p is RankedParse => p !== undefined),
        ),
      ];

      let done = 0;
      setStatus(`Parsing benchmark logs: 0 / ${unique.length}`);
      const parsed = await parseAll(config, unique, () => {
        done += 1;
        setStatus(`Parsing benchmark logs: ${done} / ${unique.length}`);
      });
      const resultsOf = (parses: RankedParse[]) =>
        parses.map((p) => parsed.get(p)).filter((r): r is ProfileResults => !!r);
      const single = (parse: RankedParse | undefined) => (parse && parsed.get(parse)) ?? null;
      const closeCount = selection.top10Close.filter((c) => c.withinBounds).length;

      setColumns([
        { title: 'You', subtitle: 'this log', results: playerResults },
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
          subtitle: `${resultsOf(selection.top10Close.map((c) => c.parse)).length} logs, ${closeCount} within bounds`,
          results: medianResults(profile, resultsOf(selection.top10Close.map((c) => c.parse))),
        },
      ]);
      setStatus(
        `Compared against ${rankings.length} ranked parses. Close = ilvl ±5, kill time ±20%, raid size ±5.`,
      );
    } catch (err) {
      setStatus(`Failed to load benchmarks: ${(err as Error).message}`);
    }
  };

  if (!columns) {
    return (
      <div>
        <button type="button" className="btn btn-primary" onClick={load} disabled={!!status}>
          Load benchmarks
        </button>{' '}
        {status && <span className="text-muted">{status}</span>}
      </div>
    );
  }

  const metricCell = (column: Column, entryIndex: number, kind: MetricKind) => {
    const entry = column.results?.entries[entryIndex];
    const metric: ScoredMetric | undefined = entry?.applicable ? entry.metrics[kind] : undefined;
    return (
      <td key={column.title} style={{ color: metric ? STATUS_COLORS[metric.status] : undefined }}>
        {metric ? formatValue(kind, metric.value) : '—'}
      </td>
    );
  };

  const ruleCell = (column: Column, ruleIndex: number) => {
    const rule: ScoredRule | undefined = column.results?.rules[ruleIndex];
    return (
      <td key={column.title} style={{ color: rule ? STATUS_COLORS[rule.status] : undefined }}>
        {rule ? formatValue('rule', rule.value) : '—'}
      </td>
    );
  };

  return (
    <>
      <table className="table table-condensed">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Buff / cooldown</th>
            <th>Metric</th>
            {columns.map((column) => (
              <th key={column.title} title={column.subtitle}>
                {column.title}
                <div className="text-muted" style={{ fontWeight: 'normal', fontSize: '0.8em' }}>
                  {column.subtitle}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {playerResults.entries.flatMap((entry, entryIndex) =>
            (Object.keys(entry.metrics) as MetricKind[]).map((kind) => (
              <tr key={`${entry.kind}-${entry.spellId}-${kind}`}>
                <td>{entry.rank}</td>
                <td>
                  <SpellLink spell={entry.spellId}>{entry.label}</SpellLink>
                </td>
                <td>{METRIC_LABELS[kind]}</td>
                {columns.map((column) => metricCell(column, entryIndex, kind))}
              </tr>
            )),
          )}
          {playerResults.rules.map((rule, ruleIndex) => (
            <tr key={rule.ruleId}>
              <td>{rule.rule.rank}</td>
              <td colSpan={2}>{rule.rule.description}</td>
              {columns.map((column) => ruleCell(column, ruleIndex))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted">{status}</p>
    </>
  );
}
