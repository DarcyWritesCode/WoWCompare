import { RankedParse, RankingsPool } from './rankings';
import { ReferenceBand, selectReference } from './reference';

/** The analyzed log's context, matched against ranked parses. */
export interface PlayerContext {
  ilvl: number;
  durationMs: number;
  raidSize: number;
  /** Same `talentID:points` format as `RankedParse.talents`. */
  talents: string[];
}

export interface CloseBounds {
  ilvl: number;
  /** Fraction of the player's kill time, e.g. 0.2 = ±20%. */
  duration: number;
  raidSize: number;
}

export const DEFAULT_CLOSE_BOUNDS: CloseBounds = { ilvl: 5, duration: 0.2, raidSize: 5 };

/** Parses in the "close" median. */
export const CLOSE_COUNT = 10;

/** Below this talent similarity a "same build" match is shown as approximate. */
export const SAME_BUILD_THRESHOLD = 0.95;

export interface BuildMatch {
  parse: RankedParse;
  similarity: number;
}

export interface CloseMatch {
  parse: RankedParse;
  /** False when the pool had too few parses in bounds and this one was filled in by distance. */
  withinBounds: boolean;
}

export interface BenchmarkSelection {
  /** The #1 parse, shown as the ceiling; nothing is scored against it once the reference loads. */
  top: RankedParse | undefined;
  /** The parses spread over `REFERENCE_BAND` the player is scored against. */
  reference: ReferenceBand;
  sameBuild: BuildMatch | undefined;
  bestClose: CloseMatch | undefined;
  /** Up to `CLOSE_COUNT` parses closest to the player's ilvl, kill time and raid size. */
  close: CloseMatch[];
}

/** Jaccard similarity of two talent sets (1 = identical build). */
export function talentSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const shared = b.filter((talent) => setA.has(talent)).length;
  const union = setA.size + b.length - shared;
  return union === 0 ? 0 : shared / union;
}

function withinBounds(parse: RankedParse, player: PlayerContext, bounds: CloseBounds) {
  return (
    Math.abs(parse.ilvl - player.ilvl) <= bounds.ilvl &&
    Math.abs(parse.durationMs - player.durationMs) <= bounds.duration * player.durationMs &&
    Math.abs(parse.raidSize - player.raidSize) <= bounds.raidSize
  );
}

/** Distance in units of each bound, so the three criteria weigh equally. */
function closeness(parse: RankedParse, player: PlayerContext, bounds: CloseBounds) {
  return (
    Math.abs(parse.ilvl - player.ilvl) / bounds.ilvl +
    Math.abs(parse.durationMs - player.durationMs) / (bounds.duration * player.durationMs) +
    Math.abs(parse.raidSize - player.raidSize) / bounds.raidSize
  );
}

/**
 * Picks the five benchmarks. Same build and close parses come from the rankings pages covering
 * the reference band, so they're held to the same realistic level.
 */
export function selectBenchmarks(
  { top, pool, totalParses }: RankingsPool,
  player: PlayerContext,
  bounds: CloseBounds = DEFAULT_CLOSE_BOUNDS,
): BenchmarkSelection {
  let sameBuild: BuildMatch | undefined;
  for (const parse of pool) {
    const similarity = talentSimilarity(player.talents, parse.talents);
    if (!sameBuild || similarity > sameBuild.similarity) {
      sameBuild = { parse, similarity };
    }
    if (similarity >= SAME_BUILD_THRESHOLD) {
      break; // the pool is best first, so the first close-enough build is the best one
    }
  }

  const inBounds = pool.filter((parse) => withinBounds(parse, player, bounds));
  const fill = pool
    .filter((parse) => !inBounds.includes(parse))
    .sort((a, b) => closeness(a, player, bounds) - closeness(b, player, bounds));
  const close: CloseMatch[] = [
    ...inBounds.map((parse) => ({ parse, withinBounds: true })),
    ...fill.map((parse) => ({ parse, withinBounds: false })),
  ].slice(0, CLOSE_COUNT);

  return {
    top,
    reference: selectReference(pool, totalParses),
    sameBuild,
    bestClose: close[0],
    close,
  };
}
