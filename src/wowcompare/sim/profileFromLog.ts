import { IGNORED } from 'common/TALENTS/IGNORED';
import SPECS from 'game/SPECS';
import type { CombatantInfoEvent } from 'parser/core/Events';
import type { Item } from 'parser/core/EventsItems';

import type { TalentTree } from '../benchmarks/talents';

/**
 * WoWCompare: a SimulationCraft profile for the player as the log saw them (talents, gear with its
 * bonus IDs, gems and enchants), plus profilesets for the variants Live Compare sims. Gear stats
 * come from SimC's item data, not from the log's pull stats: those are a character-sheet snapshot
 * at the pull, potions and procs included. Consumables, race and the APL are SimC's defaults on
 * every variant, so they cancel out of the differences, which are all this is used for.
 */

/** The player's character from the log, as plain data. */
export interface SimCharacter {
  /** SimC's class and spec tokens, e.g. `deathknight`, `beast_mastery`. */
  classToken: string;
  specToken: string;
  /** `entryId:rank`, as on ranked parses. */
  talents: string[];
  gear: SimItem[];
  /** Fight length to sim, seconds. */
  fightSeconds: number;
  /** Targets over the fight, from the log (`fightModel`). */
  fight: FightModel;
}

/** How many targets the fight had, and when: SimC's desired_targets plus add waves. */
export interface FightModel {
  /** Targets up most of the fight (council fights: 2 or more). */
  baseTargets: number;
  /** Stretches with more targets than that: start and length in seconds, extra targets. */
  adds: { start: number; duration: number; count: number }[];
  /**
   * Damage amp windows on the boss (encounters/damageWindows.ts): start and length in seconds,
   * damage taken multiplier. Added once the page has fetched them.
   */
  vulnerable?: { start: number; duration: number; multiplier: number }[];
}

/** Iterations with real allies: about ±0.5% of an Augmentation's contribution. */
const ALLY_ITERATIONS = 1000;
/** Buckets the fight is read in, ms. */
const FIGHT_BUCKET_MS = 5_000;
/** An enemy counts as a target in a bucket when it took this share of the player's damage. */
const TARGET_SHARE = 0.15;
/** Add stretches shorter than this are left out. */
const MIN_ADDS_SECONDS = 10;
/** SimC handles a few targets fine; past this the count adds little. */
const MAX_TARGETS = 5;

/**
 * The fight's targets from the player's own damage: per 5 s, how many enemies took at least 15% of
 * it. The usual count is the base (a council keeps 2 up), and longer stretches above it are add
 * waves. Damage going to several enemies at once is what makes cleave talents worth taking, so this
 * is what decides whether a sim treats the fight as Patchwerk.
 */
export function fightModel(
  hits: { timestamp: number; amount: number; targetID: number }[],
  fightStart: number,
  fightEnd: number,
): FightModel {
  const buckets = Math.max(1, Math.ceil((fightEnd - fightStart) / FIGHT_BUCKET_MS));
  const byBucket = Array.from({ length: buckets }, () => new Map<number, number>());
  for (const hit of hits) {
    const i = Math.floor((hit.timestamp - fightStart) / FIGHT_BUCKET_MS);
    if (i >= 0 && i < buckets) {
      byBucket[i].set(hit.targetID, (byBucket[i].get(hit.targetID) ?? 0) + hit.amount);
    }
  }
  const counts = byBucket.map((targets) => {
    const total = [...targets.values()].reduce((sum, v) => sum + v, 0);
    return total > 0
      ? Math.min(MAX_TARGETS, [...targets.values()].filter((v) => v / total >= TARGET_SHARE).length)
      : 0;
  });
  const active = counts.filter((c) => c > 0);
  const tally = new Map<number, number>();
  active.forEach((c) => tally.set(c, (tally.get(c) ?? 0) + 1));
  const baseTargets = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1;

  const adds: FightModel['adds'] = [];
  let from: number | null = null;
  let peak = 0;
  counts.forEach((count, i) => {
    if (count > baseTargets) {
      from ??= i;
      peak = Math.max(peak, count);
    }
    if ((count <= baseTargets || i === counts.length - 1) && from !== null) {
      const end = count > baseTargets ? i + 1 : i;
      const duration = ((end - from) * FIGHT_BUCKET_MS) / 1000;
      if (duration >= MIN_ADDS_SECONDS) {
        adds.push({ start: (from * FIGHT_BUCKET_MS) / 1000, duration, count: peak - baseTargets });
      }
      from = null;
      peak = 0;
    }
  });
  return { baseTargets, adds };
}

/**
 * SimC lines for the fight: SimC's default (Patchwerk) plus base targets, one-off add waves and
 * damage amp windows. No `fight_style=` line: setting a fight style replaces the raid events with its
 * own, Patchwerk's being none. SimC wants the first raid event as `raid_events=` and each further one
 * as `+=`, and an event whose cooldown reaches past the fight (rather than `last=`) to happen once.
 */
