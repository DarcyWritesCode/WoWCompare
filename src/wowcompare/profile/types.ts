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

/**
 * A spell as a profile names it: a stable token (SimC's, e.g. `tigers_fury`) plus candidate IDs.
 * Analyzers resolve it against the log, preferring spells whose in-game name matches the token,
 * since spell tables carry several IDs per name (cast vs buff vs dot, old tier sets).
 */
export interface SpellRef {
  token: string;
  spellIds: number[];
}

/**
 * Identifies an entry within a profile. The token alone isn't enough: one SimC token can be both a
 * cooldown and a DoT (Guardian's Thrash, BM's Barbed Shot), giving two entries.
 */
export const entryKey = (entry: { kind: EntryKind; token: string }) =>
  `${entry.kind}:${entry.token}`;

export interface ProfileEntry extends SpellRef {
  kind: EntryKind;
  /** 1 = most important. */
  rank: number;
  metrics: MetricKind[];
  thresholds?: Partial<Record<MetricKind, Thresholds>>;
  /** Casts that consume this proc (for `procUsage`). */
  consumers?: SpellRef[];
  /** Cooldowns without a buff: fixed window length after each cast, in ms. */
  windowMs?: number;
  /** Optional display name; the UI otherwise uses the spell's name. */
  label?: string;
  /** The entry applies only if the player has this ability, e.g. the cast behind a debuff. */
  requires?: SpellRef;
}

export interface AuraCondition {
  aura: SpellRef;
  /** `player`: a buff on the player from any source. `target`: the player's debuff on the cast target. */
  on: 'player' | 'target';
  present: boolean;
}

/** "Whenever you cast X, these conditions should hold." */
export interface CastRule {
  id: string;
  description: string;
  rank: number;
  onCast: SpellRef;
  /** All conditions must hold. */
  require: AuraCondition[];
  /** False when the source (e.g. an APL) only favours the conditions rather than requiring them. */
  strict?: boolean;
  /** Applied to the fraction of casts that met the conditions. */
  thresholds?: Thresholds;
}

/** A hero talent tree, recognised by its keystone talent's entry id. */
export interface HeroTree {
  name: string;
  keystoneEntryId: number;
}

/** Where a profile came from, shown with the results. */
export interface ProfileSource {
  kind: 'simc';
  /** SimC APL file, e.g. `druid_feral`. */
  file: string;
  url: string;
  /** False when the live APL couldn't be fetched and the bundled snapshot was used. */
  live: boolean;
  retrievedAt?: number;
}

export interface Profile {
  id: string;
  name: string;
  specId: number;
  source?: ProfileSource;
  /** Changes whenever the profile's content does (for SimC profiles, a hash of the APL). */
  version: number;
  entries: ProfileEntry[];
  rules: CastRule[];
  heroTrees?: HeroTree[];
}
