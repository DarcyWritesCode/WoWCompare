import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, { AbilityEvent } from 'parser/core/Events';

import { SpellRef } from '../profile/types';
import { simcToken } from '../simc/resolve';

export type CatalogKind = 'cast' | 'buff' | 'debuff';

/**
 * Every spell the player cast, buff they had and debuff they applied, by ID and in-game name.
 * Profiles name spells by token with candidate IDs; this settles which IDs this log actually uses.
 */
class SpellCatalog extends Analyzer {
  private readonly seen: Record<CatalogKind, Map<number, string>> = {
    cast: new Map(),
    buff: new Map(),
    debuff: new Map(),
  };

  constructor(options: Options) {
    super(options);
    this.addEventListener(Events.cast.by(SELECTED_PLAYER), (e) => this.record('cast', e));
    this.addEventListener(Events.applybuff.to(SELECTED_PLAYER), (e) => this.record('buff', e));
    this.addEventListener(Events.applydebuff.by(SELECTED_PLAYER), (e) => this.record('debuff', e));
  }

  private record(kind: CatalogKind, event: AbilityEvent<string>) {
    this.seen[kind].set(event.ability.guid, event.ability.name);
  }

  /**
   * IDs of `kind` seen in this log whose name matches the token or that are candidates.
   * Falls back to the candidates when nothing matching was seen.
   */
  resolve(kind: CatalogKind, ref: SpellRef): number[] {
    const ids = this.matching(kind, ref);
    return ids.length > 0 ? ids : ref.spellIds;
  }

  /** Whether any spell of `kind` matching the ref appeared in the log. */
  seenAny(kind: CatalogKind, ref: SpellRef): boolean {
    return this.matching(kind, ref).length > 0;
  }

  /**
   * Seen IDs that are candidates or whose name is the token. Auras also match variants named
   * `<token> (...)`, since SimC's `eclipse` means either "Eclipse (Solar)" or "Eclipse (Lunar)".
   */
  private matching(kind: CatalogKind, ref: SpellRef): number[] {
    const entries = [...this.seen[kind].entries()];
    const exact = entries
      .filter(([id, name]) => ref.spellIds.includes(id) || simcToken(name) === ref.token)
      .map(([id]) => id);
    if (exact.length > 0 || kind === 'cast' || !ref.token) {
      return exact;
    }
    return entries
      .filter(([, name]) => simcToken(name.replace(/\s*\(.*\)$/, '')) === ref.token)
      .map(([id]) => id);
  }

  name(spellId: number): string | undefined {
    return (
      this.seen.cast.get(spellId) ?? this.seen.buff.get(spellId) ?? this.seen.debuff.get(spellId)
    );
  }
}

export default SpellCatalog;
