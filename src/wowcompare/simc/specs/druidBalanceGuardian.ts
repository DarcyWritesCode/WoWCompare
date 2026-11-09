import SPELLS_DRUID from 'common/SPELLS/druid';
import { TALENTS_DRUID } from 'common/TALENTS';

import { SpecOverrides } from './types';

/**
 * Balance: `ca_inc` is whichever of Celestial Alignment / Incarnation the player has. `eclipse` is
 * cast as Lunar or Solar Eclipse (the name matched the Eclipse talent, which is never cast, so no
 * log had an Eclipse window); its window is either Eclipse buff.
 */
export const druidBalance: SpecOverrides = {
  aliases: {
    ca_inc: {
      action: [SPELLS_DRUID.CELESTIAL_ALIGNMENT.id, SPELLS_DRUID.INCARNATION_CHOSEN_OF_ELUNE.id],
    },
    eclipse: {
      action: [SPELLS_DRUID.LUNAR_ECLIPSE.id, SPELLS_DRUID.SOLAR_ECLIPSE.id],
      buff: [SPELLS_DRUID.ECLIPSE_LUNAR.id, SPELLS_DRUID.ECLIPSE_SOLAR.id],
    },
  },
  extraEntries: [
    {
      // Stacked by spenders; keeping it rolling is a core Balance skill the APL never states.
      token: 'starlord',
      spellIds: [SPELLS_DRUID.STARLORD.id],
      kind: 'buff',
      metrics: ['uptime'],
      requires: { token: '', spellIds: [TALENTS_DRUID.STARLORD_TALENT.id] },
    },
  ],
};

/**
 * Guardian: `bs_inc` is whichever of Berserk / Incarnation the player has. SimC splits Gory Fur
 * into its Ironfur and Maul buffs, names no spell has.
 */
export const druidGuardian: SpecOverrides = {
  aliases: {
    bs_inc: {
      action: [SPELLS_DRUID.BERSERK_BEAR.id, TALENTS_DRUID.INCARNATION_GUARDIAN_OF_URSOC_TALENT.id],
    },
    gory_fur_ironfur: { buff: [SPELLS_DRUID.GORY_FUR_BUFF.id] },
    // As SimC's druid module looks it up; WoWAnalyzer has no constant for it.
    gory_fur_maul: { buff: [1307881] },
  },
};