function fightLines(fight: FightModel, fightSeconds: number): string[] {
  const once = Math.ceil(fightSeconds) + 60;
  const events = [
    ...fight.adds.map(
      (wave, i) =>
        `/adds,name=wave${i + 1},count=${wave.count},first=${wave.start},duration=${wave.duration},cooldown=${once}`,
    ),
    // SimC's multiplier is extra damage taken: 1 doubles it.
    ...(fight.vulnerable ?? []).map(
      (window) =>
        `/vulnerable,first=${Math.round(window.start)},duration=${Math.round(window.duration)},cooldown=${once},multiplier=${window.multiplier - 1}`,
    ),
  ];
  return [
    `desired_targets=${fight.baseTargets}`,
    ...events.map((event, i) => `raid_events${i === 0 ? '' : '+'}=${event}`),
  ];
}

export interface SimItem {
  /** SimC's slot name, e.g. `main_hand`. */
  slot: string;
  id: number;
  itemLevel: number;
  bonusIds: number[];
  gemIds: number[];
  enchantId?: number;
}

/** Combatantinfo gear order to SimC slot names; shirt and tabard don't matter to a sim. */
export const SIMC_SLOTS = [
  'head',
  'neck',
  'shoulder',
  null,
  'chest',
  'waist',
  'legs',
  'feet',
  'wrist',
  'hands',
  'finger1',
  'finger2',
  'trinket1',
  'trinket2',
  'back',
  'main_hand',
  'off_hand',
  null,
] as const;

/** A combatantinfo gear list (in its slot order) as SimC items. */
export function simGear(items: (Item | undefined)[]): SimItem[] {
  return SIMC_SLOTS.flatMap((slot, index) => {
    const item = items[index];
    if (!slot || !item?.id) {
      return [];
    }
    return [
      {
        slot,
        id: item.id,
        itemLevel: item.itemLevel,
        bonusIds: item.bonusIDs === undefined ? [] : [item.bonusIDs].flat(),
        gemIds: (item.gems ?? []).map((gem) => gem.id),
        enchantId: item.permanentEnchant || undefined,
      },
    ];
  });
}

/** Another player in the sim, from their combatantinfo: an ally for Augmentation to buff. */
export interface SimAlly {
  name: string;
  specId: number;
  classToken: string;
  specToken: string;
  talents: string[];
  gear: SimItem[];
}

/** An ally from the log's combatantinfo; null when the spec isn't known. */
export function allyFromCombatantInfo(info: CombatantInfoEvent, name: string): SimAlly | null {
  const spec = SPECS[info.specID];
  if (!spec?.wclClassName || !spec.wclSpecName) {
    return null;
  }
  return {
    name,
    specId: spec.id,
    classToken: simcClassToken(spec.wclClassName),
    specToken: simcSpecToken(spec.wclSpecName),
    talents: (info.talentTree ?? [])
      .filter((t) => !IGNORED.includes(t.id))
      .map((t) => `${t.id}:${t.rank}`),
    gear: simGear(info.gear ?? []),
  };
}

/** SimC's spec token: `BeastMastery` to `beast_mastery`. */
export const simcSpecToken = (name: string) => name.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
/** SimC's class token, which runs words together: `DeathKnight` to `deathknight`. */
export const simcClassToken = (name: string) => name.toLowerCase();

type TreeName = 'class' | 'spec' | 'hero';

/** A build's talents per tree, as `entryId:rank`; the hero sub-tree choice is left out (SimC infers it). */
export function talentsByTree(talents: string[], tree: TalentTree): Record<TreeName, string[]> {
  const entries = (nodes: TalentTree['class']) =>
    new Set(nodes.flatMap((node) => node.entries.map((entry) => entry.id)));
  const sets = {
    class: entries(tree.class),
    spec: entries(tree.spec),
    hero: entries(tree.hero.flatMap((hero) => hero.nodes)),
  };
  const out: Record<TreeName, string[]> = { class: [], spec: [], hero: [] };
  for (const talent of talents) {
    const id = Number(talent.split(':')[0]);
    const name = (Object.keys(sets) as TreeName[]).find((n) => sets[n].has(id));
    if (name) {
      out[name].push(talent);
    }
  }
  (Object.keys(out) as TreeName[]).forEach((name) => out[name].sort());
  return out;
}

const talentLines = (byTree: Record<TreeName, string[]>) =>
  (Object.keys(byTree) as TreeName[]).map((name) => `${name}_talents=${byTree[name].join('/')}`);

const itemLine = (item: SimItem, ilevel = item.itemLevel) =>
  [
    `${item.slot}=`,
    `id=${item.id}`,
    item.bonusIds.length > 0 && `bonus_id=${item.bonusIds.join('/')}`,
    item.gemIds.length > 0 && `gem_id=${item.gemIds.join('/')}`,
    item.enchantId && `enchant_id=${item.enchantId}`,
    ilevel !== item.itemLevel && `ilevel=${ilevel}`,
  ]
    .filter(Boolean)
    .join(',');

