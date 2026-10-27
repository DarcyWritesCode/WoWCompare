import { captureException } from 'common/errorLogger';
import fetchWcl from 'common/fetchWclApi';
import { WCLEventsResponse } from 'common/WCL_TYPES';
import { AnyEvent } from 'parser/core/Events';
import { useEffect, useState } from 'react';

import { DAMAGE_WINDOWS, DamageWindowDef } from './encounters/damageWindows';
import { CooldownWindowSet, entryResult, ProfileResults } from './metrics/results';

/**
 * WoWCompare: the encounter's damage windows (encounters/damageWindows.ts) in one fight, and how
 * the player used them: damage on the amplified target, cooldowns inside, and cooldowns spent on
 * targets that were taking less damage. The windows come from a fetch of their auras, since the
 * parser only sees events involving the player and boss self-buffs aren't among them.
 */

/** Hits on other targets count as cleave when the same spell hit two targets this close together. */
const CLEAVE_MS = 50;
/** Window aura events are few; more pages than this means a bad filter. */
const MAX_PAGES = 5;
/** A cooldown is flagged when its main target was reduced or immune for this share of it. */
const REDUCED_SHARE = 0.5;
/** Cooldown casts this long before a window are shown as "used before it". */
const RECENT_CAST_MS = 60_000;
/** A cooldown cast this soon before a window still counts as used for it. */
const LEAD_MS = 3_000;

export interface DamageWindowInputs {
  reportCode: string;
  encounterId: number;
  /** The analyzed range, in report timestamps (the death cutoff can shorten it). */
  fightStart: number;
  fightEnd: number;
  hits: { timestamp: number; amount: number; spellId: number; targetID: number }[];
  casts: { timestamp: number; spellId: number; targetID?: number }[];
  /** Enemy actors by ID. */
  enemies: Record<number, string>;
}

/** One stretch of a window's aura on one enemy, in report timestamps. */
export interface AuraSpan {
  def: DamageWindowDef;
  targetID: number;
  start: number;
  end: number;
}

export type WindowFetch =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'done'; spans: AuraSpan[] };

