import { formatNumber } from 'common/format';
import { SpellLink } from 'interface';

import { biggestMistakes } from '../benchmarks/mistakes';
import { LogSnapshot } from '../metrics/results';
import { Profile } from '../profile/types';

/** The player's biggest gaps to the reference benchmark, ordered by estimated DPS lost. */
export default function BiggestMistakes({
  profile,
  player,
  topLogs,
  referenceLabel,
}: {
  profile: Profile;
  player: LogSnapshot;
  topLogs: LogSnapshot[];
  /** e.g. "the top-10 median". */
  referenceLabel: string;
}) {
  const mistakes = biggestMistakes(profile, player, topLogs);
  if (mistakes.length === 0) {
    return <p className="text-muted">No clear gaps to {referenceLabel}.</p>;
  }
  return (
    <>
      <ol>
        {mistakes.map((m) => (
          <li key={m.key} style={{ marginBottom: 4 }}>
            <SpellLink spell={m.spellId} /> <strong>{m.title}</strong>: {m.detail}.{' '}
            <span className="text-muted">
              ≈{formatNumber(m.dps)} DPS ({((m.dps / player.fightDps) * 100).toFixed(1)}% of yours)
            </span>
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
