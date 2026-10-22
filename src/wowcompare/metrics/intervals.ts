/** Half-open time interval [start, end) in log timestamps (ms). */
export interface Interval {
  start: number;
  end: number;
}

/** Sorts and merges overlapping/touching intervals, clamped to [min, max]. */
export function mergeIntervals(intervals: Interval[], min = -Infinity, max = Infinity): Interval[] {
  const sorted = intervals
    .map(({ start, end }) => ({ start: Math.max(start, min), end: Math.min(end, max) }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start);

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

export function totalDuration(intervals: Interval[]) {
  return intervals.reduce((sum, { start, end }) => sum + (end - start), 0);
}

/** Whether `timestamp` falls in any of the (merged, sorted) intervals. */
export function contains(intervals: Interval[], timestamp: number) {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timestamp < intervals[mid].start) {
      hi = mid - 1;
    } else if (timestamp >= intervals[mid].end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

export interface WindowThroughput {
  damageIn: number;
  damageOut: number;
  timeIn: number;
  timeOut: number;
  /** DPS inside the windows divided by DPS outside; null when either side has no time or damage. */
  ratio: number | null;
}

/**
 * Splits damage into inside/outside `windows` over the span [fightStart, fightEnd).
 * `damage` must be sorted by timestamp.
 */
export function windowThroughput(
  damage: { timestamp: number; amount: number }[],
  windows: Interval[],
  fightStart: number,
  fightEnd: number,
): WindowThroughput {
  const merged = mergeIntervals(windows, fightStart, fightEnd);
  const timeIn = totalDuration(merged);
  const timeOut = fightEnd - fightStart - timeIn;

  let damageIn = 0;
  let damageOut = 0;
  for (const { timestamp, amount } of damage) {
    if (contains(merged, timestamp)) {
      damageIn += amount;
    } else {
      damageOut += amount;
    }
  }

  const dpsOut = timeOut > 0 ? damageOut / timeOut : 0;
  const ratio = timeIn > 0 && dpsOut > 0 ? damageIn / timeIn / dpsOut : null;
  return { damageIn, damageOut, timeIn, timeOut, ratio };
}