/** Fetches the encounter's window auras for the analyzed range; null on encounters without any. */
export function useDamageWindowSpans(inputs: DamageWindowInputs | undefined): WindowFetch | null {
  const defs = inputs ? DAMAGE_WINDOWS[inputs.encounterId] : undefined;
  const [result, setResult] = useState<WindowFetch>({ state: 'loading' });
  const { reportCode, fightStart, fightEnd } = inputs ?? {};

  useEffect(() => {
    if (!defs || !reportCode || fightStart === undefined || fightEnd === undefined) {
      return;
    }
    let cancelled = false;
    setResult({ state: 'loading' });
    fetchDamageWindowSpans(reportCode, defs, fightStart, fightEnd).then(
      (spans) => !cancelled && setResult({ state: 'done', spans }),
      (err) => {
        captureException(err as Error);
        if (!cancelled) {
          setResult({ state: 'error' });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [defs, reportCode, fightStart, fightEnd]);

  return defs ? result : null;
}

/** Pages of the window auras' events, from the enemies' side (boss self-buffs included). */
export async function fetchDamageWindowSpans(
  reportCode: string,
  defs: DamageWindowDef[],
  fightStart: number,
  fightEnd: number,
): Promise<AuraSpan[]> {
  const ids = defs.map((def) => def.auraId).join(', ');
  const filter = `ability.id in (${ids}) and type in ("applybuff", "removebuff", "applydebuff", "removedebuff")`;
  const events: AnyEvent[] = [];
  let start = fightStart;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const json = await fetchWcl<WCLEventsResponse>(`report/events/${reportCode}`, {
      start,
      end: fightEnd,
      filter,
      hostility: 1,
      translate: true,
    });
    json.events?.forEach((event) => events.push(event));
    if (!json.nextPageTimestamp || json.nextPageTimestamp >= fightEnd) {
      break;
    }
    start = json.nextPageTimestamp;
  }
  return toSpans(events, defs, fightStart, fightEnd);
}

/** A window aura's spans merged across the enemies that had it (report timestamps). */
export function mergeSpans(spans: AuraSpan[]) {
  const merged: { def: DamageWindowDef; start: number; end: number; holders: Set<number> }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged.findLast((m) => m.def === span.def && span.start <= m.end);
    if (last) {
      last.end = Math.max(last.end, span.end);
      last.holders.add(span.targetID);
    } else {
      merged.push({
        def: span.def,
        start: span.start,
        end: span.end,
        holders: new Set([span.targetID]),
      });
    }
  }
  return merged;
}

/** The windows as stored on a snapshot. */
export const snapshotWindows = (spans: AuraSpan[], fightStart: number) =>
  mergeSpans(spans).map((w) => ({
    auraId: w.def.auraId,
    kind: w.def.kind,
    startMs: w.start - fightStart,
    endMs: w.end - fightStart,
  }));

function toSpans(
  events: AnyEvent[],
  defs: DamageWindowDef[],
  fightStart: number,
  fightEnd: number,
): AuraSpan[] {
  const byId = new Map(defs.map((def) => [def.auraId, def]));
  const open = new Map<string, { def: DamageWindowDef; targetID: number; start: number }>();
  const spans: AuraSpan[] = [];
  for (const event of events) {
    if (!('ability' in event) || !('targetID' in event) || event.targetID === undefined) {
      continue;
    }
    const def = byId.get(event.ability.guid);
    if (!def) {
      continue;
    }
    const instance = 'targetInstance' in event ? (event.targetInstance ?? 0) : 0;
    const key = `${def.auraId}:${event.targetID}:${instance}`;
    if (event.type === 'applybuff' || event.type === 'applydebuff') {
      open.set(key, { def, targetID: event.targetID, start: event.timestamp });
    } else if (event.type === 'removebuff' || event.type === 'removedebuff') {
      // Up before the range started.
      const opened = open.get(key) ?? { def, targetID: event.targetID, start: fightStart };
      open.delete(key);
      spans.push({ ...opened, end: event.timestamp });
    }
  }
  open.forEach((opened) => spans.push({ ...opened, end: fightEnd }));
  return spans.filter((span) => span.end > span.start);
}

export interface WindowCooldown {
  token: string;
  spellId: number;
  label?: string;
  /** Casts in the window, or just before it (`LEAD_MS`). */
  castsInside: number;
  /** With none inside: how long before the window the last cast was, ms. */
  usedBeforeMs?: number;
  /** With none inside: it was off cooldown as the window opened and still wasn't used. */
  readyUnused?: boolean;
}

export interface AmpWindowResult {
  def: DamageWindowDef;
  /** ms from fight start. */
  startMs: number;
  endMs: number;
  targetName: string;
  /** The player's damage on the aura's holder(s) during the window. */
  onTarget: number;
  /** Damage on other targets from spells that hit one target: aimed elsewhere. */
  aimedElsewhere: number;
  /** Damage on other targets from spells that also hit something else at the time. */
  cleaveElsewhere: number;
  /** ms from the window's start to the player's first cast at the target; null if none. */
  firstCastMs: number | null;
  cooldowns: WindowCooldown[];
}

export interface ReducedCooldown {
  token: string;
  spellId: number;
  label?: string;
  /** ms from fight start. */
  castMs: number;
  durationMs: number;
  def: DamageWindowDef;
  targetName: string;
  /** Share of the cooldown its main target was reduced or immune. */
  reducedShare: number;
  /** How long after the cast the reduction ended, ms. */
  waitMs: number;
  /** Whether holding it until then would have cost no cast over the fight; null if unknown. */
  holdIsFree: boolean | null;
}

export interface DamageWindowAnalysis {
  amps: AmpWindowResult[];
  reduced: ReducedCooldown[];
  /** Every window, ms from fight start. */
  timeline: { def: DamageWindowDef; startMs: number; endMs: number }[];
}

const overlap = (a: number, b: number, c: number, d: number) =>
  Math.max(0, Math.min(b, d) - Math.max(a, c));

export function analyzeDamageWindows(
  inputs: DamageWindowInputs,
  spans: AuraSpan[],
  cooldowns: CooldownWindowSet[],
  results: ProfileResults,
): DamageWindowAnalysis {
  const { fightStart, fightEnd, hits, casts, enemies } = inputs;
  const rel = (timestamp: number) => timestamp - fightStart;

  // Same-window spans of one aura on several enemies (e.g. two adds) are one window.
  const merged = mergeSpans(spans);

  // Spells that hit two targets at once are cleave: their damage elsewhere is a bonus, not a miss.
  const cleaves = new Set<number>();
  const seen = new Map<string, number>();
  for (const hit of hits) {
    const key = `${hit.spellId}:${Math.floor(hit.timestamp / CLEAVE_MS)}`;
    const target = seen.get(key);
    if (target === undefined) {
      seen.set(key, hit.targetID);
    } else if (target !== hit.targetID) {
      cleaves.add(hit.spellId);
    }
  }

  const holderNames = (holders: Set<number>) =>
    [...new Set([...holders].map((id) => enemies[id] ?? 'Unknown'))].join(', ');
  const cooldownMsOf = (set: CooldownWindowSet) =>
    entryResult(results, { kind: 'cooldown', token: set.token })?.metrics.cooldownUsage?.detail
      .cooldownMs ?? null;
  // Cast times, ms from fight start; the windows' starts for spells cast under another ID.
  const castTimes = (set: CooldownWindowSet) => {
    const own = casts
      .filter((cast) => cast.spellId === set.spellId)
      .map((cast) => rel(cast.timestamp));
    return own.length > 0 ? own : set.windows.map((w) => w.startMs);
  };

  const amps = merged
    .filter((window) => window.def.kind === 'amp')
    .map((window): AmpWindowResult => {
      let onTarget = 0;
      let aimedElsewhere = 0;
      let cleaveElsewhere = 0;
      for (const hit of hits) {
        if (hit.timestamp < window.start || hit.timestamp >= window.end) {
          continue;
        }
        if (window.holders.has(hit.targetID)) {
          onTarget += hit.amount;
        } else if (cleaves.has(hit.spellId)) {
          cleaveElsewhere += hit.amount;
        } else {
          aimedElsewhere += hit.amount;
        }
      }
      const firstCast = casts.find(
        (cast) =>
          cast.timestamp >= window.start &&
          cast.timestamp < window.end &&
          cast.targetID !== undefined &&
          window.holders.has(cast.targetID),
      );
      const startMs = rel(window.start);
      const endMs = rel(window.end);
      return {
        def: window.def,
        startMs,
        endMs,
        targetName: holderNames(window.holders),
        onTarget,
        aimedElsewhere,
        cleaveElsewhere,
        firstCastMs: firstCast ? firstCast.timestamp - window.start : null,
        cooldowns: cooldowns
          .map((set): WindowCooldown | null => {
            const times = castTimes(set);
            const base = { token: set.token, spellId: set.spellId, label: set.label };
            const castsInside = times.filter((t) => t >= startMs - LEAD_MS && t < endMs).length;
            if (castsInside > 0) {
              return { ...base, castsInside };
            }
            const before = times.filter((t) => t < startMs - LEAD_MS).at(-1);
            const cooldownMs = cooldownMsOf(set);
            if (cooldownMs !== null && (before === undefined || startMs - before >= cooldownMs)) {
              return { ...base, castsInside: 0, readyUnused: true };
            }
            return before !== undefined && startMs - before <= RECENT_CAST_MS
              ? { ...base, castsInside: 0, usedBeforeMs: startMs - before }
              : null;
          })
          .filter((c): c is WindowCooldown => c !== null),
      };
    });

  // Cooldowns whose main target (by casts) was reduced or immune for most of them.
  const reductions = merged.filter((w) => w.def.kind !== 'amp');
  const fightMs = fightEnd - fightStart;
  const reduced = cooldowns.flatMap((set) => {
    const cooldownMs = cooldownMsOf(set);
    return set.windows.flatMap((w): ReducedCooldown[] => {
      const start = fightStart + w.startMs;
      const end = start + w.durationMs;
      const targets = new Map<number, number>();
      casts.forEach((cast) => {
        if (
          cast.timestamp >= start &&
          cast.timestamp < end &&
          cast.targetID !== undefined &&
          enemies[cast.targetID]
        ) {
          targets.set(cast.targetID, (targets.get(cast.targetID) ?? 0) + 1);
        }
      });
      const main = [...targets].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (main === undefined || w.durationMs <= 0) {
        return [];
      }
      const hitting = reductions.filter(
        (r) => r.holders.has(main) && overlap(r.start, r.end, start, end) > 0,
      );
      const reducedMs = hitting.reduce((sum, r) => sum + overlap(r.start, r.end, start, end), 0);
      if (hitting.length === 0 || reducedMs / w.durationMs < REDUCED_SHARE) {
        return [];
      }
      const waitMs = Math.max(...hitting.map((r) => r.end)) - start;
      const holdIsFree =
        cooldownMs && cooldownMs > 0
          ? Math.floor((fightMs - w.startMs - waitMs) / cooldownMs) ===
            Math.floor((fightMs - w.startMs) / cooldownMs)
          : null;
      return [
        {
          token: set.token,
          spellId: set.spellId,
          label: set.label,
          castMs: w.startMs,
          durationMs: w.durationMs,
          def: hitting[0].def,
          targetName: enemies[main] ?? 'Unknown',
          reducedShare: Math.min(1, reducedMs / w.durationMs),
          waitMs,
          holdIsFree,
        },
      ];
    });
  });

  return {
    amps,
    reduced: reduced.sort((a, b) => a.castMs - b.castMs),
    timeline: merged.map((w) => ({
      def: w.def,
      startMs: rel(w.start),
      endMs: rel(w.end),
    })),
  };
}
