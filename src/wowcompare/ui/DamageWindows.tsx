import { formatDuration, formatNumber } from 'common/format';
import { SpellIcon, SpellLink } from 'interface';
import { useMemo } from 'react';

import {
  AmpWindowResult,
  analyzeDamageWindows,
  DamageWindowInputs,
  WindowFetch,
} from '../damageWindows';
import { LogSnapshot } from '../metrics/results';
import { CHART_COLORS, fill, tint } from './charts';

const COLORS = {
  amp: '#4caf50',
  reduction: 'rgba(255, 255, 255, 0.35)',
  elsewhere: CHART_COLORS.loss,
  cleave: 'rgba(255, 255, 255, 0.3)',
  /** Advice that depends: e.g. a cooldown spent shortly before a window. */
  maybe: '#ff9800',
};
/** Reacting slower than this to a new target is flagged. */
const SLOW_SWAP_MS = 3_000;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const multiplierText = (m: number) =>
  m >= 1 ? `+${Math.round((m - 1) * 100)}%` : m === 0 ? 'immune' : `−${Math.round((1 - m) * 100)}%`;

/** Where the player's damage went during one amplified window. */
function SplitBar({ amp, max }: { amp: AmpWindowResult; max: number }) {
  const parts = [
    { value: amp.onTarget, color: COLORS.amp, label: `${amp.targetName}` },
    { value: amp.aimedElsewhere, color: COLORS.elsewhere, label: 'aimed elsewhere' },
    { value: amp.cleaveElsewhere, color: COLORS.cleave, label: 'cleave elsewhere' },
  ];
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{ display: 'flex', height: 10, background: CHART_COLORS.track }}>
        {parts.map((p) => (
          <div
            key={p.label}
            title={`${p.label}: ${formatNumber(p.value)}`}
            style={{ width: `${(p.value / max) * 100}%`, ...fill(p.color) }}
          />
        ))}
      </div>
      <div className="text-muted" style={{ fontSize: '0.85em' }}>
        {formatNumber(amp.onTarget)} on target
        {amp.aimedElsewhere > 0 && (
          <span style={tint(COLORS.elsewhere)}>
            {' '}
            · {formatNumber(amp.aimedElsewhere)} aimed elsewhere
          </span>
        )}
        {amp.cleaveElsewhere > 0 && <> · {formatNumber(amp.cleaveElsewhere)} cleave</>}
      </div>
    </div>
  );
}

/**
 * The encounter's damage windows: when a target takes more damage (hit it, with cooldowns) or
 * less (hold cooldowns), and how this player used them.
 */
export default function DamageWindows({
  inputs,
  fetched,
  snapshot,
}: {
  inputs: DamageWindowInputs;
  /** The window auras (useDamageWindowSpans), shared with the fight timelines. */
  fetched: WindowFetch | null;
  snapshot: LogSnapshot;
}) {
  const analysis = useMemo(
    () =>
      fetched?.state === 'done'
        ? analyzeDamageWindows(inputs, fetched.spans, snapshot.windows, snapshot.results)
        : null,
    [fetched, inputs, snapshot],
  );
  if (!fetched) {
    return null;
  }
  if (fetched.state === 'loading') {
    return <p className="text-muted">Loading the fight's damage windows…</p>;
  }
  if (!analysis) {
    return <p className="text-muted">The damage windows couldn't be loaded from Warcraft Logs.</p>;
  }
  if (analysis.timeline.length === 0) {
    return <p className="text-muted">None of this boss's damage windows happened in this pull.</p>;
  }
  const defs = [...new Map(analysis.timeline.map((w) => [w.def.auraId, w.def])).values()];
  const maxWindowDamage = Math.max(
    1,
    ...analysis.amps.map((a) => a.onTarget + a.aimedElsewhere + a.cleaveElsewhere),
  );

  return (
    <>
      <ul className="text-muted" style={{ paddingLeft: 18 }}>
        {defs.map((def) => (
          <li key={def.auraId}>
            <SpellLink spell={def.auraId}>{def.name}</SpellLink> ({multiplierText(def.multiplier)}
            ): {def.advice}
          </li>
        ))}
      </ul>

      {analysis.amps.length > 0 && (
        <table className="table table-condensed" style={{ marginBottom: 16 }}>
          <thead>
            <tr>
              <th>Window</th>
              <th>Your damage in it</th>
              <th>First cast at it</th>
              <th>Your cooldowns</th>
            </tr>
          </thead>
          <tbody>
            {analysis.amps.map((amp) => (
              <tr key={`${amp.def.auraId}-${amp.startMs}`}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {formatDuration(amp.startMs)}–{formatDuration(amp.endMs)}
                  <div className="text-muted" style={{ fontSize: '0.85em' }}>
                    {amp.targetName} {multiplierText(amp.def.multiplier)}
                  </div>
                </td>
                <td>
                  <SplitBar amp={amp} max={maxWindowDamage} />
                </td>
                <td
                  style={tint(
                    amp.firstCastMs === null || amp.firstCastMs > SLOW_SWAP_MS
                      ? CHART_COLORS.loss
                      : undefined,
                  )}
                >
                  {amp.firstCastMs === null ? 'none' : seconds(amp.firstCastMs)}
                </td>
                <td>
                  {amp.cooldowns.length === 0 && <span className="text-muted">none nearby</span>}
                  {amp.cooldowns.map((cd) => (
                    <div
                      key={cd.token}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <SpellIcon
                        spell={cd.spellId}
                        style={{ width: 18, height: 18, borderRadius: 3 }}
                      />
                      {cd.castsInside > 0 ? (
                        <span>
                          {cd.castsInside} {cd.castsInside === 1 ? 'cast' : 'casts'}
                        </span>
                      ) : cd.readyUnused ? (
                        <span style={tint(CHART_COLORS.loss)}>ready, not used</span>
                      ) : (
                        <span style={tint(COLORS.maybe)}>
                          used {seconds(cd.usedBeforeMs!)} before
                        </span>
                      )}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Cooldowns into reduced targets</h4>
      {analysis.reduced.length === 0 ? (
        <p className="text-muted">
          None: no cooldown went mostly into a target taking reduced damage.
        </p>
      ) : (
        <ul style={{ paddingLeft: 18 }}>
          {analysis.reduced.map((r) => (
            <li key={`${r.token}-${r.castMs}`} style={{ marginBottom: 4 }}>
              <SpellLink spell={r.spellId}>{r.label}</SpellLink> at {formatDuration(r.castMs)} went
              into {r.targetName} under <SpellLink spell={r.def.auraId}>{r.def.name}</SpellLink> (
              {multiplierText(r.def.multiplier)}) for {Math.round(r.reducedShare * 100)}% of it.
              That ended {seconds(r.waitMs)} after the cast
              {r.holdIsFree === true && '; holding it would have cost no casts over the fight'}
              {r.holdIsFree === false &&
                '; holding it would have cost a cast over the fight, so it may have been right'}
              .
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted" style={{ fontSize: '0.9em' }}>
        Aimed elsewhere = damage on other targets from spells that hit one target at a time. Cleave
        that also reached other targets isn't counted against you. Only cooldowns are judged here;
        building resources or pooling during a reduction is often right.
      </p>
    </>
  );
}
