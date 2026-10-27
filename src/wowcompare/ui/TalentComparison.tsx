import { Icon, SpellLink } from 'interface';
import { createContext, ReactNode, useContext } from 'react';

import {
  COMMON_PICK,
  RARE_PICK,
  TalentComparison as Comparison,
  TalentPick,
  TalentTree,
  TreeEntry,
  treeNodes,
} from '../benchmarks/talents';
import { CHART_COLORS, ImpactBar } from './charts';
import TalentTreeView from './TalentTreeView';

/** The spec's talents by entry ID, for names and icons. */
const EntriesContext = createContext<Map<number, TreeEntry>>(new Map());

const percent = (share: number) => `${Math.round(share * 100)}%`;

function TalentName({ entryId, icon = true }: { entryId: number; icon?: boolean }) {
  const entry = useContext(EntriesContext).get(entryId);
  return entry ? (
    <SpellLink spell={entry.spellId} icon={icon}>
      {entry.name}
    </SpellLink>
  ) : (
    <>Talent {entryId}</>
  );
}

function Row({ talent, children }: { talent: TalentPick; children?: ReactNode }) {
  const entry = useContext(EntriesContext).get(talent.entryId);
  return (
    <li style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
      {entry ? (
        <Icon icon={entry.icon} alt="" style={{ width: 28, height: 28, borderRadius: 4 }} />
      ) : (
        <div style={{ width: 28 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <strong>
            {/* The row has its own large icon. */}
            <TalentName entryId={talent.entryId} icon={false} />
          </strong>
          <span style={{ whiteSpace: 'nowrap' }}>
            {percent(talent.pickRate)} take it
            {talent.topPickRate !== undefined && (
              <span className="text-muted"> · top 100: {percent(talent.topPickRate)}</span>
            )}
          </span>
        </div>
        <ImpactBar fraction={talent.pickRate} color={CHART_COLORS.reference} />
        {children}
      </div>
    </li>
  );
}

/** Where the player's talents differ from what ranked players of the spec take. */
export default function TalentComparison({
  comparison,
  tree,
}: {
  comparison: Comparison;
  tree: TalentTree;
}) {
  const { skipped, took, heroTrees, heroTree, sameHeroTree, groupSize, topSize } = comparison;
  const entries = new Map(treeNodes(tree).flatMap((node) => node.entries.map((e) => [e.id, e])));
  return (
    <EntriesContext.Provider value={entries}>
      <TalentTreeView comparison={comparison} tree={tree} />
      {heroTrees.length > 0 && (
        <p>
          Hero trees: {heroTrees.map((tree) => `${percent(tree.share)} ${tree.name}`).join(' · ')}
        </p>
      )}
      {sameHeroTree && (
        <p className="text-muted">
          Compared with parses on your hero tree{heroTree ? ` (${heroTree})` : ''} only, so its
          talents don't crowd the list.
        </p>
      )}
      {skipped.length === 0 && took.length === 0 ? (
        <p className="text-muted">Your talents match what most ranked players take.</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
          {took.length > 0 && (
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <h4 style={{ marginTop: 0 }}>You took, and few others do</h4>
              <ol style={{ listStyle: 'none', paddingLeft: 0 }}>
                {took.map((talent) => (
                  <Row key={talent.entryId} talent={talent}>
                    {talent.instead && (
                      <div className="text-muted" style={{ marginTop: 2 }}>
                        {percent(talent.instead.pickRate)} take{' '}
                        <TalentName entryId={talent.instead.entryId} /> instead.
                      </div>
                    )}
                  </Row>
                ))}
              </ol>
            </div>
          )}
          {skipped.length > 0 && (
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <h4 style={{ marginTop: 0 }}>Most take, and you didn't</h4>
              <ol style={{ listStyle: 'none', paddingLeft: 0 }}>
                {skipped.map((talent) => (
                  <Row key={talent.entryId} talent={talent} />
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
      <p className="text-muted">
        Pick rates across the {groupSize} ranked parses around the reference band
        {topSize > 0 ? `, and the top ${topSize}` : ''}. Listed: talents {percent(COMMON_PICK)} or
        more take that you didn't, and ones you took that {percent(RARE_PICK)} or fewer take. A rare
        pick can be right for a fight; this shows what's usual, not what's best.
      </p>
    </EntriesContext.Provider>
  );
}
