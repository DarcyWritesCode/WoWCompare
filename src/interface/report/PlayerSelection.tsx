import ROLES from 'game/ROLES';
import SPECS from 'game/SPECS';
import { wclGameVersionToBranch } from 'game/VERSIONS';
import Report from 'parser/core/Report';
import getConfig from 'parser/getConfig';

import { PlayerDetails } from '../../parser/core/Player';
import PlayerTile from './PlayerTile';

import './PlayerSelection.scss';
import { usePageView } from 'interface/useGoogleAnalytics';
import { i18n } from '@lingui/core';
import { PlayerPerformance } from 'wowcompare/groupPerformance';
import { PlayerActivity } from 'wowcompare/groupActivity';

const ROLE_SORT_KEY: Record<string, number> = {
  [ROLES.TANK]: 0,
  [ROLES.HEALER]: 1,
  //Different sort for range/melee was tested and felt intuitive.
  //Because of this all DPS are treated the same for sorting purposes.
  [ROLES.DPS.MELEE]: 2,
  [ROLES.DPS.RANGED]: 2,
};

function sortPlayers(a: PlayerDetails, b: PlayerDetails) {
  const aSpec = SPECS[a.specID ?? 0];
  const bSpec = SPECS[b.specID ?? 0];
  const aRoleSortKey = aSpec ? ROLE_SORT_KEY[aSpec.role] : -1;
  const bRoleSortKey = bSpec ? ROLE_SORT_KEY[bSpec.role] : -1;

  if (aRoleSortKey !== bRoleSortKey) {
    return aRoleSortKey - bRoleSortKey;
  }

  const aSpecSortKey = aSpec ? i18n._(aSpec.className) : '';
  const bSpecSortKey = bSpec ? i18n._(bSpec.className) : '';
  if (aSpecSortKey !== bSpecSortKey) {
    return aSpecSortKey.localeCompare(bSpecSortKey);
  }

  return a.name.localeCompare(b.name);
}

interface Props {
  report: Report;
  players: PlayerDetails[];
  makeUrl: (playerId: number, build?: string) => string;
  /** WoWCompare: each player's DPS or HPS against their spec's 95th percentile, by ID. */
  performance?: Map<number, PlayerPerformance>;
  /** WoWCompare: each player's active time against their spec's reference logs, by ID. */
  activity?: Map<number, PlayerActivity>;
}

const PlayerSelection = ({ report, players, makeUrl, performance, activity }: Props) => {
  usePageView('PlayerSelection');
  return (
    <div className="player-selection">
      {players.toSorted(sortPlayers).map((player) => (
        <PlayerTile
          key={player.id}
          player={player}
          makeUrl={makeUrl}
          performance={performance?.get(player.id)}
          activity={activity?.get(player.id)}
          config={getConfig(wclGameVersionToBranch(report.gameVersion), player.specID ?? 0, player)}
        />
      ))}
    </div>
  );
};

export default PlayerSelection;
