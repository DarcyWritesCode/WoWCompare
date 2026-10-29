import { formatDuration, formatNumber } from 'common/format';
import { Panel } from 'interface';
import { ReactNode, useEffect, useMemo, useState } from 'react';

import { median, PASS_FRACTION, WARN_FRACTION } from '../benchmarks/aggregate';
import { biggestMistakes, Mistake } from '../benchmarks/mistakes';
import {
  AUGMENTATION_MIN_UPTIME,
  POWER_INFUSION_MIN_UPTIME,
  REFERENCE_LABEL,
} from '../benchmarks/reference';
import { CLOSE_COUNT } from '../benchmarks/select';
import { compareTalents, TalentTree } from '../benchmarks/talents';
import { loadTalentTree } from '../talentTrees';
import { LogSnapshot, ProfileResults } from '../metrics/results';
import { Profile } from '../profile/types';
import {
  analyzeDamageWindows,
  DamageWindowInputs,
  mergeSpans,
  useDamageWindowSpans,
} from '../damageWindows';
import { useDeathCutoffState } from '../deathCutoff';
import SPECS from 'game/SPECS';
import {
  AugSimMode,
  rememberAugMode,
  rememberedAugMode,
  SimSource,
  useSimAllies,
} from '../sim/allies';
import type { SimCharacter } from '../sim/profileFromLog';
import { useRaidFight } from '../sim/raidFight';
import { autoSim, canSim, preloadEngine } from '../sim/runner';
import { useSimGaps } from '../sim/variants';
import AplExpectations from './AplExpectations';
import AugSimDialog from './AugSimDialog';
import BenchmarkLogList from './BenchmarkLogList';
import BenchmarkTable from './BenchmarkTable';
import BiggestGaps from './BiggestGaps';
import { CHART_COLORS, DpsStrip, StatTile } from './charts';
import CooldownDamage from './CooldownDamage';
import CooldownEntry from './CooldownEntry';
import DamageWindows from './DamageWindows';
import DeathCutoffControl from './DeathCutoffControl';
import FightTimelines from './FightTimelines';
import ProfileResultsTable, { STATUS_COLORS } from './ProfileResultsTable';
import SimGaps from './SimGaps';
import Suggestions from './Suggestions';
import TalentComparison from './TalentComparison';
import { DEFAULT_NORMALIZATION, DPS_PER_ILVL, headline, Normalization } from './normalize';
import useBenchmarks, { BenchmarkInputs, BenchmarkKind, BenchmarkReference } from './useBenchmarks';

/** Extra benchmarks, as offered on their buttons. */
const LOAD_HINTS: Partial<Record<BenchmarkKind, string>> = {
  sameBuild: 'Same build (1 log)',
  bestClose: 'Best close parse (1 log)',
  close: `Close median (up to ${CLOSE_COUNT} logs)`,
};

const NORMALIZATION_KEY = 'wowcompare:normalization';
/** Shortest fight the death cutoff can leave that still gets benchmarks. */
const MIN_CUT_MS = 30_000;

function readNormalization(): Normalization {
  try {
    return {
      ...DEFAULT_NORMALIZATION,
      ...JSON.parse(localStorage.getItem(NORMALIZATION_KEY) ?? '{}'),
    };
  } catch {
    return DEFAULT_NORMALIZATION;
  }
}

