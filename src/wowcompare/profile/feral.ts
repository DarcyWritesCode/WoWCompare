import SPELLS from 'common/SPELLS';
import { TALENTS_DRUID } from 'common/TALENTS';
import SPECS from 'game/SPECS';

import { Profile } from './types';

/**
 * Hard-coded starter profile for Feral until profiles are stored and edited in Supabase.
 * Ranks and thresholds are placeholders for a theorycrafter to tune.
 */
const FERAL_STARTER_PROFILE: Profile = {
  id: 'feral-starter',
  name: 'Feral starter profile',
  specId: SPECS.FERAL_DRUID.id,
  patch: '12.0.5',
  version: 2, // v2: Bloodtalons removed (not in Midnight)
  entries: [
    {
      spellId: SPELLS.RIP.id,
      kind: 'debuff',
      rank: 1,
      metrics: ['uptime'],
      thresholds: { uptime: { pass: 0.9, warn: 0.8 } },
    },
    {
      spellId: SPELLS.TIGERS_FURY.id,
      kind: 'cooldown',
      rank: 2,
      metrics: ['cooldownUsage', 'windowDps'],
      thresholds: { cooldownUsage: { pass: 0.9, warn: 0.8 } },
    },
    {
      spellId: SPELLS.BERSERK_CAT.id,
      kind: 'cooldown',
      rank: 3,
      metrics: ['cooldownUsage', 'windowDps'],
      thresholds: { cooldownUsage: { pass: 0.9, warn: 0.75 } },
    },
    {
      spellId: SPELLS.RAKE_BLEED.id,
      kind: 'debuff',
      rank: 4,
      metrics: ['uptime'],
      thresholds: { uptime: { pass: 0.9, warn: 0.8 } },
    },
    {
      spellId: SPELLS.APEX_PREDATORS_CRAVING_BUFF.id,
      kind: 'buff',
      rank: 5,
      metrics: ['procUsage'],
      consumerSpellIds: [SPELLS.FEROCIOUS_BITE.id],
      thresholds: { procUsage: { pass: 0.95, warn: 0.85 } },
    },
    {
      spellId: SPELLS.CLEARCASTING_FERAL.id,
      kind: 'buff',
      rank: 6,
      metrics: ['procUsage'],
      consumerSpellIds: [SPELLS.SHRED.id, SPELLS.SWIPE_CAT.id],
      thresholds: { procUsage: { pass: 0.9, warn: 0.8 } },
    },
    {
      spellId: TALENTS_DRUID.CONVOKE_THE_SPIRITS_TALENT.id,
      kind: 'cooldown',
      rank: 7,
      metrics: ['cooldownUsage', 'windowDps'],
      windowMs: 4_000,
      thresholds: { cooldownUsage: { pass: 0.9, warn: 0.75 } },
    },
  ],
  rules: [
    {
      id: 'berserk-in-tf',
      description: "Berserk cast while Tiger's Fury is up",
      rank: 1,
      onCast: [SPELLS.BERSERK_CAT.id, TALENTS_DRUID.INCARNATION_AVATAR_OF_ASHAMANE_TALENT.id],
      require: [{ auraId: SPELLS.TIGERS_FURY.id, on: 'player', present: true }],
      thresholds: { pass: 1, warn: 0.75 },
    },
    {
      id: 'convoke-in-tf',
      description: "Convoke cast while Tiger's Fury is up",
      rank: 2,
      onCast: [TALENTS_DRUID.CONVOKE_THE_SPIRITS_TALENT.id],
      require: [{ auraId: SPELLS.TIGERS_FURY.id, on: 'player', present: true }],
      thresholds: { pass: 1, warn: 0.75 },
    },
  ],
};

export default FERAL_STARTER_PROFILE;
