/**
 * Serves the v1-shaped endpoints the app was written against (`report/fights/:code`,
 * `report/events/...`, `report/tables/...`, `report/graph/...`) from the Warcraft Logs v2
 * GraphQL API, so the parser and UI keep working unchanged.
 */
import { QueryParams } from 'common/makeApiUrl';
import { EnemyInfo } from 'parser/core/Enemy';
import { WCLFight } from 'parser/core/Fight';
import { PetInfo } from 'parser/core/Pet';
import { PlayerDetails, PlayerInfo } from 'parser/core/Player';
import { WCLReport } from 'parser/core/Report';

import GameBranch from 'game/GameBranch';
import SPECS from 'game/SPECS';

import { wclQuery } from './graphql';

interface V2Actor {
  id: number;
  name: string;
  type: string;
  subType: string;
  server: string | null;
  petOwner: number | null;
  gameID: number;
  icon: string;
}

interface V2Ability {
  gameID: number;
  name: string;
  icon: string;
  /** Spell school, as a string. */
  type: string;
}

interface V2FightNpc {
  id: number;
  gameID?: number;
  instanceCount: number;
  groupCount?: number;
}

interface V2Fight {
  id: number;
  startTime: number;
  endTime: number;
  encounterID: number;
  originalEncounterID: number | null;
  name: string;
  kill: boolean | null;
  difficulty: number | null;
  size: number | null;
  bossPercentage: number | null;
  fightPercentage: number | null;
  hardModeLevel: number | null;
  phaseTransitions: { id: number; startTime: number }[] | null;
  friendlyPlayers: number[] | null;
  friendlyNPCs: V2FightNpc[] | null;
  enemyNPCs: V2FightNpc[] | null;
  friendlyPets: V2FightNpc[] | null;
  enemyPets: V2FightNpc[] | null;
  dungeonPulls:
    | {
        id: number;
        encounterID: number;
        startTime: number;
        endTime: number;
        name: string;
        kill: boolean | null;
        enemyNPCs:
          | { id: number; gameID: number; minimumInstanceID: number; maximumInstanceID: number }[]
          | null;
      }[]
    | null;
}

interface V2Report {
  title: string;
  startTime: number;
  endTime: number;
  owner: { name: string } | null;
  zone: { id: number } | null;
  region: { compactName: string } | null;
  rankedCharacters:
    | { id: number; name: string; server: { name: string; region: { compactName: string } } }[]
    | null;
  masterData: {
    lang: string;
    logVersion: number;
    gameVersion: number;
    actors: V2Actor[];
    abilities: V2Ability[];
  };
  phases:
    | {
        encounterID: number;
        separatesWipes: boolean;
        phases: { id: number; name: string; isIntermission: boolean | null }[];
      }[]
    | null;
  fights: V2Fight[];
}

const FIGHTS_QUERY = `
query ($code: String!, $translate: Boolean) {
  reportData {
    report(code: $code) {
      title startTime endTime
      owner { name }
      zone { id }
      region { compactName }
      rankedCharacters { id name server { name region { compactName } } }
      masterData(translate: $translate) {
        lang logVersion gameVersion
        actors { id name type subType server petOwner gameID icon }
        abilities { gameID name icon type }
      }
      phases { encounterID separatesWipes phases { id name isIntermission } }
      fights(translate: $translate) {
        id startTime endTime encounterID originalEncounterID name kill difficulty size
        bossPercentage fightPercentage hardModeLevel
        phaseTransitions { id startTime }
        friendlyPlayers
        friendlyNPCs { id instanceCount groupCount }
        enemyNPCs { id gameID instanceCount groupCount }
        friendlyPets { id instanceCount }
        enemyPets { id instanceCount }
        dungeonPulls {
          id encounterID startTime endTime name kill
          enemyNPCs { id gameID minimumInstanceID maximumInstanceID }
        }
      }
    }
  }
}`;

const EVENTS_QUERY = `
query ($code: String!, $start: Float, $end: Float, $filter: String, $translate: Boolean,
       $dataType: EventDataType, $abilityID: Float, $sourceID: Int, $targetID: Int,
       $hostility: HostilityType) {
  reportData {
    report(code: $code) {
      events(startTime: $start, endTime: $end, filterExpression: $filter, translate: $translate,
             dataType: $dataType, abilityID: $abilityID, sourceID: $sourceID, targetID: $targetID,
             hostilityType: $hostility, includeResources: true, limit: 10000) {
        data
        nextPageTimestamp
      }
    }
  }
}`;

