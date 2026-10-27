/**
 * WoWCompare: writes each spec's talent tree layout (class, spec and hero trees: node positions,
 * connections, choice nodes) to src/wowcompare/talentTrees/<specId>.json, for drawing the
 * talent comparison as the in-game tree. The generated talent tables (scripts/talents/) keep only
 * spells, not the layout. Run again after a patch moves the trees:
 *
 *   pnpm exec tsx scripts/wowcompare/generate-talent-trees.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const URL = 'https://www.raidbots.com/static/data/live/talents.json';
const OUT_DIR = path.resolve('src/wowcompare/talentTrees');
/** Raidbots positions are in steps of 300; the tree files use grid units. */
const STEP = 300;

interface RaidbotsEntry {
  id: number;
  maxRanks?: number;
  name?: string;
  spellId?: number;
  icon?: string;
  type: string;
  nodes?: number[];
}

interface RaidbotsNode {
  id: number;
  type: string;
  posX: number;
  posY: number;
  maxRanks?: number;
  next: number[];
  freeNode?: boolean;
  subTreeId?: number;
  entries: RaidbotsEntry[];
}

interface RaidbotsTree {
  specId: number;
  className: string;
  specName: string;
  classNodes: RaidbotsNode[];
  specNodes: RaidbotsNode[];
  heroNodes: RaidbotsNode[];
  subTreeNodes: RaidbotsNode[];
}

function layout(nodes: RaidbotsNode[]) {
  const minX = Math.min(...nodes.map((n) => n.posX));
  const minY = Math.min(...nodes.map((n) => n.posY));
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.map((node) => ({
    id: node.id,
    x: (node.posX - minX) / STEP,
    y: (node.posY - minY) / STEP,
    // Only links within this tree.
    next: node.next.filter((id) => ids.has(id)),
    type: node.type,
    ...(node.freeNode && { free: true }),
    entries: node.entries.map((entry) => ({
      id: entry.id,
      spellId: entry.spellId ?? 0,
      name: entry.name ?? '',
      icon: entry.icon ?? 'inv_misc_questionmark',
      maxRanks: entry.maxRanks ?? node.maxRanks ?? 1,
    })),
  }));
}

async function main() {
  const response = await fetch(URL);
  if (!response.ok) {
    throw new Error(`${URL}: HTTP ${response.status}`);
  }
  const trees = (await response.json()) as RaidbotsTree[];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const tree of trees) {
    // The sub-tree node's entries are the hero tree choice: the rankings list the chosen entry.
    const choices = tree.subTreeNodes.flatMap((node) => node.entries);
    const hero = choices.map((choice) => ({
      name: choice.name ?? '',
      entryId: choice.id,
      nodes: layout(tree.heroNodes.filter((node) => choice.nodes?.includes(node.id))),
    }));
    const out = {
      specId: tree.specId,
      className: tree.className,
      specName: tree.specName,
      class: layout(tree.classNodes),
      spec: layout(tree.specNodes),
      hero,
    };
    fs.writeFileSync(path.join(OUT_DIR, `${tree.specId}.json`), `${JSON.stringify(out)}\n`);
  }
  console.log(`Wrote ${trees.length} talent trees to ${path.relative('.', OUT_DIR)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
