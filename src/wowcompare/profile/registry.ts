import { buildProfile, BuiltProfile } from '../simc/buildProfile';
import { fetchLiveApl } from '../simc/source';
import { getAdapter } from '../simc/specs';
import { SpecAdapter } from '../simc/specs/types';
import { Profile } from './types';

/** Bundled APL snapshots, loaded only when the live copy can't be fetched. */
const bundledApls = import.meta.glob<string>('../simc/bundled/*.simc', {
  query: '?raw',
  import: 'default',
});

const built = new Map<number, BuiltProfile>();
const overrides = new Map<number, Profile>();
const loads = new Map<number, Promise<void>>();

export const aplUrl = (adapter: SpecAdapter) =>
  `https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/${adapter.simcFile}.simc`;

/** Whether SimC publishes a default APL for this spec (most healers have none). */
export function hasSimcApl(specId: number): boolean {
  const adapter = getAdapter(specId);
  return adapter !== undefined && `../simc/bundled/${adapter.simcFile}.simc` in bundledApls;
}

/**
 * The profile analyzers should use for `specId`: an explicit selection, else the one built from
 * the spec's SimC APL. Undefined until `loadProfile` has finished, or if the spec has no APL.
 */
export function getProfile(specId: number): Profile | undefined {
  return getBuiltProfile(specId)?.profile;
}

export function getBuiltProfile(specId: number): BuiltProfile | undefined {
  const override = overrides.get(specId);
  return override ? { profile: override, unresolved: [] } : built.get(specId);
}

/** Select a profile (e.g. one sent to a parse worker) for its spec; `null` clears it. */
export function setProfile(specId: number, profile: Profile | null) {
  if (profile) {
    overrides.set(specId, profile);
  } else {
    overrides.delete(specId);
  }
}

async function load(adapter: SpecAdapter) {
  const url = aplUrl(adapter);
  const source = { kind: 'simc' as const, file: adapter.simcFile, url };
  const live = await fetchLiveApl(url);
  if (live) {
    built.set(
      adapter.specId,
      buildProfile(adapter, live.text, { ...source, live: true, retrievedAt: live.retrievedAt }),
    );
    return;
  }
  const bundled = bundledApls[`../simc/bundled/${adapter.simcFile}.simc`];
  if (bundled) {
    built.set(adapter.specId, buildProfile(adapter, await bundled(), { ...source, live: false }));
  }
}

/**
 * Builds the spec's profile from its current SimC APL (falling back to the bundled snapshot).
 * Never rejects; runs once per session per spec.
 */
export function loadProfile(specId: number): Promise<void> {
  const adapter = getAdapter(specId);
  if (!adapter || !hasSimcApl(specId)) {
    return Promise.resolve();
  }
  let pending = loads.get(specId);
  if (!pending) {
    pending = load(adapter).catch((err) => console.warn('Building the SimC profile failed', err));
    loads.set(specId, pending);
  }
  return pending;
}
