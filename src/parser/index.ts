import FeralDruid from 'analysis/retail/druid/feral';
import { loadLiveProfile } from 'wowcompare/profile/registry';

import Config from './Config';

/**
 * WoWCompare: the spec's importance profile is built from its current SimC APL, so fetch that
 * alongside the parser code; analyzers read the profile synchronously when they start.
 */
function withLiveProfile(config: Config): Config {
  const { parser } = config;
  if (!parser) {
    return config;
  }
  return {
    ...config,
    parser: async () => {
      const [parserClass] = await Promise.all([parser(), loadLiveProfile(config.spec.id)]);
      return parserClass;
    },
  };
}

// WoWCompare: only specs with benchmark/profile support are registered. Other spec
// folders under src/analysis are kept (unregistered) so upstream merges stay clean.
const configs: Config[] = [FeralDruid].map(withLiveProfile);

export default configs;
