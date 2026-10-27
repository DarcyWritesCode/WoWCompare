import { LogSnapshot } from '../metrics/results';
import { Profile } from '../profile/types';
import type { RankedParse } from './rankings';
import type { BuffEffects } from './buffEffects';
import type { ReferenceBand } from './reference';

/**
 * Data the benchmark job (scripts/benchmarks/) publishes, read-only to the app: each spec's
 * profile; per spec, boss and difficulty the rankings plus the parsed #1 and reference logs
 * (packed per spec and difficulty); and a status summary for the specs page. Each class is rebuilt weekly (see schedule.ts).
 * Served by a Cloudflare Pages Function (functions/wc-api/) from KV, and in development by the
 * dev server (vite/publishedDataPlugin.ts) from the job's `--local` output.
 */

/**
 * Bump whenever `LogSnapshot` or the metrics behind it change, so snapshots from older code are
 * never used.
 */
export const SNAPSHOT_VERSION = 6;

/**
 * Bump when what the status records changes meaning, e.g. how reference logs are chosen or when a
 * spec counts as complete. The job then ignores the old status, so every spec is due for a rebuild.
 */
export const STATUS_VERSION = 2;

export interface PublishedProfile {
  snapshotVersion: number;
  profile: Profile;
  /** SimC tokens the builder couldn't map to spells. */
  unresolved: string[];
  builtAt: number;
  /** The SimC commit that last changed the APL file; null if GitHub couldn't be asked. */
  aplCommit: AplCommit | null;
}

export interface AplCommit {
  sha: string;
  /** ISO date. */
  date: string;
}

export interface BenchmarkBundle {
  snapshotVersion: number;
  specId: number;
  encounterId: number;
  difficulty: number;
  builtAt: number;
  /** `profileFingerprint` of the profile the snapshots were parsed with. */
  profileFingerprint: string;
  top: RankedParse | undefined;
  /** Ranked parses around the reference rank, best first. */
  pool: RankedParse[];
  totalParses: number | null;
  /** Talents of the top 100 parses; missing from bundles built before the talent comparison. */
  topTalents?: string[][];
  /** The reference candidates the job parsed. */
  reference: ReferenceBand;
  /** Parsed logs (the #1 and the reference candidates), by `logKey`. */
  snapshots: Record<string, LogSnapshot>;
}

/** One spec, boss and difficulty in the status summary. */
export interface BundleStatus {
  encounterId: number;
  encounterName: string | null;
  difficulty: number;
  builtAt: number;
  totalParses: number | null;
  /** Rank range of the reference candidates. */
  ranks: [number, number] | null;
  /** Reference candidates parsed, of which externally buffed, and those that failed. */
  logs: number;
  buffed: number;
  failed: number;
}

export interface SpecStatus {
  specId: number;
  profileBuiltAt: number;
  aplCommit: AplCommit | null;
  /** When the job last got through every boss for this spec; null while incomplete. */
  completedAt: number | null;
  bundles: BundleStatus[];
}

/** What the job last did for each spec, for the specs page. */
export interface BenchmarkStatus {
  snapshotVersion: number;
  version: number;
  updatedAt: number;
  /** By spec ID. */
  specs: Record<string, SpecStatus>;
}

/** Storage keys, shared by the job, the Pages Function and the dev server. */
export const profileKey = (specId: number) => `profile-${specId}`;
/**
 * A spec's bundles for one difficulty, packed in one value so a rebuild costs one KV write (the
 * free plan allows 1,000 a day). The value is a JSON object by encounter ID; its metadata holds a
 * `PackIndex`, so the Pages Function serves one boss by slicing bytes instead of parsing ~10 MB.
 */
export const packKey = (specId: number, difficulty: number) => `pack-${specId}-${difficulty}`;

/** UTF-8 byte range `[start, end)` of each encounter's bundle in a pack, by encounter ID. */
export type PackIndex = Record<string, [number, number]>;

export const STATUS_KEY = 'status';
export const effectsKey = (specId: number) => `effects-${specId}`;

export const logKey = (ref: { reportCode: string; fightId: number; playerName: string }) =>
  `${ref.reportCode}:${ref.fightId}:${ref.playerName}`;

/** FNV-1a, hex. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Identifies what a profile measures (its entries and rules), so snapshots are only reused with
 * the profile they were parsed with. Customized profiles get a different fingerprint.
 */
export const profileFingerprint = (profile: Profile) =>
  fnv1a(JSON.stringify({ e: profile.entries, r: profile.rules }));

const ENDPOINT = '/wc-api';
/** Published data is a shortcut; don't hold up the analysis waiting for it. */
const FETCH_TIMEOUT_MS = 5_000;

async function getJson<T>(path: string): Promise<T | null> {
  if (import.meta.env.MODE === 'test') {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}/${path}`, { signal: controller.signal });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The spec's published profile, or null if none is published for this code version. */
export async function fetchPublishedProfile(specId: number): Promise<PublishedProfile | null> {
  const published = await getJson<PublishedProfile>(`profiles/${specId}`);
  return published?.snapshotVersion === SNAPSHOT_VERSION && published.profile.specId === specId
    ? published
    : null;
}

/** The rankings and parsed reference logs for a boss, or null if none are published. */
export async function fetchBenchmarkBundle(
  specId: number,
  encounterId: number,
  difficulty: number,
): Promise<BenchmarkBundle | null> {
  const bundle = await getJson<BenchmarkBundle>(
    `benchmarks/${specId}/${encounterId}/${difficulty}`,
  );
  return bundle?.snapshotVersion === SNAPSHOT_VERSION ? bundle : null;
}

export const isCurrentStatus = (status: BenchmarkStatus | null): status is BenchmarkStatus =>
  status?.snapshotVersion === SNAPSHOT_VERSION && status.version === STATUS_VERSION;

/** The job's status summary, or null if none is published. */
export async function fetchBenchmarkStatus(): Promise<BenchmarkStatus | null> {
  const status = await getJson<BenchmarkStatus>(STATUS_KEY);
  return isCurrentStatus(status) ? status : null;
}

/** The spec's measured buff effects, or null if none are published. */
export const fetchBuffEffects = (specId: number) => getJson<BuffEffects>(`effects/${specId}`);
