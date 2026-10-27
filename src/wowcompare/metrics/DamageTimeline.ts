import Analyzer, { Options, SELECTED_PLAYER, SELECTED_PLAYER_PET } from 'parser/core/Analyzer';
import Events, { CastEvent, DamageEvent, ResourceActor } from 'parser/core/Events';

/**
 * Records the player's (and pets') damage to enemies, and the player's casts, so window metrics
 * and the window timelines can slice them later.
 */
class DamageTimeline extends Analyzer {
  readonly damage: {
    timestamp: number;
    amount: number;
    spellId: number;
    targetID: number;
    targetInstance?: number;
    /** Spell school bitmask; 1 is physical. */
    school: number;
  }[] = [];
  readonly casts: {
    timestamp: number;
    spellId: number;
    targetID?: number;
    targetInstance?: number;
    /** The player's resources as of the cast, e.g. Astral Power before a cooldown. */
    resources?: { type: number; amount: number; max: number; cost?: number }[];
  }[] = [];
  /** In-game names of every spell seen in `damage` and `casts`. */
  readonly names = new Map<number, string>();
  /** The largest enemy max HP the player hit: the boss, for "damage as a share of boss HP". */
  maxEnemyHp = 0;

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
      resources: event.classResources?.map(({ type, amount, max, cost }) => ({
        type,
        amount,
        max,
        cost,
      })),
    });
  }

  private onDamage(event: DamageEvent) {
    if (event.targetIsFriendly) {
      return;
    }
    this.names.set(event.ability.guid, event.ability.name);
    if (event.maxHitPoints && event.resourceActor !== ResourceActor.Source) {
      this.maxEnemyHp = Math.max(this.maxEnemyHp, event.maxHitPoints);
    }
    this.damage.push({
      timestamp: event.timestamp,
      amount: event.amount + (event.absorbed ?? 0),
      spellId: event.ability.guid,
      targetID: event.targetID,
      targetInstance: event.targetInstance,
      school: event.ability.type,
    });
  }
}

export default DamageTimeline;
