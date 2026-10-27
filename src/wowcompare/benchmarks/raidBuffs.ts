import { PRIMARY_STAT } from 'parser/shared/modules/features/STAT';

/**
 * WoWCompare: raid buffs and debuffs, by the class that brings them, with a rough share of DPS each
 * is worth to a player it applies to. Used to split the "everything hits softer" gap into what
 * raid comp explains; the reference raids (20+ players in the 90-95th percentile) are taken to have
 * them all. The figures are deliberately round: they name the likely cause, they aren't a sim.
 */
export interface RaidBuff {
  name: string;
  /** PlayerDetails `className` of the class that brings it. */
  className: string;
  /** Share of DPS it adds for a player it fully applies to. */
  value: number;
  /** Applies only to these primary stats, or to magic or physical damage (scaled by its share). */
  appliesTo?: { stat?: string[]; school?: 'magic' | 'physical' };
}

export const RAID_BUFFS: RaidBuff[] = [
  { name: 'Chaos Brand', className: 'DemonHunter', value: 0.03, appliesTo: { school: 'magic' } },
  { name: 'Mystic Touch', className: 'Monk', value: 0.05, appliesTo: { school: 'physical' } },
  { name: 'Mark of the Wild', className: 'Druid', value: 0.03 },
  {
    name: 'Arcane Intellect',
    className: 'Mage',
    value: 0.03,
    appliesTo: { stat: [PRIMARY_STAT.INTELLECT] },
  },
  {
    name: 'Battle Shout',
    className: 'Warrior',
    value: 0.04,
    appliesTo: { stat: [PRIMARY_STAT.AGILITY, PRIMARY_STAT.STRENGTH] },
  },
  { name: 'Skyfury', className: 'Shaman', value: 0.015 },
  { name: "Hunter's Mark", className: 'Hunter', value: 0.01 },
];

/** The raid buffs a player's raid lacked, with what each is worth to them. */
export function missingRaidBuffs(raid: {
  classes: string[];
  primaryStat?: string;
  /** Share of the player's damage that's magic. */
  magicShare: number;
}): { name: string; value: number }[] {
  return RAID_BUFFS.filter((buff) => !raid.classes.includes(buff.className)).flatMap((buff) => {
    const { stat, school } = buff.appliesTo ?? {};
    if (stat && (!raid.primaryStat || !stat.includes(raid.primaryStat))) {
      return [];
    }
    const share =
      school === 'magic' ? raid.magicShare : school === 'physical' ? 1 - raid.magicShare : 1;
    return share > 0.05 ? [{ name: buff.name, value: buff.value * share }] : [];
  });
}
