import SPECS from 'game/SPECS';

import { hasSimcApl } from '../profile/registry';
import { UPDATE_DAYS } from './schedule';

describe('benchmark schedule', () => {
  it('gives every class with a SimC APL an update day', () => {
    const classes = new Set(
      Object.values(SPECS)
        .filter((spec) => typeof spec === 'object' && hasSimcApl(spec.id))
        .map((spec) => spec.wclClassName),
    );
    expect(classes.size).toBeGreaterThan(10);
    expect([...classes].filter((name) => !(name in UPDATE_DAYS))).toEqual([]);
  });
});
