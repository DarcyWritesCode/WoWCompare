import ARCANE_MAGE from 'analysis/retail/mage/arcane/SPELLS';
import FIRE_MAGE from 'analysis/retail/mage/fire/SPELLS';
import FROST_MAGE from 'analysis/retail/mage/frost/SPELLS';
import MAGE from 'analysis/retail/mage/shared/SPELLS';
import DEATH_KNIGHT from 'common/SPELLS/deathknight';
import DEMON_HUNTER from 'common/SPELLS/demonhunter';
import DRUID from 'common/SPELLS/druid';
import EVOKER from 'common/SPELLS/evoker';
import HUNTER from 'common/SPELLS/hunter';
import MONK from 'common/SPELLS/monk';
import PALADIN from 'common/SPELLS/paladin';
import PRIEST from 'common/SPELLS/priest';
import ROGUE from 'common/SPELLS/rogue';
import SHAMAN from 'common/SPELLS/shaman';
import Spell from 'common/SPELLS/Spell';
import WARLOCK from 'common/SPELLS/warlock';
import WARRIOR from 'common/SPELLS/warrior';
import {
  TALENTS_DEATH_KNIGHT,
  TALENTS_DEMON_HUNTER,
  TALENTS_DRUID,
  TALENTS_EVOKER,
  TALENTS_HUNTER,
  TALENTS_MAGE,
  TALENTS_MONK,
  TALENTS_PALADIN,
  TALENTS_PRIEST,
  TALENTS_ROGUE,
  TALENTS_SHAMAN,
  TALENTS_WARLOCK,
  TALENTS_WARRIOR,
} from 'common/TALENTS';
import SPECS, { isRetailSpec } from 'game/SPECS';

import { druidBalance, druidGuardian } from './druidBalanceGuardian';
import druidFeral from './druidFeral';
import { SpecAdapter, SpecOverrides } from './types';

/** Spell tables searched for each class's SimC tokens, keyed by WCL class name. */
const CLASS_TABLES: Record<string, Record<string, Spell>[]> = {
  DeathKnight: [DEATH_KNIGHT, TALENTS_DEATH_KNIGHT],
  DemonHunter: [DEMON_HUNTER, TALENTS_DEMON_HUNTER],
  Druid: [DRUID, TALENTS_DRUID],
  Evoker: [EVOKER, TALENTS_EVOKER],
  Hunter: [HUNTER, TALENTS_HUNTER],
  Mage: [MAGE, ARCANE_MAGE, FIRE_MAGE, FROST_MAGE, TALENTS_MAGE],
  Monk: [MONK, TALENTS_MONK],
  Paladin: [PALADIN, TALENTS_PALADIN],
  Priest: [PRIEST, TALENTS_PRIEST],
  Rogue: [ROGUE, TALENTS_ROGUE],
  Shaman: [SHAMAN, TALENTS_SHAMAN],
  Warlock: [WARLOCK, TALENTS_WARLOCK],
  Warrior: [WARRIOR, TALENTS_WARRIOR],
};

/** Hand-written fixes for specs whose APL uses shorthands or mechanics the generic mapping misses. */
const OVERRIDES: Record<number, SpecOverrides> = {
  [SPECS.FERAL_DRUID.id]: druidFeral,
  [SPECS.BALANCE_DRUID.id]: druidBalance,
  [SPECS.GUARDIAN_DRUID.id]: druidGuardian,
};

const snake = (name: string) => name.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();

/** SimC's file name for a spec, e.g. `deathknight_blood`, `hunter_beast_mastery`. */
export const simcFileFor = (wclClassName: string, wclSpecName: string) =>
  `${wclClassName.toLowerCase()}_${snake(wclSpecName)}`;

/** The adapter for any retail spec: generic name matching plus that spec's overrides, if any. */
export function getAdapter(specId: number): SpecAdapter | undefined {
  const spec = Object.values(SPECS).find((s) => s.id === specId);
  if (!spec || !isRetailSpec(spec)) {
    return undefined;
  }
  const overrides = OVERRIDES[specId] ?? {};
  return {
    specId,
    simcFile: simcFileFor(spec.wclClassName, spec.wclSpecName),
    tables: CLASS_TABLES[spec.wclClassName] ?? [],
    ...overrides,
    aliases: overrides.aliases ?? {},
  };
}
