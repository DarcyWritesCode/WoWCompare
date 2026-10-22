import { CastRule, Profile, ProfileEntry, ProfileSource } from '../profile/types';
import { summarizeApl } from './extract';
import { makeResolver } from './resolve';
import { SpecAdapter } from './specs/types';

export interface BuiltProfile {
  profile: Profile;
  /** SimC tokens that couldn't be mapped to spells (dropped from the profile). */
  unresolved: string[];
}

/** Stable 32-bit hash of the APL text, used as the profile version. */
function hash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Turns a SimC APL into an importance profile: its cooldowns, the dots it keeps refreshed and the
 * procs it waits for, ranked in APL order, plus "cast X while Y" rules for cooldowns. The APL says
 * nothing about thresholds; those come from benchmarks (see `rescoreAgainst`).
 */
export function buildProfile(
  adapter: SpecAdapter,
  aplText: string,
  source: ProfileSource,
): BuiltProfile {
  const summary = summarizeApl(aplText);
  const resolver = makeResolver(adapter.tables, adapter.aliases);
  const unresolved = new Set<string>();
  const resolve = (token: string, kind: 'action' | 'buff' | 'dot') => {
    const ids = resolver.resolve(token, kind);
    if (ids.length === 0) {
      unresolved.add(token);
    }
    return ids;
  };

  type Candidate = { order: number; entries: Omit<ProfileEntry, 'rank'>[] };
  const candidates: Candidate[] = [
    ...summary.cooldowns.map((cd) => ({
      order: cd.order,
      entries: resolve(cd.token, 'action').map((spellId) => ({
        spellId,
        kind: 'cooldown' as const,
        metrics: ['cooldownUsage' as const, 'windowDps' as const],
        windowMs: adapter.windowMs?.[cd.token],
      })),
    })),
    ...summary.dots.map((dot) => ({
      order: dot.order,
      entries: resolve(dot.token, 'dot').map((spellId) => ({
        spellId,
        kind: 'debuff' as const,
        metrics: ['uptime' as const],
        requiresSpellIds: resolver.resolve(dot.token, 'action'),
      })),
    })),
    ...summary.procs.map((proc) => ({
      order: proc.order,
      entries: resolve(proc.token, 'buff').map((spellId) => ({
        spellId,
        kind: 'buff' as const,
        metrics: ['procUsage' as const],
        consumerSpellIds: [
          ...new Set([
            ...proc.consumers.flatMap((c) => resolve(c, 'action')),
            ...(adapter.extraConsumers?.[proc.token] ?? []),
          ]),
        ],
      })),
    })),
  ].sort((a, b) => a.order - b.order);

  // Aliases (bs_inc and berserk) can produce the same spell twice; keep the first.
  const seen = new Set<string>();
  const entries: ProfileEntry[] = [];
  let rank = 0;
  for (const candidate of candidates) {
    const fresh = candidate.entries.filter((e) => !seen.has(`${e.kind}:${e.spellId}`));
    if (fresh.length === 0) {
      continue;
    }
    rank += 1;
    for (const entry of fresh) {
      seen.add(`${entry.kind}:${entry.spellId}`);
      entries.push({ ...entry, rank });
    }
  }

  const rules: CastRule[] = summary.rules
    .map((aplRule, i) => {
      const onCast = resolve(aplRule.token, 'action');
      const require = aplRule.requires.map((req) => ({
        auraIds: resolve(req.token, req.on === 'player' ? 'buff' : 'dot'),
        on: req.on,
        present: req.present,
      }));
      const describe = (ids: number[]) => ids.map((id) => resolver.name(id)).join(' / ');
      const conditions = require
        .map((r) => `${describe(r.auraIds)} is ${r.present ? 'up' : 'down'}`)
        .join(' and ');
      return {
        id: `${aplRule.token}-${aplRule.strict ? 'requires' : 'prefers'}-${aplRule.requires.map((r) => r.token).join('-')}`,
        description: `${describe(onCast)} cast while ${conditions}`,
        strict: aplRule.strict,
        rank: i + 1,
        onCast,
        require,
      };
    })
    .filter((rule) => rule.onCast.length > 0 && rule.require.every((r) => r.auraIds.length > 0));

  return {
    profile: {
      id: `simc-${adapter.simcFile}`,
      name: `SimC ${adapter.simcFile} APL`,
      specId: adapter.specId,
      source,
      version: hash(aplText),
      entries,
      rules,
      heroTrees: adapter.heroTrees,
    },
    unresolved: [...unresolved],
  };
}
