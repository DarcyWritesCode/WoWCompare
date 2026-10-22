import Analyzer, { Options } from 'parser/core/Analyzer';
import { UpdateSpellUsableEvent } from 'parser/core/Events';
import Abilities from 'parser/core/modules/Abilities';
import SpellUsable from 'parser/shared/modules/SpellUsable';

import { getProfile } from '../profile/registry';
import { Profile, ProfileEntry } from '../profile/types';
import DamageTimeline from './DamageTimeline';
import SpellCatalog from './SpellCatalog';
import { contains, Interval, mergeIntervals, windowThroughput } from './intervals';
import { CooldownWindow, CooldownWindowSet, RawEntryMetrics, WindowAbility } from './results';
import { simcToken } from '../simc/resolve';

/** Context shown around each window in the timelines. */
const WINDOW_PADDING_MS = 3_000;
const BUCKET_MS = 1_000;
/** Shorter cooldowns are rotational (e.g. a 6s builder), not something to grade as a cooldown. */
const MIN_COOLDOWN_SECONDS = 20;
/** Abilities below this share of a cooldown's window damage aren't listed. */
const MIN_ABILITY_SHARE = 0.03;
const MAX_ABILITIES = 8;

export interface CooldownUsage {
  casts: number;
  /** Time the spell sat fully off cooldown (all charges ready). */
  idleMs: number;
  cooldownMs: number;
  /** Whole casts lost to idle time. */
  lostCasts: number;
}

/**
 * Off-cooldown time from SpellUsable's update history. The spell is assumed ready at pull;
 * time it sat fully charged is idle time, and every full cooldown of idle time is a lost cast.
 */
export function cooldownUsage(
  casts: number,
  updates: UpdateSpellUsableEvent[],
  fightStart: number,
  fightEnd: number,
): CooldownUsage | null {
  const cooldownMs = updates.find((u) => u.expectedRechargeDuration > 0)?.expectedRechargeDuration;
  if (!cooldownMs) {
    return null;
  }

  let idleMs = 0;
  let idleSince: number | null = fightStart;
  for (const update of updates) {
    if (update.isOnCooldown && idleSince !== null) {
      idleMs += Math.max(0, update.timestamp - idleSince);
      idleSince = null;
    } else if (!update.isOnCooldown && idleSince === null) {
      idleSince = update.timestamp;
    }
  }
  if (idleSince !== null) {
    idleMs += Math.max(0, fightEnd - idleSince);
  }

  return { casts, idleMs, cooldownMs, lostCasts: Math.floor(idleMs / cooldownMs) };
}

/** Usage efficiency and in-window throughput for the profile's cooldown entries. */
class CooldownMetrics extends Analyzer {
  static dependencies = {
    spellUsable: SpellUsable,
    abilities: Abilities,
    damageTimeline: DamageTimeline,
    spellCatalog: SpellCatalog,
  };
  protected spellUsable!: SpellUsable;
  protected abilities!: Abilities;
  protected damageTimeline!: DamageTimeline;
  protected spellCatalog!: SpellCatalog;

  private readonly profile: Profile | undefined;

  constructor(options: Options) {
    super(options);
    const specId = this.selectedCombatant.spec?.id;
    this.profile = specId === undefined ? undefined : getProfile(specId);
    this.active = this.entries.length > 0;
  }

  private get entries(): ProfileEntry[] {
    return this.profile?.entries.filter((e) => e.kind === 'cooldown') ?? [];
  }

  private castTimes(spellId: number): number[] {
    return this.damageTimeline.casts.filter((c) => c.spellId === spellId).map((c) => c.timestamp);
  }

  /**
   * The spell this log uses for the entry: the matching spell cast most often, else one the
   * player has in their spellbook. Undefined when the player doesn't have it.
   */
  private resolve(entry: ProfileEntry): { spellId: number; casts: number[] } | undefined {
    const candidates = this.spellCatalog.resolve('cast', entry);
    const best = candidates
      .map((spellId) => ({ spellId, casts: this.castTimes(spellId) }))
      .sort((a, b) => b.casts.length - a.casts.length)[0];
    if (best && best.casts.length > 0) {
      return best;
    }
    const known = candidates.find((id) => this.abilities.getAbility(id) !== undefined);
    return known === undefined ? undefined : { spellId: known, casts: [] };
  }

  /** Real cooldowns only: spells with no or a short cooldown aren't graded as cooldowns. */
  private isCooldown(spellId: number): boolean {
    const cooldown = this.abilities.getAbility(spellId)?.cooldown;
    const fromLog = this.spellUsable
      .history(spellId)
      .data.find((u) => u.expectedRechargeDuration > 0)?.expectedRechargeDuration;
    const seconds = cooldown ?? (fromLog ? fromLog / 1000 : undefined);
    return seconds === undefined || seconds >= MIN_COOLDOWN_SECONDS;
  }

  /** The cooldown's active windows: its buff if it has one, else a fixed span after each cast. */
  windows(entry: ProfileEntry, spellId: number, casts: number[]): Interval[] {
    const start = this.owner.fight.start_time;
    const end = this.owner.fight.end_time;
    const buffIds = this.spellCatalog.resolve('buff', { token: entry.token, spellIds: [spellId] });
    const buffWindows = buffIds.flatMap((id) =>
      this.selectedCombatant
        .getBuffHistory(id)
        .map((buff) => ({ start: buff.start, end: buff.end ?? end })),
    );
    if (buffWindows.length > 0 || !entry.windowMs) {
      return mergeIntervals(buffWindows, start, end);
    }
    const windowMs = entry.windowMs;
    return mergeIntervals(
      casts.map((t) => ({ start: t, end: t + windowMs })),
      start,
      end,
    );
  }

