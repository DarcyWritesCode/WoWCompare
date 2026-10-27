import getTalentFromEntry from 'common/TALENTS/getTalentFromEntry';
import { SpellIcon, SpellLink } from 'interface';
import { ReactNode } from 'react';

import {
  COMMON_PICK,
  RARE_PICK,
  TalentComparison as Comparison,
  TalentPick,
} from '../benchmarks/talents';
import { CHART_COLORS, ImpactBar } from './charts';

const percent = (share: number) => `${Math.round(share * 100)}%`;

function TalentName({ entryId }: { entryId: number }) {
  const talent = getTalentFromEntry({ id: entryId });
  return talent ? <SpellLink spell={talent} /> : <>Talent {entryId}</>;
}

function Row({ talent, children }: { talent: TalentPick; children?: ReactNode }) {
  const icon = getTalentFromEntry({ id: talent.entryId });
  return (
    <li style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
      {icon ? (
        <SpellIcon spell={icon} style={{ width: 28, height: 28, borderRadius: 4 }} />
      ) : (
        <div style={{ width: 28 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <strong>
            <TalentName entryId={talent.entryId} />
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
export default function TalentComparison({ comparison }: { comparison: Comparison }) {
  const { skipped, took, heroTrees, heroTree, sameHeroTree, groupSize, topSize } = comparison;
  return (
    <>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
          {took.length > 0 && (
            <section style={{ flex: '1 1 320px', minWidth: 0 }}>
              <h4>You took, and few others do</h4>
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
            </section>
          )}
          {skipped.length > 0 && (
            <section style={{ flex: '1 1 320px', minWidth: 0 }}>
              <h4>Most take, and you didn't</h4>
              <ol style={{ listStyle: 'none', paddingLeft: 0 }}>
                {skipped.map((talent) => (
                  <Row key={talent.entryId} talent={talent} />
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
      <p className="text-muted">
        Pick rates across the {groupSize} ranked parses around the reference band
        {topSize > 0 ? `, and the top ${topSize}` : ''}. Listed: talents {percent(COMMON_PICK)} or
        more take that you didn't, and ones you took that {percent(RARE_PICK)} or fewer take. A rare
        pick can be right for a fight; this shows what's usual, not what's best.
      </p>
    </>
  );
}