/** Checkboxes for what to take out of the comparison; remembered in this browser. */
function NormalizationControls({
  value,
  onChange,
  player,
}: {
  value: Normalization;
  onChange: (value: Normalization) => void;
  player: LogSnapshot;
}) {
  const options: { key: keyof Normalization; label: string; hint: string; disabled?: boolean }[] = [
    {
      key: 'killTime',
      label: 'Kill time',
      hint: `Rescale other logs to your ${formatDuration(player.durationMs)} kill: short kills fit more cooldowns per minute.`,
    },
    {
      key: 'ilvl',
      label: 'Item level',
      hint: `Rescale other logs to your item level${player.ilvl ? ` (${player.ilvl.toFixed(1)})` : ''} at ≈${DPS_PER_ILVL * 100}% DPS per level.`,
      disabled: !player.ilvl,
    },
    {
      key: 'bossHp',
      label: 'Boss HP (raid size)',
      hint: 'Show damage as a share of the boss HP split evenly across the raid; 100% is an even share. Boss HP scales with raid size, so this compares raids of different sizes.',
      disabled: !player.bossHp,
    },
    {
      key: 'externalBuffs',
      label: 'Leave out PI/Aug-buffed logs',
      hint: `Leave reference logs out of the median when someone else kept Power Infusion (${POWER_INFUSION_MIN_UPTIME * 100}%+ of the fight) or Ebon Might and Prescience (${AUGMENTATION_MIN_UPTIME * 100}%+) on the player.`,
    },
  ];
  return (
    <div
      style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginBottom: 12 }}
    >
      <span className="text-muted">Normalize for:</span>
      {options.map((option) => (
        <label
          key={option.key}
          title={option.hint}
          style={{ fontWeight: 'normal', margin: 0, opacity: option.disabled ? 0.5 : 1 }}
        >
          <input
            type="checkbox"
            checked={value[option.key]}
            disabled={option.disabled}
            onChange={(e) => onChange({ ...value, [option.key]: e.target.checked })}
            style={{ marginRight: 6 }}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/** Opens every collapsed section while printing, so the PDF has the full tables. */
function useOpenDetailsForPrint() {
  useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => {
      opened = [...document.querySelectorAll<HTMLDetailsElement>('details:not([open])')];
      opened.forEach((details) => (details.open = true));
    };
    const after = () => opened.forEach((details) => (details.open = false));
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
}

/** Scored metrics and rules by status, for the "on par" tile. */
function statusCounts(results: ProfileResults) {
  const statuses = [
    ...results.entries
      .filter((entry) => entry.applicable)
      .flatMap((entry) => Object.values(entry.metrics).map((m) => m!.status)),
    ...results.rules.filter((rule) => rule.casts > 0).map((rule) => rule.status),
  ].filter((status) => status !== 'unknown');
  return {
    total: statuses.length,
    pass: statuses.filter((s) => s === 'pass').length,
    fail: statuses.filter((s) => s === 'fail').length,
  };
}

const names = (items: ReactNode[]) =>
  items.length <= 1
    ? items
    : [
        ...items.slice(0, -1).flatMap((item, i) => [item, i < items.length - 2 ? ', ' : ' and ']),
        items[items.length - 1],
      ];

/** The headline: DPS against the reference, where it sits among the top logs, and the top gaps. */
function Summary({
  player,
  results,
  reference,
  mistakes,
  normalization,
}: {
  player: LogSnapshot;
  results: ProfileResults;
  reference: BenchmarkReference;
  mistakes: Mistake[] | null;
  normalization: Normalization;
}) {
  const hp = normalization.bossHp;
  const unit = hp ? 'share of boss HP' : 'DPS';
  const format = hp ? (v: number) => `${Math.round(v * 100)}%` : formatNumber;
  const mine = headline(player, player, normalization) ?? 0;
  const topDps = reference.logs
    .map((log) => headline(log, player, normalization))
    .filter((v): v is number => v !== null && v > 0);
  const referenceDps = median(topDps);
  const share = referenceDps ? mine / referenceDps : null;
  const adjusted = [
    normalization.killTime && 'kill time',
    normalization.ilvl && 'item level',
  ].filter(Boolean);
  const scaledNote = adjusted.length > 0 ? `scaled to your ${adjusted.join(' and ')}` : null;
  const counts = statusCounts(results);
  const playGaps = mistakes?.filter((m) => !m.notPlay) ?? null;
  const worst = playGaps?.[0];

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <StatTile
          label={hp ? 'Your share of boss HP' : 'Your DPS'}
          value={format(mine)}
          sub={`over ${formatDuration(player.durationMs)}`}
          color={CHART_COLORS.you}
        />
        {referenceDps && (
          <StatTile
            label={`${reference.label.replace(/^the /, '')} ${hp ? 'share' : 'DPS'}`}
            value={format(referenceDps)}
            sub={
              share !== null &&
              `you're at ${Math.round(share * 100)}%${scaledNote ? `, ${scaledNote}` : ''}`
            }
          />
        )}
        {counts.total > 0 && (
          <StatTile
            label="Metrics on par"
            value={`${counts.pass} / ${counts.total}`}
            sub={`${counts.fail} well behind`}
            color={counts.fail > 0 ? STATUS_COLORS.fail : STATUS_COLORS.pass}
          />
        )}
        {worst && (
          <StatTile
            label="Biggest gap"
            value={`≈${formatNumber(worst.dps)} DPS`}
            sub={worst.title}
            color={CHART_COLORS.loss}
          />
        )}
      </div>

      <p style={{ fontSize: '1.1em' }}>
        {share !== null && (
          <>
            You did <strong>{Math.round(share * 100)}%</strong> of {reference.label}'s {unit}
            {scaledNote && ` (${scaledNote})`}.{' '}
            {adjusted.length < 2 &&
              "Some of the gap is gear, raid comp and kill time, which play can't close; the checkboxes above take those out."}{' '}
          </>
        )}
        {!playGaps ? (
          <>DPS estimates for each gap appear once the reference logs have loaded.</>
        ) : playGaps.length > 0 ? (
          <>
            The gaps that play can close start with{' '}
            {names(playGaps.slice(0, 3).map((m) => <strong key={m.key}>{m.title}</strong>))}; the
            list below puts a DPS figure on each.
          </>
        ) : (
          <>Nothing stands out against {reference.label}: your rotation metrics are on par.</>
        )}
      </p>

      {topDps.length > 1 && (
        <>
          <p className="text-muted" style={{ marginBottom: 0 }}>
            Your {unit} among the reference logs (grey): {reference.description}.
          </p>
          <DpsStrip you={mine} others={topDps} format={format} unit={unit} />
        </>
      )}
    </>
  );
}

/**
 * The Live Compare tab: this log against the #1 parse and the reference logs (loaded straight
 * away), with the other benchmarks one click each, plus the cooldown window reels. Each section is its own
 * panel, as on WoWAnalyzer's other tabs.
 */
export default function ProfileView({
  profile,
  unresolved,
  snapshot,
  benchmarkInputs,
  damageWindowInputs,
  simCharacter,
  simSource,
}: {
  profile: Profile;
  /** SimC tokens the profile builder couldn't map to spells. */
  unresolved: string[];
  snapshot: LogSnapshot;
  /** Undefined outside boss fights, where there are no rankings to compare against. */
  benchmarkInputs: Omit<BenchmarkInputs, 'playerResults'> | undefined;
  /** Undefined on encounters without damage windows. */
  damageWindowInputs?: DamageWindowInputs;
  /** The player's character for in-browser sims. */
  simCharacter?: SimCharacter;
  /** Where sims read the fight's targets and, for Augmentation, its allies from. */
  simSource?: SimSource;
}) {
  // A fight cut this short (by the death cutoff) has too little to compare.
  const tooShort = useDeathCutoffState().applied !== null && snapshot.durationMs < MIN_CUT_MS;
  const inputs = useMemo(
    () =>
      benchmarkInputs && !tooShort
        ? { ...benchmarkInputs, playerResults: snapshot.results }
        : undefined,
    [benchmarkInputs, snapshot, tooShort],
  );
  const [normalization, setNormalizationState] = useState(readNormalization);
  const {
    status,
    busy,
    load,
    loaded,
    available,
    poolSize,
    talents,
    effects,
    columns,
    logs,
    reference,
    playerResults,
  } = useBenchmarks(inputs, normalization.externalBuffs);
  const results = playerResults ?? snapshot.results;
  useOpenDetailsForPrint();
  const setNormalization = (value: Normalization) => {
    setNormalizationState(value);
    try {
      localStorage.setItem(NORMALIZATION_KEY, JSON.stringify(value));
    } catch {
      // Not remembered; it still applies on this page.
    }
  };
  const windowFetch = useDamageWindowSpans(damageWindowInputs);
  // Start the engine download now, so it's ready by the time the reference logs are.
  useEffect(() => {
    if (simCharacter && canSim() && autoSim()) {
      preloadEngine();
    }
  }, [simCharacter]);
  const windowAnalysis = useMemo(
    () =>
      windowFetch?.state === 'done' && damageWindowInputs
        ? analyzeDamageWindows(
            damageWindowInputs,
            windowFetch.spans,
            snapshot.windows,
            snapshot.results,
          )
        : null,
    [windowFetch, damageWindowInputs, snapshot],
  );
  const playerAmpWindows = useMemo(
    () =>
      windowFetch?.state === 'done' && damageWindowInputs
        ? mergeSpans(windowFetch.spans)
            .filter((w) => w.def.kind === 'amp')
            .map((w): [number, number] => [
              w.start - damageWindowInputs.fightStart,
              w.end - damageWindowInputs.fightStart,
            ])
        : undefined,
    [windowFetch, damageWindowInputs],
  );
  const source = profile.source;
  const [talentTree, setTalentTree] = useState<TalentTree | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadTalentTree(profile.specId).then((tree) => !cancelled && setTalentTree(tree));
    return () => {
      cancelled = true;
    };
  }, [profile.specId]);
  const talentComparison = useMemo(
    () =>
      talents &&
      talentTree &&
      compareTalents(talents.pool, talents.top, snapshot.build.talents, talentTree),
    [talents, snapshot, talentTree],
  );
  // Augmentation needs players to buff, and asks how (sim/allies.ts) on every page load unless
  // told not to; its sims wait for the answer.
  const isAug = profile.specId === SPECS.AUGMENTATION_EVOKER.id;
  const [augMode, setAugMode] = useState<AugSimMode | null>(() =>
    isAug ? rememberedAugMode() : null,
  );
  const [augDialog, setAugDialog] = useState(isAug && augMode === null);
  const chooseAugMode = (mode: AugSimMode, ask: boolean) => {
    rememberAugMode(mode, ask);
    setAugMode(mode);
    setAugDialog(false);
  };
  const allyFetch = useSimAllies(simSource, isAug && augMode === 'raid');
  const simAllies =
    allyFetch.state === 'done' && allyFetch.allies.length > 0 ? allyFetch.allies : undefined;
  const alliesReady = !isAug || (augMode !== null && allyFetch.state !== 'loading');
  // The fight's targets from the whole raid's damage, so a player who skipped the adds still sims
  // with them; the player's own damage stands in when it can't load.
  const raidFight = useRaidFight(simSource?.reportCode, simSource?.fightStart, simSource?.fightEnd);
  // Damage amp windows on the boss (or a target sharing its health) go into the sim's fight.
  const simWindowsReady =
    (!damageWindowInputs || windowFetch?.state !== 'loading') && raidFight.state === 'done';
  const simFight = useMemo(
    () =>
      simCharacter && {
        ...simCharacter,
        fight: {
          ...((raidFight.state === 'done' && raidFight.fight) || simCharacter.fight),
          vulnerable: (windowAnalysis?.amps ?? [])
            .filter((amp) => amp.def.onBoss || amp.def.sharedHealth)
            .map((amp) => ({
              start: amp.startMs / 1000,
              duration: (amp.endMs - amp.startMs) / 1000,
              multiplier: amp.def.multiplier,
            })),
        },
      },
    [simCharacter, windowAnalysis, raidFight],
  );
  // The reference's item level shifts while its logs load; a sim started early would run again.
  const referenceLoaded = loaded.includes('reference') || (!busy && reference !== null);
  const simInputs = useMemo(
    () =>
      simFight &&
      simWindowsReady &&
      alliesReady &&
      referenceLoaded &&
      talentTree &&
      talents &&
      reference
        ? {
            character: simFight,
            tree: talentTree,
            builds: talents.top.length > 0 ? talents.top : talents.pool,
            playerIlvl: snapshot.ilvl,
            referenceIlvl: reference.ilvl,
            raidClasses: snapshot.raid?.classes ?? [],
            raidMetric: isAug,
            allies: simAllies,
          }
        : null,
    [
      simFight,
      simWindowsReady,
      alliesReady,
      referenceLoaded,
      talentTree,
      talents,
      reference,
      snapshot,
      isAug,
      simAllies,
    ],
  );
  const sims = useSimGaps(simInputs);
  const simResults = sims.results;
  // Estimates against the #1 parse alone swing wildly (one log's windows), so they wait for the
  // reference logs, unless they can't load at all.
  const mistakesReady = referenceLoaded;
  // While the sims run, or their inputs (talents, the reference) are still loading, the gaps wait
  // for them rather than show the rougher log-only estimates first.
  const simPending =
    sims.pending ||
    (!!simCharacter &&
      !simInputs &&
      (busy || !alliesReady || !simWindowsReady) &&
      canSim() &&
      autoSim() &&
      sims.run.state !== 'error');
  const mistakes = useMemo(
    () =>
      reference && mistakesReady && !simPending
        ? biggestMistakes(
            profile,
            snapshot,
            reference.logs,
            effects,
            windowAnalysis,
            talentComparison,
            simResults,
          )
        : null,
    [
      profile,
      snapshot,
      reference,
      mistakesReady,
      simPending,
      effects,
      windowAnalysis,
      talentComparison,
      simResults,
    ],
  );

  const moreButtons = available.length > 0 && (
    <>
      {available.map((kind) => (
        <button
          key={kind}
          type="button"
          className="btn btn-default btn-sm hidden-print"
          style={{ marginLeft: 8, marginBottom: 4 }}
          disabled={busy}
          onClick={() => load(kind)}
        >
          {LOAD_HINTS[kind]}
        </button>
      ))}
    </>
  );

  return (
    <>
      {augDialog && simCharacter && canSim() && (
        <AugSimDialog
          allyNames={(simSource?.buffedAllies ?? []).map((ally) => ally.name)}
          onChoose={chooseAugMode}
        />
      )}
      <Panel
        title={profile.name}
        explanation={
          source && (
            <>
              Built from SimC's <a href={source.url}>{source.file}</a> APL (
              {source.live
                ? `fetched ${new Date(source.retrievedAt ?? Date.now()).toLocaleString()}`
                : 'bundled snapshot; the live APL could not be fetched'}
              ). Rank follows APL priority order.
              {unresolved.length > 0 && ` Not mapped to spells yet: ${unresolved.join(', ')}.`}
            </>
          )
        }
        actions={moreButtons}
      >
        <DeathCutoffControl />
        {status && <p className="text-muted">{status}</p>}
        {reference ? (
          <>
            <NormalizationControls
              value={normalization}
              onChange={setNormalization}
              player={snapshot}
            />
            <Summary
              player={snapshot}
              results={results}
              reference={reference}
              mistakes={mistakes}
              normalization={normalization}
            />
          </>
        ) : (
          (!benchmarkInputs || tooShort) && (
            <p className="text-muted">
              {tooShort
                ? `The death cutoff leaves under ${MIN_CUT_MS / 1000} seconds of this fight: too little to compare; showing it on its own.`
                : 'Benchmarks need a boss kill with rankings; showing this log on its own.'}
            </p>
          )
        )}
      </Panel>

      <Panel
        title="Fight timeline"
        explanation={`Your DPS and cooldowns against the ${REFERENCE_LABEL} logs, from the pull. Bloodlust, damage potions and damage amp windows are banded in every chart; below, how you used this boss's damage windows.`}
      >
        <FightTimelines
          player={snapshot}
          playerAmpWindows={playerAmpWindows}
          references={reference?.logs ?? []}
          referenceLabel={REFERENCE_LABEL}
        />
        {damageWindowInputs && (
          <>
            <h4 style={{ marginTop: 24 }}>Damage windows</h4>
            <DamageWindows fetched={windowFetch} analysis={windowAnalysis} />
          </>
        )}
      </Panel>

      {simCharacter && sims.plan && (
        <Panel
          title="Sim your gaps"
          explanation="What your talents and item level are worth on your own character, simulated with SimulationCraft in your browser."
        >
          <SimGaps
            character={simFight ?? simCharacter}
            plan={sims.plan!}
            run={sims.run}
            start={sims.start}
            playerDps={snapshot.fightDps}
            aug={
              isAug
                ? {
                    mode: augMode,
                    allies: simAllies?.map(({ ally }) => ally.name) ?? [],
                    change: () => setAugDialog(true),
                  }
                : undefined
            }
          />
        </Panel>
      )}

      {reference && (
        <Panel
          title="Biggest gaps"
          explanation={`What separates you from ${reference.label}, largest first: what play can close, and what it can't.`}
        >
          {mistakes ? (
            <BiggestGaps
              mistakes={mistakes}
              fightDps={snapshot.fightDps}
              referenceLabel={reference.label}
            />
          ) : (
            <p className="text-muted">
              {simPending
                ? 'Estimates appear once your character is simmed (see Sim your gaps).'
                : 'Estimates appear once the reference logs have loaded.'}
            </p>
          )}
        </Panel>
      )}

      {talentComparison && (
        <Panel
          title="Talents"
          explanation="Where your talents differ from what ranked players of your spec take on this boss."
        >
          <TalentComparison comparison={talentComparison} tree={talentTree!} />
        </Panel>
      )}

      <Panel
        title="Buffs and cooldowns"
        explanation={
          reference
            ? `Each APL entry, coloured against ${reference.label}: green at ${PASS_FRACTION * 100}% or better, orange at ${WARN_FRACTION * 100}%.`
            : 'Each APL entry measured on this log.'
        }
      >
        <ProfileResultsTable results={results} reference={reference ?? undefined} />
      </Panel>

      {columns && reference && (
        <>
          <Panel
            title="Damage inside cooldowns"
            explanation="Where the damage in each cooldown comes from, per window."
          >
            <CooldownDamage
              player={snapshot}
              columns={columns}
              topLogs={reference.logs}
              referenceLabel={reference.label}
              normalization={normalization}
            />
          </Panel>

          <Panel
            title="Going into cooldowns"
            explanation="Resources pooled and buffs lined up at each cooldown cast."
          >
            <CooldownEntry
              specId={profile.specId}
              player={snapshot}
              topLogs={reference.logs}
              referenceLabel={reference.label}
            />
          </Panel>

          <Panel
            title="Benchmarks"
            explanation={`Scored against ${reference.label}: ${reference.description}. #1 is shown as the ceiling. Same build and close come from the ${poolSize} ranked parses on the reference's rankings pages. Close = ilvl ±5, kill time ±20%, raid size ±5.`}
          >
            <BenchmarkTable player={{ ...snapshot, results }} benchmarks={columns} />
          </Panel>

          <Panel
            title="APL expectations vs reference parses"
            explanation={`What the APL asks for, and how often ${reference.label} actually does it. "Favoured" lines are ones the APL prefers under a buff without requiring it.`}
          >
            <AplExpectations player={snapshot.results} topLogs={reference.logs} />
          </Panel>

          <Panel title="Suggestions">
            <Suggestions
              profile={profile}
              player={snapshot}
              topLogs={reference.logs}
              allLogs={[snapshot, ...logs.map((log) => log.snapshot)]}
            />
          </Panel>
        </>
      )}

      <Panel
        title="Logs compared against"
        explanation="Every parsed benchmark log: #1, same build and best close first, then by rank. Open one on Warcraft Logs or analyze it here."
      >
        <BenchmarkLogList logs={logs} />
      </Panel>
    </>
  );
}
