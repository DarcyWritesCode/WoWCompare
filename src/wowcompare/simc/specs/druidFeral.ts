import SPELLS_DRUID from 'common/SPELLS/druid';
import { TALENTS_DRUID } from 'common/TALENTS';
import SPECS from 'game/SPECS';

import bundledApl from '../bundled/druid_feral.simc?raw';
import { SpecAdapter } from './types';

const BERSERK_OR_INCARNATION = [
  SPELLS_DRUID.BERSERK_CAT.id,
  TALENTS_DRUID.INCARNATION_AVATAR_OF_ASHAMANE_TALENT.id,
];

/** How Feral's SimC APL tokens map onto this codebase's spells. */
const druidFeral: SpecAdapter = {
  specId: SPECS.FERAL_DRUID.id,
  simcFile: 'druid_feral',
  bundledApl,
  tables: [SPELLS_DRUID, TALENTS_DRUID],
  aliases: {
    // SimC's "whichever of Berserk / Incarnation you have"; the `berserk` action is both too.
    bs_inc: { action: BERSERK_OR_INCARNATION },
    berserk: { action: BERSERK_OR_INCARNATION },
    tigers_fury: { action: [SPELLS_DRUID.TIGERS_FURY.id] },
    rake: { action: [SPELLS_DRUID.RAKE.id], dot: [SPELLS_DRUID.RAKE_BLEED.id] },
    moonfire_cat: {
      action: [SPELLS_DRUID.MOONFIRE_FERAL.id],
      dot: [SPELLS_DRUID.MOONFIRE_FERAL.id],
    },
    // Ravage replaces Ferocious Bite while its buff is up.
    ferocious_bite: {
      action: [SPELLS_DRUID.FEROCIOUS_BITE.id, SPELLS_DRUID.RAVAGE_DOTC_CAT.id],
    },
    ravage: { buff: [SPELLS_DRUID.RAVAGE_BUFF_CAT.id] },
    clearcasting: { buff: [SPELLS_DRUID.CLEARCASTING_FERAL.id] },
    sudden_ambush: { buff: [SPELLS_DRUID.SUDDEN_AMBUSH_BUFF.id] },
    apex_predators_craving: { buff: [SPELLS_DRUID.APEX_PREDATORS_CRAVING_BUFF.id] },
  },
  // Sudden Ambush lets Rake hit as if from stealth; the APL only covers that via buff.prowl.
  extraConsumers: { sudden_ambush: [SPELLS_DRUID.RAKE.id] },
  // Channelled, no buff: grade the channel plus its tail.
  windowMs: { convoke_the_spirits: 4_000 },
  heroTrees: [
    { name: 'Wildstalker', keystoneEntryId: TALENTS_DRUID.THRIVING_GROWTH_TALENT.entryIds[0] },
    { name: 'Druid of the Claw', keystoneEntryId: TALENTS_DRUID.RAVAGE_TALENT.entryIds[0] },
  ],
};

export default druidFeral;
