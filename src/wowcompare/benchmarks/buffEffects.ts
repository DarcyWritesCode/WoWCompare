import { LogSnapshot } from '../metrics/results';

/**
 * How much each buff raises a cooldown window's damage, estimated by the benchmark job from many
 * logs of a spec and published for Live Compare's "have X up during Y" estimates.
 *
 * Method (chosen by comparing strategies on planted effects; see scripts/benchmarks/README.md):
 * window strength (window DPS / the log's average DPS) regressed on each buff's share of the
 * window and the resources at the cast, within each log (log fixed effects, so gear, comp, fight
 * and player cancel out), with every other buff as a control (so Bloodlust or a potion isn't
 * credited to a class buff), lightly ridge-regularized. Confidence comes from resampling logs.
 *
 * Checked against real Frost DK logs, two guards were needed (see `significantEffect`): a buff
 * that is almost always up (Icy Talons in Pillar of Frost) only varies by a few percent, and the
 * fit extrapolates that to absurd effects; and an effect that changes a lot with the controls
 * (Pillar of Frost in Breath of Sindragosa: +0.83 with every buff, +0.05 with resources only) is
 * driven by what's controlled for, not measured.
 */

/** One cooldown window, reduced to what the fit needs. */
export interface EffectRow {
  /** Identifies the log; windows are only compared within a log. */
  log: string;
  cooldown: string;
  /** Window DPS / the log's average DPS. */
  strength: number;
  /** Buff token → share of the window it was up. */
  overlap: Record<string, number>;
  /** Resource name → fraction of max at the cast. */
  resources: Record<string, number>;
  /** When the log was collected, ms since epoch (rows age out). */
  at: number;
}

export interface BuffEffect {
  cooldown: string;
  buff: string;
  /** Window strength gained with the buff up for the whole window. */
  effect: number;
  /** 90% interval from resampling logs. */
  low: number;
  high: number;
  /** The same fit with only resources as controls. */
  resourcesOnly: number;
  /** Logs with the buff clearly up for one window and clearly not for another. */
  logs: number;
  windows: number;
}

export interface BuffEffects {
  specId: number;
  builtAt: number;
  logs: number;
  effects: BuffEffect[];
}

/** Windows shorter than this have spiky DPS that swamps the comparison. */
const MIN_WINDOW_MS = 3_000;
/** A buff is a feature when it overlaps at least this share of a cooldown's windows. */
const MIN_FEATURE_SHARE = 0.1;
/**
 * A cooldown needs this many logs before its effects are estimated: in the strategy comparison,
 * 50 logs still missed planted effects by ~0.1-0.15 window strength; ~400 by ~0.05.
 */
const MIN_LOGS = 200;
/** Ridge penalty per 100 windows; shrinks noisy controls without biasing well-measured ones. */
const RIDGE_PER_100 = 1;
/** A window counts as "clearly up" at this share or more, and "clearly not" at 1 minus it. */
const CLEARLY_UP = 0.75;
const BOOTSTRAP_ROUNDS = 40;

export function effectRows(log: string, snapshot: LogSnapshot, at: number): EffectRow[] {
  if (snapshot.fightDps <= 0) {
    return [];
  }
  return snapshot.windows.flatMap((set) =>
    set.windows.flatMap((window, i) => {
      const state = set.entryStates[i];
      if (!state?.overlap || window.durationMs < MIN_WINDOW_MS) {
        return [];
      }
      // The cooldown's own buff is the window itself.
      const overlap = Object.fromEntries(
        Object.entries(state.overlap).filter(([buff]) => buff !== set.token),
      );
      return [
        {
          log,
          cooldown: set.token,
          strength: window.dps / snapshot.fightDps,
          overlap,
          resources: state.resources,
          at,
        },
      ];
    }),
  );
}

