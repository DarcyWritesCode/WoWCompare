import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, {
  ApplyBuffEvent,
  ApplyBuffStackEvent,
  RefreshBuffEvent,
  RemoveBuffEvent,
  RemoveBuffStackEvent,
} from 'parser/core/Events';
import Abilities from 'parser/core/modules/Abilities';
import Enemies from 'parser/shared/modules/Enemies';

import { getProfile } from '../profile/registry';
import { Profile, ProfileEntry, SpellRef } from '../profile/types';
import DamageTimeline from './DamageTimeline';
import SpellCatalog from './SpellCatalog';
import { Interval, mergeIntervals, totalDuration } from './intervals';
import { RawEntryMetrics } from './results';

/** A proc removal counts as consumed if a consumer cast lands within this many ms of it. */
const CONSUME_WINDOW_MS = 150;
/**
 * Below this share of removals landing on a consumer cast, the buff is a state the APL waits for
 * (e.g. Eclipse) rather than a proc to spend, and proc usage isn't reported.
 */
const MIN_PROC_LIKE_SHARE = 0.4;

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

/** Uptime and proc usage for the profile's buff and debuff entries. */
class BuffMetrics extends Analyzer {
  static dependencies = {
    abilities: Abilities,
    enemies: Enemies,
    damageTimeline: DamageTimeline,
    spellCatalog: SpellCatalog,
  };
  protected abilities!: Abilities;
  protected enemies!: Enemies;
  protected damageTimeline!: DamageTimeline;
  protected spellCatalog!: SpellCatalog;

  private readonly profile: Profile | undefined;
  /** Every buff on the player, tracked by ID; profile entries are matched to IDs afterwards. */
  private readonly procs = new Map<number, ProcTracking>();

  constructor(options: Options) {
    super(options);
    const specId = this.selectedCombatant.spec?.id;
    this.profile = specId === undefined ? undefined : getProfile(specId);
    this.active = this.entries.length > 0;
    if (!this.entries.some((e) => e.metrics.includes('procUsage'))) {
      return;
    }
    this.addEventListener(Events.applybuff.to(SELECTED_PLAYER), this.onApply);
    this.addEventListener(Events.applybuffstack.to(SELECTED_PLAYER), this.onApplyStack);
    this.addEventListener(Events.refreshbuff.to(SELECTED_PLAYER), this.onRefresh);
    this.addEventListener(Events.removebuffstack.to(SELECTED_PLAYER), this.onRemoveStack);
    this.addEventListener(Events.removebuff.to(SELECTED_PLAYER), this.onRemove);
  }

  private get entries(): ProfileEntry[] {
    return this.profile?.entries.filter((e) => e.kind !== 'cooldown') ?? [];
  }

  private proc(spellId: number): ProcTracking {
    let proc = this.procs.get(spellId);
    if (!proc) {
      proc = { gained: 0, refreshed: 0, currentStacks: 0, removals: [] };
      this.procs.set(spellId, proc);
    }
    return proc;
  }

  private onApply(event: ApplyBuffEvent) {
    const proc = this.proc(event.ability.guid);
    proc.gained += 1;
    proc.currentStacks = 1;
  }

  private onApplyStack(event: ApplyBuffStackEvent) {
    const proc = this.proc(event.ability.guid);
    proc.gained += Math.max(1, event.stack - proc.currentStacks);
    proc.currentStacks = event.stack;
  }

  private onRefresh(event: RefreshBuffEvent) {
    const proc = this.proc(event.ability.guid);
    proc.gained += 1;
    proc.refreshed += 1;
  }

  private onRemoveStack(event: RemoveBuffStackEvent) {
    const proc = this.proc(event.ability.guid);
    proc.removals.push({
      timestamp: event.timestamp,
      stacks: Math.max(1, proc.currentStacks - event.stack),
    });
    proc.currentStacks = event.stack;
  }

  private onRemove(event: RemoveBuffEvent) {
    const proc = this.proc(event.ability.guid);
    proc.removals.push({ timestamp: event.timestamp, stacks: Math.max(1, proc.currentStacks) });
    proc.currentStacks = 0;
  }

