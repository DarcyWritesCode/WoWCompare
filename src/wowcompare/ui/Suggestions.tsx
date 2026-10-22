import { formatPercentage } from 'common/format';
import { SpellLink } from 'interface';
import { useState } from 'react';

import { missingAuras, suggestRanks } from '../benchmarks/suggest';
import { classSpellMatcher } from '../simc/specs';
import { LogSnapshot } from '../metrics/results';
import { Customization, readCustomization, writeCustomization } from '../profile/customizations';
import { Profile } from '../profile/types';
import { METRIC_LABELS } from './ProfileResultsTable';

const pct = (value: number | null) => (value === null ? '—' : `${formatPercentage(value, 0)}%`);

/**
 * Auto-suggestions from the parsed logs: buffs the top parses keep up that the profile misses,
 * and an entry order by how strongly each metric tracks DPS. Accepted suggestions are saved in
 * this browser and take effect on the next analysis.
 */
export default function Suggestions({
  profile,
  player,
  topLogs,
  allLogs,
}: {
  profile: Profile;
  player: LogSnapshot;
  /** The top-10 logs: what "top parses keep it up" is measured on. */
  topLogs: LogSnapshot[];
  /** Every parsed log including the player's: the sample for DPS correlations. */
  allLogs: LogSnapshot[];
}) {
  const missing = missingAuras(profile, player, topLogs, classSpellMatcher(profile.specId));
  const ranks = suggestRanks(profile, allLogs);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(missing.map((m) => `${m.kind}:${m.token}`)),
  );
  const [saved, setSaved] = useState<Customization | null>(() => readCustomization(profile.specId));

  const save = (customization: Customization | null) => {
    writeCustomization(profile.specId, customization);
    setSaved(customization);
  };

  const trackSelected = () => {
    const current = saved ?? { extraEntries: [] };
    const additions = missing
      .filter((m) => selected.has(`${m.kind}:${m.token}`))
      .map((m) => ({
        token: m.token,
        spellIds: [m.spellId],
        kind: m.kind,
        metrics: ['uptime' as const],
      }));
    save({
      ...current,
      extraEntries: [
        ...current.extraEntries.filter((e) => !additions.some((a) => a.token === e.token)),
        ...additions,
      ],
    });
  };

  const useSuggestedOrder = () => {
    save({
      extraEntries: saved?.extraEntries ?? [],
      rankOrder: ranks.map((r) => r.entry.token),
    });
  };

  return (
    <>
      <p className="text-muted">
        Worked out from {allLogs.length} parsed logs ({topLogs.length} top-10). Accepted suggestions
        are saved in this browser and apply from the next page load.
        {saved && (
          <>
            {' '}
            You have saved changes for this spec.{' '}
            <button type="button" className="btn btn-link" onClick={() => save(null)}>
              Reset to the APL
            </button>
          </>
        )}
      </p>

      <h3>Not in the APL, but top parses keep it up</h3>
      {missing.length === 0 ? (
        <p className="text-muted">Nothing: the profile covers what the top parses keep up.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table table-condensed">
            <thead>
              <tr>
                <th />
                <th>Aura</th>
                <th>Kind</th>
                <th>Top parses keeping it up</th>
                <th>Top median uptime</th>
                <th>You</th>
              </tr>
            </thead>
            <tbody>
              {missing.map((m) => {
                const key = `${m.kind}:${m.token}`;
                return (
                  <tr key={key}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Track ${m.name}`}
                        checked={selected.has(key)}
                        onChange={() => {
                          const next = new Set(selected);
                          if (next.has(key)) {
                            next.delete(key);
                          } else {
                            next.add(key);
                          }
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td>
                      <SpellLink spell={m.spellId}>{m.name}</SpellLink>
                    </td>
                    <td>{m.kind}</td>
                    <td>{pct(m.topShare)}</td>
                    <td>{pct(m.medianUptime)}</td>
                    <td>{pct(m.playerUptime)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            type="button"
            className="btn btn-primary"
            onClick={trackSelected}
            disabled={selected.size === 0}
          >
            Track selected
          </button>
        </div>
      )}

      <h3>Suggested importance</h3>
      <p className="text-muted">
        Entries ordered by how strongly their main metric rises with DPS across these logs (r, from
        −1 to 1). Kill time, raid size and gear also move DPS, so treat weak correlations (|r| &lt;
        0.3) as noise.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table table-condensed">
          <thead>
            <tr>
              <th>Suggested</th>
              <th>APL order</th>
              <th>Entry</th>
              <th>Metric</th>
              <th>r with DPS</th>
              <th>Logs</th>
            </tr>
          </thead>
          <tbody>
            {ranks.map((rank) => (
              <tr key={`${rank.entry.kind}-${rank.entry.token}`}>
                <td>{rank.suggestedRank}</td>
                <td>{rank.entry.rank}</td>
                <td>
                  <SpellLink spell={player.results.entries[rank.index]?.spellId ?? 0}>
                    {rank.entry.label}
                  </SpellLink>
                </td>
                <td>{rank.metric ? METRIC_LABELS[rank.metric] : '—'}</td>
                <td style={{ opacity: rank.r !== null && Math.abs(rank.r) >= 0.3 ? 1 : 0.5 }}>
                  {rank.r === null ? '—' : rank.r.toFixed(2)}
                </td>
                <td>{rank.logs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn btn-primary" onClick={useSuggestedOrder}>
        Use suggested order
      </button>
    </>
  );
}
