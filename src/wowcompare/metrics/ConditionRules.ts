import Analyzer, { Options } from 'parser/core/Analyzer';
import Enemies from 'parser/shared/modules/Enemies';

import { getProfile } from '../profile/registry';
import { AuraCondition, CastRule } from '../profile/types';
import DamageTimeline from './DamageTimeline';
import { RawRuleResult } from './results';
import SpellCatalog from './SpellCatalog';

/** Tolerance for an aura that ended a moment before the cast (log ordering jitter). */
const BUFFER_MS = 100;

type Cast = DamageTimeline['casts'][number];

/**
 * Checks the profile's cast rules ("cast X while Y is up") at every matching cast. Evaluated after
 * the fight, so the spells behind each rule can be matched to the ones this log actually used.
 */
class ConditionRules extends Analyzer {
  static dependencies = {
    enemies: Enemies,
    damageTimeline: DamageTimeline,
    spellCatalog: SpellCatalog,
  };
  protected enemies!: Enemies;
  protected damageTimeline!: DamageTimeline;
  protected spellCatalog!: SpellCatalog;

  private readonly rules: CastRule[];

  constructor(options: Options) {
    super(options);
    const specId = this.selectedCombatant.spec?.id;
    this.rules = (specId === undefined ? undefined : getProfile(specId))?.rules ?? [];
    this.active = this.rules.length > 0;
  }

  private holds(condition: AuraCondition, cast: Cast) {
    const onPlayer = condition.on === 'player';
    const entity = onPlayer
      ? this.selectedCombatant
      : cast.targetID === undefined
        ? null
        : this.enemies.getById(cast.targetID, cast.targetInstance);
    const sourceID = onPlayer ? null : this.owner.playerId;
    const auraIds = this.spellCatalog.resolve(onPlayer ? 'buff' : 'debuff', condition.aura);
    const up = auraIds.some(
      (auraId) => entity?.hasBuff(auraId, cast.timestamp, BUFFER_MS, 0, sourceID) ?? false,
    );
    return up === condition.present;
  }

  results(): RawRuleResult[] {
    return this.rules.map((rule) => {
      const castIds = new Set(this.spellCatalog.resolve('cast', rule.onCast));
      const casts = this.damageTimeline.casts.filter((c) => castIds.has(c.spellId));
      const passed = casts.filter((cast) =>
        rule.require.every((condition) => this.holds(condition, cast)),
      ).length;
      return { ruleId: rule.id, casts: casts.length, passed };
    });
  }
}

export default ConditionRules;
