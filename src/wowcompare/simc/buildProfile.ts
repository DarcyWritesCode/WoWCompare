import { CastRule, Profile, ProfileEntry, ProfileSource, SpellRef } from '../profile/types';
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
 * procs it waits for, ranked in APL order, plus "cast X while Y" rules. Spell IDs are only
 * candidates: analyzers settle them against the spells seen in each log. The APL says
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
  /** Display name for a spell: from the tables if known, else the token in title case. */
  const describe = (spell: SpellRef) =>
    spell.spellIds.length > 0 && !(spell.token in adapter.aliases)
      ? resolver.name(spell.spellIds[0])
      : spell.spellIds.length > 0
        ? spell.spellIds.map((id) => resolver.name(id)).join(' / ')
        : spell.token.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

  const ref = (token: string, kind: 'action' | 'buff' | 'dot'): SpellRef => ({
    token,
    spellIds: resolve(token, kind),
  });

  type Candidate = { order: number; entry: Omit<ProfileEntry, 'rank'> };
  const candidates: Candidate[] = [
    ...summary.cooldowns.map((cd) => ({
      order: cd.order,
      entry: {
        ...ref(cd.token, 'action'),
        kind: 'cooldown' as const,
        metrics: ['cooldownUsage' as const, 'windowDps' as const],
        windowMs: adapter.windowMs?.[cd.token],
      },
    })),
    ...summary.dots.map((dot) => ({
      order: dot.order,
      entry: {
        ...ref(dot.token, 'dot'),
        kind: 'debuff' as const,
        metrics: ['uptime' as const],
        requires: { token: dot.token, spellIds: resolver.resolve(dot.token, 'action') },
      },
    })),
    ...summary.procs.map((proc) => ({
      order: proc.order,
      entry: {
        ...ref(proc.token, 'buff'),
        kind: 'buff' as const,
        // Uptime too: some "procs" are states the APL waits for (e.g. Eclipse), not spendables.
        metrics: ['procUsage' as const, 'uptime' as const],
        consumers: [
          ...proc.consumers.map((c) => ref(c, 'action')),
          // Extra consumers are exact IDs; an empty token never matches a spell name.
          ...(adapter.extraConsumers?.[proc.token] ?? []).map((id) => ({
            token: '',
            spellIds: [id],
          })),
        ],
      },
    })),
  ].sort((a, b) => a.order - b.order);

  // Alias tokens (e.g. `bs_inc` and `berserk`) name the same spells; keep the first.
  const seen = new Set<string>();
  const entries: ProfileEntry[] = candidates
    .filter(({ entry }) => {
      const key = `${entry.kind}:${entry.spellIds.length > 0 ? [...entry.spellIds].sort().join(',') : entry.token}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((candidate, i) => ({ ...candidate.entry, rank: i + 1 }));

  const rules: CastRule[] = summary.rules.map((aplRule, i) => {
    const onCast = ref(aplRule.token, 'action');
    const require = aplRule.requires.map((req) => ({
      aura: ref(req.token, req.on === 'player' ? 'buff' : 'dot'),
      on: req.on,
      present: req.present,
    }));
    const conditions = require
      .map((r) => `${describe(r.aura)} is ${r.present ? 'up' : 'down'}`)
      .join(' and ');
    return {
      id: `${aplRule.token}-${aplRule.strict ? 'requires' : 'prefers'}-${aplRule.requires.map((r) => r.token).join('-')}`,
      description: `${describe(onCast)} cast while ${conditions}`,
      strict: aplRule.strict,
      rank: i + 1,
      onCast,
      require,
    };
  });

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
