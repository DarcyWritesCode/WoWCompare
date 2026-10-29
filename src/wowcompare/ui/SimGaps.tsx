import { formatNumber } from 'common/format';
import { useState } from 'react';

import { SIMC_RELEASE } from '../sim/engine';
import type { SimCharacter } from '../sim/profileFromLog';
import { autoSim, canSim, setAutoSim, useEngineState } from '../sim/runner';
import type { AugSimMode } from '../sim/allies';
import { SimRun, variantChange, variantsFor } from '../sim/variants';
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
  aug,
}: {
  character: SimCharacter;
  plan: ReturnType<typeof variantsFor>;
  run: SimRun;
  start: () => void;
  /** To turn sim differences into DPS at the player's own level. */
  playerDps: number;
  /** Augmentation: how it's simmed (sim/allies.ts), and a way to change it. */
  aug?: { mode: AugSimMode | null; allies: string[]; change: () => void };
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
        Your character from this log, simmed in your browser against {plan.variants.length}{' '}
        {plan.variants.length === 1 ? 'variant' : 'variants'} of your own talents and gear, over{' '}
        {Math.round(character.fightSeconds)} s with {fightText(character.fight)}, as in this log.
        Each variant changes one thing; only the differences are used, since a sim's own DPS isn't a
        reliable target. SimulationCraft {SIMC_RELEASE.simcCommit.slice(0, 7)} (game data{' '}
        {SIMC_RELEASE.gameVersion}), via{' '}
        <a href="https://github.com/PwogSoupe/voidsim-simc">voidsim</a>.
      </p>
      {aug && (
        <p style={tint(CHART_COLORS.loss)}>
          Augmentation: Warcraft Logs credits you with the damage your Ebon Might and Prescience add
          to other players, so these sims are scored by the whole raid&apos;s DPS, and each change
          is a share of everything you added (your damage plus your buffs&apos;).{' '}
          {aug.allies.length > 0
            ? `Simmed with ${aug.allies.join(', ')}, the players you buffed most, on their own gear and talents.`
            : "Simmed with SimulationCraft's stand-in raid of eight generic players, not your raid, so read these as rough."}{' '}
          <button type="button" className="btn btn-link btn-sm hidden-print" onClick={aug.change}>
            Change
          </button>
        </p>
      )}
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
            {plan.variants.map((variant) => {
              const measured = variantChange(run.result, variant.name);
              if (!measured) {
                return null;
              }
              const { change, error } = measured;
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
                    {(change * 100).toFixed(1)}% ±{(error * 100).toFixed(1)}
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
