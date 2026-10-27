/**
 * WoWCompare: boss mechanics that change how much damage a target takes, by encounter ID. Found
 * by measuring same-spell hit sizes across ranked kills against Bloodlust and each log's busiest
 * cooldown window as controls, then confirmed against the aura's tooltip (which also gives the
 * multiplier). Each window is the time its aura is up on the NPC that has it.
 */

export type DamageWindowKind =
  /** The aura's holder takes more damage: hit it, with cooldowns. */
  | 'amp'
  /** The aura's holder takes less damage: hold cooldowns. */
  | 'reduction'
  /** The aura's holder takes no damage. */
  | 'immune';

export interface DamageWindowDef {
  auraId: number;
  name: string;
  kind: DamageWindowKind;
  /** Damage taken while the aura is up: 2 for +100%, 0.01 for -99%, 0 for immune. */
  multiplier: number;
  /** Shares health with the boss, so damage to it counts toward the kill. */
  sharedHealth?: boolean;
  /** What to tell the player, in a few words. */
  advice: string;
}

export const DAMAGE_WINDOWS: Record<number, DamageWindowDef[]> = {
  // Sszorak
  3420: [
    {
      auraId: 1286033,
      name: 'Dig In',
      kind: 'amp',
      multiplier: 1.3,
      advice: 'Sszorak takes 30% more damage while he digs in during Howling Maelstrom.',
    },
  ],
  // The Coiled Altar
  3429: [
    {
      auraId: 1304033,
      name: 'Ghastly Regeneration',
      kind: 'amp',
      multiplier: 2,
      advice: "Zul'jan takes double damage while he regenerates; Malacrass is shielded meanwhile.",
    },
    {
      auraId: 1304028,
      name: 'Deathguard',
      kind: 'reduction',
      multiplier: 0.01,
      advice: 'Malacrass takes 99% less damage under Deathguard.',
    },
    {
      auraId: 1285847,
      name: 'Unassailable',
      kind: 'immune',
      multiplier: 0,
      advice: 'Manifestations of Dread are immune while Unassailable.',
    },
  ],
  // Ula'tek
  3492: [
    {
      auraId: 1299526,
      name: 'Venomous Heart',
      kind: 'amp',
      multiplier: 2,
      sharedHealth: true,
      advice: "The Venomous Heart shares Ula'tek's health and takes double damage.",
    },
    {
      auraId: 1303410,
      name: 'Defect: Weakened',
      kind: 'amp',
      multiplier: 2,
      advice: 'A Weakened Doomscale takes double damage.',
    },
  ],
  // Nek'zali the Soulcoiler
  3470: [
    {
      auraId: 1289696,
      name: 'Tether of Awakening',
      kind: 'immune',
      multiplier: 0,
      advice: 'Tethered enemies are immune.',
    },
  ],
};
