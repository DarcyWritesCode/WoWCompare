import { TalentTree } from '../benchmarks/talents';

/** One chunk per spec, loaded when its talent comparison is shown. */
const TREES = import.meta.glob<TalentTree>('./*.json', { import: 'default' });

/** The spec's talent trees; null for a spec the generator didn't cover. */
export async function loadTalentTree(specId: number): Promise<TalentTree | null> {
  const load = TREES[`./${specId}.json`];
  return load ? load() : null;
}
