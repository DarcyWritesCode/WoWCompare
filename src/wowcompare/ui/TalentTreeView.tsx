import { Icon, SpellLink } from 'interface';

import { TalentComparison, TreeNode } from '../benchmarks/talents';
import { CHART_COLORS } from './charts';

/** Pixels per grid unit; neighbouring nodes are 2 units apart. */
const UNIT = 26;
const ICON = 34;
/** Room under each icon for its pick rate, clear of a flag's ring. */
const LABEL = 12;
const LABEL_GAP = 5;

export const TREE_COLORS = {
  /** Most of the group takes it; the player didn't. */
  missed: '#f44336',
  /** Few of the group take it; the player did. */
  extra: '#2196f3',
  taken: CHART_COLORS.you,
};

const percent = (share: number) => `${Math.round(share * 100)}%`;

function Tree({
  title,
  nodes,
  comparison,
  missed,
  extra,
}: {
  title: string;
  nodes: TreeNode[];
  comparison: TalentComparison;
  missed: Set<number>;
  extra: Set<number>;
}) {
  if (nodes.length === 0) {
    return null;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const taken = (node: TreeNode) =>
    node.free || node.entries.some((e) => comparison.player.has(e.id));
  // Room on the right for a points badge, which overhangs its node.
  const width = Math.max(...nodes.map((n) => n.x)) * UNIT + ICON + 10;
  const height = Math.max(...nodes.map((n) => n.y)) * UNIT + ICON + LABEL_GAP + LABEL;
  const center = (node: TreeNode) => ({ x: node.x * UNIT + ICON / 2, y: node.y * UNIT + ICON / 2 });

  return (
    <div style={{ flex: '0 0 auto' }}>
      <h4 style={{ textAlign: 'center' }}>{title}</h4>
      <div style={{ position: 'relative', width, height }}>
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
          {nodes.flatMap((node) =>
            node.next
              .map((id) => byId.get(id))
              .filter((next): next is TreeNode => next !== undefined)
              .map((next) => {
                const a = center(node);
                const b = center(next);
                const lit = taken(node) && taken(next);
                return (
                  <line
                    key={`${node.id}-${next.id}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={lit ? TREE_COLORS.taken : 'rgba(255, 255, 255, 0.15)'}
                    strokeWidth={lit ? 2 : 1.5}
                  />
                );
              }),
          )}
        </svg>
        {nodes.map((node) => {
          // A choice node shows the side the player took, else the side most take.
          const mine = node.entries.find((e) => comparison.player.has(e.id));
          const rate = (id: number) => comparison.rates.get(id)?.pickRate ?? 0;
          const shown =
            mine ?? [...node.entries].sort((a, b) => rate(b.id) - rate(a.id))[0] ?? node.entries[0];
          if (!shown) {
            return null;
          }
          const flag = node.entries.some((e) => extra.has(e.id))
            ? 'extra'
            : node.entries.some((e) => missed.has(e.id))
              ? 'missed'
              : null;
          const isTaken = taken(node);
          const others = node.entries.filter((e) => e !== shown);
          // Multi-point nodes: the player's points, against what most who take it put in.
          const max = shown.maxRanks;
          const points = comparison.playerRanks.get(shown.id) ?? 0;
          const usual = comparison.rates.get(shown.id)?.usualRank ?? 0;
          const pointsColor =
            max > 1 && points > 0 && usual > 0 && points !== usual
              ? points < usual
                ? TREE_COLORS.missed
                : TREE_COLORS.extra
              : undefined;
          const tip = [
            `${shown.name}: ${percent(rate(shown.id))} take it`,
            ...others.map((e) => `${e.name} (other choice): ${percent(rate(e.id))}`),
            node.free ? 'Granted to everyone' : isTaken ? 'You took it' : "You didn't take it",
            max > 1 && usual > 0
              ? `Points: yours ${points}/${max}; most who take it put in ${usual}/${max}`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
          const ring = flag ? TREE_COLORS[flag] : isTaken ? TREE_COLORS.taken : 'transparent';
          return (
            <div
              key={node.id}
              title={tip}
              style={{
                position: 'absolute',
                left: node.x * UNIT,
                top: node.y * UNIT,
                width: ICON,
                textAlign: 'center',
              }}
            >
              <SpellLink
                spell={shown.spellId}
                icon={false}
                style={{
                  display: 'block',
                  width: ICON,
                  height: ICON,
                  borderRadius: node.type === 'choice' ? 10 : 4,
                  // On the link, not the icon: the icon's greyscale filter would grey the ring too.
                  // Thicker for flags, which stand out against the greyed-out icon.
                  boxShadow: `0 0 0 ${flag ? 4 : 2}px ${ring}`,
                }}
              >
                <Icon
                  icon={shown.icon}
                  alt=""
                  style={{
                    // Fill the ringed link exactly: the global img.icon style nudges icons up.
                    display: 'block',
                    margin: 0,
                    width: ICON,
                    height: ICON,
                    borderRadius: node.type === 'choice' ? 10 : 4,
                    filter: isTaken ? undefined : 'grayscale(1)',
                    opacity: isTaken || flag ? 1 : 0.35,
                  }}
                />
              </SpellLink>
              {max > 1 && (
                <div
                  style={{
                    position: 'absolute',
                    top: ICON - 12,
                    right: -8,
                    padding: '0 3px',
                    fontSize: 10,
                    lineHeight: '13px',
                    fontWeight: 600,
                    borderRadius: 3,
                    background: 'rgba(0, 0, 0, 0.85)',
                    color: pointsColor ?? (isTaken ? TREE_COLORS.taken : undefined),
                    border: pointsColor ? `1px solid ${pointsColor}` : undefined,
                  }}
                >
                  {points}/{max}
                  {pointsColor && usual > 0 && (
                    <span>
                      {' '}
                      ({points < usual ? '−' : '+'}
                      {Math.abs(usual - points)})
                    </span>
                  )}
                </div>
              )}
              {!node.free && (
                <div
                  style={{
                    fontSize: 10,
                    marginTop: LABEL_GAP,
                    lineHeight: `${LABEL}px`,
                    color: flag ? TREE_COLORS[flag] : undefined,
                    opacity: flag ? 1 : 0.6,
                  }}
                >
                  {percent(rate(shown.id))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The player's build drawn as the in-game trees: their talents lit, talents most ranked players
 * take that they skipped ringed red, and rare picks they took ringed blue. The number under each
 * node is the share of the group that takes it.
 */
export default function TalentTreeView({
  comparison,
  tree,
}: {
  comparison: TalentComparison;
  tree: { class: TreeNode[]; spec: TreeNode[]; hero: { name: string; nodes: TreeNode[] }[] };
}) {
  const missed = new Set(comparison.skipped.map((t) => t.entryId));
  const extra = new Set(comparison.took.map((t) => t.entryId));
  const hero = tree.hero.find((h) => h.name === comparison.heroTree);
  return (
    <>
      <p className="text-muted" style={{ marginBottom: 8 }}>
        <span style={{ color: TREE_COLORS.missed }}>■</span> most take it, you didn't ·{' '}
        <span style={{ color: TREE_COLORS.extra }}>■</span> few take it, you did ·{' '}
        <span style={{ color: TREE_COLORS.taken }}>■</span> your talents. The number is the share of
        ranked parses that take it.
      </p>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 24,
          overflowX: 'auto',
          marginBottom: 16,
        }}
      >
        <Tree title="Class" nodes={tree.class} {...{ comparison, missed, extra }} />
        <Tree title="Spec" nodes={tree.spec} {...{ comparison, missed, extra }} />
        {hero && <Tree title={hero.name} nodes={hero.nodes} {...{ comparison, missed, extra }} />}
      </div>
    </>
  );
}
