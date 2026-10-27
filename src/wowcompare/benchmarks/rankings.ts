import fetchWcl, { USE_WCL_V2 } from 'common/fetchWclApi';
import { WCLRanking, WCLRankingsResponse } from 'common/WCL_TYPES';
import { wclQuery } from 'common/wclV2/graphql';

import { PercentileBand, REFERENCE_BAND, REFERENCE_CANDIDATES, targetRanks } from './reference';

/** One ranked parse, flattened to what benchmark selection needs. */
export interface RankedParse {
  rank: number;
  name: string;
  serverName: string;
  amount: number;
  durationMs: number;
  ilvl: number;
  raidSize: number;
  reportCode: string;
  fightId: number;
  /** `talentID:points` entries, sorted; see `talentSimilarity`. */
  talents: string[];
}

export interface RankingsQuery {
  encounterId: number;
  difficulty: number;
  className: string;
  specName: string;
  metric: 'dps' | 'hps';
}

/** WCL serves rankings 100 per page, and no further than page 20. */
const PAGE_SIZE = 100;
const MAX_PAGE = 20;

const RANKINGS_QUERY = `
  query Rankings($encounterId: Int!, $className: String!, $specName: String!, $difficulty: Int!,
                 $metric: CharacterRankingMetricType, $page: Int) {
    worldData {
      encounter(id: $encounterId) {
        characterRankings(className: $className, specName: $specName, difficulty: $difficulty,
                          metric: $metric, page: $page, includeCombatantInfo: true)
      }
    }
  }
`;

interface RankingsQueryResult {
  worldData: { encounter: { characterRankings: WCLRankingsResponse } | null };
}

/** A fight's rankings for each player, including how many parses each was ranked among. */
const REPORT_RANKINGS_QUERY = `
  query ReportRankings($code: String!, $fightId: Int!, $metric: ReportRankingMetricType) {
    reportData { report(code: $code) { rankings(fightIDs: [$fightId], playerMetric: $metric) } }
  }
`;

interface ReportRankingsResult {
  reportData: {
    report: {
      rankings: {
        data: {
          roles: Record<string, { characters: { name: string; totalParses?: number }[] }>;
        }[];
      } | null;
    } | null;
  };
}

function toRankedParse(ranking: WCLRanking, rank: number): RankedParse {
  const amount = 'amount' in ranking ? ranking.amount : ranking.total;
  const ilvl = 'bracketData' in ranking ? ranking.bracketData : ranking.itemLevel;
  return {
    rank,
    name: ranking.name,
    serverName: ranking.server?.name ?? '',
    amount,
    durationMs: ranking.duration,
    ilvl,
    raidSize: ranking.size,
    reportCode: ranking.report.code,
    fightId: ranking.report.fightID,
    talents: ranking.talents.map((t) => `${t.talentID}:${t.points}`).sort(),
  };
}

/** One page of rankings (v2), best first, with absolute ranks. */
async function fetchRankingsPage(
  query: RankingsQuery,
  page: number,
): Promise<{ parses: RankedParse[]; hasMorePages: boolean }> {
  const result = await wclQuery<RankingsQueryResult>(RANKINGS_QUERY, { ...query, page });
  const data = result.worldData.encounter?.characterRankings;
  return {
    parses: (data?.rankings ?? []).map((r, i) => toRankedParse(r, (page - 1) * PAGE_SIZE + i + 1)),
    hasMorePages: data?.hasMorePages ?? false,
  };
}

/**
 * How many parses `parse` was ranked among: WCL's rankings list has no total, but the ranks it
 * gives a report's players do.
 */
async function fetchTotalParses(query: RankingsQuery, parse: RankedParse): Promise<number | null> {
  const result = await wclQuery<ReportRankingsResult>(REPORT_RANKINGS_QUERY, {
    code: parse.reportCode,
    fightId: parse.fightId,
    metric: query.metric,
  });
  for (const fight of result.reportData.report?.rankings?.data ?? []) {
    for (const role of Object.values(fight.roles)) {
      const total = role.characters.find((c) => c.name === parse.name)?.totalParses;
      if (total) {
        return total;
      }
    }
  }
  return null;
}

/** The ranked parses benchmarks are chosen from. */
export interface RankingsPool {
  /** The #1 parse. */
  top: RankedParse | undefined;
  /** Parses on the rankings pages covering the band, best first. */
  pool: RankedParse[];
  /** Talents of the first rankings page (up to the top 100), for the talent comparison. */
  topTalents?: string[][];
  /** Ranked parses for the spec, boss and difficulty; null when unknown (v1 mode). */
  totalParses: number | null;
}

/**
 * The #1 parse plus the parses spread over `band` (`count` target ranks). v2 mode looks up the
 * total number of parses and fetches the pages holding the target ranks (usually two to six
 * queries for the reference band).
 * Through the upstream proxy (v1 mode) only the top 100 are available, so the pool is those.
 */
export async function fetchRankingsPool(
  query: RankingsQuery,
  band: PercentileBand = REFERENCE_BAND,
  count = REFERENCE_CANDIDATES,
): Promise<RankingsPool> {
  if (!USE_WCL_V2) {
    const response = await fetchWcl<WCLRankingsResponse>(
      `rankings/encounter/${query.encounterId}`,
      {
        className: query.className,
        specName: query.specName,
        difficulty: query.difficulty,
        metric: query.metric,
        includeCombatantInfo: true,
      },
    );
    const parses = response.rankings.map((r, i) => toRankedParse(r, i + 1));
    return {
      top: parses[0],
      pool: parses,
      totalParses: null,
      topTalents: parses.map((p) => p.talents),
    };
  }

  const first = await fetchRankingsPage(query, 1);
  const top = first.parses[0];
  const topTalents = first.parses.map((p) => p.talents);
  if (!top) {
    return { top, pool: [], totalParses: null };
  }
  const totalParses = await fetchTotalParses(query, top);
  if (totalParses === null) {
    return { top, pool: first.parses, totalParses, topTalents };
  }
  const pages = [
    ...new Set(
      targetRanks(totalParses, MAX_PAGE * PAGE_SIZE, band, count).map((rank) =>
        Math.ceil(rank / PAGE_SIZE),
      ),
    ),
  ];
  let pool: RankedParse[] = [];
  for (const page of pages) {
    pool = pool.concat(page === 1 ? first.parses : (await fetchRankingsPage(query, page)).parses);
  }
  return { top, pool, totalParses, topTalents };
}