export interface SimVariant {
  name: string;
  /** Talent trees to replace, as `entryId:rank` lists. */
  trees?: Partial<Record<TreeName, string[]>>;
  /** Item level to add to every item. */
  ilevelDelta?: number;
  /** Extra SimC option lines, e.g. `override.chaos_brand=0`. */
  overrides?: string[];
  /**
   * Changes the other players too (raid buffs). Scored by raid DPS, it gets an idle twin
   * (`<name>_idle`), so only the player's part of the change is counted.
   */
  affectsRaid?: boolean;
}

/** Profileset names may only hold simple characters. */
const setName = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_');

/** Actor names may only hold simple characters, and must differ from the player's. */
const actorName = (name: string, i: number) => `Ally${i + 1}_${name.replace(/[^a-zA-Z0-9]/g, '')}`;

const actorLines = (
  actor: Pick<SimCharacter, 'classToken' | 'specToken' | 'talents' | 'gear'>,
  name: string,
  tree: TalentTree,
) => [
  `${actor.classToken}="${name}"`,
  `spec=${actor.specToken}`,
  'level=90',
  ...talentLines(talentsByTree(actor.talents, tree)),
  ...actor.gear.map((item) => itemLine(item)),
];

/** The profileset that measures Augmentation's whole contribution: the player casting nothing. */
export const IDLE_SET = 'idle';
const IDLE_ACTIONS = ['actions=wait,sec=10000', 'actions.precombat=wait,sec=0'];
export const idleTwin = (name: string) => `${name}_idle`;

export interface SimInputOptions {
  threads: number;
  targetError: number;
  /**
   * Score by the whole raid's DPS, for Augmentation: Warcraft Logs credits it with the damage its
   * buffs add to others. With no allies, SimC adds its own generic raid around a lone Augmentation.
   */
  raidMetric?: boolean;
  /** Real players from the log to sim alongside, with their talent trees. */
  allies?: { ally: SimAlly; tree: TalentTree }[];
}

/**
 * The full SimC input: the player, then one profileset per variant (each only overrides what it
 * changes, so SimC reuses everything else). Profileset lines apply to the first actor, so the
 * player comes before any allies. Scored by raid DPS, an extra profileset with the player idle
 * gives the raid without them, so the difference is their whole contribution.
 */
export function simcInput(
  character: SimCharacter,
  tree: TalentTree,
  variants: SimVariant[],
  { threads, targetError, raidMetric = false, allies = [] }: SimInputOptions,
): string {
  const lines = [
    ...actorLines(character, 'Player', tree),
    ...allies.flatMap(({ ally, tree: allyTree }, i) =>
      actorLines(ally, actorName(ally.name, i), allyTree),
    ),
    `max_time=${Math.round(character.fightSeconds)}`,
    'vary_combat_length=0',
    ...fightLines(character.fight, character.fightSeconds),
    // target_error follows the player's own DPS; with real allies every iteration costs several
    // characters, so a fixed count keeps the sim to minutes.
    ...(allies.length > 0
      ? ['target_error=0', `iterations=${ALLY_ITERATIONS}`]
      : [`target_error=${targetError}`, 'iterations=20000']),
    `threads=${threads}`,
    ...(raidMetric ? ['profileset_metric=raid_dps'] : []),
  ];
  const sets: SimVariant[] = raidMetric
    ? [
        ...variants,
        { name: IDLE_SET, overrides: IDLE_ACTIONS },
        ...variants
          .filter((variant) => variant.affectsRaid)
          .map((variant) => ({
            name: idleTwin(variant.name),
            overrides: [...(variant.overrides ?? []), ...IDLE_ACTIONS],
          })),
      ]
    : variants;
  for (const variant of sets) {
    const name = setName(variant.name);
    const overrides = [
      ...Object.entries(variant.trees ?? {}).map(
        ([treeName, talents]) => `${treeName}_talents=${talents.join('/')}`,
      ),
      ...(variant.ilevelDelta
        ? character.gear.map((item) => itemLine(item, item.itemLevel + variant.ilevelDelta!))
        : []),
      ...(variant.overrides ?? []),
    ];
    overrides.forEach((line) => lines.push(`profileset."${name}"+=${line}`));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The most popular exact allocation of each tree among ranked builds: an allocation someone
 * actually plays, so it's always valid. For the hero tree that's the most common allocation of
 * either hero tree, which sits on the more popular one.
 */
export function popularTrees(
  builds: string[][],
  tree: TalentTree,
): Record<TreeName, string[]> | null {
  if (builds.length === 0) {
    return null;
  }
  const out = {} as Record<TreeName, string[]>;
  for (const name of ['class', 'spec', 'hero'] as TreeName[]) {
    const counts = new Map<string, number>();
    for (const build of builds) {
      const key = talentsByTree(build, tree)[name].join('/');
      if (key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const [top] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [''];
    out[name] = top ? top.split('/') : [];
  }
  return out;
}
