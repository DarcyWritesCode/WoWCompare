import { formatDuration } from 'common/format';
import { useEffect, useState } from 'react';

import { setDeathCutoff, useDeathCutoffState } from '../deathCutoff';

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as const)[n % 10] ?? 'th');
  return `${n}${suffix}`;
};

/** "Ignore events after N deaths" (see deathCutoff.ts), and where it cut this fight. */
export default function DeathCutoffControl() {
  const { setting, applied } = useDeathCutoffState();
  // Applied on Enter or leaving the field: every change re-parses the fight.
  const [draft, setDraft] = useState(setting === null ? '' : String(setting));
  useEffect(() => setDraft(setting === null ? '' : String(setting)), [setting]);
  const commit = () => {
    const value = Number(draft);
    const next = draft !== '' && Number.isInteger(value) && value > 0 ? value : null;
    if (next !== setting) {
      setDeathCutoff(next);
    } else {
      setDraft(setting === null ? '' : String(setting));
    }
  };
  return (
    <div
      className="hidden-print"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}
    >
      <label
        style={{ fontWeight: 'normal', margin: 0 }}
        title="Analyze raid fights only up to this many player deaths, like Warcraft Logs' wipe cutoff, so a wipe isn't scored on the time the raid spent dead. Applies to every tab; a time filter picked by hand takes precedence."
      >
        <span className="text-muted">Ignore events after</span>{' '}
        <input
          type="number"
          min={1}
          max={40}
          placeholder="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          style={{ width: 56 }}
        />{' '}
        <span className="text-muted">deaths</span>
      </label>
      {applied && (
        <span>
          Cut at the {ordinal(applied.deaths)} death, {formatDuration(applied.atMs)}. Benchmarks are
          whole kills, so later phases count in theirs and not in yours.
        </span>
      )}
    </div>
  );
}
