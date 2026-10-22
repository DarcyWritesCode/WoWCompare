import { LogSnapshot } from '../metrics/results';

/** Which differences between logs to take out before comparing them. */
export interface Normalization {
  /** Rescale other logs' DPS to the player's kill time (short kills fit more burst per second). */
  killTime: boolean;
  /** Rescale other logs' DPS to the player's item level. */
  ilvl: boolean;
  /** Show damage as a share of the boss's HP per raid member instead of raw DPS. */
  bossHp: boolean;
}

export const NO_NORMALIZATION: Normalization = { killTime: false, ilvl: false, bossHp: false };

/** Rough DPS gained per item level; real scaling varies by spec and secondary stats. */
export const DPS_PER_ILVL = 0.01;
const MAX_ILVL_ADJUST = 0.4;
/** Burst can't be more than this share of a log's damage, however the windows overlap. */
const MAX_BURST_SHARE = 0.5;

const raidSize = (log: LogSnapshot) => log.comp.tank + log.comp.healer + log.comp.dps;

/**
 * DPS `log` would do at `targetMs` kill time. Damage is split into a steady baseline and the
 * extra inside cooldown windows; the first window is there whatever the length, later ones come
 * in proportion to the fight's length.
 */
export function dpsAtKillTime(log: LogSnapshot, targetMs: number): number {
  const seconds = log.durationMs / 1000;
  const targetSeconds = targetMs / 1000;
  if (seconds <= 0 || targetSeconds <= 0) {
    return log.fightDps;
  }
  const total = log.fightDps * seconds;
  let burst = 0;
  let burstAtTarget = 0;
  for (const set of log.windows) {
    const extra = set.windows.reduce(
      (sum, w) => sum + Math.max(0, w.dps - log.fightDps) * (w.durationMs / 1000),
      0,
    );
    const uses = set.windows.length;
    if (uses === 0) {
      continue;
    }
    const usesAtTarget = Math.max(1, 1 + (uses - 1) * (targetSeconds / seconds));
    burst += extra;
    burstAtTarget += (extra / uses) * usesAtTarget;
  }
  // Overlapping windows count the same damage twice; scale both down together.
  const cap = burst > total * MAX_BURST_SHARE ? (total * MAX_BURST_SHARE) / burst : 1;
  const baseline = (total - burst * cap) / seconds;
  return baseline + (burstAtTarget * cap) / targetSeconds;
}

/** Multiplier on `log`'s DPS for the item level difference to `player`. */
export function ilvlFactor(log: LogSnapshot, player: LogSnapshot): number {
  if (!log.ilvl || !player.ilvl) {
    return 1;
  }
  const adjust = (player.ilvl - log.ilvl) * DPS_PER_ILVL;
  return 1 + Math.max(-MAX_ILVL_ADJUST, Math.min(MAX_ILVL_ADJUST, adjust));
}

/** `log`'s DPS in the player's conditions, per the options (the player's own log is unchanged). */
export function normalizedDps(log: LogSnapshot, player: LogSnapshot, n: Normalization): number {
  if (log === player) {
    return log.fightDps;
  }
  const dps = n.killTime ? dpsAtKillTime(log, player.durationMs) : log.fightDps;
  return dps * (n.ilvl ? ilvlFactor(log, player) : 1);
}

/** Multiplier for `log`'s damage figures (e.g. per window) for the item level option. */
export function damageFactor(log: LogSnapshot, player: LogSnapshot, n: Normalization): number {
  return n.ilvl && log !== player ? ilvlFactor(log, player) : 1;
}

/**
 * Damage as a share of the boss's HP split evenly across the raid: 1 means the player did an
 * even share. Boss HP scales with raid size, so this compares raids of different sizes. Null if
 * the log has no boss HP.
 */
export function hpShare(damage: number, log: LogSnapshot): number | null {
  return log.bossHp ? (damage * raidSize(log)) / log.bossHp : null;
}

/**
 * A log's headline figure under the options: DPS, or its whole-fight damage as a share of boss
 * HP per raid member. With kill time normalised, damage is DPS over the player's kill time.
 */
export function headline(log: LogSnapshot, player: LogSnapshot, n: Normalization): number | null {
  const dps = normalizedDps(log, player, n);
  if (!n.bossHp) {
    return dps;
  }
  const ms = n.killTime ? player.durationMs : log.durationMs;
  return hpShare((dps * ms) / 1000, log);
}
