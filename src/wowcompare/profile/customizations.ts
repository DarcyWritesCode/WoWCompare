import { entryKey, Profile, ProfileEntry } from './types';

/**
 * Suggestions a viewer accepted for a spec, kept in this browser until profiles are stored
 * server-side (Phase 5): extra entries to track and a preferred entry order.
 */
export interface Customization {
  extraEntries: Omit<ProfileEntry, 'rank'>[];
  /**
   * Entries by `entryKey`, most important first; entries not listed keep their order after
   * these. Saved before keys had a kind, an item may be a bare token, which matches every kind.
   */
  rankOrder?: string[];
}

const key = (specId: number) => `wowcompare:customization:${specId}`;

export function readCustomization(specId: number): Customization | null {
  try {
    const raw = window.localStorage.getItem(key(specId));
    return raw ? (JSON.parse(raw) as Customization) : null;
  } catch {
    return null;
  }
}

export function writeCustomization(specId: number, customization: Customization | null) {
  try {
    if (customization) {
      window.localStorage.setItem(key(specId), JSON.stringify(customization));
    } else {
      window.localStorage.removeItem(key(specId));
    }
  } catch {
    // storage blocked: the suggestion just isn't remembered
  }
}

/** The profile with a customization's extra entries appended and its order applied. */
export function applyCustomization(profile: Profile, customization: Customization | null): Profile {
  if (!customization) {
    return profile;
  }
  const keys = new Set(profile.entries.map(entryKey));
  const entries = [
    ...profile.entries,
    ...customization.extraEntries
      .filter((e) => !keys.has(entryKey(e)))
      .map((e) => ({ ...e, rank: 0 })),
  ];
  const order = customization.rankOrder ?? [];
  const position = (entry: ProfileEntry) => {
    const exact = order.indexOf(entryKey(entry));
    const i = exact !== -1 ? exact : order.indexOf(entry.token);
    return i === -1 ? order.length + entries.indexOf(entry) : i;
  };
  return {
    ...profile,
    entries: [...entries]
      .sort((a, b) => position(a) - position(b))
      .map((entry, i) => ({ ...entry, rank: i + 1 })),
  };
}
