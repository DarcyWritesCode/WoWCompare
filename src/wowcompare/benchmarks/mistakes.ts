import { CooldownWindowSet, entryResult, LogSnapshot, WindowEntryState } from '../metrics/results';
import { Profile, ProfileEntry, SpellRef } from '../profile/types';
import { median } from './aggregate';
import { BuffEffects, significantEffect } from './buffEffects';

/** Gaps worth less than this share of the player's DPS aren't listed. */
const MIN_SHARE = 0.003;
const MAX_MISTAKES = 8;

export interface Mistake {
  key: string;
  /** Spell to show with the mistake. */
  spellId: number;
  title: string;
  /** What the player did vs the reference median, e.g. "5.4 vs 6.9 per window". */
  detail: string;
  /** Estimated DPS lost against the reference median. */
  dps: number;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

function abilityFor(log: LogSnapshot, ref: { token: string; spellIds: number[] }) {
  return log.abilities.find(
    (a) => a.token === ref.token || a.spellIds.some((id) => ref.spellIds.includes(id)),
  );
}

/** Average damage per cast of an ability, from the player if they cast it, else the top logs. */
function perCast(player: LogSnapshot, topLogs: LogSnapshot[], ref: SpellRef): number {
  const of = (log: LogSnapshot) => {
    const total = abilityFor(log, ref);
    return total && total.casts > 0 ? total.damage / total.casts : null;
  };
  return of(player) ?? median(topLogs.map(of).filter((v): v is number => v !== null)) ?? 0;
}

/** Average window length in seconds. */
const windowSeconds = (set: CooldownWindowSet) =>
  set.windows.reduce((sum, w) => sum + w.durationMs, 0) / set.windows.length / 1000;

/** Windows that end early: windows can stretch (e.g. Breath of Sindragosa lasts while fed). */
const LONGER_BY = 1.1;

/**
 * Cooldown windows: whether the player's windows last as long as the top logs', and how many
 * casts they fit in per second of window, valued at their own damage per cast. Rates per second
 * keep a short window from counting twice (once as "ends early", again as "fewer casts").
 */
function windowMistakes(player: LogSnapshot, topLogs: LogSnapshot[]): Mistake[] {
  const seconds = player.durationMs / 1000;
  return player.windows.flatMap((set) => {
    const topSets = topLogs
      .map((log) => log.windows.find((s) => s.token === set.token))
      .filter((s): s is CooldownWindowSet => s !== undefined && s.windows.length > 0);
    if (topSets.length === 0 || set.windows.length === 0) {
      return [];
    }
    const cooldown = set.label ?? cooldownName(player, set);
    const mySeconds = windowSeconds(set);
    const myWindowTotal = mySeconds * set.windows.length;
    const mistakes: Mistake[] = [];

    // Damage per window, the top logs' scaled by DPS so their gear doesn't count as your loss.
    const windowDamage = (s: CooldownWindowSet) =>
      s.windows.reduce((sum, w) => sum + (w.dps * w.durationMs) / 1000, 0) / s.windows.length;
    const topSeconds = median(topSets.map(windowSeconds));
    const topDamage = median(
      topLogs.flatMap((log) => {
        const s = log.windows.find((w) => w.token === set.token);
        return s?.windows.length && log.fightDps > 0
          ? [windowDamage(s) * (player.fightDps / log.fightDps)]
          : [];
      }),
    );
    const myDamage = windowDamage(set);
    // The extra seconds would have earned normal damage anyway; only the window's lift counts.
    const outside = entryResult(player.results, { kind: 'cooldown', token: set.token })?.metrics
      .windowDps?.detail;
    const outsideDps =
      outside?.timeOut && outside.damageOut != null
        ? outside.damageOut / (outside.timeOut / 1000)
        : player.fightDps;
    const gain = topSeconds ? topDamage! - myDamage - (topSeconds - mySeconds) * outsideDps : 0;
    if (topSeconds && topDamage && topSeconds > mySeconds * LONGER_BY && gain > 0) {
      mistakes.push({
        key: `window-length-${set.token}`,
        spellId: set.spellId,
        title: `${cooldown} ends early`,
        detail: `${mySeconds.toFixed(1)}s vs ${topSeconds.toFixed(1)}s per window`,
        dps: (gain * set.windows.length) / seconds,
      });
    }

    const tokens = new Set([
      ...set.abilities.map((a) => a.token),
      ...topSets.flatMap((s) => s.abilities.map((a) => a.token)),
    ]);
    for (const token of tokens) {
      const mine = set.abilities.find((a) => a.token === token);
      const any = mine ?? topSets.flatMap((s) => s.abilities).find((a) => a.token === token)!;
      const perSecond = (s: CooldownWindowSet) =>
        (s.abilities.find((a) => a.token === token)?.casts ?? 0) /
        (windowSeconds(s) * s.windows.length);
      const topRate = median(topSets.map(perSecond));
      const myRate = perSecond(set);
      if (!topRate || topRate <= myRate) {
        continue;
      }
      const value = perCast(player, topLogs, { token, spellIds: [any.spellId] });
      const perWindow = (rate: number) => (rate * mySeconds).toFixed(1);
      mistakes.push({
        key: `window-${set.token}-${token}`,
        spellId: any.spellId,
        title:
          token === 'melee'
            ? `Stay in melee range during ${cooldown}`
            : `Fit more ${any.name} into ${cooldown}`,
        detail:
          token === 'melee'
            ? `${perWindow(myRate)} vs ${perWindow(topRate)} swings per window`
            : `${perWindow(myRate)} vs ${perWindow(topRate)} per window of your length`,
        dps: ((topRate - myRate) * myWindowTotal * value) / seconds,
      });
    }
    return mistakes;
  });
}

function cooldownName(player: LogSnapshot, set: CooldownWindowSet) {
  return (
    player.abilities.find((a) => a.spellIds.includes(set.spellId))?.name ??
    set.token.replace(/_/g, ' ')
  );
}

function entryName(player: LogSnapshot, entry: ProfileEntry, spellId: number) {
  return (
    entry.label ??
    player.abilities.find((a) => a.spellIds.includes(spellId))?.name ??
    player.auras.find((a) => a.spellId === spellId)?.name ??
    entry.token.replace(/_/g, ' ')
  );
}

/** Uptime, proc and cooldown-usage gaps, valued with the player's own damage. */
function entryMistakes(profile: Profile, player: LogSnapshot, topLogs: LogSnapshot[]): Mistake[] {
  const seconds = player.durationMs / 1000;
  return profile.entries.flatMap((entry): Mistake[] => {
    const mine = entryResult(player.results, entry);
    if (!mine?.applicable) {
      return [];
    }
    const top = (kind: 'uptime' | 'procUsage' | 'cooldownUsage') =>
      median(
        topLogs
          .map((log) => entryResult(log.results, entry))
          .filter((e) => e?.applicable)
          .map((e) => e!.metrics[kind]?.value)
          .filter((v): v is number => typeof v === 'number'),
      );
    const name = entryName(player, entry, mine.spellId);
    const key = `${entry.kind}-${entry.token}`;

    // DoTs: their damage scales with uptime.
    const uptime = mine.metrics.uptime?.value;
    const topUptime = top('uptime');
    if (entry.kind === 'debuff' && uptime && topUptime && topUptime > uptime) {
      const dot = abilityFor(player, { token: entry.token, spellIds: [mine.spellId] });
      if (dot) {
        return [
          {
            key,
            spellId: mine.spellId,
            title: `Keep ${name} up`,
            detail: `${pct(uptime)} vs ${pct(topUptime)} uptime`,
            dps: (dot.damage / seconds) * (topUptime / uptime - 1),
          },
        ];
      }
    }

    // Procs: each wasted one is a spender cast lost.
    const usage = mine.metrics.procUsage;
    const topUsage = top('procUsage');
    if (usage?.value != null && topUsage && topUsage > usage.value) {
      const d = usage.detail;
      const resolved = (d.consumed ?? 0) + (d.expired ?? 0) + (d.overwritten ?? 0);
      const value = Math.max(0, ...(entry.consumers ?? []).map((c) => perCast(player, topLogs, c)));
      return [
        {
          key,
          spellId: mine.spellId,
          title: `Spend ${name} before it's wasted`,
          detail: `${pct(usage.value)} vs ${pct(topUsage)} of procs used`,
          dps: ((topUsage - usage.value) * resolved * value) / seconds,
        },
      ];
    }

    // Cooldowns: each missed cast is its own damage plus the window it would have opened.
    const cd = mine.metrics.cooldownUsage;
    const topCd = top('cooldownUsage');
    if (cd?.value != null && topCd && topCd > cd.value) {
      const casts = cd.detail.casts ?? 0;
      const possible = casts + (cd.detail.lostCasts ?? 0);
      const missed = Math.max(0, Math.round(possible * topCd) - casts);
      const own = perCast(player, topLogs, { token: entry.token, spellIds: [mine.spellId] });
      const set = player.windows.find((s) => s.token === entry.token);
      const ratio = mine.metrics.windowDps?.value;
      const avgWindowSec = set?.windows.length
        ? set.windows.reduce((sum, w) => sum + w.durationMs, 0) / set.windows.length / 1000
        : 0;
      const windowBonus = ratio && ratio > 1 ? (ratio - 1) * player.fightDps * avgWindowSec : 0;
      if (missed > 0) {
        return [
          {
            key,
            spellId: mine.spellId,
            title: `Use ${name} on cooldown`,
            detail: `${casts} of ${possible} possible casts (top: ${pct(topCd)})`,
            dps: (missed * (own + windowBonus)) / seconds,
          },
        ];
      }
    }
    return [];
  });
}

/** How much more pooled (as a share of the resource's max) before it's worth flagging. */
const MIN_POOL_GAP = 0.1;
/** How much more of each window a buff must be up in reference logs before it's worth flagging. */
const MIN_LINEUP_GAP = 0.25;
/** Very short windows have spiky DPS that swamps the comparison. */
const MIN_SAMPLE_MS = 3_000;

interface WindowSample {
  state: WindowEntryState;
  /** Window DPS as a multiple of that log's average DPS, so logs with different gear compare. */
  value: number;
}

function samples(log: LogSnapshot, token: string): WindowSample[] {
  const set = log.windows.find((s) => s.token === token);
  if (!set?.entryStates || log.fightDps <= 0) {
    return [];
  }
  return set.windows.flatMap((window, i) =>
    set.entryStates[i] && window.durationMs >= MIN_SAMPLE_MS
      ? [
          {
            state: set.entryStates[i],
            value: window.dps / log.fightDps,
          },
        ]
      : [],
  );
}

/**
 * Resources pooled going into each cooldown vs the reference logs, valued as the extra points x
 * the player's damage per point x the window's extra multiplier.
 */
function poolingMistakes(player: LogSnapshot, topLogs: LogSnapshot[]): Mistake[] {
  const seconds = player.durationMs / 1000;
  return player.windows.flatMap((set) => {
    const mine = samples(player, set.token);
    const top = topLogs.map((log) => samples(log, set.token)).filter((s) => s.length > 0);
    if (mine.length === 0 || top.length === 0) {
      return [];
    }
    const cooldown = set.label ?? cooldownName(player, set);
    const mistakes: Mistake[] = [];

    // Resources: each point pooled is spent inside the window instead of outside it, so it
    // gains the window's extra damage on top of what the spender does anyway.
    const ratio =
      entryResult(player.results, { kind: 'cooldown', token: set.token })?.metrics.windowDps
        ?.value ?? null;
    for (const resource of Object.keys(mine[0].state.resources)) {
      const at = (list: WindowSample[]) =>
        median(
          list
            .map((s) => s.state.resources[resource])
            .filter((v): v is number => typeof v === 'number'),
        );
      const myLevel = at(mine);
      const topLevel = median(top.map(at).filter((v): v is number => v !== null));
      const value = player.resourceValues?.[resource];
      if (
        myLevel === null ||
        !topLevel ||
        topLevel - myLevel < MIN_POOL_GAP ||
        !value ||
        !ratio ||
        ratio <= 1
      ) {
        continue;
      }
      const points = (topLevel - myLevel) * value.max;
      mistakes.push({
        key: `pool-${set.token}-${resource}`,
        spellId: set.spellId,
        title: `Pool more ${resource} before ${cooldown}`,
        detail: `${pct(myLevel)} vs ${pct(topLevel)} of max at the cast`,
        dps: (points * value.damagePerPoint * (ratio - 1) * set.windows.length) / seconds,
      });
    }

    return mistakes;
  });
}

/** Average share of `set`'s windows that `buff` was up (windows recorded without overlap skipped). */
function overlapShare(set: CooldownWindowSet, buff: string): number | null {
  const shares = set.windows.flatMap((window, i) => {
    const overlap = set.entryStates[i]?.overlap;
    return overlap && window.durationMs >= MIN_SAMPLE_MS ? [overlap[buff] ?? 0] : [];
  });
  return shares.length > 0 ? shares.reduce((sum, v) => sum + v, 0) / shares.length : null;
}

/**
 * The APL's other cooldowns kept up during each cooldown less than in the reference logs (e.g.
 * Tiger's Fury during Berserk), valued with the spec's measured buff effects (see
 * buffEffects.ts): the window strength the buff adds x the player's average DPS x window length,
 * for the share of each window it was missing. Only the APL's cooldowns, which players line up on
 * purpose: a proc or passive buff being up reflects how the window went, not a choice.
 */
function buffOverlapMistakes(
  profile: Profile,
  player: LogSnapshot,
  topLogs: LogSnapshot[],
  effects: BuffEffects | null,
): Mistake[] {
  if (!effects) {
    return [];
  }
  const seconds = player.durationMs / 1000;
  const cooldowns = new Set(
    profile.entries.filter((e) => e.kind === 'cooldown').map((e) => e.token),
  );
  return player.windows.flatMap((set) => {
    const cooldown = set.label ?? cooldownName(player, set);
    return effects.effects.flatMap((candidate): Mistake[] => {
      if (candidate.cooldown !== set.token || !cooldowns.has(candidate.buff)) {
        return [];
      }
      const effect = significantEffect(effects, set.token, candidate.buff);
      const aura = player.auras.find((a) => a.token === candidate.buff && a.kind === 'buff');
      if (!effect || effect.effect <= 0 || !aura) {
        return [];
      }
      const mine = overlapShare(set, candidate.buff);
      const theirs = median(
        topLogs
          .map((log) => log.windows.find((s) => s.token === set.token))
          .map((s) => (s ? overlapShare(s, candidate.buff) : null))
          .filter((v): v is number => v !== null),
      );
      if (mine === null || theirs === null || theirs - mine < MIN_LINEUP_GAP) {
        return [];
      }
      const perWindow = effect.effect * player.fightDps * windowSeconds(set);
      return [
        {
          key: `lineup-${set.token}-${candidate.buff}`,
          spellId: aura.spellId,
          title: `Have ${aura.name} up during ${cooldown}`,
          detail: `up for ${pct(mine)} vs ${pct(theirs)} of each window`,
          dps: (perWindow * (theirs - mine) * set.windows.length) / seconds,
        },
      ];
    });
  });
}

/**
 * The player's biggest gaps to the reference median, each with a rough DPS cost, biggest first.
 * Every estimate values the gap at the player's own damage (casts, DoT damage), so gear
 * differences don't inflate it; they're still estimates, and overlapping causes can double count.
 */
export function biggestMistakes(
  profile: Profile,
  player: LogSnapshot,
  topLogs: LogSnapshot[],
  /** The spec's measured buff effects (benchmark job), for cooldown line-up estimates. */
  effects: BuffEffects | null = null,
): Mistake[] {
  if (topLogs.length === 0 || player.durationMs <= 0) {
    return [];
  }
  return [
    ...windowMistakes(player, topLogs),
    ...entryMistakes(profile, player, topLogs),
    ...poolingMistakes(player, topLogs),
    ...buffOverlapMistakes(profile, player, topLogs, effects),
  ]
    .filter((m) => Number.isFinite(m.dps) && m.dps >= player.fightDps * MIN_SHARE)
    .sort((a, b) => b.dps - a.dps)
    .slice(0, MAX_MISTAKES);
}
