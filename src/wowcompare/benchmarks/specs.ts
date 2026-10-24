import configs from 'parser';

import { hasSimcApl } from '../profile/registry';
import { weeklySlots } from './schedule';

/** The specs the benchmark job builds: those with an analyzer and a SimC APL. */
export const BENCHMARK_CONFIGS = configs.filter(
  (config) => config.parser !== undefined && hasSimcApl(config.spec.id),
);

/** Each benchmarked spec's weekly build slot, by spec ID. */
export const SPEC_SLOTS = weeklySlots(BENCHMARK_CONFIGS.map((config) => config.spec));
