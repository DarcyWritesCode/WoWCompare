import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, { CastEvent } from 'parser/core/Events';
import Enemies from 'parser/shared/modules/Enemies';

import { getProfile } from '../profile/registry';
import { AuraCondition, CastRule } from '../profile/types';
import { RawRuleResult } from './results';

/** Tolerance for an aura that ended a moment before the cast (log ordering jitter). */
const BUFFER_MS = 100;

/** Checks the profile's cast rules ("cast X while Y is up") at every matching cast. */
class ConditionRules extends Analyzer {
  static dependencies = {
    enemies: Enemies,
  };
  protected enemies!: Enemies;

  private readonly rules: CastRule[];
  private readonly counts = new Map<string, RawRuleResult>();

  constructor(options: Options) {
    super(options);
    const specId = this.selectedCombatant.spec?.id;
    this.rules = (specId === undefined ? undefined : getProfile(specId))?.rules ?? [];
    this.active = this.rules.length > 0;
    this.rules.forEach((rule) =>
      this.counts.set(rule.id, { ruleId: rule.id, casts: 0, passed: 0 }),
    );
    this.addEventListener(Events.cast.by(SELECTED_PLAYER), this.onCast);
  }

  private holds(condition: AuraCondition, event: CastEvent) {
    const entity =
      condition.on === 'player' ? this.selectedCombatant : this.enemies.getEntity(event);
    const sourceID = condition.on === 'player' ? null : this.owner.playerId;
    const up = entity?.hasBuff(condition.auraId, event.timestamp, BUFFER_MS, 0, sourceID) ?? false;
    return up === condition.present;
  }

  private onCast(event: CastEvent) {
    for (const rule of this.rules) {
      if (!rule.onCast.includes(event.ability.guid)) {
        continue;
      }
      const count = this.counts.get(rule.id)!;
      count.casts += 1;
      if (rule.require.every((condition) => this.holds(condition, event))) {
        count.passed += 1;
      }
    }
  }

  results(): RawRuleResult[] {
    return [...this.counts.values()];
  }
}

export default ConditionRules;
