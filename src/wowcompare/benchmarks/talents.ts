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
/** Below this many parses on the player's hero tree, the whole group is used. */
const MIN_HERO_GROUP = 20;

/** A spec's talent trees (src/wowcompare/talentTrees/, from scripts/wowcompare/). */
export interface TalentTree {
  specId: number;
  class: TreeNode[];
  spec: TreeNode[];
  /** `entryId` is the hero tree's entry in the sub-tree choice, which ranked parses list. */
  hero: { name: string; entryId: number; nodes: TreeNode[] }[];
}

export interface TreeNode {
  id: number;
  /** Grid position; neighbouring nodes are 2 apart. */
  x: number;
  y: number;
  next: number[];
  /** `single`, `choice` (one of two entries) or `tiered`. */
  type: string;
  /** Granted to everyone: not a choice, so never flagged. */
  free?: boolean;
  entries: TreeEntry[];
}

export interface TreeEntry {
  id: number;
  spellId: number;
  name: string;
  icon: string;
  maxRanks: number;
}

export interface TalentPick {
  entryId: number;
  /** Share of the group that takes it. */
  pickRate: number;
  /** Share of the top 100; undefined when not published. */
  topPickRate?: number;
  /** The most common number of points among those who take it; 0 when nobody does. */
  usualRank: number;
}

export interface TookTalent extends TalentPick {
  /** The other side of its choice node, when most of the group takes that instead. */
  instead?: TalentPick;
}

export interface TalentComparison {
  groupSize: number;
  topSize: number;
  /** Whether the group was narrowed to parses on the player's hero tree. */
  sameHeroTree: boolean;
  /** The player's hero tree. */
  heroTree?: string;
  /** Hero trees across the group, most common first. */
  heroTrees: { name: string; share: number }[];
  /** Common talents the player didn't take, most common first. */
  skipped: TalentPick[];
  /** Rare talents the player took, rarest first. */
  took: TookTalent[];
  /** Every talent's pick rates, by entry ID, for drawing the tree. */
  rates: Map<number, TalentPick>;
  /** Entries the player took. */
  player: Set<number>;
  /** Points the player put into each entry they took. */
  playerRanks: Map<number, number>;
}

/** `entryId:rank` to entry ID: a talent counts as taken at any rank. */
const entryOf = (talent: string) => Number(talent.split(':')[0]);

function pickRates(builds: Set<number>[]): Map<number, number> {
  const counts = new Map<number, number>();
  builds.forEach((build) => build.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1)));
  return new Map([...counts].map(([id, count]) => [id, count / builds.length]));
}

export const treeNodes = (tree: TalentTree) => [
  ...tree.class,
  ...tree.spec,
  ...tree.hero.flatMap((hero) => hero.nodes),
];

export function compareTalents(
  /** Talents of each parse in the group (`entryId:rank`, as on ranked parses). */
  groupTalents: string[][],
  topTalents: string[][],
  playerTalents: string[],
  tree: TalentTree,
): TalentComparison | null {
  const nodes = treeNodes(tree);
  const nodeOf = new Map(nodes.flatMap((node) => node.entries.map((e) => [e.id, node] as const)));
  const heroOf = new Map(
    tree.hero.flatMap((hero) =>
      hero.nodes.flatMap((node) => node.entries.map((e) => [e.id, hero])),
    ),
  );
  /** A build's hero tree: the sub-tree choice if listed (rankings), else its hero talents. */
  const heroTreeOf = (raw: Set<number>) => {
    const chosen = tree.hero.find((hero) => raw.has(hero.entryId));
    if (chosen) {
      return chosen.name;
    }
    const counts = new Map<string, number>();
    raw.forEach((id) => {
      const hero = heroOf.get(id);
      if (hero) {
        counts.set(hero.name, (counts.get(hero.name) ?? 0) + 1);
      }
    });
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  // Only entries on the tree count; free nodes are granted to everyone, so they're no choice.
  const builds = (all: string[][]) =>
    all
      .map(
        (talents) =>
          new Map(talents.map((talent) => [entryOf(talent), Number(talent.split(':')[1]) || 1])),
      )
      .map((ranks) => ({
        heroTree: heroTreeOf(new Set(ranks.keys())),
        ranks,
        talents: new Set([...ranks.keys()].filter((id) => nodeOf.has(id) && !nodeOf.get(id)!.free)),
      }))
      .filter((build) => build.talents.size > 0);
  const [player] = builds([playerTalents]);
  let group = builds(groupTalents);
  let top = builds(topTalents);
  if (!player || group.length === 0) {
    return null;
  }

  const treeCounts = new Map<string, number>();
  group.forEach(({ heroTree }) => {
    if (heroTree) {
      treeCounts.set(heroTree, (treeCounts.get(heroTree) ?? 0) + 1);
    }
  });
  const heroTreeMix = [...treeCounts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, share: count / group.length }));

  // Hero-tree talents would otherwise dominate the list for a player on the less common tree.
  const sameTree = (build: { heroTree?: string }) => build.heroTree === player.heroTree;
  const narrowed = player.heroTree !== undefined && group.filter(sameTree).length >= MIN_HERO_GROUP;
  if (narrowed) {
    group = group.filter(sameTree);
    top = top.filter(sameTree);
  }

  const rates = pickRates(group.map((build) => build.talents));
  const topRates = top.length > 0 ? pickRates(top.map((build) => build.talents)) : null;
  const usualRank = (entryId: number) => {
    const counts = new Map<number, number>();
    group.forEach(({ ranks }) => {
      const rank = ranks.get(entryId);
      if (rank) {
        counts.set(rank, (counts.get(rank) ?? 0) + 1);
      }
    });
    return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  };
  const pick = (entryId: number): TalentPick => ({
    entryId,
    pickRate: rates.get(entryId) ?? 0,
    topPickRate: topRates ? (topRates.get(entryId) ?? 0) : undefined,
    usualRank: usualRank(entryId),
  });

  // Hero talents of the other tree aren't a choice once the tree is chosen.
  const onPlayerTree = (id: number) => {
    const hero = heroOf.get(id);
    return !hero || hero.name === player.heroTree;
  };
  const skipped = [...rates.keys()]
    .filter((id) => !player.talents.has(id) && onPlayerTree(id) && rates.get(id)! >= COMMON_PICK)
    .map(pick)
    .sort((a, b) => b.pickRate - a.pickRate);
  const used = new Set<number>();
  const took: TookTalent[] = [...player.talents]
    .filter((id) => (rates.get(id) ?? 0) <= RARE_PICK)
    .map(pick)
    .sort((a, b) => a.pickRate - b.pickRate)
    .map((talent) => {
      const node = nodeOf.get(talent.entryId)!;
      const instead =
        node.type === 'choice'
          ? skipped.find((other) => node.entries.some((e) => e.id === other.entryId))
          : undefined;
      if (instead) {
        used.add(instead.entryId);
      }
      return { ...talent, instead };
    });

  return {
    groupSize: group.length,
    topSize: top.length,
    sameHeroTree: narrowed,
    heroTree: player.heroTree,
    heroTrees: heroTreeMix,
    // A skipped talent on the other side of a choice the player made is shown on that row.
    skipped: skipped.filter((talent) => !used.has(talent.entryId)),
    took,
    rates: new Map(nodes.flatMap((node) => node.entries.map((e) => [e.id, pick(e.id)]))),
    player: player.talents,
    playerRanks: player.ranks,
  };
}
