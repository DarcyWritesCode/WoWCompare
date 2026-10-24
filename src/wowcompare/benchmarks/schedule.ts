/**
 * When the benchmark job (scripts/benchmarks/) rebuilds each spec: its profile from SimC's APL and
 * every boss's benchmarks. The job runs every two hours and builds one spec per run, so each spec
 * gets a weekly slot: its class's day, at one of that day's run times. The specs page shows the
 * same slots, so the two can't disagree. Classes are spread so each day has about five specs with
 * a SimC APL.
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

/**
 * The job's runs, in UTC: slot n starts at 00:47 + 2n hours. Keep in step with the cron in
 * .github/workflows/benchmarks.yml ('47 0-10/2 * * *'). A run that GitHub starts late (it can be
 * an hour) still falls in its own two-hour slot.
 */
export const SLOT_HOURS = 2;
export const SLOT_MINUTE = 47;
export const SLOTS_PER_DAY = 6;

export interface SpecSlot {
  day: Weekday;
  /** 0 = the day's first run. */
  slot: number;
}

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

/**
 * Each spec's weekly slot: its class's day, then one slot per spec in `UPDATE_DAYS` class order
 * and the order given. A spec past the day's last slot (`SLOTS_PER_DAY`) only gets built as
 * catch-up; schedule.test.ts fails until the table is rebalanced.
 */
export function weeklySlots(specs: { id: number; wclClassName: string }[]): Map<number, SpecSlot> {
  const classOrder = Object.keys(UPDATE_DAYS);
  const rank = (name: string) => {
    const i = classOrder.indexOf(name);
    return i === -1 ? classOrder.length : i;
  };
  const sorted = specs
    .map((spec, i) => ({ spec, i }))
    .sort(
      (a, b) =>
        rank(a.spec.wclClassName) - rank(b.spec.wclClassName) ||
        a.spec.wclClassName.localeCompare(b.spec.wclClassName) ||
        a.i - b.i,
    );
  const used = new Map<Weekday, number>();
  const slots = new Map<number, SpecSlot>();
  for (const { spec } of sorted) {
    const day = updateDay(spec.wclClassName);
    const slot = used.get(day) ?? 0;
    used.set(day, slot + 1);
    slots.set(spec.id, { day, slot });
  }
  return slots;
}

/** The slot a run starting at `at` belongs to. */
export const slotAt = (at: Date): SpecSlot => ({
  day: at.getUTCDay() as Weekday,
  slot: Math.floor(at.getUTCHours() / SLOT_HOURS),
});

/** The next start of `slot` (for showing it in the viewer's time zone). */
export function nextRun({ day, slot }: SpecSlot, now = new Date()): Date {
  const run = new Date(now);
  run.setUTCHours(slot * SLOT_HOURS, SLOT_MINUTE, 0, 0);
  run.setUTCDate(run.getUTCDate() + ((day - run.getUTCDay() + 7) % 7));
  if (run < now) {
    run.setUTCDate(run.getUTCDate() + 7);
  }
  return run;
}

/** e.g. "02:47 UTC". */
export const slotTimeUtc = (slot: number) =>
  `${String(slot * SLOT_HOURS).padStart(2, '0')}:${String(SLOT_MINUTE).padStart(2, '0')} UTC`;
