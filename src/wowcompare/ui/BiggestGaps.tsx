import { formatNumber } from 'common/format';
import { SpellIcon } from 'interface';

import { Mistake } from '../benchmarks/mistakes';
import { ImpactBar } from './charts';

/** Colours of a gap's parts, e.g. gear, raid buffs and stats. */
const PART_COLORS = ['#ff9800', '#b388ff', '#4fc3f7'];

/**
 * The player's biggest gaps to the reference benchmark, ordered by estimated DPS lost: what play
 * can close, and what it can't (gear, raid buffs), marked as such.
 */
export default function BiggestGaps({
  mistakes,
  fightDps,
  referenceLabel,
}: {
  mistakes: Mistake[];
  fightDps: number;
  /** e.g. "the 90–95th percentile median". */
  referenceLabel: string;
}) {
  if (mistakes.length === 0) {
    return <p className="text-muted">No clear gaps to {referenceLabel}.</p>;
  }
  const largest = mistakes[0].dps;
  return (
    <>
      <ol style={{ listStyle: 'none', paddingLeft: 0 }}>
        {mistakes.map((m, i) => (
          <li
            key={m.key}
            style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}
          >
            <div className="text-muted" style={{ width: 18, textAlign: 'right', paddingTop: 4 }}>
              {i + 1}
            </div>
            {m.spellId ? (
              <SpellIcon spell={m.spellId} style={{ width: 32, height: 32, borderRadius: 4 }} />
            ) : (
              <div style={{ width: 32, flex: '0 0 auto' }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>
                  {m.title}
                  {m.notPlay && (
                    <span className="text-muted" style={{ fontWeight: 'normal' }}>
                      {' '}
                      (not play)
                    </span>
                  )}
                </strong>
                <span style={{ whiteSpace: 'nowrap' }}>
                  ≈{formatNumber(m.dps)} DPS{' '}
                  <span className="text-muted">({((m.dps / fightDps) * 100).toFixed(1)}%)</span>
                </span>
              </div>
              <ImpactBar
                fraction={m.dps / largest}
                segments={m.parts?.map((part, j) => ({
                  share: part.dps / m.dps,
                  color: PART_COLORS[j % PART_COLORS.length],
                  title: `${part.label}: ≈${formatNumber(part.dps)} DPS`,
                }))}
              />
              <div className="text-muted" style={{ marginTop: 2 }}>
                {m.detail}.
              </div>
              {m.parts && (
                <ul style={{ listStyle: 'none', paddingLeft: 0, margin: '2px 0 0' }}>
                  {m.parts.map((part, j) => (
                    <li key={part.label} className="text-muted">
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          marginRight: 6,
                          background: PART_COLORS[j % PART_COLORS.length],
                        }}
                      />
                      {part.label}: ≈{formatNumber(part.dps)} DPS
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-muted">
        {mistakes.some(
          (m) => m.key === 'setup' || m.key === 'talents' || m.key === 'other-play',
        ) ? (
          <>
            Against {referenceLabel}. Gear, raid buffs and talents are simmed on your character; the
            rest of the gap is play, broken down where it can be measured from the log (each valued
            at your own damage), with "other play differences" for the remainder. Together they add
            up to the gap, apart from items too small to list.
          </>
        ) : (
          <>
            Estimated against {referenceLabel}, valuing each gap at your own damage (your casts,
            your DoT damage). Gaps marked "not play" are gear and raid setup, a rough estimate from
            the logs until your character is simmed. Causes interact, so the total is roughly, not
            exactly, their sum.
          </>
        )}
      </p>
    </>
  );
}