/** Solves `a x = b` for a small symmetric positive-definite `a` (Gaussian elimination). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) {
        pivot = r;
      }
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    if (Math.abs(m[col][col]) < 1e-12) {
      continue;
    }
    for (let r = 0; r < n; r += 1) {
      if (r !== col) {
        const f = m[r][col] / m[col][col];
        for (let c = col; c <= n; c += 1) {
          m[r][c] -= f * m[col][c];
        }
      }
    }
  }
  return m.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) {
      group.push(item);
    } else {
      groups.set(k, [item]);
    }
  }
  return groups;
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];

/** A small deterministic generator, so the published intervals don't change between runs. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Effects for one cooldown's windows. */
function fitCooldown(cooldown: string, rows: EffectRow[]): BuffEffect[] {
  const counts = new Map<string, number>();
  rows.forEach((row) =>
    Object.keys(row.overlap).forEach((b) => counts.set(b, (counts.get(b) ?? 0) + 1)),
  );
  const buffs = [...counts]
    .filter(([, n]) => n / rows.length >= MIN_FEATURE_SHARE)
    .map(([b]) => b)
    .sort();
  const resources = [...new Set(rows.flatMap((row) => Object.keys(row.resources)))].sort();
  const p = buffs.length + resources.length;
  if (buffs.length === 0) {
    return [];
  }
  const features = (row: EffectRow) => [
    ...buffs.map((b) => row.overlap[b] ?? 0),
    ...resources.map((r) => row.resources[r] ?? 0),
  ];

  // Per log: X'X and X'y of the log-demeaned rows. Sums of these over logs give the fixed-effects
  // fit, and resampling logs only needs re-summing them.
  const byLog = groupBy(rows, (row) => row.log);
  const perLog = [...byLog.values()].flatMap((logRows) => {
    if (logRows.length < 2) {
      return [];
    }
    const xs = logRows.map(features);
    const ys = logRows.map((r) => r.strength);
    const meanX = xs[0].map((_, j) => xs.reduce((s, x) => s + x[j], 0) / xs.length);
    const meanY = ys.reduce((s, y) => s + y, 0) / ys.length;
    const xtx = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const xty = new Array<number>(p).fill(0);
    xs.forEach((x, i) => {
      const d = x.map((v, j) => v - meanX[j]);
      const dy = ys[i] - meanY;
      for (let j = 0; j < p; j += 1) {
        xty[j] += d[j] * dy;
        for (let k = 0; k < p; k += 1) {
          xtx[j][k] += d[j] * d[k];
        }
      }
    });
    return [
      {
        xtx,
        xty,
        n: logRows.length,
        contrast: buffs.map(
          (_, j) => xs.some((x) => x[j] >= CLEARLY_UP) && xs.some((x) => x[j] <= 1 - CLEARLY_UP),
        ),
      },
    ];
  });
  if (perLog.length < MIN_LOGS) {
    return [];
  }

  /** X'X, X'y and row count summed over `logs` (a log drawn twice counts twice). */
  const totals = (logs: typeof perLog) => {
    const xtx = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const xty = new Array<number>(p).fill(0);
    let n = 0;
    for (const log of logs) {
      n += log.n;
      for (let j = 0; j < p; j += 1) {
        xty[j] += log.xty[j];
        for (let k = 0; k < p; k += 1) {
          xtx[j][k] += log.xtx[j][k];
        }
      }
    }
    return { xtx, xty, n };
  };
  const everything = Array.from({ length: p }, (_, j) => j);
  const resourceFeatures = resources.map((_, i) => buffs.length + i);
  /**
   * The coefficient of feature `free`, with the `controls` features ridge-shrunk. A subset of
   * features only needs the matching rows and columns of the sums.
   */
  const fit = ({ xtx, xty, n }: ReturnType<typeof totals>, free: number, controls = everything) => {
    const ridge = (RIDGE_PER_100 * n) / 100;
    const used = [free, ...controls.filter((j) => j !== free)];
    return solve(
      used.map((j) => used.map((k) => (j === k && j !== free ? xtx[j][k] + ridge : xtx[j][k]))),
      used.map((j) => xty[j]),
    )[0];
  };

  const all = totals(perLog);
  const random = seeded(rows.length);
  const resamples = Array.from({ length: BOOTSTRAP_ROUNDS }, () =>
    totals(Array.from(perLog, () => perLog[Math.floor(random() * perLog.length)])),
  );
  return buffs.map((buff, j) => {
    const samples = resamples.map((logs) => fit(logs, j)).sort((a, b) => a - b);
    return {
      cooldown,
      buff,
      effect: fit(all, j),
      low: percentile(samples, 5),
      high: percentile(samples, 95),
      resourcesOnly: fit(all, j, resourceFeatures),
      logs: perLog.filter((l) => l.contrast[j]).length,
      windows: counts.get(buff) ?? 0,
    };
  });
}

export function fitBuffEffects(rows: EffectRow[]): BuffEffect[] {
  const byCooldown = groupBy(rows, (row) => row.cooldown);
  return [...byCooldown].flatMap(([cooldown, cooldownRows]) => fitCooldown(cooldown, cooldownRows));
}

/** An effect is only used once this many logs had the buff clearly on and clearly off. */
const MIN_EFFECT_LOGS = 20;
/** The fits with and without the buff controls may differ by at most this factor. */
const MAX_CONTROL_RATIO = 3;

/**
 * The effect of `buff` on `cooldown`'s windows, if it's well measured, clearly not zero, and about
 * the same whichever controls are used. Of the two fits, the smaller effect is used.
 */
export function significantEffect(
  effects: BuffEffects | null,
  cooldown: string,
  buff: string,
): BuffEffect | undefined {
  const found = effects?.effects.find((e) => e.cooldown === cooldown && e.buff === buff);
  if (!found || found.logs < MIN_EFFECT_LOGS || !(found.low > 0 || found.high < 0)) {
    return undefined;
  }
  // Effects published before `resourcesOnly` existed can't be checked.
  const other = found.resourcesOnly ?? 0;
  const [small, large] = [found.effect, other].sort((a, b) => Math.abs(a) - Math.abs(b));
  return found.effect * other > 0 && Math.abs(large) <= MAX_CONTROL_RATIO * Math.abs(small)
    ? { ...found, effect: small }
    : undefined;
}
