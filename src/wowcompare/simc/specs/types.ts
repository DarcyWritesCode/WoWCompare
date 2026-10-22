import Spell from 'common/SPELLS/Spell';

import { HeroTree } from '../../profile/types';
import { AliasTable } from '../resolve';

/** What it takes to build a profile for one spec from its SimC APL. */
export interface SpecAdapter {
  specId: number;
  /** File name under SimC's `ActionPriorityLists/default/`, without `.simc`. */
  simcFile: string;
  /** Snapshot of the APL shipped with the app, used when the live copy can't be fetched. */
  bundledApl: string;
  /** Spell tables searched for SimC tokens. */
  tables: Record<string, Spell>[];
  aliases: AliasTable;
  /**
   * Spenders the APL doesn't express as buff checks, by proc token, e.g. Sudden Ambush making
   * Rake act as if stealthed. Merged with the consumers found in the APL.
   */
  extraConsumers?: Record<string, number[]>;
  /** Cooldowns without a buff: window length after each cast, by SimC token. */
  windowMs?: Record<string, number>;
  heroTrees?: HeroTree[];
}
