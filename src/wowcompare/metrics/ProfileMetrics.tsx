import { Panel } from 'interface';
import Analyzer, { Options } from 'parser/core/Analyzer';

import { getBuiltProfile, getProfile } from '../profile/registry';
import { Profile } from '../profile/types';
import ProfileView from '../ui/ProfileView';
import BuffMetrics from './BuffMetrics';
import ConditionRules from './ConditionRules';
import CooldownMetrics from './CooldownMetrics';
import DamageTimeline from './DamageTimeline';
import { LogSnapshot, ProfileResults, scoreProfile } from './results';

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
  protected damageTimeline!: DamageTimeline;

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

  /** Inputs for the benchmark comparison; undefined outside boss fights. */
  private get benchmarkProps() {
    const { fight, config } = this.owner;
    if (!this.profile || !fight.boss || fight.difficulty === undefined) {
      return undefined;
    }
    return {
      config,
      profile: this.profile,
      query: {
        encounterId: fight.boss,
        difficulty: fight.difficulty,
        className: config.spec.wclClassName,
        specName: config.spec.wclSpecName,
        metric: 'dps' as const,
      },
      player: {
        ilvl: Math.round(this.selectedCombatant.ilvl ?? 0),
        durationMs: fight.end_time - fight.start_time,
        raidSize: fight.size ?? 20,
        talents: this.selectedCombatant.talentTree.map((t) => `${t.id}:${t.rank}`).sort(),
      },
    };
  }

  /** Results plus window timelines: everything this log contributes to a comparison. */
  snapshot(): LogSnapshot | null {
    const results = this.results();
    if (!results) {
      return null;
    }
    const damage = this.damageTimeline.damage.reduce((sum, d) => sum + d.amount, 0);
    const durationMs = this.owner.fight.end_time - this.owner.fight.start_time;
    const talents = this.selectedCombatant.talentTree.map((t) => `${t.id}:${t.rank}`).sort();
    const heroTree = this.profile?.heroTrees?.find((tree) =>
      talents.some((t) => t.startsWith(`${tree.keystoneEntryId}:`)),
    )?.name;
    const comp = { tank: 0, healer: 0, dps: 0 };
    this.owner.playerDetails.forEach((player) => (comp[player.role] += 1));
    return {
      results,
      build: { talents, heroTree },
      comp,
      windows: this.cooldownMetrics.active ? this.cooldownMetrics.windowTimelines() : [],
      fightDps: durationMs > 0 ? (damage / durationMs) * 1000 : 0,
    };
  }

  tab() {
    const snapshot = this.snapshot();
    if (!snapshot || !this.profile) {
      return;
    }
    return {
      title: 'Profile',
      url: 'profile',
      render: () => (
        <Panel title={this.profile!.name}>
          <ProfileView
            profile={this.profile!}
            unresolved={getBuiltProfile(this.profile!.specId)?.unresolved ?? []}
            snapshot={snapshot}
            benchmarkInputs={this.benchmarkProps}
          />
        </Panel>
      ),
    };
  }
}

export default ProfileMetrics;
