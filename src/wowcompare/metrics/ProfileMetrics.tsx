import RESOURCE_TYPES from 'game/RESOURCE_TYPES';
import ROLES from 'game/ROLES';
import Analyzer, { Options } from 'parser/core/Analyzer';

import { getBuiltProfile, getProfile } from '../profile/registry';
import { Profile } from '../profile/types';
import ProfileView from '../ui/ProfileView';
import BuffMetrics from './BuffMetrics';
import ConditionRules from './ConditionRules';
import CooldownMetrics from './CooldownMetrics';
import DamageTimeline from './DamageTimeline';
import DeathTracker from 'parser/shared/modules/DeathTracker';
import Enemies from 'parser/shared/modules/Enemies';

import { simcToken } from '../simc/resolve';
import { mergeIntervals, totalDuration, windowThroughput } from './intervals';
import BLOODLUST_BUFFS from 'game/BLOODLUST_BUFFS';

import { DAMAGE_POTION_IDS, DAMAGE_POTION_NAMES, EXTERNAL_BUFF_IDS } from '../benchmarks/reference';
import { DamageWindowInputs } from '../damageWindows';
import { DAMAGE_WINDOWS } from '../encounters/damageWindows';
import {
  AbilityTotal,
  AuraUsage,
  ExternalBuff,
  LogSnapshot,
  ProfileResults,
  scoreProfile,
} from './results';

/** Bucket size of the whole-fight DPS timeline. */
const TIMELINE_BUCKET_MS = 2_000;

/** Combines the metric modules into one scored, serializable result for the selected profile. */
class ProfileMetrics extends Analyzer {
  static dependencies = {
    buffMetrics: BuffMetrics,
    cooldownMetrics: CooldownMetrics,
    conditionRules: ConditionRules,
    damageTimeline: DamageTimeline,
    deathTracker: DeathTracker,
    enemies: Enemies,
  };
  protected buffMetrics!: BuffMetrics;
  protected cooldownMetrics!: CooldownMetrics;
  protected conditionRules!: ConditionRules;
  protected damageTimeline!: DamageTimeline;
  protected deathTracker!: DeathTracker;
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

  /** Inputs for the damage windows panel; undefined on encounters without windows. */
  private get damageWindowInputs(): DamageWindowInputs | undefined {
    const { fight, report } = this.owner;
    if (!fight.boss || !DAMAGE_WINDOWS[fight.boss]) {
      return undefined;
    }
    return {
      reportCode: report.code,
      encounterId: fight.boss,
      fightStart: fight.start_time,
      fightEnd: fight.end_time,
      hits: this.damageTimeline.damage,
      casts: this.damageTimeline.casts,
      enemies: Object.fromEntries(report.enemies.map((enemy) => [enemy.id, enemy.name])),
    };
  }

  /** Per resource: its max and the damage the player's spenders did per point spent. */
  private resourceValues(): LogSnapshot['resourceValues'] {
    const { casts, damage } = this.damageTimeline;
    const spent = new Map<number, Map<number, number>>(); // type -> spellId -> points
    const max = new Map<number, number>();
    for (const cast of casts) {
      for (const r of cast.resources ?? []) {
        max.set(r.type, Math.max(max.get(r.type) ?? 0, r.max));
        if (r.cost && r.cost > 0) {
          const bySpell = spent.get(r.type) ?? new Map<number, number>();
          bySpell.set(cast.spellId, (bySpell.get(cast.spellId) ?? 0) + r.cost);
          spent.set(r.type, bySpell);
        }
      }
    }
    const values: LogSnapshot['resourceValues'] = {};
    for (const [type, bySpell] of spent) {
      const name = RESOURCE_TYPES[type]?.name;
      const points = [...bySpell.values()].reduce((sum, p) => sum + p, 0);
      const dealt = damage
        .filter((hit) => bySpell.has(hit.spellId))
        .reduce((sum, hit) => sum + hit.amount, 0);
      if (name && points > 0) {
        values[name] = { max: max.get(type) ?? 0, damagePerPoint: dealt / points };
      }
    }
    return values;
  }

  /** Damage and casts per ability over the fight, grouped by in-game name. */
  private abilityTotals(): AbilityTotal[] {
    const { damage, casts, names } = this.damageTimeline;
    const byToken = new Map<string, AbilityTotal>();
    const get = (spellId: number) => {
      const name = names.get(spellId) ?? `Spell ${spellId}`;
      const token = simcToken(name);
      const total = byToken.get(token) ?? { token, name, spellIds: [], casts: 0, damage: 0 };
      if (!total.spellIds.includes(spellId)) {
        total.spellIds.push(spellId);
      }
      byToken.set(token, total);
      return total;
    };
    damage.forEach((hit) => (get(hit.spellId).damage += hit.amount));
    casts.forEach((cast) => (get(cast.spellId).casts += 1));
    return [...byToken.values()].filter((total) => total.damage > 0 || total.casts > 0);
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
    return [...groups.values()].map((group) => {
      const intervals = mergeIntervals(group.intervals, start, end);
      return {
        token: simcToken(group.name),
        name: group.name,
        spellId: group.spellId,
        kind: group.kind,
        uptime: end > start ? totalDuration(intervals) / (end - start) : 0,
        dpsRatio: windowThroughput(this.damageTimeline.damage, intervals, start, end).ratio,
      };
    });
  }