const TABLE_QUERY = (field: 'table' | 'graph', enumType: string) => `
query ($code: String!, $start: Float, $end: Float, $filter: String, $translate: Boolean,
       $dataType: ${enumType}, $abilityID: Float, $sourceID: Int, $targetID: Int,
       $hostility: HostilityType) {
  reportData {
    report(code: $code) {
      ${field}(startTime: $start, endTime: $end, filterExpression: $filter, translate: $translate,
             dataType: $dataType, abilityID: $abilityID, sourceID: $sourceID, targetID: $targetID,
             hostilityType: $hostility)
    }
  }
}`;

/** Actor lists from the last fights fetch, used to expand `actorid` to include pets. */
const actorCache = new Map<string, V2Actor[]>();
/** v1 ability objects from the last fights fetch, by game ID: v2 events only carry the ID. */
const abilityCache = new Map<string, Map<number, V1Ability>>();

interface V1Ability {
  name: string;
  guid: number;
  type: number;
  abilityIcon: string;
}

/** v2 events name abilities by `abilityGameID`; v1 events, which the parser reads, embed them. */
function toV1Event(code: string, event: Record<string, unknown>) {
  const abilities = abilityCache.get(code);
  const ability = (id: unknown): V1Ability | undefined =>
    typeof id === 'number'
      ? (abilities?.get(id) ?? { name: `Unknown ${id}`, guid: id, type: 0, abilityIcon: '' })
      : undefined;
  const { abilityGameID, extraAbilityGameID, ...rest } = event;
  return {
    ...rest,
    ...(abilityGameID !== undefined && { ability: ability(abilityGameID) }),
    ...(extraAbilityGameID !== undefined && { extraAbility: ability(extraAbilityGameID) }),
  };
}

function toV1Report(code: string, report: V2Report): WCLReport {
  const actors = report.masterData.actors;
  actorCache.set(code, actors);
  abilityCache.set(
    code,
    new Map(
      report.masterData.abilities.map((a) => [
        a.gameID,
        { name: a.name, guid: a.gameID, type: Number(a.type), abilityIcon: a.icon },
      ]),
    ),
  );

  const fightsFor = <T>(pick: (fight: V2Fight) => T | undefined) =>
    report.fights.flatMap((fight) => {
      const value = pick(fight);
      return value === undefined ? [] : [value];
    });

  const friendlies: PlayerInfo[] = [];
  const enemies: EnemyInfo[] = [];
  const friendlyPets: PetInfo[] = [];
  const enemyPets: PetInfo[] = [];

  for (const actor of actors) {
    const unit = {
      id: actor.id,
      name: actor.name,
      guid: actor.gameID,
      icon: actor.icon,
    };
    if (actor.type === 'Player') {
      friendlies.push({
        ...unit,
        // v1 reported a player's class as its `type`.
        type: actor.subType,
        subType: actor.subType,
        server: actor.server ?? undefined,
        region: report.region?.compactName,
        fights: fightsFor((f) =>
          f.friendlyPlayers?.includes(actor.id) ? { id: f.id } : undefined,
        ),
      });
      continue;
    }
    if (actor.type === 'Pet') {
      const pet = (side: 'friendlyPets' | 'enemyPets') =>
        fightsFor((f) => {
          const entry = f[side]?.find((n) => n.id === actor.id);
          return entry ? { id: f.id, instances: entry.instanceCount } : undefined;
        });
      const friendlyFights = pet('friendlyPets');
      const base = { ...unit, type: actor.type, subType: actor.subType, petOwner: actor.petOwner! };
      if (friendlyFights.length > 0) {
        friendlyPets.push({ ...base, fights: friendlyFights });
      } else {
        enemyPets.push({ ...base, fights: pet('enemyPets') });
      }
      continue;
    }
    const enemyFights = fightsFor((f) => {
      const entry = f.enemyNPCs?.find((n) => n.id === actor.id);
      return entry
        ? { id: f.id, groups: entry.groupCount ?? 1, instances: entry.instanceCount }
        : undefined;
    });
    if (enemyFights.length > 0) {
      enemies.push({ ...unit, type: actor.type, subType: actor.subType, fights: enemyFights });
    } else if (actor.type === 'NPC') {
      friendlies.push({
        ...unit,
        type: actor.type,
        subType: actor.subType,
        fights: fightsFor((f) =>
          f.friendlyNPCs?.some((n) => n.id === actor.id) ? { id: f.id } : undefined,
        ),
      });
    }
  }

  const fights: WCLFight[] = report.fights.map((f) => ({
    id: f.id,
    start_time: f.startTime,
    end_time: f.endTime,
    boss: f.encounterID,
    originalBoss: f.originalEncounterID ?? undefined,
    name: f.name,
    size: f.size ?? undefined,
    difficulty: f.difficulty ?? undefined,
    kill: f.kill ?? undefined,
    bossPercentage: f.bossPercentage ?? undefined,
    fightPercentage: f.fightPercentage ?? undefined,
    hardModeLevel: f.hardModeLevel ?? undefined,
    phases: f.phaseTransitions ?? undefined,
    dungeonPulls: f.dungeonPulls?.map((p) => ({
      id: p.id,
      boss: p.encounterID,
      start_time: p.startTime,
      end_time: p.endTime,
      name: p.name,
      kill: p.kill ?? undefined,
      enemyNPCs: p.enemyNPCs ?? undefined,
    })),
  }));

  return {
    fights,
    lang: report.masterData.lang,
    friendlies,
    enemies,
    friendlyPets,
    enemyPets,
    phases: (report.phases ?? []).map((p) => ({
      boss: p.encounterID,
      separatesWipes: p.separatesWipes,
      phases: Object.fromEntries(p.phases.map((phase) => [phase.id, phase.name])),
      intermissions: p.phases.filter((phase) => phase.isIntermission).map((phase) => phase.id),
    })),
    logVersion: report.masterData.logVersion,
    gameVersion: report.masterData.gameVersion,
    title: report.title,
    owner: report.owner?.name ?? '',
    start: report.startTime,
    end: report.endTime,
    zone: report.zone?.id ?? 0,
    exportedCharacters: (report.rankedCharacters ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      server: c.server.name,
      region: c.server.region.compactName,
    })),
  };
}

