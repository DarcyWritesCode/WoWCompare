import { buildProfile, BuiltProfile } from '../simc/buildProfile';
import { fetchLiveApl } from '../simc/source';
import druidFeral from '../simc/specs/druidFeral';
import { SpecAdapter } from '../simc/specs/types';
import { Profile } from './types';

const adapters: SpecAdapter[] = [druidFeral];

const built = new Map<number, BuiltProfile>();
const overrides = new Map<number, Profile>();
const liveLoads = new Map<number, Promise<void>>();

function bundled(adapter: SpecAdapter): BuiltProfile {
  return buildProfile(adapter, adapter.bundledApl, {
    kind: 'simc',
    file: adapter.simcFile,
    url: aplUrl(adapter),
    live: false,
  });
}

export const aplUrl = (adapter: SpecAdapter) =>
  `https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/${adapter.simcFile}.simc`;

/**
 * The profile analyzers should use for `specId`: an explicit selection, else the one built from
 * the live SimC APL if it has loaded (see `loadLiveProfile`), else the bundled APL snapshot.
 */
export function getProfile(specId: number): Profile | undefined {
  return getBuiltProfile(specId)?.profile;
}

export function getBuiltProfile(specId: number): BuiltProfile | undefined {
  const override = overrides.get(specId);
  if (override) {
    return { profile: override, unresolved: [] };
  }
  const existing = built.get(specId);
  if (existing) {
    return existing;
  }
  const adapter = adapters.find((a) => a.specId === specId);
  if (!adapter) {
    return undefined;
  }
  const result = bundled(adapter);
  built.set(specId, result);
  return result;
}

/** Select a profile (e.g. one sent to a parse worker) for its spec; `null` clears it. */
export function setProfile(specId: number, profile: Profile | null) {
  if (profile) {
    overrides.set(specId, profile);
  } else {
    overrides.delete(specId);
  }
}

/**
 * Fetches the spec's current SimC APL and rebuilds its profile from it. Never rejects: on any
 * failure the bundled snapshot stays in use. Runs once per session per spec.
 */
export function loadLiveProfile(specId: number): Promise<void> {
  const adapter = adapters.find((a) => a.specId === specId);
  if (!adapter) {
    return Promise.resolve();
  }
  let load = liveLoads.get(specId);
  if (!load) {
    load = fetchLiveApl(aplUrl(adapter))
      .then((apl) => {
        if (apl) {
          built.set(
            specId,
            buildProfile(adapter, apl.text, {
              kind: 'simc',
              file: adapter.simcFile,
              url: aplUrl(adapter),
              live: true,
              retrievedAt: apl.retrievedAt,
            }),
          );
        }
      })
      .catch((err) => console.warn('SimC APL profile failed, using the bundled APL', err));
    liveLoads.set(specId, load);
  }
  return load;
}
