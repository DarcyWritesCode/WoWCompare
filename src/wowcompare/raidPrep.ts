import { eventItemGemSocketCount } from 'common/ITEMS/thewarwithin/socketBonusId';
import { captureException } from 'common/errorLogger';
import { fetchCombatants, fetchEvents } from 'common/fetchWclApi';
import FLASKS from 'common/SPELLS/midnight/flasks';
import GEAR_SLOTS from 'game/GEAR_SLOTS';
import { CastEvent, CombatantInfoEvent, EventType, Item } from 'parser/core/Events';
import { COMBAT_POTIONS } from 'parser/retail/modules/items/PotionChecker';
import { useEffect, useState } from 'react';

/**
 * WoWCompare: the raid's preparation for a fight, for the player selection page. Flasks, gems and
 * enchants come from each player's combatantinfo (their buffs and gear at the pull); potions from
 * combat potion casts in the fight, plus a potion buff already up at the pull (a prepot).
 */

const FLASK_IDS = new Set(Object.values(FLASKS).map((flask) => flask.id));
const POTION_IDS = new Set(COMBAT_POTIONS);

/** The slots Midnight enchants, by gear index. An off hand counts only when it's a weapon. */
const ENCHANT_SLOTS: [number, string][] = [
  [GEAR_SLOTS.HEAD, 'head'],
  [GEAR_SLOTS.SHOULDER, 'shoulders'],
  [GEAR_SLOTS.CHEST, 'chest'],
  [GEAR_SLOTS.LEGS, 'legs'],
  [GEAR_SLOTS.FEET, 'boots'],
  [GEAR_SLOTS.FINGER1, 'ring'],
  [GEAR_SLOTS.FINGER2, 'ring'],
  [GEAR_SLOTS.MAINHAND, 'weapon'],
  [GEAR_SLOTS.OFFHAND, 'off hand'],
];

export interface PlayerPrep {
  id: number;
  flask: boolean;
  potions: number;
  /** Slot names, one per unenchanted item. */
  missingEnchants: string[];
  emptySockets: number;
}

/** Shields and held-in-off-hand items take no enchant; the same test as EnchantChecker's. */
const isEnchantable = (item: Item | undefined): item is Item =>
  Boolean(item) &&
  item!.id !== 0 &&
  !item!.icon.includes('offhand') &&
  !item!.icon.includes('shield');

function playerPrep(info: CombatantInfoEvent, potionCasts: number): PlayerPrep {
  const auras = info.auras ?? [];
  const prepot = auras.some((aura) => POTION_IDS.has(aura.ability));
  return {
    id: info.sourceID,
    flask: auras.some((aura) => FLASK_IDS.has(aura.ability)),
    potions: potionCasts + (prepot ? 1 : 0),
    missingEnchants: ENCHANT_SLOTS.filter(([slot]) => {
      const item = info.gear[slot];
      return isEnchantable(item) && !item.permanentEnchant;
    }).map(([, name]) => name),
    emptySockets: info.gear.reduce(
      (sum, item) => sum + Math.max(0, eventItemGemSocketCount(item) - (item.gems?.length ?? 0)),
      0,
    ),
  };
}

async function fetchRaidPrep(reportCode: string, start: number, end: number) {
  const [combatants, potions] = await Promise.all([
    fetchCombatants(reportCode, start, end),
    fetchEvents(
      reportCode,
      start,
      end,
      undefined,
      `type="cast" and ability.id in (${COMBAT_POTIONS.join(',')})`,
    ),
  ]);
  const casts = new Map<number, number>();
  for (const event of potions as CastEvent[]) {
    casts.set(event.sourceID, (casts.get(event.sourceID) ?? 0) + 1);
  }
  return combatants
    .filter((event): event is CombatantInfoEvent => event.type === EventType.CombatantInfo)
    .map((info) => playerPrep(info, casts.get(info.sourceID) ?? 0));
}

export type RaidPrep = { state: 'loading' } | { state: 'done'; players: PlayerPrep[] | null };

/** Each player's preparation for the fight; null when it can't load. */
export function useRaidPrep(reportCode: string, start: number, end: number): RaidPrep {
  const [result, setResult] = useState<RaidPrep>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setResult({ state: 'loading' });
    fetchRaidPrep(reportCode, start, end).then(
      (players) => !cancelled && setResult({ state: 'done', players }),
      (err) => {
        captureException(err as Error);
        if (!cancelled) {
          setResult({ state: 'done', players: null });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reportCode, start, end]);
  return result;
}