const num = (value: QueryParams[string]) =>
  value === undefined || value === '' ? undefined : Number(value);

/** `damage-done` -> `DamageDone` */
const pascal = (kebab: string) =>
  kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

function hostility(value: QueryParams[string]) {
  if (value === undefined) {
    return undefined;
  }
  // v1 takes 1 for enemies; WoWCompare's own requests also pass v2's name.
  return Number(value) === 1 || value === 'Enemies' ? 'Enemies' : 'Friendlies';
}

/**
 * v1's `actorid` returned events where the actor (or its pets) was source or target. v2's
 * `sourceID` argument covers only the source side, and its filter expressions match `source.id`
 * against game IDs, not report actor IDs (so an ID filter returns nothing). Names do work: filter
 * by the actor's and its pets' names, then keep only events whose IDs match exactly, since other
 * players' pets can share a name.
 */
function actorFilter(code: string, actorId: number, filter?: string) {
  const actors = (actorCache.get(code) ?? []).filter(
    (actor) => actor.id === actorId || actor.petOwner === actorId,
  );
  if (actors.length === 0) {
    throw new Error(`Actor ${actorId} unknown: fetch report ${code}'s fights before its events`);
  }
  const ids = new Set([actorId, ...actors.map((actor) => actor.id)]);
  const names = [...new Set(actors.map((actor) => JSON.stringify(actor.name)))].join(', ');
  const involvement = `source.name in (${names}) or target.name in (${names})`;
  return {
    filter: filter ? `(${filter}) and (${involvement})` : involvement,
    keep: (event: { sourceID?: number; targetID?: number }) =>
      (event.sourceID !== undefined && ids.has(event.sourceID)) ||
      (event.targetID !== undefined && ids.has(event.targetID)),
  };
}

function commonVariables(code: string, params: QueryParams) {
  const actorId = num(params.actorid);
  const filter = (params.filter as string | undefined) || undefined;
  return {
    code,
    start: num(params.start),
    end: num(params.end),
    translate: params.translate ? true : undefined,
    abilityID: num(params.abilityid),
    targetID: num(params.targetid),
    hostility: hostility(params.hostility),
    actorId,
    filter,
  };
}

