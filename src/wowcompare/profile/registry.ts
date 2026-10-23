import { fetchPublishedProfile } from '../benchmarks/published';
import { buildProfile, BuiltProfile } from '../simc/buildProfile';
import { fetchLiveApl } from '../simc/source';
import { getAdapter } from '../simc/specs';
import { SpecAdapter } from '../simc/specs/types';
import { applyCustomization, readCustomization } from './customizations';
import { Profile } from './types';

/** Bundled APL snapshots, loaded only when the live copy can't be fetched. */
const bundledApls = import.meta.glob<string>('../simc/bundled/*.simc', {
  query: '?raw',
  import: 'default',
});

const built = new Map<number, BuiltProfile>();
const overrides = new Map<number, Profile>();
const loads = new Map<number, Promise<void>>();

/**
 * SimC's default branch (`HEAD`), which tracks the current expansion. Old expansion branches stay
 * up, so naming one here would keep serving a stale APL after the next expansion.
 */
export const aplUrl = (adapter: SpecAdapter) =>
  `https://raw.githubusercontent.com/simulationcraft/simc/HEAD/ActionPriorityLists/default/${adapter.simcFile}.simc`;

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

/** Builds the profile and layers on any suggestions the viewer accepted for this spec. */
function build(adapter: SpecAdapter, text: string, source: Parameters<typeof buildProfile>[2]) {
  const result = buildProfile(adapter, text, source);
  return {
    ...result,
    profile: applyCustomization(result.profile, readCustomization(adapter.specId)),
  };
}

async function load(adapter: SpecAdapter) {
  // The benchmark job's profile first: the published benchmark snapshots were parsed with it, so
  // they can be reused as-is (unless the viewer customized the profile).
  const published = await fetchPublishedProfile(adapter.specId);
  if (published) {
    built.set(adapter.specId, {
      profile: applyCustomization(published.profile, readCustomization(adapter.specId)),
      unresolved: published.unresolved,
    });
    return;
  }

  const url = aplUrl(adapter);
  const source = { kind: 'simc' as const, file: adapter.simcFile, url };
  const live = await fetchLiveApl(url);
  if (live) {
    built.set(
      adapter.specId,
      build(adapter, live.text, { ...source, live: true, retrievedAt: live.retrievedAt }),
    );
    return;
  }
  const bundled = bundledApls[`../simc/bundled/${adapter.simcFile}.simc`];
  if (bundled) {
    built.set(adapter.specId, build(adapter, await bundled(), { ...source, live: false }));
  }
}

/**
 * Loads the spec's profile: the published one (rebuilt weekly), else built from SimC's current APL, else
 * from the bundled snapshot. Never rejects; runs once per session per spec. Skipped when a profile
 * was selected with `setProfile` (parse workers, the benchmark job), which takes precedence anyway.
 */
export function loadProfile(specId: number): Promise<void> {
  const adapter = getAdapter(specId);
  if (!adapter || !hasSimcApl(specId) || overrides.has(specId)) {
    return Promise.resolve();
  }
  let pending = loads.get(specId);
  if (!pending) {
    pending = load(adapter).catch((err) => console.warn('Building the SimC profile failed', err));
    loads.set(specId, pending);
  }
  return pending;
}
