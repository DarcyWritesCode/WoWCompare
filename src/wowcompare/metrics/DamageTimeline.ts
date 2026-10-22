import Analyzer, { Options, SELECTED_PLAYER, SELECTED_PLAYER_PET } from 'parser/core/Analyzer';
import Events, { DamageEvent } from 'parser/core/Events';

/** Records the player's (and pets') damage to enemies so window metrics can bucket it later. */
class DamageTimeline extends Analyzer {
  readonly damage: { timestamp: number; amount: number }[] = [];

  constructor(options: Options) {
    super(options);
    this.addEventListener(Events.damage.by(SELECTED_PLAYER | SELECTED_PLAYER_PET), this.onDamage);
  }

  private onDamage(event: DamageEvent) {
    if (event.targetIsFriendly) {
      return;
    }
    this.damage.push({ timestamp: event.timestamp, amount: event.amount + (event.absorbed ?? 0) });
  }
}

export default DamageTimeline;
