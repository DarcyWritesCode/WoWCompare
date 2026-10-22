import Analyzer, { Options, SELECTED_PLAYER, SELECTED_PLAYER_PET } from 'parser/core/Analyzer';
import Events, { CastEvent, DamageEvent } from 'parser/core/Events';

/**
 * Records the player's (and pets') damage to enemies, and the player's casts, so window metrics
 * and the window timelines can slice them later.
 */
class DamageTimeline extends Analyzer {
  readonly damage: { timestamp: number; amount: number }[] = [];
  readonly casts: { timestamp: number; spellId: number }[] = [];

  constructor(options: Options) {
    super(options);
    this.addEventListener(Events.damage.by(SELECTED_PLAYER | SELECTED_PLAYER_PET), this.onDamage);
    this.addEventListener(Events.cast.by(SELECTED_PLAYER), this.onCast);
  }

  private onCast(event: CastEvent) {
    this.casts.push({ timestamp: event.timestamp, spellId: event.ability.guid });
  }

  private onDamage(event: DamageEvent) {
    if (event.targetIsFriendly) {
      return;
    }
    this.damage.push({ timestamp: event.timestamp, amount: event.amount + (event.absorbed ?? 0) });
  }
}

export default DamageTimeline;
