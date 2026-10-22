import fetchWcl, { USE_WCL_V2 } from 'common/fetchWclApi';
import { WCLRanking, WCLRankingsResponse } from 'common/WCL_TYPES';
import { wclQuery } from 'common/wclV2/graphql';

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

/** v2 pages are 100 parses each; three pages give "close" selection a wider pool. */
const V2_PAGES = 3;

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

function toRankedParse(ranking: WCLRanking, index: number): RankedParse {
  const amount = 'amount' in ranking ? ranking.amount : ranking.total;
  const ilvl = 'bracketData' in ranking ? ranking.bracketData : ranking.itemLevel;
  return {
    rank: index + 1,
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

/**
 * Top parses for an encounter and spec, best first. Through the upstream proxy (v1 mode) this is
 * the top 100 only: it ignores paging and ilvl brackets. v2 mode fetches `V2_PAGES` pages.
 */
export async function fetchRankings(query: RankingsQuery): Promise<RankedParse[]> {
  let rankings: WCLRanking[] = [];
  if (USE_WCL_V2) {
    for (let page = 1; page <= V2_PAGES; page += 1) {
      const result = await wclQuery<RankingsQueryResult>(RANKINGS_QUERY, { ...query, page });
      const pageData = result.worldData.encounter?.characterRankings;
      rankings = rankings.concat(pageData?.rankings ?? []);
      if (!pageData?.hasMorePages) {
        break;
      }
    }
  } else {
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
    rankings = response.rankings;
  }
  return rankings.map(toRankedParse);
}
