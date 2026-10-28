import Spell from 'common/SPELLS/Spell';

import { HeroTree, ProfileEntry } from '../../profile/types';
import { AliasTable } from '../resolve';

/** What it takes to build a profile for one spec from its SimC APL. */
export interface SpecAdapter {
  specId: number;
  /** File name under SimC's `ActionPriorityLists/default/`, without `.simc`. */
  simcFile: string;
  /** Spell tables searched for SimC tokens. */
  tables: Record<string, Spell>[];
  aliases: AliasTable;
  /**
   * Spenders the APL doesn't express as buff checks, by proc token, e.g. Sudden Ambush making
   * Rake act as if stealthed. Merged with the consumers found in the APL.
   */
  extraConsumers?: Record<string, number[]>;
  /**
   * Cooldowns the APL casts outside its cooldown lists without checking `cooldown.x`, e.g.
   * Protection Warrior's Avatar in its main list. Ranked first; dropped from procs if the APL
   * also waits on their buff.
   */
  extraCooldowns?: string[];
  /**
   * Forms entered on a resource rather than a cooldown, e.g. Devourer's Void Metamorphosis:
   * tracked like `extraCooldowns`, though the spell itself has no cooldown.
   */
  forms?: string[];
  /** Cooldowns without a buff: window length after each cast, by SimC token. */
  windowMs?: Record<string, number>;
  heroTrees?: HeroTree[];
  /**
   * Entries the APL never checks but that matter, e.g. Balance's Starlord (SimC models it
   * internally, so the APL has no reason to mention it). Appended after the APL's own entries.
   */
  extraEntries?: Omit<ProfileEntry, 'rank'>[];
}

/** Per-spec fixes layered over the generic adapter. */
export type SpecOverrides = Partial<Omit<SpecAdapter, 'specId' | 'simcFile'>>;
