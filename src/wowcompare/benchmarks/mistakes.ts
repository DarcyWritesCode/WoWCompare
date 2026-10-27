import { formatDuration, formatNumber } from 'common/format';

import type { DamageWindowAnalysis } from '../damageWindows';
import { CooldownWindowSet, entryResult, LogSnapshot, WindowEntryState } from '../metrics/results';
import { Profile, ProfileEntry, SpellRef } from '../profile/types';
import { missingRaidBuffs } from './raidBuffs';
import type { TalentComparison } from './talents';
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
  /** A gap play can't close (gear, raid buffs), listed so the gaps add up. */
  notPlay?: boolean;
  /** What the gap breaks down into, largest cause first; drawn as segments of its bar. */
  parts?: { label: string; dps: number }[];
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
 * purpose: a proc or passive buff being up reflects how the window went, not a choice. A pair of
 * cooldowns has one effect (see buffEffects.ts), so each pair is reported once, from the side
 * where the gap costs most.
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
  const mistakes = player.windows.flatMap((set) => {
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
  const byPair = new Map<string, Mistake>();
  for (const m of mistakes) {
    const pair = m.key.split('-').slice(1).sort().join('-');
    if (m.dps > (byPair.get(pair)?.dps ?? -Infinity)) {
      byPair.set(pair, m);
    }
  }
  return [...byPair.values()];
}

/**
 * The player's biggest gaps to the reference median, each with a rough DPS cost, biggest first.
 * Every estimate values the gap at the player's own damage (casts, DoT damage), so gear
 * differences don't inflate it; they're still estimates, and overlapping causes can double count.
 */
/**
 * The spec's cooldowns: "Use X on cooldown" and the window checks already value their missed and
 * mistimed casts, so the cast-rate and per-cast checks leave them out rather than count them twice.
 */
const isCooldown = (profile: Profile, ability: { token: string; spellIds: number[] }) =>
  profile.entries.some(
    (entry) =>
      entry.kind === 'cooldown' &&
      (entry.token === ability.token || entry.spellIds.some((id) => ability.spellIds.includes(id))),
  );

/**
 * Casts of damaging abilities other than the spec's cooldowns per minute alive, and the damage
 * each brings (procs included, since they follow casts; the cooldowns' own damage left out).
 */
function fillerCasts(profile: Profile, log: LogSnapshot) {
  const fillers = log.abilities.filter(
    (a) => a.damage > 0 && a.casts > 0 && !isCooldown(profile, a),
  );
  const casts = fillers.reduce((sum, a) => sum + a.casts, 0);
  const cooldownDamage = log.abilities
    .filter((a) => isCooldown(profile, a))
    .reduce((sum, a) => sum + a.damage, 0);
  const totalDamage = log.fightDps * (log.durationMs / 1000);
  const aliveMs = log.aliveMs ?? log.durationMs;
  return aliveMs > 0 && casts > 0
    ? {
        perMinute: casts / (aliveMs / 60_000),
        perCast: (totalDamage - cooldownDamage) / casts,
        aliveMs,
      }
    : null;
}

/**
 * Casting less often than the top logs: downtime, movement, or casts lost to mechanics. Counts
 * casts other than the spec's cooldowns, over the time the player was alive (a death isn't slow
 * casting), and values the missing casts at the player's own damage per cast.
 */
function castRateMistakes(
  profile: Profile,
  player: LogSnapshot,
  topLogs: LogSnapshot[],
): Mistake[] {
  const mine = fillerCasts(profile, player);
  const rates = topLogs
    .map((log) => fillerCasts(profile, log)?.perMinute)
    .filter((v): v is number => v !== undefined);
  const top = median(rates);
  if (!mine || top === null || mine.perMinute >= top || player.durationMs <= 0) {
    return [];
  }
  const missing = (top - mine.perMinute) * (mine.aliveMs / 60_000);
  const mostCast = [...player.abilities]
    .filter((a) => a.damage > 0 && !isCooldown(profile, a))
    .sort((a, b) => b.casts - a.casts)[0];
  return [
    {
      key: 'cast-rate',
      spellId: mostCast?.spellIds[0] ?? 0,
      title: 'Cast more often',
      detail: `${mine.perMinute.toFixed(1)} casts a minute while alive besides your cooldowns, against ${top.toFixed(1)} (top logs range ${Math.min(...rates).toFixed(1)}–${Math.max(...rates).toFixed(1)}): downtime, movement or casts lost to mechanics`,
      dps: (missing * mine.perCast) / (player.durationMs / 1000),
    },
  ];
}

/** Abilities below this share of the top logs' damage aren't judged per cast. */
const MIN_PER_CAST_SHARE = 0.02;
/** Top logs that must use an ability for it to be judged per cast. */
const MIN_PER_CAST_LOGS = 5;
const lowerQuartile = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 4)];
/** Flagged at or under this share of the player's usual per-cast ratio to the top logs. */
const WEAK_RELATIVE = 0.85;

