import Analyzer, { Options, SELECTED_PLAYER, SELECTED_PLAYER_PET } from 'parser/core/Analyzer';
import Events, { CastEvent, DamageEvent } from 'parser/core/Events';

/**
 * Records the player's (and pets') damage to enemies, and the player's casts, so window metrics
 * and the window timelines can slice them later.
 */
class DamageTimeline extends Analyzer {
  readonly damage: { timestamp: number; amount: number; spellId: number }[] = [];
  readonly casts: {
    timestamp: number;
    spellId: number;
    targetID?: number;
    targetInstance?: number;
    /** The player's resources as of the cast, e.g. Astral Power before a cooldown. */
    resources?: { type: number; amount: number; max: number }[];
  }[] = [];
  /** In-game names of every spell seen in `damage` and `casts`. */
  readonly names = new Map<number, string>();

  constructor(options: Options) {
    super(options);
    this.addEventListener(Events.damage.by(SELECTED_PLAYER | SELECTED_PLAYER_PET), this.onDamage);
    this.addEventListener(Events.cast.by(SELECTED_PLAYER), this.onCast);
  }

  private onCast(event: CastEvent) {
    this.names.set(event.ability.guid, event.ability.name);
    this.casts.push({
      timestamp: event.timestamp,
      spellId: event.ability.guid,
      targetID: event.targetID,
      targetInstance: event.targetInstance,
      resources: event.classResources?.map(({ type, amount, max }) => ({ type, amount, max })),
    });
  }

  private onDamage(event: DamageEvent) {
    if (event.targetIsFriendly) {
      return;
    }
    this.names.set(event.ability.guid, event.ability.name);
    this.damage.push({
      timestamp: event.timestamp,
      amount: event.amount + (event.absorbed ?? 0),
      spellId: event.ability.guid,
    });
  }
}

export default DamageTimeline;