export async function fetchV1Endpoint(endpoint: string, params: QueryParams): Promise<unknown> {
  const parts = endpoint.split('/');

  if (parts[0] === 'report' && parts[1] === 'fights') {
    const code = parts[2];
    const data = await wclQuery<{ reportData: { report: V2Report | null } }>(FIGHTS_QUERY, {
      code,
      translate: params.translate ? true : undefined,
    });
    if (!data.reportData.report) {
      return null;
    }
    return toV1Report(code, data.reportData.report);
  }

  if (parts[0] === 'report' && parts[1] === 'events') {
    // report/events/:code or report/events/:view/:code
    const code = parts.at(-1)!;
    const view = parts.length === 4 ? parts[2] : undefined;
    const { actorId, filter, ...vars } = commonVariables(code, params);
    const byActor = !view && actorId !== undefined ? actorFilter(code, actorId, filter) : null;
    const data = await wclQuery<{
      reportData: {
        report: {
          events: {
            data: (Record<string, unknown> & { sourceID?: number; targetID?: number })[];
            nextPageTimestamp: number | null;
          };
        };
      };
    }>(EVENTS_QUERY, {
      ...vars,
      dataType: view ? pascal(view) : undefined,
      sourceID: view && actorId !== undefined ? actorId : undefined,
      filter: byActor?.filter ?? filter,
    });
    const { data: events, nextPageTimestamp } = data.reportData.report.events;
    return {
      events: (byActor ? events.filter(byActor.keep) : events).map((event) =>
        toV1Event(code, event),
      ),
      nextPageTimestamp: nextPageTimestamp ?? undefined,
    };
  }

  if (parts[0] === 'report' && (parts[1] === 'tables' || parts[1] === 'graph')) {
    const field = parts[1] === 'tables' ? 'table' : 'graph';
    const code = parts[3];
    const { actorId, ...vars } = commonVariables(code, params);
    const data = await wclQuery<{ reportData: { report: Record<string, { data: unknown }> } }>(
      TABLE_QUERY(field, field === 'table' ? 'TableDataType' : 'GraphDataType'),
      { ...vars, dataType: pascal(parts[2]), sourceID: actorId },
    );
    return data.reportData.report[field].data;
  }

  throw new Error(`The Warcraft Logs v2 adapter does not support "${parts[0]}/${parts[1]}" yet.`);
}

const PLAYER_DETAILS_QUERY = `
query ($code: String!, $fight: Int!) {
  reportData {
    report(code: $code) {
      region { compactName }
      playerDetails(fightIDs: [$fight])
    }
  }
}`;

interface V2PlayerDetail {
  id: number;
  name: string;
  guid: number;
  type: string;
  server?: string;
  specs?: { spec: string }[];
  minItemLevel?: number;
  maxItemLevel?: number;
}

type V2PlayerDetailsByRole = Partial<Record<'tanks' | 'healers' | 'dps', V2PlayerDetail[]>>;

const ROLE_OF: Record<keyof V2PlayerDetailsByRole, PlayerDetails['role']> = {
  tanks: 'tank',
  healers: 'healer',
  dps: 'dps',
};

/**
 * A fight's players with their roles and specs, in the shape of WoWAnalyzer's
 * `v2/report/:code/fight/:id/players` endpoint (which v1 mode uses).
 */
/**
 * `branch` picks between specs that share WCL's class and spec names: Classic's Assassination
 * Rogue (182) sorts before retail's (259), and a retail log matched to it gets no analysis.
 */
export async function fetchPlayerDetails(
  code: string,
  fightId: number,
  branch: GameBranch,
): Promise<PlayerDetails[]> {
  const data = await wclQuery<{
    reportData: {
      report: {
        region: { compactName: string } | null;
        playerDetails: { data: { playerDetails: V2PlayerDetailsByRole } };
      } | null;
    };
  }>(PLAYER_DETAILS_QUERY, { code, fight: fightId });
  const report = data.reportData.report;
  if (!report) {
    throw new Error(`Report ${code} not found`);
  }
  const byRole = report.playerDetails.data.playerDetails;
  return (Object.keys(ROLE_OF) as (keyof V2PlayerDetailsByRole)[]).flatMap((group) =>
    (byRole[group] ?? []).map((player) => {
      const specName = player.specs?.[0]?.spec;
      const spec = Object.values(SPECS).find(
        (s) => s.wclClassName === player.type && s.wclSpecName === specName && s.branch === branch,
      );
      return {
        id: player.id,
        name: player.name,
        server: player.server ?? '',
        region: report.region?.compactName ?? '',
        ilvl:
          player.minItemLevel !== undefined && player.maxItemLevel !== undefined
            ? (player.minItemLevel + player.maxItemLevel) / 2
            : undefined,
        className: player.type,
        specName,
        specID: spec?.id,
        role: ROLE_OF[group],
        guid: player.guid,
      };
    }),
  );
}
