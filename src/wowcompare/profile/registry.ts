import FERAL_STARTER_PROFILE from './feral';
import { Profile } from './types';

const defaults: Profile[] = [FERAL_STARTER_PROFILE];
const overrides = new Map<number, Profile>();

/** The profile analyzers should use for `specId`: an explicit selection, else the default. */
export function getProfile(specId: number): Profile | undefined {
  return overrides.get(specId) ?? defaults.find((profile) => profile.specId === specId);
}

/** Select a profile (e.g. one loaded from the backend) for its spec; `null` restores the default. */
export function setProfile(specId: number, profile: Profile | null) {
  if (profile) {
    overrides.set(specId, profile);
  } else {
    overrides.delete(specId);
  }
}