/**
 * Abilities that hit unusually soft for this player: damage per cast against the top logs,
 * divided by the median of that ratio over the player's abilities, so gear and raid buffs (which
 * lift every ability alike) cancel out. Procs, which have no casts, are taken per damaging cast.
 * Catches cut-short channels, casts without their empowering buff, and procs not set up, without
 * per-spec rules; it can't say which. Only deficits below the top logs' lower quartile are listed,
 * since cleave and target count can push single abilities either way. The spec's cooldowns count
 * toward the baseline but aren't flagged: their timing is valued by the window checks.
 */
function perCastRows(profile: Profile, player: LogSnapshot, topLogs: LogSnapshot[]) {
  const damagingCasts = (log: LogSnapshot) =>
    log.abilities.filter((a) => a.damage > 0 && a.casts > 0).reduce((sum, a) => sum + a.casts, 0);
  const perCastOf = (log: LogSnapshot, ability: { token: string; spellIds: number[] }) => {
    const total = abilityFor(log, ability);
    if (!total || total.damage <= 0) {
      return null;
    }
    const casts = total.casts > 0 ? total.casts : damagingCasts(log);
    return casts > 0 ? total.damage / casts : null;
  };

  const rows = player.abilities.flatMap((ability) => {
    const mine = perCastOf(player, ability);
    const top = topLogs
      .map((log) => perCastOf(log, ability))
      .filter((v): v is number => v !== null);
    const topShare =
      median(
        topLogs.map(
          (log) =>
            (abilityFor(log, ability)?.damage ?? 0) /
            Math.max(1, log.fightDps * (log.durationMs / 1000)),
        ),
      ) ?? 0;
    const topMedian = median(top);
    if (
      mine === null ||
      topMedian === null ||
      top.length < MIN_PER_CAST_LOGS ||
      topShare < MIN_PER_CAST_SHARE
    ) {
      return [];
    }
    return [{ ability, mine, top, ratio: mine / topMedian }];
  });
  const baseline = rows.length >= 3 ? median(rows.map((r) => r.ratio)) : null;
  return { rows, baseline };
}

function perCastMistakes(profile: Profile, player: LogSnapshot, topLogs: LogSnapshot[]): Mistake[] {
  const { rows, baseline } = perCastRows(profile, player, topLogs);
  if (baseline === null) {
    return [];
  }
  const seconds = player.durationMs / 1000;
  return rows
    .filter(
      ({ ability, mine, top, ratio }) =>
        !isCooldown(profile, ability) &&
        ratio / baseline <= WEAK_RELATIVE &&
        mine / baseline < lowerQuartile(top),
    )
    .map(({ ability, ratio }): Mistake => {
      const relative = ratio / baseline;
      const proc = ability.casts === 0;
      return {
        key: `per-cast:${ability.token}`,
        spellId: ability.spellIds[0] ?? 0,
        title: `${ability.name} ${proc ? 'procs' : 'casts'} hit weak`,
        detail: `${pct(1 - relative)} less per ${proc ? 'damaging cast' : 'cast'} than the top logs, after taking out the gap your other spells share (gear, buffs): ${proc ? 'the proc may not be set up' : 'channels cut short, casts without their empowering buff, or reduced-damage targets'}`,
        dps: (ability.damage / seconds) * (1 / relative - 1),
      };
    });
}

