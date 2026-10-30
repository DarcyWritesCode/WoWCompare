import fetchWcl from 'common/fetchWclApi';
import { PlayerDetails } from 'parser/core/Player';
import { useEffect, useState } from 'react';

import { median } from './benchmarks/aggregate';
import { fetchBenchmarkBundle } from './benchmarks/published';

/**
 * WoWCompare: each player's DPS (HPS for healers) on the player selection page, with their Warcraft
 * Logs parse and the 95th percentile's amount for their spec. The amount comes from Warcraft Logs'
 * damage or healing table (so wipes have one too); a kill's ranked amount replaces it, so the
 * figure matches the parse. The 95th percentile comes from the benchmark job's published rankings
 * pool (benchmarks/published.ts), which spans the reference band's ranks, so specs without a
 * published bundle, or whose rank total is unknown, have none.
 */

/** The parse the reference is taken at. */
export const REFERENCE_PERCENTILE = 95;
/** Parses nearest that rank whose median is the reference, steadier than any single one. */
const REFERENCE_PARSES = 5;

export interface PlayerPerformance {
  metric: 'dps' | 'hps';
  amount: number;
  /** Warcraft Logs' parse, 0–100; null on wipes and unranked fights. */
  parse: number | null;
  /** The spec's amount at the 95th percentile, or null when unknown. */
  reference: number | null;
  /** When they died, in ms into the fight (the first death if rezzed); [] if they lived; null if unknown. */
  deaths: number[] | null;
}

interface TableResponse {
  entries: { id: number; total: number }[];
}

interface DeathsResponse {
  entries: { id: number; timestamp: number }[];
}

interface CharacterParse {
  reportID: string;
  fightID: number;
  percentile: number;
  total: number;
}

const metricOf = (player: PlayerDetails) => (player.role === 'healer' ? 'hps' : 'dps');

/**
 * Warcraft Logs' realm slug. The player list names realms without spaces ("BurningLegion",
 * "Lightning'sBlade", "Mal'Ganis", "Area52"); the slugs are burning-legion, lightnings-blade, malganis
 * and area-52.
 */
const realmSlug = (server: string) =>
  server
    .replace(/([a-z])(?=[A-Z0-9])/g, '$1-')
    .replace(/'/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();

async function fetchTotals(reportCode: string, start: number, end: number, table: string) {
  const response = (await fetchWcl(`report/tables/${table}/${reportCode}`, {
    start,
    end,
  })) as unknown as TableResponse;
  const seconds = (end - start) / 1000;
  return new Map(response.entries.map((entry) => [entry.id, entry.total / seconds]));
}

/** Each player's deaths in the fight, in ms into it, by player ID. */
async function fetchDeaths(reportCode: string, start: number, end: number) {
  const response = (await fetchWcl(`report/tables/deaths/${reportCode}`, {
    start,
    end,
  })) as unknown as DeathsResponse;
  const deaths = new Map<number, number[]>();
  for (const { id, timestamp } of response.entries) {
    deaths.set(id, [...(deaths.get(id) ?? []), timestamp - start]);
  }
  return deaths;
}

async function fetchParse(
  player: PlayerDetails,
  reportCode: string,
  fightId: number,
  encounterId: number,
): Promise<CharacterParse | null> {
  if (!player.server || !player.region) {
    return null;
  }
  const parses = (await fetchWcl(
    `parses/character/${encodeURIComponent(player.name)}/${encodeURIComponent(realmSlug(player.server))}/${player.region}`,
    { metric: metricOf(player), encounter: encounterId },
  )) as unknown as CharacterParse[];
  return (
    (Array.isArray(parses) ? parses : []).find(
      (parse) => parse.reportID === reportCode && parse.fightID === fightId,
    ) ?? null
  );
}

/** The median amount of the parses nearest the 95th percentile's rank, from the published pool. */
async function fetchReference(specId: number, encounterId: number, difficulty: number) {
  const bundle = await fetchBenchmarkBundle(specId, encounterId, difficulty);
  if (!bundle?.totalParses) {
    return null;
  }
  const rank = Math.ceil((bundle.totalParses * (100 - REFERENCE_PERCENTILE)) / 100);
  const nearest = bundle.pool
    .toSorted((a, b) => Math.abs(a.rank - rank) - Math.abs(b.rank - rank))
    .slice(0, REFERENCE_PARSES);
  // A pool that doesn't reach the rank (top-100 fallback) says nothing about it.
  if (nearest.length === 0 || Math.abs(nearest[0].rank - rank) > REFERENCE_PARSES) {
    return null;
  }
  return median(nearest.map((parse) => parse.amount));
}

/**
 * Settles to null on failure: each piece is optional on the page, and some fail routinely (a
 * character Warcraft Logs can't find), so failures aren't reported.
 */
const settle = <T>(promise: Promise<T>) => promise.catch(() => null);

async function fetchGroupPerformance(
  reportCode: string,
  fight: { id: number; start: number; end: number; boss: number; difficulty?: number },
  players: PlayerDetails[],
) {
  const [damage, healing, deaths] = await Promise.all([
    settle(fetchTotals(reportCode, fight.start, fight.end, 'damage-done')),
    settle(fetchTotals(reportCode, fight.start, fight.end, 'healing')),
    settle(fetchDeaths(reportCode, fight.start, fight.end)),
  ]);
  const specIds = [...new Set(players.map((p) => p.specID).filter((id): id is number => !!id))];
  const [parses, references] = await Promise.all([
    Promise.all(
      players.map((player) => settle(fetchParse(player, reportCode, fight.id, fight.boss))),
    ),
    Promise.all(
      specIds.map((specId) =>
        fight.difficulty ? settle(fetchReference(specId, fight.boss, fight.difficulty)) : null,
      ),
    ),
  ]);
  const referenceBySpec = new Map(specIds.map((specId, i) => [specId, references[i]]));
  const result = new Map<number, PlayerPerformance>();
  players.forEach((player, i) => {
    const metric = metricOf(player);
    const parse = parses[i];
    const amount = parse?.total ?? (metric === 'hps' ? healing : damage)?.get(player.id);
    if (amount === undefined) {
      return;
    }
    result.set(player.id, {
      metric,
      amount,
      parse: parse ? parse.percentile : null,
      reference: (player.specID && referenceBySpec.get(player.specID)) || null,
      deaths: deaths ? (deaths.get(player.id) ?? []) : null,
    });
  });
  return result;
}

/** Each player's performance by player ID; empty while loading or if nothing loads. */
export function useGroupPerformance(
  reportCode: string,
  fight: { id: number; start: number; end: number; boss: number; difficulty?: number },
  players: PlayerDetails[],
): Map<number, PlayerPerformance> {
  const [result, setResult] = useState(() => new Map<number, PlayerPerformance>());
  const { id, start, end, boss, difficulty } = fight;
  const playerKey = players.map((p) => p.id).join(',');
  useEffect(() => {
    let cancelled = false;
    setResult(new Map());
    if (players.length === 0) {
      return;
    }
    fetchGroupPerformance(reportCode, { id, start, end, boss, difficulty }, players).then(
      (performance) => !cancelled && setResult(performance),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // The player list is refetched as a new array; refetch only when who's in it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportCode, id, start, end, boss, difficulty, playerKey]);
  return result;
}
