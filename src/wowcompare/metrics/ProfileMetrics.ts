import Analyzer, { Options } from 'parser/core/Analyzer';

import { getProfile } from '../profile/registry';
import { Profile } from '../profile/types';
import BuffMetrics from './BuffMetrics';
import ConditionRules from './ConditionRules';
import CooldownMetrics from './CooldownMetrics';
import DamageTimeline from './DamageTimeline';
import { ProfileResults, scoreProfile } from './results';

/** Combines the metric modules into one scored, serializable result for the selected profile. */
class ProfileMetrics extends Analyzer {
  static dependencies = {
    buffMetrics: BuffMetrics,
    cooldownMetrics: CooldownMetrics,
    conditionRules: ConditionRules,
    damageTimeline: DamageTimeline,
  };
  protected buffMetrics!: BuffMetrics;
  protected cooldownMetrics!: CooldownMetrics;
  protected conditionRules!: ConditionRules;

  private readonly profile: Profile | undefined;

  constructor(options: Options) {
    super(options);
    const specId = this.selectedCombatant.spec?.id;
    this.profile = specId === undefined ? undefined : getProfile(specId);
    this.active = this.profile !== undefined;
  }

  /** Call after the parse has finished. */
  results(): ProfileResults | null {
    if (!this.profile) {
      return null;
    }
    const entryMetrics = [
      ...(this.buffMetrics.active ? this.buffMetrics.results() : []),
      ...(this.cooldownMetrics.active ? this.cooldownMetrics.results() : []),
    ];
    const ruleResults = this.conditionRules.active ? this.conditionRules.results() : [];
    return scoreProfile(this.profile, entryMetrics, ruleResults);
  }
}

export default ProfileMetrics;
