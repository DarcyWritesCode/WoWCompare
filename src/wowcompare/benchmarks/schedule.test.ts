import { SLOTS_PER_DAY, UPDATE_DAYS } from './schedule';
import { BENCHMARK_CONFIGS, SPEC_SLOTS } from './specs';

describe('benchmark schedule', () => {
  it('gives every class with a SimC APL an update day', () => {
    const classes = new Set(BENCHMARK_CONFIGS.map((config) => config.spec.wclClassName));
    expect(classes.size).toBeGreaterThan(10);
    expect([...classes].filter((name) => !(name in UPDATE_DAYS))).toEqual([]);
  });

  it('fits every spec in a slot the job runs', () => {
    const late = [...SPEC_SLOTS.entries()].filter(([, slot]) => slot.slot >= SLOTS_PER_DAY);
    expect(late).toEqual([]);
  });
});