  /** Uptime of the `EXTERNAL_BUFF_IDS` buffs other players put on this one. */
  private externalBuffs(): ExternalBuff[] {
    const start = this.owner.fight.start_time;
    const end = this.owner.fight.end_time;
    const bySpell = new Map<
      number,
      { name: string; intervals: { start: number; end: number }[] }
    >();
    for (const aura of this.selectedCombatant.buffs) {
      if (aura.sourceID === this.owner.playerId || !EXTERNAL_BUFF_IDS.includes(aura.ability.guid)) {
        continue;
      }
      const group = bySpell.get(aura.ability.guid) ?? { name: aura.ability.name, intervals: [] };
      group.intervals.push({ start: aura.start, end: aura.end ?? end });
      bySpell.set(aura.ability.guid, group);
    }
    return [...bySpell.entries()].map(([spellId, group]) => ({
      spellId,
      name: group.name,
      uptime:
        end > start
          ? totalDuration(mergeIntervals(group.intervals, start, end)) / (end - start)
          : 0,
    }));
  }

  /** Primary stat at the pull. */
  private pullStats(): LogSnapshot['pullStats'] {
    const stats = this.selectedCombatant.pullStats;
    const primaryStat = this.owner.config.spec.primaryStat;
    if (!stats || !primaryStat) {
      return undefined;
    }
    return { primary: stats[primaryStat] };
  }

  /** DPS per `TIMELINE_BUCKET_MS` over the whole fight, rounded. */
  private timeline(): LogSnapshot['timeline'] {
    const start = this.owner.fight.start_time;
    const buckets = new Array(
      Math.max(1, Math.ceil((this.owner.fight.end_time - start) / TIMELINE_BUCKET_MS)),
    ).fill(0);
    for (const hit of this.damageTimeline.damage) {
      const i = Math.floor((hit.timestamp - start) / TIMELINE_BUCKET_MS);
      if (i >= 0 && i < buckets.length) {
        buckets[i] += hit.amount;
      }
    }
    return {
      bucketMs: TIMELINE_BUCKET_MS,
      dps: buckets.map((damage) => Math.round((damage / TIMELINE_BUCKET_MS) * 1000)),
    };
  }

  /** Spans of the matching buffs on the player, ms from the pull, merged. */
  private buffSpans(matches: (aura: { guid: number; name: string; sourceID?: number }) => boolean) {
    const { start_time: start, end_time: end } = this.owner.fight;
    const intervals = this.selectedCombatant.buffs
      .filter((aura) =>
        matches({ guid: aura.ability.guid, name: aura.ability.name, sourceID: aura.sourceID }),
      )
      .map((aura) => ({ start: aura.start, end: aura.end ?? end }));
    return mergeIntervals(intervals, start, end).map((i): [number, number] => [
      i.start - start,
      i.end - start,
    ]);
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
      durationMs,
      abilities: this.abilityTotals(),
      resourceValues: this.resourceValues(),
      auras: this.auraUsage(),
      build: { talents, heroTree },
      comp,
      externalBuffs: this.externalBuffs(),
      windows: this.cooldownMetrics.active ? this.cooldownMetrics.windowTimelines() : [],
      fightDps: durationMs > 0 ? (damage / durationMs) * 1000 : 0,
      // Warcraft Logs' item level: Combatant.ilvl averages every slot, shirt and tabard included.
      ilvl:
        this.owner.playerDetails.find((p) => p.id === this.owner.playerId)?.ilvl ??
        this.selectedCombatant.ilvl,
      pullStats: this.pullStats(),
      raid: {
        classes: [...new Set(this.owner.playerDetails.map((p) => p.className))],
        primaryStat: this.owner.config.spec.primaryStat,
        magicShare:
          damage > 0
            ? this.damageTimeline.damage
                .filter((hit) => hit.school !== 1)
                .reduce((sum, hit) => sum + hit.amount, 0) / damage
            : 0,
      },
      bossHp: this.damageTimeline.maxEnemyHp || undefined,
      aliveMs: Math.max(0, durationMs - this.deathTracker.totalTimeDead),
      timeline: this.timeline(),
      lust: this.buffSpans((aura) => aura.guid in BLOODLUST_BUFFS),
      potions: this.buffSpans(
        (aura) =>
          aura.sourceID === this.owner.playerId &&
          (DAMAGE_POTION_IDS.includes(aura.guid) || DAMAGE_POTION_NAMES.includes(aura.name)),
      ),
    };
  }

  tab() {
    const snapshot = this.snapshot();
    if (!snapshot || !this.profile) {
      return;
    }
    return {
      title: 'Live Compare',
      url: 'live-compare',
      render: () => (
        <ProfileView
          profile={this.profile!}
          unresolved={getBuiltProfile(this.profile!.specId)?.unresolved ?? []}
          snapshot={snapshot}
          benchmarkInputs={this.benchmarkProps}
          damageWindowInputs={this.damageWindowInputs}
        />
      ),
    };
  }
}

export default ProfileMetrics;
