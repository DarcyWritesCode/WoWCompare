import getTalentFromEntry from 'common/TALENTS/getTalentFromEntry';

import { BuildInfo, LogSnapshot, RaidComp } from '../metrics/results';

const entryId = (talent: string) => Number(talent.split(':')[0]);

function talentName(talent: string) {
  const [id, rank] = talent.split(':');
  const name = getTalentFromEntry({ id: Number(id) })?.name ?? `Talent ${id}`;
  return rank === '1' ? name : `${name} (${rank})`;
}

/**
 * How a benchmark's build differs from the player's: a short summary for the column header and
 * a tooltip naming each talent taken (+) or not taken (−) compared with the player.
 */
export function describeBuild(build: BuildInfo, playerTalents: string[]) {
  const mine = new Set(playerTalents);
  const theirs = new Set(build.talents);
  const added = build.talents.filter((talent) => !mine.has(talent));
  const removed = playerTalents.filter((talent) => !theirs.has(talent));
  const changed = new Set([...added, ...removed].map(entryId)).size;

  const summary = [
    build.heroTree,
    changed === 0 ? 'same talents' : `${changed} talent${changed === 1 ? '' : 's'} differ`,
  ]
    .filter(Boolean)
    .join(' · ');
  const tooltip = [
    ...added.map((talent) => `+ ${talentName(talent)}`),
    ...removed.map((talent) => `− ${talentName(talent)}`),
  ].join('\n');
  return { summary, tooltip };
}

export function describeComp(comp: RaidComp) {
  return `${comp.tank}T ${comp.healer}H ${comp.dps}D`;
}

/** Hero tree mix across the logs behind a median column, e.g. "9 Wildstalker · 1 Druid of the Claw". */
export function describeHeroTrees(snapshots: LogSnapshot[]) {
  const counts = new Map<string, number>();
  snapshots.forEach((snapshot) => {
    const tree = snapshot.build.heroTree ?? 'Unknown';
    counts.set(tree, (counts.get(tree) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tree, count]) => `${count} ${tree}`)
    .join(' · ');
}
