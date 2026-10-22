/**
 * Importance profiles: what a theorycrafter says matters for a spec, and how to judge it.
 * Profiles are plain JSON (spell IDs, no Spell objects) so they can be stored and edited.
 */

/**
 * Every metric is normalized so that higher is better, which keeps thresholds uniform:
 * - `uptime`: fraction of the fight the buff/debuff was up (0..1)
 * - `procUsage`: fraction of procs that were consumed rather than expired or overwritten (0..1)
 * - `cooldownUsage`: casts / (casts + casts lost to sitting off cooldown) (0..1)
 * - `windowDps`: DPS inside the buff/cooldown window divided by DPS outside it (ratio, ~1+)
 */
export type MetricKind = 'uptime' | 'procUsage' | 'cooldownUsage' | 'windowDps';

export interface Thresholds {
  /** Value at or above which the metric passes. */
  pass: number;
  /** Value at or above which the metric is a warning rather than a failure. */
  warn: number;
}

export type EntryKind = 'buff' | 'debuff' | 'cooldown';

export interface ProfileEntry {
  /** For buffs/debuffs, the aura ID. For cooldowns, the cast spell ID. */
  spellId: number;
  kind: EntryKind;
  /** 1 = most important. */
  rank: number;
  metrics: MetricKind[];
  thresholds?: Partial<Record<MetricKind, Thresholds>>;
  /** Casts that consume this proc (required for `procUsage`). */
  consumerSpellIds?: number[];
  /** Cooldowns: the buff that marks the window, if it isn't the cast spell's own ID. */
  windowBuffId?: number;
  /** Cooldowns without a buff: fixed window length after each cast, in ms. */
  windowMs?: number;
  /** Optional display name; the UI otherwise uses the spell's name. */
  label?: string;
}

export interface AuraCondition {
  auraId: number;
  /** `player`: a buff on the player from any source. `target`: the player's debuff on the cast target. */
  on: 'player' | 'target';
  present: boolean;
}

/** "Whenever you cast X, these conditions should hold." */
export interface CastRule {
  id: string;
  description: string;
  rank: number;
  onCast: number[];
  /** All conditions must hold. */
  require: AuraCondition[];
  /** Applied to the fraction of casts that met the conditions. */
  thresholds?: Thresholds;
}

export interface Profile {
  id: string;
  name: string;
  specId: number;
  /** Game patch the profile was written for, e.g. "12.0.5". */
  patch: string;
  version: number;
  entries: ProfileEntry[];
  rules: CastRule[];
}
