import { HeroTree } from '../profile/types';

/**
 * How the player's talents compare with what ranked players take: pick rates in a group of
 * ranked parses (the rankings pages around the reference band, hundreds of parses) and in the
 * top 100, for the talents where the player's choice is unusual. Makes no claim about what a
 * talent is worth: choice is confounded with skill and gear.
 */

/** Talents at least this share of the group takes are flagged when the player skipped them. */
export const COMMON_PICK = 0.6;
/** Talents at most this share of the group takes are flagged when the player took them. */
export const RARE_PICK = 0.25;
/** Two talents taken together by at most this share of the group are treated as a choice. */
const EXCLUSIVE_TOGETHER = 0.02;
/** Below this many parses on the player's hero tree, the whole group is used. */
const MIN_HERO_GROUP = 20;
/** An inferred hero tree: at least this many talents taken by the same parses. */
const MIN_HERO_TALENTS = 6;
/** Talents in one inferred hero tree are taken by near enough the same parses (Jaccard). */
const SAME_PARSES = 0.9;
/** Inferred hero trees share at most this share of the smaller one's parses. */
const HERO_OVERLAP = 0.05;

export interface TalentPick {
  entryId: number;
  /** Share of the group that takes it. */
  pickRate: number;
  /** Share of the top 100; undefined when not published. */
  topPickRate?: number;
}

export interface TookTalent extends TalentPick {
  /** The common talent the group takes instead, when the two look like one choice node. */
  instead?: TalentPick;
}

export interface TalentComparison {
  groupSize: number;
  topSize: number;
  /** Whether the group was narrowed to parses on the player's hero tree. */
  sameHeroTree: boolean;
  /** The player's hero tree, when the spec's trees are named. */
  heroTree?: string;
  /** Hero trees across the group, most common first; empty when the spec's are unknown. */
  heroTrees: { name: string; share: number }[];
  /** Common talents the player didn't take, most common first. */
  skipped: TalentPick[];
  /** Rare talents the player took, rarest first. */
  took: TookTalent[];
}

/** `entryId:rank` to entry ID: a talent counts as taken at any rank. */
const entryOf = (talent: string) => Number(talent.split(':')[0]);
const entriesOf = (talents: string[]) => new Set(talents.map(entryOf));

const heroTreeOf = (entries: Set<number>, heroTrees: HeroTree[]) =>
  heroTrees.find((tree) => entries.has(tree.keystoneEntryId))?.name;

/**
 * Hero trees inferred from the builds, for specs without hand-written keystones (the talent data
 * doesn't mark hero talents): groups of talents taken by the same parses, where the groups are
 * never taken together. Returns each tree's talents; empty when no such split shows.
 */
function inferHeroTrees(builds: Set<number>[]): Set<number>[] {
  const takers = new Map<number, Set<number>>();
  builds.forEach((build, i) =>
    build.forEach((id) => {
      const set = takers.get(id) ?? new Set<number>();
      set.add(i);
      takers.set(id, set);
    }),
  );
  const jaccard = (a: Set<number>, b: Set<number>) => {
    const shared = [...a].filter((i) => b.has(i)).length;
    return shared / (a.size + b.size - shared);
  };
  // Only split talents: one every parse takes says nothing about hero trees.
  const split = [...takers]
    .filter(([, set]) => set.size >= builds.length * 0.05 && set.size <= builds.length * 0.95)
    .sort((a, b) => b[1].size - a[1].size);
  const clusters: { seed: Set<number>; talents: Set<number> }[] = [];
  for (const [id, set] of split) {
    const cluster = clusters.find((c) => jaccard(c.seed, set) >= SAME_PARSES);
    if (cluster) {
      cluster.talents.add(id);
    } else {
      clusters.push({ seed: set, talents: new Set([id]) });
    }
  }
  const trees = clusters
    .filter((c) => c.talents.size >= MIN_HERO_TALENTS)
    .map((c) => ({ talents: c.talents, parses: onTree(builds, c.talents) }));
  // Hero trees exclude each other: their parses barely overlap.
  const exclusive = trees.filter((tree) =>
    trees.some(
      (other) =>
        other !== tree &&
        [...tree.parses].filter((i) => other.parses.has(i)).length <=
          HERO_OVERLAP * Math.min(tree.parses.size, other.parses.size),
    ),
  );
  return exclusive.length >= 2 ? exclusive.map((tree) => tree.talents) : [];
}

