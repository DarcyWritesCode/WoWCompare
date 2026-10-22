import Spell from 'common/SPELLS/Spell';

export type TokenKind = 'action' | 'buff' | 'dot';

/** SimC's spell tokens: lowercase, punctuation dropped, spaces to underscores. */
export function simcToken(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 _]/g, '')
    .trim()
    .replace(/[ ]+/g, '_');
}

const KIND_SUFFIX = /_(TALENT|BUFF|DEBUFF|BLEED|DOT)$/;

/** Prefers table keys whose suffix fits the kind, e.g. `RAKE_BLEED` for the `rake` dot. */
const preference: Record<TokenKind, (key: string) => number> = {
  action: (key) => (/_(BUFF|DEBUFF|BLEED|DOT)$/.test(key) ? 2 : /_TALENT$/.test(key) ? 1 : 0),
  buff: (key) => (/_BUFF$/.test(key) ? 0 : /_(DEBUFF|BLEED|DOT)$/.test(key) ? 2 : 1),
  dot: (key) => (/_(DEBUFF|BLEED|DOT)$/.test(key) ? 0 : /_BUFF$/.test(key) ? 2 : 1),
};

export interface Resolver {
  /** Spell IDs for a token (several for aliases like `bs_inc`); empty when unknown. */
  resolve(token: string, kind: TokenKind): number[];
  name(spellId: number): string;
}

export type AliasTable = Record<string, Partial<Record<TokenKind, number[]>>>;

/**
 * Maps SimC tokens to spell IDs by matching names and keys in the spec's spell tables. Aliases
 * cover SimC's own shorthands (`bs_inc`) and spells whose IDs differ by role (dot vs cast).
 */
export function makeResolver(tables: Record<string, Spell>[], aliases: AliasTable): Resolver {
  const byToken = new Map<string, { key: string; spell: Spell }[]>();
  const names = new Map<number, string>();
  for (const table of tables) {
    for (const [key, spell] of Object.entries(table)) {
      names.set(spell.id, spell.name);
      for (const token of new Set([
        simcToken(spell.name),
        key.replace(KIND_SUFFIX, '').toLowerCase(),
      ])) {
        const list = byToken.get(token) ?? [];
        list.push({ key, spell });
        byToken.set(token, list);
      }
    }
  }

  return {
    resolve(token, kind) {
      const alias = aliases[token]?.[kind] ?? aliases[token]?.action;
      if (alias) {
        return alias;
      }
      const candidates = byToken.get(token);
      if (!candidates?.length) {
        return [];
      }
      const best = [...candidates].sort(
        (a, b) => preference[kind](a.key) - preference[kind](b.key),
      );
      return [best[0].spell.id];
    },
    name: (spellId) => names.get(spellId) ?? `Spell ${spellId}`,
  };
}
