import Modal from 'interface/Modal';
import { useState } from 'react';

import { AugSimMode, lastAugMode, MAX_ALLIES } from '../sim/allies';

/** Asks an Augmentation player how to sim them; see sim/allies.ts. */
export default function AugSimDialog({
  allyNames,
  onChoose,
}: {
  /** The players high accuracy would sim with. */
  allyNames: string[];
  onChoose: (mode: AugSimMode, ask: boolean) => void;
}) {
  const [mode, setMode] = useState<AugSimMode>(lastAugMode);
  const [ask, setAsk] = useState(true);
  const option = (value: AugSimMode, title: string, detail: string) => (
    <label style={{ display: 'block', fontWeight: 'normal', marginBottom: 12 }}>
      <input
        type="radio"
        name="aug-sim-mode"
        checked={mode === value}
        onChange={() => setMode(value)}
      />{' '}
      <strong>{title}</strong>
      <span className="text-muted" style={{ display: 'block', marginLeft: 20 }}>
        {detail}
      </span>
    </label>
  );
  return (
    <Modal id="aug-sim-mode" onClose={() => onChoose(mode, ask)}>
      <h2>How should we sim your Augmentation?</h2>
      <p>
        Warcraft Logs credits you with the damage your Ebon Might and Prescience add to other
        players, so your sims need players to buff. Both options score each sim by the whole
        raid&apos;s DPS.
      </p>
      {option(
        'standard',
        'Standard',
        "SimulationCraft's own stand-in raid of eight generic players. Under a minute.",
      )}
      {option(
        'raid',
        'High accuracy',
        allyNames.length > 0
          ? `The ${Math.min(allyNames.length, MAX_ALLIES)} players you buffed most in this log, with their own gear and talents: ${allyNames.slice(0, MAX_ALLIES).join(', ')}. Several minutes of CPU.`
          : 'The players you buffed most in this log, with their own gear and talents. Several minutes of CPU. (No buffed players were found in this log, so it falls back to standard.)',
      )}
      <label style={{ display: 'block', fontWeight: 'normal' }}>
        <input type="checkbox" checked={!ask} onChange={(e) => setAsk(!e.target.checked)} />{' '}
        Don&apos;t ask again (change it in Sim your gaps)
      </label>
      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 12 }}
        onClick={() => onChoose(mode, ask)}
      >
        Sim
      </button>
    </Modal>
  );
}
