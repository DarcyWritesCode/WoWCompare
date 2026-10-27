import { captureException } from 'common/errorLogger';
import { fetchEvents } from 'common/fetchWclApi';
import { DeathEvent } from 'parser/core/Events';
import { WCLFight } from 'parser/core/Fight';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/**
 * WoWCompare: "ignore events after N deaths", like Warcraft Logs' wipe cutoff. When set, the report
 * is analyzed up to the Nth death of a player in the raid (pets excluded), through upstream's time
 * filter, so a wipe isn't scored on the time the raid spent dead. Applies to kills too. Remembered
 * in this browser; a time filter the user picks by hand takes precedence.
 */

const KEY = 'wowcompare:deathCutoff';

/** What the report page last applied, for showing on Live Compare. */
export interface AppliedCutoff {
  deaths: number;
  /** Fight time of the cut, from the pull. */
  atMs: number;
}

interface State {
  /** Deaths to allow; null = off. */
  setting: number | null;
  applied: AppliedCutoff | null;
}

function readSetting(): number | null {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

let state: State = { setting: readSetting(), applied: null };
const listeners = new Set<() => void>();
const update = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setDeathCutoff(deaths: number | null) {
  try {
    if (deaths === null) {
      localStorage.removeItem(KEY);
    } else {
      localStorage.setItem(KEY, String(deaths));
    }
  } catch {
    // Not remembered; it still applies on this page.
  }
  update({ setting: deaths });
}

export const useDeathCutoffState = () => useSyncExternalStore(subscribe, () => state);

/**
 * The time filter the cutoff gives `fight` (report timestamps), or null when it's off or fewer
 * players died. Fetches the fight's deaths only while a cutoff is set.
 */
export function useDeathCutoffFilter(
  reportCode: string,
  fight: Pick<WCLFight, 'id' | 'start_time' | 'end_time'>,
  /** False where the cutoff doesn't apply (Mythic+). */
  applies = true,
): { start: number; end: number } | null {
  const { setting: chosen } = useDeathCutoffState();
  const setting = applies ? chosen : null;
  const [deaths, setDeaths] = useState<{ fightId: number; times: number[] } | null>(null);
  const enabled = setting !== null;

  useEffect(() => {
    if (!enabled || deaths?.fightId === fight.id) {
      return;
    }
    let cancelled = false;
    fetchEvents(
      reportCode,
      fight.start_time,
      fight.end_time,
      undefined,
      'type = "death" and target.disposition = "friendly" and target.type = "Player" and feign = false',
    ).then(
      (events) => {
        if (!cancelled) {
          const times = (events as DeathEvent[]).map((e) => e.timestamp).sort((a, b) => a - b);
          setDeaths({ fightId: fight.id, times });
        }
      },
      (err) => {
        // Without deaths the fight is analyzed whole, as with the cutoff off.
        captureException(err as Error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, reportCode, fight.id, fight.start_time, fight.end_time, deaths]);

  const end =
    setting !== null && deaths?.fightId === fight.id && deaths.times.length >= setting
      ? deaths.times[setting - 1]
      : null;
  // A new object only when the cut moves: the time filter re-parses whenever its filter changes.
  const filter = useMemo(
    () => (end !== null && end < fight.end_time ? { start: fight.start_time, end } : null),
    [end, fight.start_time, fight.end_time],
  );
  useEffect(() => {
    update({
      applied: filter && setting ? { deaths: setting, atMs: filter.end - fight.start_time } : null,
    });
  }, [filter, setting, fight.start_time]);
  return filter;
}