  /** Each graded cooldown's windows as plain data, for the window timelines. */
  windowTimelines(): CooldownWindowSet[] {
    return this.entries.flatMap((entry) => {
      const resolved = this.resolve(entry);
      if (!resolved || !this.isCooldown(resolved.spellId)) {
        return [];
      }
      const windows = this.windows(entry, resolved.spellId, resolved.casts);
      return [
        {
          token: entry.token,
          spellId: resolved.spellId,
          rank: entry.rank,
          label: entry.label,
          windows: windows.map((window) => this.timeline(window)),
          abilities: this.abilityBreakdown(windows),
        },
      ];
    });
  }

  /** The biggest damage abilities inside the windows, grouped by name across spell IDs. */
  private abilityBreakdown(windows: Interval[]): WindowAbility[] {
    const byName = new Map<string, WindowAbility & { damageById: Map<number, number> }>();
    const get = (spellId: number) => {
      const name = this.damageTimeline.names.get(spellId) ?? `Spell ${spellId}`;
      const token = simcToken(name);
      let ability = byName.get(token);
      if (!ability) {
        ability = { token, name, spellId, casts: 0, damage: 0, damageById: new Map() };
        byName.set(token, ability);
      }
      return ability;
    };
    let total = 0;
    for (const hit of this.damageTimeline.damage) {
      if (contains(windows, hit.timestamp)) {
        const ability = get(hit.spellId);
        ability.damage += hit.amount;
        ability.damageById.set(
          hit.spellId,
          (ability.damageById.get(hit.spellId) ?? 0) + hit.amount,
        );
        total += hit.amount;
      }
    }
    for (const cast of this.damageTimeline.casts) {
      if (contains(windows, cast.timestamp)) {
        const ability = byName.get(simcToken(this.damageTimeline.names.get(cast.spellId) ?? ''));
        if (ability) {
          ability.casts += 1;
        }
      }
    }
    return [...byName.values()]
      .filter((ability) => total > 0 && ability.damage / total >= MIN_ABILITY_SHARE)
      .sort((a, b) => b.damage - a.damage)
      .slice(0, MAX_ABILITIES)
      .map(({ damageById, ...ability }) => ({
        ...ability,
        spellId: [...damageById.entries()].sort((a, b) => b[1] - a[1])[0][0],
      }));
  }

  private timeline(window: Interval): CooldownWindow {
    const fightStart = this.owner.fight.start_time;
    const from = Math.max(fightStart, window.start - WINDOW_PADDING_MS);
    const to = Math.min(this.owner.fight.end_time, window.end + WINDOW_PADDING_MS);

    const buckets = new Array<number>(Math.max(1, Math.ceil((to - from) / BUCKET_MS))).fill(0);
    let inside = 0;
    for (const { timestamp, amount } of this.damageTimeline.damage) {
      if (timestamp < from || timestamp >= to) {
        continue;
      }
      buckets[Math.floor((timestamp - from) / BUCKET_MS)] += amount;
      if (timestamp >= window.start && timestamp < window.end) {
        inside += amount;
      }
    }
    // Damage per bucket to DPS; the last bucket may be partial.
    const dps = buckets.map((amount, i) => {
      const length = Math.min(BUCKET_MS, to - from - i * BUCKET_MS);
      return length > 0 ? (amount / length) * 1000 : 0;
    });

    return {
      startMs: window.start - fightStart,
      durationMs: window.end - window.start,
      leadMs: window.start - from,
      trailMs: to - window.end,
      bucketMs: BUCKET_MS,
      buckets: dps,
      dps: window.end > window.start ? (inside / (window.end - window.start)) * 1000 : 0,
      casts: this.damageTimeline.casts
        .filter((cast) => cast.timestamp >= from && cast.timestamp < to)
        .map((cast) => ({ offsetMs: cast.timestamp - from, spellId: cast.spellId })),
    };
  }

  results(): RawEntryMetrics[] {
    const fightStart = this.owner.fight.start_time;
    const fightEnd = this.owner.fight.end_time;

    return this.entries.map((entry) => {
      const metrics: RawEntryMetrics['metrics'] = {};
      const resolved = this.resolve(entry);
      const spellId = resolved?.spellId ?? entry.spellIds[0] ?? 0;
      const base = { token: entry.token, spellId, kind: entry.kind };
      if (!resolved || !this.isCooldown(resolved.spellId)) {
        return { ...base, applicable: false, metrics };
      }

      if (entry.metrics.includes('cooldownUsage')) {
        const usage = cooldownUsage(
          resolved.casts.length,
          this.spellUsable.history(spellId).data,
          fightStart,
          fightEnd,
        );
        const possible = usage ? usage.casts + usage.lostCasts : 0;
        metrics.cooldownUsage = {
          value: usage && possible > 0 ? usage.casts / possible : null,
          detail: { ...usage },
        };
      }
      if (entry.metrics.includes('windowDps')) {
        const windows = this.windows(entry, spellId, resolved.casts);
        const throughput = windowThroughput(
          this.damageTimeline.damage,
          windows,
          fightStart,
          fightEnd,
        );
        metrics.windowDps = {
          value: windows.length > 0 ? throughput.ratio : null,
          detail: { ...throughput },
        };
      }
      return { ...base, applicable: true, metrics };
    });
  }
}

export default CooldownMetrics;
