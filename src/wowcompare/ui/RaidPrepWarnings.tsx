import AlertWarning from 'interface/AlertWarning';
import { PlayerDetails } from 'parser/core/Player';

import { PlayerPrep, useRaidPrep } from '../raidPrep';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * WoWCompare: who in the fight went in without a flask, used no combat potion, or has unenchanted
 * gear or empty sockets (raidPrep.ts). Each line shows only when someone missed it; nothing shows
 * when no one did.
 */
export default function RaidPrepWarnings({
  reportCode,
  start,
  end,
  players,
}: {
  reportCode: string;
  start: number;
  end: number;
  players: PlayerDetails[];
}) {
  const prep = useRaidPrep(reportCode, start, end);
  if (prep.state !== 'done' || !prep.players) {
    return null;
  }
  const names = new Map(players.map((player) => [player.id, player.name]));
  const named = prep.players
    .filter((p) => names.has(p.id))
    .toSorted((a, b) => names.get(a.id)!.localeCompare(names.get(b.id)!));
  const list = (missed: PlayerPrep[], detail?: (p: PlayerPrep) => string) =>
    missed.map((p) => (detail ? `${names.get(p.id)} (${detail(p)})` : names.get(p.id))).join(', ');

  const noFlask = named.filter((p) => !p.flask);
  const noPotion = named.filter((p) => p.potions === 0);
  const unenchanted = named.filter((p) => p.missingEnchants.length > 0);
  const ungemmed = named.filter((p) => p.emptySockets > 0);
  const lines = [
    noFlask.length > 0 && ['No flask', list(noFlask)],
    noPotion.length > 0 && ['No combat potion', list(noPotion)],
    unenchanted.length > 0 && [
      'Missing enchants',
      list(unenchanted, (p) => p.missingEnchants.join(', ')),
    ],
    ungemmed.length > 0 && [
      'Empty gem sockets',
      list(ungemmed, (p) => plural(p.emptySockets, 'socket')),
    ],
  ].filter((line): line is [string, string] => Boolean(line));
  if (lines.length === 0) {
    return null;
  }
  return (
    <AlertWarning style={{ marginBottom: 30 }}>
      <h2>Raid preparation</h2>
      {lines.map(([title, who]) => (
        <div key={title}>
          <strong>{title}:</strong> {who}
        </div>
      ))}
    </AlertWarning>
  );
}
