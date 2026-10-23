import { formatNumber } from 'common/format';
import { SpellIcon } from 'interface';

import { Mistake } from '../benchmarks/mistakes';
import { ImpactBar } from './charts';

/** The player's biggest gaps to the reference benchmark, ordered by estimated DPS lost. */
export default function BiggestMistakes({
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
            <SpellIcon spell={m.spellId} style={{ width: 32, height: 32, borderRadius: 4 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>{m.title}</strong>
                <span style={{ whiteSpace: 'nowrap' }}>
                  ≈{formatNumber(m.dps)} DPS{' '}
                  <span className="text-muted">({((m.dps / fightDps) * 100).toFixed(1)}%)</span>
                </span>
              </div>
              <ImpactBar fraction={m.dps / largest} />
              <div className="text-muted" style={{ marginTop: 2 }}>
                {m.detail}.
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-muted">
        Estimated against {referenceLabel}, valuing each gap at your own damage (your casts, your
        DoT damage), so gear differences don't inflate it. Causes overlap, so don't add them up.
      </p>
    </>
  );
}