/** Whether a build is on an inferred tree: it has at least half the tree's talents. */
const isOnTree = (build: Set<number>, tree: Set<number>) =>
  [...tree].filter((id) => build.has(id)).length * 2 >= tree.size;

const onTree = (builds: Set<number>[], tree: Set<number>) =>
  new Set(builds.flatMap((build, i) => (isOnTree(build, tree) ? [i] : [])));

function pickRates(builds: Set<number>[]): Map<number, number> {
  const counts = new Map<number, number>();
  builds.forEach((build) => build.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1)));
  return new Map([...counts].map(([id, count]) => [id, count / builds.length]));
}

export function compareTalents(
  /** Talents of each parse in the group (`entryId:rank`, as on ranked parses). */
  groupTalents: string[][],
  topTalents: string[][],
  playerTalents: string[],
  heroTrees: HeroTree[] = [],
  /**
   * Entries to compare. Rankings list some the parsed log never does (e.g. Feral's 123296 on
   * every ranked parse, missing from the talent tables), which would otherwise top the list.
   */
  isKnown: (entryId: number) => boolean = () => true,
): TalentComparison | null {
  const known = (talents: string[]) =>
    new Set([...entriesOf(talents)].filter((entryId) => isKnown(entryId)));
  const player = known(playerTalents);
  let group = groupTalents.map(known).filter((build) => build.size > 0);
  let top = topTalents.map(known).filter((build) => build.size > 0);
  if (group.length === 0 || player.size === 0) {
    return null;
  }

  const treeCounts = new Map<string, number>();
  group.forEach((build) => {
    const tree = heroTreeOf(build, heroTrees);
    if (tree) {
      treeCounts.set(tree, (treeCounts.get(tree) ?? 0) + 1);
    }
  });
  const heroTreeMix = [...treeCounts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, share: count / group.length }));

  // Hero-tree talents would otherwise dominate the list for a player on the less common tree.
  // Named trees come from the profile's keystones; otherwise they're inferred, unnamed.
  const inferred = heroTrees.length > 0 ? [] : inferHeroTrees(group);
  const treeOf = (build: Set<number>): string | undefined => {
    if (heroTrees.length > 0) {
      return heroTreeOf(build, heroTrees);
    }
    const i = inferred.findIndex((tree) => isOnTree(build, tree));
    return i === -1 ? undefined : `inferred-${i}`;
  };
  const playerTree = treeOf(player);
  const sameTree = (build: Set<number>) => treeOf(build) === playerTree;
  const narrowed = playerTree !== undefined && group.filter(sameTree).length >= MIN_HERO_GROUP;
  if (narrowed) {
    group = group.filter(sameTree);
    top = top.filter(sameTree);
  }

  const rates = pickRates(group);
  const topRates = top.length > 0 ? pickRates(top) : null;
  const pick = (entryId: number): TalentPick => ({
    entryId,
    pickRate: rates.get(entryId) ?? 0,
    topPickRate: topRates ? (topRates.get(entryId) ?? 0) : undefined,
  });

  const skipped = [...rates.keys()]
    .filter((id) => !player.has(id) && rates.get(id)! >= COMMON_PICK)
    .map(pick)
    .sort((a, b) => b.pickRate - a.pickRate);
  const together = (a: number, b: number) =>
    group.filter((build) => build.has(a) && build.has(b)).length / group.length;
  const used = new Set<number>();
  const took: TookTalent[] = [...player]
    .filter((id) => (rates.get(id) ?? 0) <= RARE_PICK)
    .map(pick)
    .sort((a, b) => a.pickRate - b.pickRate)
    .map((talent) => {
      // The common talent almost never taken alongside this one: likely the other side of its
      // choice node, since the talent data has no node IDs.
      const instead = skipped.find(
        (other) =>
          !used.has(other.entryId) &&
          together(talent.entryId, other.entryId) <= EXCLUSIVE_TOGETHER &&
          talent.pickRate + other.pickRate >= 0.9,
      );
      if (instead) {
        used.add(instead.entryId);
      }
      return { ...talent, instead };
    });

  return {
    groupSize: group.length,
    topSize: top.length,
    sameHeroTree: narrowed,
    heroTree: heroTrees.length > 0 ? playerTree : undefined,
    heroTrees: heroTreeMix,
    // A skipped talent paired with one the player took is shown on that row instead.
    skipped: skipped.filter((talent) => !used.has(talent.entryId)),
    took,
  };
}
