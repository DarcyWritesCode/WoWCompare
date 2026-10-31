import GameBranch from 'game/GameBranch';
import getConfig from 'parser/getConfig';
import { PlayerDetails } from 'parser/core/Player';
import { useEffect, useState } from 'react';

import { parseBenchmarkLog } from './benchmarks/parseLog';
import { fetchPublishedProfile, logKey } from './benchmarks/published';
import { bundleFor, GroupFight } from './groupPerformance';

/**
 * WoWCompare: each player's active time on the player selection page, against the average of their
 * spec's reference logs for the boss. Both sides are the same measure (ProfileMetrics' active time
 * over time alive): the references' from the published bundle, the player's from parsing their log
 * in the benchmark parse workers, a few players at a time, so results arrive one by one.
 */

/** Active time this far below the spec's average (in points) is highlighted. */
export const ACTIVE_TIME_SHORTFALL = 0.05;
/** Players parsed at once; each holds its log's events while it parses. */
const CONCURRENT_PARSES = 3;

export interface PlayerActivity {
  /** Active share of their time alive, 0–1. */
  activeTime: number;
  /** The mean of the spec's reference logs' active time, 0–1. */
  reference: number;
}

/** The mean active time of the spec's reference logs on this boss, or null. */
async function referenceActiveTime(specId: number, fight: GroupFight) {
  if (!fight.difficulty) {
    return null;
  }
  const bundle = await bundleFor(specId, fight.boss, fight.difficulty);
  const times = (bundle?.reference.candidates ?? []).flatMap((parse) => {
    const snapshot = bundle!.snapshots[logKey({ ...parse, playerName: parse.name })];
    return snapshot?.activeTime !== undefined ? [snapshot.activeTime] : [];
  });
  return times.length > 0 ? times.reduce((sum, t) => sum + t, 0) / times.length : null;
}

async function playerActivity(
  reportCode: string,
  fight: GroupFight,
  player: PlayerDetails,
): Promise<PlayerActivity | null> {
  const config = player.specID ? getConfig(GameBranch.Retail, player.specID, player) : undefined;
  if (!config?.parser || !player.specID) {
    return null;
  }
  const [reference, published] = await Promise.all([
    referenceActiveTime(player.specID, fight),
    fetchPublishedProfile(player.specID),
  ]);
  if (reference === null || !published) {
    return null;
  }
  const snapshot = await parseBenchmarkLog(config, published.profile, {
    reportCode,
    fightId: fight.id,
    playerName: player.name,
    serverName: player.server,
  });
  return snapshot?.activeTime !== undefined ? { activeTime: snapshot.activeTime, reference } : null;
}

/** Each player's activity by player ID, filling in as their logs finish parsing. */
export function useGroupActivity(
  reportCode: string,
  fight: GroupFight,
  players: PlayerDetails[],
): Map<number, PlayerActivity> {
  const [result, setResult] = useState(() => new Map<number, PlayerActivity>());
  const { id, start, end, pulledAt, boss, difficulty } = fight;
  const playerKey = players.map((p) => p.id).join(',');
  useEffect(() => {
    let cancelled = false;
    setResult(new Map());
    const queue = [...players];
    const next = async (): Promise<void> => {
      const player = queue.shift();
      if (!player || cancelled) {
        return;
      }
      const activity = await playerActivity(
        reportCode,
        { id, start, end, pulledAt, boss, difficulty },
        player,
      ).catch(() => null);
      if (activity && !cancelled) {
        setResult((map) => new Map(map).set(player.id, activity));
      }
      return next();
    };
    for (let i = 0; i < CONCURRENT_PARSES; i += 1) {
      void next();
    }
    return () => {
      cancelled = true;
    };
    // The player list is refetched as a new array; refetch only when who's in it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportCode, id, start, end, pulledAt, boss, difficulty, playerKey]);
  return result;
}

/** Whether the player's active time is far enough below their spec's average to highlight. */
export const isLowActivity = (activity: PlayerActivity | undefined) =>
  activity !== undefined && activity.activeTime < activity.reference - ACTIVE_TIME_SHORTFALL;
