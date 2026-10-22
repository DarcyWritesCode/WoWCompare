import ROLES from 'game/ROLES';
import { Panel } from 'interface';
import Analyzer, { Options } from 'parser/core/Analyzer';

import { getBuiltProfile, getProfile } from '../profile/registry';
import { Profile } from '../profile/types';
import ProfileView from '../ui/ProfileView';
import BuffMetrics from './BuffMetrics';
import ConditionRules from './ConditionRules';
import CooldownMetrics from './CooldownMetrics';
import DamageTimeline from './DamageTimeline';
import Enemies from 'parser/shared/modules/Enemies';

import { simcToken } from '../simc/resolve';
import { mergeIntervals, totalDuration } from './intervals';
import { AuraUsage, LogSnapshot, ProfileResults, scoreProfile } from './results';

/** Combines the metric modules into one scored, serializable result for the selected profile. */
class ProfileMetrics extends Analyzer {
  static dependencies = {
    buffMetrics: BuffMetrics,
    cooldownMetrics: CooldownMetrics,
    conditionRules: ConditionRules,
    damageTimeline: DamageTimeline,
    enemies: Enemies,
  };
  protected buffMetrics!: BuffMetrics;
  protected cooldownMetrics!: CooldownMetrics;
  protected conditionRules!: ConditionRules;
  protected damageTimeline!: DamageTimeline;
  protected enemies!: Enemies;

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
        metric: config.spec.role === ROLES.HEALER ? ('hps' as const) : ('dps' as const),
      },
      player: {
        ilvl: Math.round(this.selectedCombatant.ilvl ?? 0),
        durationMs: fight.end_time - fight.start_time,
        raidSize: fight.size ?? 20,
        talents: this.selectedCombatant.talentTree.map((t) => `${t.id}:${t.rank}`).sort(),
      },
    };
  }

  /** Uptime of every buff the player gave themselves and every debuff they applied, by name. */
  private auraUsage(): AuraUsage[] {
    const start = this.owner.fight.start_time;
    const end = this.owner.fight.end_time;
    const playerId = this.owner.playerId;
    const groups = new Map<
      string,
      {
        name: string;
        spellId: number;
        kind: AuraUsage['kind'];
        intervals: { start: number; end: number }[];
      }
    >();
    const add =
      (kind: AuraUsage['kind']) => (aura: (typeof this.selectedCombatant.buffs)[number]) => {
        if (aura.sourceID !== playerId) {
          return;
        }
        const name = aura.ability.name;
        const key = `${kind}:${simcToken(name)}`;
        const group = groups.get(key) ?? { name, spellId: aura.ability.guid, kind, intervals: [] };
        group.intervals.push({ start: aura.start, end: aura.end ?? end });
        groups.set(key, group);
      };
    this.selectedCombatant.buffs.forEach(add('buff'));
    Object.values(this.enemies.getEntities()).forEach((enemy) =>
      enemy.buffs.forEach(add('debuff')),
    );
    return [...groups.values()].map((group) => ({
      token: simcToken(group.name),
      name: group.name,
      spellId: group.spellId,
      kind: group.kind,
      uptime:
        end > start
          ? totalDuration(mergeIntervals(group.intervals, start, end)) / (end - start)
          : 0,
    }));
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
      auras: this.auraUsage(),
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
