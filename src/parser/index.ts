import FeralDruid from 'analysis/retail/druid/feral';

import Config from './Config';

// WoWCompare: only specs with benchmark/profile support are registered. Other spec
// folders under src/analysis are kept (unregistered) so upstream merges stay clean.
const configs: Config[] = [FeralDruid];

export default configs;
