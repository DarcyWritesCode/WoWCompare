/**
 * Which weekday the benchmark job (scripts/benchmarks/) rebuilds each class's specs: their
 * profiles from SimC's APL and every boss's benchmarks. The specs page shows the same table, so
 * the two can't disagree. Spread so each day has about five specs with a SimC APL.
 */

/** 0 = Sunday, as `Date.getUTCDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** By WCL class name (`Spec.wclClassName`). */
export const UPDATE_DAYS: Record<string, Weekday> = {
  Druid: 1,
  Priest: 1,
  DeathKnight: 2,
  Evoker: 2,
  DemonHunter: 3,
  Monk: 3,
  Hunter: 4,
  Paladin: 4,
  Mage: 5,
  Shaman: 5,
  Rogue: 6,
  Warlock: 6,
  Warrior: 0,
};

/** When the job starts each day, in UTC; keep in step with .github/workflows/benchmarks.yml. */
export const RUN_TIME_UTC = { hour: 9, minute: 17 };

/**
 * A class's update day. A class missing from `UPDATE_DAYS` (e.g. new in an expansion) still gets
 * a fixed day, derived from its name, until it's added; schedule.test.ts fails until then.
 */
export function updateDay(wclClassName: string): Weekday {
  const day = UPDATE_DAYS[wclClassName];
  if (day !== undefined) {
    return day;
  }
  let hash = 0;
  for (const char of wclClassName) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return (hash % 7) as Weekday;
}

/** Benchmarks older than this are rebuilt on any day, e.g. after a failed or cut-short run. */
export const STALE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

/** The next time the job starts on `day` (for showing it in the viewer's time zone). */
export function nextRun(day: Weekday, now = new Date()): Date {
  const run = new Date(now);
  run.setUTCHours(RUN_TIME_UTC.hour, RUN_TIME_UTC.minute, 0, 0);
  run.setUTCDate(run.getUTCDate() + ((day - run.getUTCDay() + 7) % 7));
  if (run < now) {
    run.setUTCDate(run.getUTCDate() + 7);
  }
  return run;
}

/** e.g. "09:17 UTC". */
export const runTimeUtc = () =>
  `${String(RUN_TIME_UTC.hour).padStart(2, '0')}:${String(RUN_TIME_UTC.minute).padStart(2, '0')} UTC`;