/** Per-cast baselines this close to the top logs' aren't worth a line. */
const BASELINE_TOLERANCE = 0.97;

/** A hero tree taken by at least this share of ranked players is "what most play". */
const MAJORITY_HERO_TREE = 0.6;

/**
 * What lifts or lowers every spell alike: the per-cast baseline from `perCastRows`, split into
 * gear (primary stat at the pull, which counts weapons at their real weight, unlike item level;
 * DPS follows it roughly 1:1), raid buffs the player's raid lacked (raidBuffs.ts), and the rest.
 * Secondary stats and talents stay in the rest: their worth depends on the spec, the other stats
 * and the fight, which sims (Raidbots, Bloodmallet) measure and logs can't.
 */
function baselineGaps(
  profile: Profile,
  player: LogSnapshot,
  topLogs: LogSnapshot[],
  talents: TalentComparison | null,
): Mistake[] {
  const { baseline } = perCastRows(profile, player, topLogs);
  if (baseline === null || baseline >= BASELINE_TOLERANCE) {
    return [];
  }
  const total = player.fightDps * (1 / baseline - 1);

  // Raid buffs, against the top logs' raids (taken as fully buffed where unrecorded).
  const factor = (log: LogSnapshot) =>
    log.raid ? missingRaidBuffs(log.raid).reduce((f, buff) => f * (1 + buff.value), 1) : 1;
  const missing = player.raid ? missingRaidBuffs(player.raid) : [];
  let comp = player.fightDps * Math.max(0, factor(player) / (median(topLogs.map(factor)) ?? 1) - 1);

  // Gear: primary stat at the pull against the top logs'.
  const topPrimary = median(
    topLogs.flatMap((log) => (log.pullStats ? [log.pullStats.primary] : [])),
  );
  const primaryGap =
    topPrimary !== null && player.pullStats && player.pullStats.primary > 0
      ? Math.max(0, topPrimary / player.pullStats.primary - 1)
      : null;
  let gear = primaryGap !== null ? player.fightDps * primaryGap : 0;

  // The baseline is what was measured; the parts can't explain more than it.
  if (comp + gear > total) {
    const scale = total / (comp + gear);
    comp *= scale;
    gear *= scale;
  }
  const rest = total - comp - gear;

  // Talents aren't valued (a residual can't tell them from secondary stats or fight style;
  // that needs sims), but a hero tree most ranked players don't take is named in the rest.
  const topTree = talents?.heroTrees[0];
  const otherTree =
    talents?.heroTree &&
    topTree &&
    topTree.name !== talents.heroTree &&
    topTree.share >= MAJORITY_HERO_TREE
      ? `you play ${talents.heroTree}; ${pct(topTree.share)} of ranked players play ${topTree.name}`
      : null;

  const stat = player.raid?.primaryStat ?? 'primary stat';
  const parts = [
    ...(primaryGap !== null
      ? [
          {
            label: `Gear: ${pct(primaryGap)} less ${stat} than the top logs`,
            dps: gear,
          },
        ]
      : []),
    ...(missing.length > 0
      ? [
          {
            label: `Raid buffs your raid lacked: ${missing.map((b) => b.name).join(', ')}`,
            dps: comp,
          },
        ]
      : []),
    {
      label: `${primaryGap !== null ? 'Talents, secondary stats and the rest' : 'Gear, talents and stats'}${otherTree ? ` (${otherTree})` : ''}`,
      dps: rest,
    },
  ].filter((part) => part.dps > 0);
  const notPlay = parts.reduce((sum, part) => sum + part.dps, 0);
  return [
    ...(notPlay > 0
      ? [
          {
            key: 'baseline',
            spellId: 0,
            title: 'Gear, raid buffs, talents and stats',
            detail: `Every spell hits ${pct(1 - baseline)} softer per cast than in the top logs. Sim your character on Raidbots to see how much is talents and how much secondary stats`,
            dps: notPlay,
            notPlay: true,
            parts,
          },
        ]
      : []),
  ];
}

