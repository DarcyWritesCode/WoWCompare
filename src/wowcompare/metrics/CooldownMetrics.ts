import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, { CastEvent, UpdateSpellUsableEvent } from 'parser/core/Events';
import Abilities from 'parser/core/modules/Abilities';
import SpellUsable from 'parser/shared/modules/SpellUsable';

import { getProfile } from '../profile/registry';
import { Profile, ProfileEntry } from '../profile/types';
import DamageTimeline from './DamageTimeline';
import { Interval, mergeIntervals, windowThroughput } from './intervals';
import { CooldownWindow, CooldownWindowSet, RawEntryMetrics } from './results';

/** Context shown around each window in the timelines. */
const WINDOW_PADDING_MS = 3_000;
const BUCKET_MS = 1_000;

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
  };
  protected spellUsable!: SpellUsable;
  protected abilities!: Abilities;
  protected damageTimeline!: DamageTimeline;

  private readonly profile: Profile | undefined;
  private readonly casts = new Map<number, number[]>();

  constructor(options: Options) {
    super(options);
    const specId = this.selectedCombatant.spec?.id;
    this.profile = specId === undefined ? undefined : getProfile(specId);
    this.active = this.entries.length > 0;
    this.entries.forEach((e) => this.casts.set(e.spellId, []));
    this.addEventListener(Events.cast.by(SELECTED_PLAYER), this.onCast);
  }

  private get entries(): ProfileEntry[] {
    return this.profile?.entries.filter((e) => e.kind === 'cooldown') ?? [];
  }

  private onCast(event: CastEvent) {
    this.casts.get(event.ability.guid)?.push(event.timestamp);
  }

  /** The cooldown's active windows: its buff if it has one, else a fixed span after each cast. */
  windows(entry: ProfileEntry): Interval[] {
    const end = this.owner.fight.end_time;
    const buffId = entry.windowBuffId ?? entry.spellId;
    const buffWindows = this.selectedCombatant
      .getBuffHistory(buffId)
      .map((buff) => ({ start: buff.start, end: buff.end ?? end }));
    if (buffWindows.length > 0 || !entry.windowMs) {
      return mergeIntervals(buffWindows, this.owner.fight.start_time, end);
    }
    const windowMs = entry.windowMs;
    return mergeIntervals(
      (this.casts.get(entry.spellId) ?? []).map((t) => ({ start: t, end: t + windowMs })),
      this.owner.fight.start_time,
      end,
    );
  }

  /** Each applicable cooldown's windows as plain data, for the window timelines. */
  windowTimelines(): CooldownWindowSet[] {
    return this.entries
      .filter((entry) => this.abilities.getAbility(entry.spellId) !== undefined)
      .map((entry) => ({
        spellId: entry.spellId,
        rank: entry.rank,
        label: entry.label,
        windows: this.windows(entry).map((window) => this.timeline(window)),
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
      // Abilities only lists spells the player actually has (talents, hero tree).
      const applicable = this.abilities.getAbility(entry.spellId) !== undefined;
      if (!applicable) {
        return { spellId: entry.spellId, kind: entry.kind, applicable, metrics };
      }

      if (entry.metrics.includes('cooldownUsage')) {
        const casts = this.casts.get(entry.spellId)?.length ?? 0;
        const usage = cooldownUsage(
          casts,
          this.spellUsable.history(entry.spellId).data,
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
        const throughput = windowThroughput(
          this.damageTimeline.damage,
          this.windows(entry),
          fightStart,
          fightEnd,
        );
        metrics.windowDps = { value: throughput.ratio, detail: { ...throughput } };
      }
      return { spellId: entry.spellId, kind: entry.kind, applicable, metrics };
    });
  }
}

export default CooldownMetrics;
