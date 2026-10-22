/**
 * Serves the v1-shaped endpoints the app was written against (`report/fights/:code`,
 * `report/events/...`, `report/tables/...`, `report/graph/...`) from the Warcraft Logs v2
 * GraphQL API, so the parser and UI keep working unchanged.
 */
import { QueryParams } from 'common/makeApiUrl';
import { EnemyInfo } from 'parser/core/Enemy';
import { WCLFight } from 'parser/core/Fight';
import { PetInfo } from 'parser/core/Pet';
import { PlayerInfo } from 'parser/core/Player';
import { WCLReport } from 'parser/core/Report';

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
  masterData: { lang: string; logVersion: number; gameVersion: number; actors: V2Actor[] };
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

function toV1Report(code: string, report: V2Report): WCLReport {
  const actors = report.masterData.actors;
  actorCache.set(code, actors);

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
  return Number(value) === 1 ? 'Enemies' : 'Friendlies';
}

/**
 * v1's `actorid` returned events where the actor (or its pets) was source or target; v2 only
 * filters by source, so express it as a filter instead.
 */
function actorFilter(code: string, actorId: number, filter?: string) {
  const ids = [actorId];
  for (const actor of actorCache.get(code) ?? []) {
    if (actor.petOwner === actorId) {
      ids.push(actor.id);
    }
  }
  const list = ids.join(', ');
  const involvement = `source.id in (${list}) or target.id in (${list})`;
  return filter ? `(${filter}) and (${involvement})` : involvement;
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
    const data = await wclQuery<{
      reportData: { report: { events: { data: unknown[]; nextPageTimestamp: number | null } } };
    }>(EVENTS_QUERY, {
      ...vars,
      dataType: view ? pascal(view) : undefined,
      sourceID: view && actorId !== undefined ? actorId : undefined,
      filter: !view && actorId !== undefined ? actorFilter(code, actorId, filter) : filter,
    });
    const { data: events, nextPageTimestamp } = data.reportData.report.events;
    return { events, nextPageTimestamp: nextPageTimestamp ?? undefined };
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