  /** The IDs this log uses for an entry's aura. */
  private auraIds(entry: ProfileEntry): number[] {
    return this.spellCatalog.resolve(entry.kind === 'debuff' ? 'debuff' : 'buff', entry);
  }

  /** Time intervals the buff (on the player) or the player's debuff (on any enemy) was up. */
  auraIntervals(entry: ProfileEntry): Interval[] {
    const end = this.owner.fight.end_time;
    const toInterval = (buff: { start: number; end: number | null }) => ({
      start: buff.start,
      end: buff.end ?? end,
    });
    const raw = this.auraIds(entry).flatMap((id) =>
      entry.kind === 'debuff'
        ? Object.values(this.enemies.getEntities()).flatMap((enemy) =>
            enemy.getBuffHistory(id, this.owner.playerId).map(toInterval),
          )
        : this.selectedCombatant.getBuffHistory(id).map(toInterval),
    );
    return mergeIntervals(raw, this.owner.fight.start_time, end);
  }

  private consumerTimestamps(consumers: SpellRef[]): number[] {
    const ids = new Set(consumers.flatMap((c) => this.spellCatalog.resolve('cast', c)));
    return this.damageTimeline.casts.filter((c) => ids.has(c.spellId)).map((c) => c.timestamp);
  }

  procCounts(entry: ProfileEntry): ProcCounts | null {
    const procs = this.auraIds(entry)
      .map((id) => this.procs.get(id))
      .filter((p): p is ProcTracking => p !== undefined);
    if (procs.length === 0) {
      return null;
    }
    const consumerTimestamps = this.consumerTimestamps(entry.consumers ?? []);
    // Removals at the very end of the fight are the fight ending, not the proc expiring.
    const fightEnd = this.owner.fight.end_time - CONSUME_WINDOW_MS;

    let consumed = 0;
    let expired = 0;
    for (const removal of procs.flatMap((p) => p.removals)) {
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
    const sum = (key: 'gained' | 'refreshed') => procs.reduce((total, p) => total + p[key], 0);
    return { gained: sum('gained'), consumed, expired, overwritten: sum('refreshed') };
  }

  /**
   * Debuffs apply when the player has the ability behind them (or applied them at all); buffs
   * when they appeared in the log, since a proc that never shows up is most likely not talented.
   */
  private applies(entry: ProfileEntry): boolean {
    const kind = entry.kind === 'debuff' ? 'debuff' : 'buff';
    if (this.spellCatalog.seenAny(kind, entry)) {
      return true;
    }
    const requires = entry.requires;
    return (
      requires !== undefined &&
      (this.spellCatalog.seenAny('cast', requires) ||
        requires.spellIds.some((id) => this.abilities.getAbility(id) !== undefined))
    );
  }

  results(): RawEntryMetrics[] {
    const fightStart = this.owner.fight.start_time;
    const fightEnd = this.owner.fight.end_time;
    const fightLength = fightEnd - fightStart;

    return this.entries.map((entry) => {
      const metrics: RawEntryMetrics['metrics'] = {};
      const spellId = this.auraIds(entry)[0] ?? 0;
      const applicable = this.applies(entry);
      if (!applicable) {
        return { token: entry.token, spellId, kind: entry.kind, applicable, metrics };
      }

      if (entry.metrics.includes('uptime')) {
        const uptime = totalDuration(this.auraIntervals(entry));
        metrics.uptime = {
          value: fightLength > 0 ? uptime / fightLength : null,
          detail: { uptimeMs: uptime, fightMs: fightLength },
        };
      }
      if (entry.metrics.includes('procUsage')) {
        const counts = this.procCounts(entry);
        const resolved = counts ? counts.consumed + counts.expired + counts.overwritten : 0;
        const share = counts && resolved > 0 ? counts.consumed / resolved : null;
        const procLike = share !== null && share >= MIN_PROC_LIKE_SHARE;
        // Report whichever fits: proc usage for spendable procs, uptime for states.
        if (procLike) {
          metrics.procUsage = { value: share, detail: { ...counts } };
          delete metrics.uptime;
        }
      }
      return { token: entry.token, spellId, kind: entry.kind, applicable, metrics };
    });
  }
}

export default BuffMetrics;
