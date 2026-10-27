import { formatNumber } from 'common/format';
import { useState } from 'react';

import { SIMC_RELEASE } from '../sim/engine';
import type { SimCharacter } from '../sim/profileFromLog';
import { autoSim, canSim, setAutoSim, useEngineState } from '../sim/runner';
import type { SimRun, variantsFor } from '../sim/variants';
import { CHART_COLORS, tint } from './charts';

const fightText = (fight: SimCharacter['fight']) =>
  [
    fight.baseTargets === 1 ? 'one target' : `${fight.baseTargets} targets`,
    fight.adds.length > 0 &&
      `${fight.adds.length} add ${fight.adds.length === 1 ? 'wave' : 'waves'} (${fight.adds
        .map((wave) => `+${wave.count} for ${Math.round(wave.duration)} s`)
        .join(', ')})`,
    (fight.vulnerable?.length ?? 0) > 0 &&
      `damage taken ${fight
        .vulnerable!.map((w) => `×${w.multiplier} for ${Math.round(w.duration)} s`)
        .join(', ')}`,
  ]
    .filter(Boolean)
    .join(' and ');

/**
 * The player's character from the log, simmed with SimulationCraft in the browser against
 * variants (talent trees, item level, raid buffs; sim/variants.ts). Differences only: the same
 * character, fight and APL on every variant. The sims run in useSimGaps; this shows them.
 */
export default function SimGaps({
  character,
  plan,
  run,
  start,
  playerDps,
}: {
  character: SimCharacter;
  plan: ReturnType<typeof variantsFor>;
  run: SimRun;
  start: () => void;
  /** To turn sim differences into DPS at the player's own level. */
  playerDps: number;
}) {
  const engine = useEngineState();
  const [auto, setAuto] = useState(autoSim);
  if (!canSim()) {
    return (
      <p className="text-muted">
        Sims need a browser that supports cross-origin isolation with credentialless embedding
        (Chrome, Edge or Firefox). Biggest gaps falls back to rougher estimates from the logs.
      </p>
    );
  }

  const status =
    run.state === 'running' && engine.state === 'downloading'
      ? `Downloading the sim engine… ${Math.round(engine.loaded / 1e6)}${engine.total > 0 ? ` of ${Math.round(engine.total / 1e6)}` : ''} MB`
      : run.state === 'running'
        ? `Simming… ${Math.round(run.done * 100)}%`
        : null;
  return (
    <>
      <p className="text-muted">
        Your character from this log, simmed in your browser: played perfectly by the APL (the
        target Biggest gaps measures your play against), and {plan.variants.length}{' '}
        {plan.variants.length === 1 ? 'variant' : 'variants'} against your own talents and gear,
        over {Math.round(character.fightSeconds)} s with {fightText(character.fight)}, as in this
        log. SimulationCraft {SIMC_RELEASE.simcCommit.slice(0, 7)} (game data{' '}
        {SIMC_RELEASE.gameVersion}), via{' '}
        <a href="https://github.com/PwogSoupe/voidsim-simc">voidsim</a>.
      </p>
      <label className="hidden-print" style={{ fontWeight: 'normal', display: 'block' }}>
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAutoSim(e.target.checked);
            setAuto(e.target.checked);
          }}
        />{' '}
        Sim automatically when I open a log (downloads about 16 MB once, then 10–60 s of CPU per
        log)
      </label>
      {run.state === 'idle' && (
        <button type="button" className="btn btn-default btn-sm hidden-print" onClick={start}>
          Sim my character
        </button>
      )}
      {status && <p>{status}</p>}
      {run.state === 'error' && <p style={tint(CHART_COLORS.loss)}>The sim failed: {run.error}</p>}
      {run.state === 'done' && (
        <table className="table table-condensed" style={{ marginTop: 8 }}>
          <tbody>
            <tr>
              <td>
                Your character played perfectly by the APL{' '}
                <span className="text-muted">(for reference: real players can beat it)</span>
              </td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {formatNumber(run.result.baseline)} DPS
              </td>
              <td className="text-muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                every raid buff
              </td>
            </tr>
            {plan.variants.map((variant) => {
              const set = run.result.sets.find((s) => s.name === variant.name);
              if (!set) {
                return null;
              }
              const change = set.mean / run.result.baseline - 1;
              return (
                <tr key={variant.name}>
                  <td>{plan.labels[variant.name]}</td>
                  <td
                    style={{
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                      ...tint(change > 0 ? CHART_COLORS.you : undefined),
                    }}
                  >
                    {change >= 0 ? '+' : ''}
                    {(change * 100).toFixed(1)}% ±{((set.error / set.mean) * 100).toFixed(1)}
                  </td>
                  <td className="text-muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    ≈{change >= 0 ? '+' : ''}
                    {formatNumber(change * playerDps)} DPS for you
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