/** Dead time beyond this isn't worth a line. */
const MIN_DEAD_MS = 5_000;

/** Time spent dead, beyond the top logs', valued at the player's own DPS while alive. */
function deathGaps(player: LogSnapshot, topLogs: LogSnapshot[]): Mistake[] {
  const dead = (log: LogSnapshot) => log.durationMs - (log.aliveMs ?? log.durationMs);
  const extra = dead(player) - (median(topLogs.map(dead)) ?? 0);
  const aliveMs = player.aliveMs ?? player.durationMs;
  if (extra < MIN_DEAD_MS || aliveMs <= 0) {
    return [];
  }
  const aliveDps = (player.fightDps * player.durationMs) / aliveMs;
  return [
    {
      key: 'death',
      spellId: 0,
      title: 'Stay alive',
      detail: `Dead for ${formatDuration(dead(player))} of ${formatDuration(player.durationMs)}, valued at your DPS while alive`,
      dps: (aliveDps * extra) / player.durationMs,
    },
  ];
}

/**
 * Damage aimed away from a target taking amplified damage (encounters/damageWindows.ts), which
 * would have done `multiplier` times as much on it; late swaps land here too. Cleave that also
 * reached other targets isn't counted.
 */
function damageWindowGaps(player: LogSnapshot, windows: DamageWindowAnalysis | null): Mistake[] {
  const amps = (windows?.amps ?? []).filter((amp) => amp.aimedElsewhere > 0);
  const lost = amps.reduce((sum, amp) => sum + amp.aimedElsewhere * (amp.def.multiplier - 1), 0);
  if (amps.length === 0 || player.durationMs <= 0) {
    return [];
  }
  const parts = amps.map(
    (amp) =>
      `${formatDuration(amp.startMs)} ${amp.targetName}: ${formatNumber(amp.aimedElsewhere)} aimed elsewhere${amp.firstCastMs !== null && amp.firstCastMs > 3000 ? `, first cast ${(amp.firstCastMs / 1000).toFixed(1)} s in` : ''}`,
  );
  return [
    {
      key: 'damage-windows',
      spellId: amps[0].def.auraId,
      title: 'Hit the amplified target',
      detail: parts.join('; '),
      dps: lost / (player.durationMs / 1000),
    },
  ];
}

export function biggestMistakes(
  profile: Profile,
  player: LogSnapshot,
  topLogs: LogSnapshot[],
  /** The spec's measured buff effects (benchmark job), for cooldown line-up estimates. */
  effects: BuffEffects | null = null,
  /** How the player used the boss's damage windows, when it has any. */
  windows: DamageWindowAnalysis | null = null,
  /** The player's talents against ranked players', when loaded. */
  talents: TalentComparison | null = null,
): Mistake[] {
  if (topLogs.length === 0 || player.durationMs <= 0) {
    return [];
  }
  return [
    ...deathGaps(player, topLogs),
    ...damageWindowGaps(player, windows),
    ...baselineGaps(profile, player, topLogs, talents),
    ...castRateMistakes(profile, player, topLogs),
    ...perCastMistakes(profile, player, topLogs),
    ...windowMistakes(player, topLogs),
    ...entryMistakes(profile, player, topLogs),
    ...poolingMistakes(player, topLogs),
    ...buffOverlapMistakes(profile, player, topLogs, effects),
  ]
    .filter((m) => Number.isFinite(m.dps) && m.dps >= player.fightDps * MIN_SHARE)
    .sort((a, b) => b.dps - a.dps)
    .slice(0, MAX_MISTAKES);
}
