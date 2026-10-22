import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, {
  ApplyBuffEvent,
  ApplyBuffStackEvent,
  CastEvent,
  RefreshBuffEvent,
  RemoveBuffEvent,
  RemoveBuffStackEvent,
} from 'parser/core/Events';
import Enemies from 'parser/shared/modules/Enemies';

import { getProfile } from '../profile/registry';
import { Profile, ProfileEntry } from '../profile/types';
import DamageTimeline from './DamageTimeline';
import { Interval, mergeIntervals, totalDuration, windowThroughput } from './intervals';
import { RawEntryMetrics } from './results';

/** A proc removal counts as consumed if a consumer cast lands within this many ms of it. */
const CONSUME_WINDOW_MS = 150;

interface ProcRemoval {
  timestamp: number;
  /** Stacks lost by this removal. */
  stacks: number;
}

interface ProcTracking {
  gained: number;
  refreshed: number;
  currentStacks: number;
  removals: ProcRemoval[];
}

export interface ProcCounts {
  gained: number;
  consumed: number;
  expired: number;
  /** Refreshed while already up: the new proc was wasted. */
  overwritten: number;
}

/** Uptime, proc usage and in-window throughput for the profile's buff and debuff entries. */
class BuffMetrics extends Analyzer {
  static dependencies = {
    enemies: Enemies,
    damageTimeline: DamageTimeline,
  };
  protected enemies!: Enemies;
  protected damageTimeline!: DamageTimeline;

  private readonly profile: Profile | undefined;
  private readonly procs = new Map<number, ProcTracking>();
  private readonly consumerCasts = new Map<number, number[]>();

  constructor(options: Options) {
    super(options);
    const specId = this.selectedCombatant.spec?.id;
    this.profile = specId === undefined ? undefined : getProfile(specId);
    this.active = Boolean(this.profile?.entries.some((e) => e.kind !== 'cooldown'));
    if (!this.active) {
      return;
    }

    const procEntries = this.entries.filter(
      (e) => e.kind === 'buff' && e.metrics.includes('procUsage'),
    );
    if (procEntries.length === 0) {
      return;
    }
    procEntries.forEach((e) =>
      this.procs.set(e.spellId, { gained: 0, refreshed: 0, currentStacks: 0, removals: [] }),
    );
    const consumerIds = [...new Set(procEntries.flatMap((e) => e.consumerSpellIds ?? []))];
    consumerIds.forEach((id) => this.consumerCasts.set(id, []));

    // Handlers ignore auras that aren't tracked procs (see `proc()`).
    this.addEventListener(Events.applybuff.to(SELECTED_PLAYER), this.onApply);
    this.addEventListener(Events.applybuffstack.to(SELECTED_PLAYER), this.onApplyStack);
    this.addEventListener(Events.refreshbuff.to(SELECTED_PLAYER), this.onRefresh);
    this.addEventListener(Events.removebuffstack.to(SELECTED_PLAYER), this.onRemoveStack);
    this.addEventListener(Events.removebuff.to(SELECTED_PLAYER), this.onRemove);
    this.addEventListener(Events.cast.by(SELECTED_PLAYER), this.onCast);
  }

  private get entries(): ProfileEntry[] {
    return this.profile?.entries.filter((e) => e.kind !== 'cooldown') ?? [];
  }

  private onApply(event: ApplyBuffEvent) {
    const proc = this.procs.get(event.ability.guid);
    if (!proc) {
      return;
    }
    proc.gained += 1;
    proc.currentStacks = 1;
  }

  private onApplyStack(event: ApplyBuffStackEvent) {
    const proc = this.procs.get(event.ability.guid);
    if (!proc) {
      return;
    }
    proc.gained += Math.max(1, event.stack - proc.currentStacks);
    proc.currentStacks = event.stack;
  }

  private onRefresh(event: RefreshBuffEvent) {
    const proc = this.procs.get(event.ability.guid);
    if (!proc) {
      return;
    }
    proc.gained += 1;
    proc.refreshed += 1;
  }

