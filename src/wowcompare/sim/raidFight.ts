import { captureException } from 'common/errorLogger';
import fetchWcl from 'common/fetchWclApi';
import { useEffect, useState } from 'react';

import { fightModel, FightModel } from './profileFromLog';

/**
 * WoWCompare: the fight's targets from the whole raid's damage rather than the player's. A player
 * who left the adds alone would otherwise get a sim with no adds, and a sim measures what the APL
 * does on the fight it's given. One request: Warcraft Logs' damage-taken graph for enemies, a
 * series per enemy name. Enemies sharing a name (a pack of the same add) are one series, so packs
 * count as one target; the player's own damage can't tell them apart either.
 */

interface GraphSeries {
  id: number;
  type: string;
  pointStart: number;
  pointInterval: number;
  data: number[];
}

interface GraphResponse {
  series?: GraphSeries[];
}

export type RaidFight = { state: 'loading' } | { state: 'done'; fight: FightModel | null };

async function fetchRaidFight(
  reportCode: string,
  start: number,
  end: number,
): Promise<FightModel | null> {
  const graph = (await fetchWcl(`report/graph/damage-taken/${reportCode}`, {
    start,
    end,
    hostility: 'Enemies',
  })) as unknown as GraphResponse;
  const samples = (graph.series ?? [])
    .filter((series) => series.type === 'NPC' || series.type === 'Boss')
    .flatMap((series) =>
      series.data.map((amount, i) => ({
        timestamp: series.pointStart + i * series.pointInterval,
        amount,
        targetID: series.id,
      })),
    );
  return samples.length > 0 ? fightModel(samples, start, end) : null;
}

/** The raid-wide fight model for the analyzed range; null (use the player's) when it can't load. */
export function useRaidFight(
  reportCode: string | undefined,
  start: number | undefined,
  end: number | undefined,
): RaidFight {
  const [result, setResult] = useState<RaidFight>({ state: 'loading' });
  useEffect(() => {
    if (!reportCode || start === undefined || end === undefined) {
      setResult({ state: 'done', fight: null });
      return;
    }
    let cancelled = false;
    setResult({ state: 'loading' });
    fetchRaidFight(reportCode, start, end).then(
      (fight) => !cancelled && setResult({ state: 'done', fight }),
      (err) => {
        captureException(err as Error);
        if (!cancelled) {
          setResult({ state: 'done', fight: null });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reportCode, start, end]);
  return result;
}
