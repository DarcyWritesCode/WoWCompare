import SPELLS_DRUID from 'common/SPELLS/druid';
import { TALENTS_DRUID } from 'common/TALENTS';

import { SpecOverrides } from './types';

/** Balance: `ca_inc` is whichever of Celestial Alignment / Incarnation the player has. */
export const druidBalance: SpecOverrides = {
  aliases: {
    ca_inc: {
      action: [SPELLS_DRUID.CELESTIAL_ALIGNMENT.id, SPELLS_DRUID.INCARNATION_CHOSEN_OF_ELUNE.id],
    },
  },
};

/** Guardian: `bs_inc` is whichever of Berserk / Incarnation the player has. */
export const druidGuardian: SpecOverrides = {
  aliases: {
    bs_inc: {
      action: [SPELLS_DRUID.BERSERK_BEAR.id, TALENTS_DRUID.INCARNATION_GUARDIAN_OF_URSOC_TALENT.id],
    },
  },
};