  private onRemoveStack(event: RemoveBuffStackEvent) {
    const proc = this.procs.get(event.ability.guid);
    if (!proc) {
      return;
    }
    proc.removals.push({
      timestamp: event.timestamp,
      stacks: Math.max(1, proc.currentStacks - event.stack),
    });
    proc.currentStacks = event.stack;
  }

  private onRemove(event: RemoveBuffEvent) {
    const proc = this.procs.get(event.ability.guid);
    if (!proc) {
      return;
    }
    proc.removals.push({ timestamp: event.timestamp, stacks: Math.max(1, proc.currentStacks) });
    proc.currentStacks = 0;
  }

  private onCast(event: CastEvent) {
    this.consumerCasts.get(event.ability.guid)?.push(event.timestamp);
  }

  /** Time intervals the buff (on the player) or the player's debuff (on any enemy) was up. */
  auraIntervals(entry: Pick<ProfileEntry, 'spellId' | 'kind'>): Interval[] {
    const end = this.owner.fight.end_time;
    const toInterval = (buff: { start: number; end: number | null }) => ({
      start: buff.start,
      end: buff.end ?? end,
    });
    const raw =
      entry.kind === 'debuff'
        ? Object.values(this.enemies.getEntities()).flatMap((enemy) =>
            enemy.getBuffHistory(entry.spellId, this.owner.playerId).map(toInterval),
          )
        : this.selectedCombatant.getBuffHistory(entry.spellId).map(toInterval);
    return mergeIntervals(raw, this.owner.fight.start_time, end);
  }

  procCounts(entry: ProfileEntry): ProcCounts | null {
    const proc = this.procs.get(entry.spellId);
    if (!proc) {
      return null;
    }
    const consumerTimestamps = (entry.consumerSpellIds ?? []).flatMap(
      (id) => this.consumerCasts.get(id) ?? [],
    );
    // Removals at the very end of the fight are the fight ending, not the proc expiring.
    const fightEnd = this.owner.fight.end_time - CONSUME_WINDOW_MS;

    let consumed = 0;
    let expired = 0;
    for (const removal of proc.removals) {
      if (removal.timestamp >= fightEnd) {
        continue;
      }
      const wasConsumed = consumerTimestamps.some(
        (t) => Math.abs(t - removal.timestamp) <= CONSUME_WINDOW_MS,
      );
      if (wasConsumed) {
        // One stack consumed per cast; any extra stacks dropped at once expired.
        consumed += 1;
        expired += removal.stacks - 1;
      } else {
        expired += removal.stacks;
      }
    }
    return { gained: proc.gained, consumed, expired, overwritten: proc.refreshed };
  }

  results(): RawEntryMetrics[] {
    const fightStart = this.owner.fight.start_time;
    const fightEnd = this.owner.fight.end_time;
    const fightLength = fightEnd - fightStart;

    return this.entries.map((entry) => {
      const metrics: RawEntryMetrics['metrics'] = {};
      const intervals =
        entry.metrics.includes('uptime') || entry.metrics.includes('windowDps')
          ? this.auraIntervals(entry)
          : [];

      if (entry.metrics.includes('uptime')) {
        const uptime = totalDuration(intervals);
        metrics.uptime = {
          value: fightLength > 0 ? uptime / fightLength : null,
          detail: { uptimeMs: uptime, fightMs: fightLength },
        };
      }
      if (entry.metrics.includes('procUsage')) {
        const counts = this.procCounts(entry);
        const resolved = counts ? counts.consumed + counts.expired + counts.overwritten : 0;
        metrics.procUsage = {
          value: counts && resolved > 0 ? counts.consumed / resolved : null,
          detail: { ...counts },
        };
      }
      if (entry.metrics.includes('windowDps')) {
        const throughput = windowThroughput(
          this.damageTimeline.damage,
          intervals,
          fightStart,
          fightEnd,
        );
        metrics.windowDps = { value: throughput.ratio, detail: { ...throughput } };
      }
      return { spellId: entry.spellId, kind: entry.kind, applicable: true, metrics };
    });
  }
}

export default BuffMetrics;
