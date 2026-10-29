import { useEffect, useMemo, useState } from 'react';

import { absentRaidBuffs } from '../benchmarks/raidBuffs';
import type { TalentTree } from '../benchmarks/talents';
import {
  IDLE_SET,
  idleTwin,
  popularTrees,
  SimAlly,
  SimCharacter,
  simcInput,
  SimVariant,
  talentsByTree,
} from './profileFromLog';
import { autoSim, canSim, runSim, SimResult, useWakeLock } from './runner';

/** Each variant's DPS to within this many percent (95% confidence). */
const TARGET_ERROR = 0.2;
const MAX_THREADS = 8;
/** Builds on the player's hero tree below this many: their class and spec trees aren't swapped alone. */
const MIN_SAME_HERO_BUILDS = 10;

const TREE_LABELS = { class: 'Class tree', spec: 'Spec tree', hero: 'Hero tree' } as const;

/** What the sims measured, as shares of the player's DPS (see `simGapResults`). */
export interface SimGapResults {
  /** The player's simmed DPS (Augmentation: its whole contribution), every raid buff; absent when nothing was simmed. */
  baselineDps?: number;
  /** The most popular build against theirs; 0 when theirs is it. */
  talents: number;
  /** Their gear raised to the reference item level. */
  ilvl?: number;
  ilvlDelta?: number;
  /** Every raid buff against their raid's: what the ones it lacked were worth. */
  raidBuffs?: number;
  missingBuffs: string[];
}

export interface SimGapInputs {
  character: SimCharacter;
  tree: TalentTree;
  /** Ranked players' builds (`entryId:rank`), for the most popular trees. */
  builds: string[][];
  playerIlvl: number | undefined;
  referenceIlvl: number | null;
  /** Classes in the player's raid, for its raid buffs. */
  raidClasses: string[];
  /** Score by raid DPS (Augmentation): see `simcInput`. */
  raidMetric?: boolean;
  /** Real players from the log to sim alongside the player. */
  allies?: { ally: SimAlly; tree: TalentTree }[];
}

/**
 * The variants to sim. Class and spec trees are swapped alone for the most popular among players on
 * the same hero tree (another hero tree's favourite spec tree can be a poor fit for yours); the hero
 * tree alone, and all three together, for the most popular overall. Item level raised to the
 * reference's. And the raid buffs the player's raid lacked, taken away (SimC applies all of them).
 */
export function variantsFor({
  character,
  tree,
  builds,
  playerIlvl,
  referenceIlvl,
  raidClasses,
}: SimGapInputs) {
  const mine = talentsByTree(character.talents, tree);
  const myHero = tree.hero.find((hero) =>
    character.talents.some((t) => t.startsWith(`${hero.entryId}:`)),
  );
  const sameHero = myHero
    ? builds.filter((build) => build.some((t) => t.startsWith(`${myHero.entryId}:`)))
    : [];
  const overall = popularTrees(builds, tree);
  const local = sameHero.length >= MIN_SAME_HERO_BUILDS ? popularTrees(sameHero, tree) : null;
  const variants: SimVariant[] = [];
  const labels: Record<string, string> = {};
  const differs = (theirs: string[] | undefined, name: 'class' | 'spec' | 'hero') =>
    !!theirs && theirs.length > 0 && theirs.join('/') !== mine[name].join('/');
  for (const name of ['class', 'spec'] as const) {
    if (local && differs(local[name], name)) {
      variants.push({ name, trees: { [name]: local[name] } });
      labels[name] =
        `${TREE_LABELS[name]} swapped for the most popular among ${myHero!.name} players`;
    }
  }
  if (overall && differs(overall.hero, 'hero')) {
    variants.push({ name: 'hero', trees: { hero: overall.hero } });
    labels.hero = `${TREE_LABELS.hero} swapped for the most popular one`;
  }
  if (
    overall &&
    (['class', 'spec', 'hero'] as const).some((name) => differs(overall[name], name))
  ) {
    variants.push({ name: 'all_trees', trees: overall });
    labels.all_trees = 'All three trees swapped for the most popular build';
  }
  const ilevelDelta = referenceIlvl && playerIlvl ? Math.round(referenceIlvl - playerIlvl) : 0;
  if (ilevelDelta >= 1) {
    variants.push({ name: 'ilvl', ilevelDelta });
    labels.ilvl = `Every item ${ilevelDelta} item levels higher (the reference median), same stats`;
  }
  const absent = absentRaidBuffs(raidClasses);
  if (absent.length > 0) {
    variants.push({
      name: 'raid',
      overrides: absent.map((buff) => `override.${buff.simcOverride}=0`),
      affectsRaid: true,
    });
    labels.raid = `Without the raid buffs your raid lacked (${absent.map((buff) => buff.name).join(', ')})`;
  }
  return { variants, labels, ilevelDelta, absent };
}

/**
 * The player's DPS in the sim: their own, or scored by raid DPS, the raid's DPS less the raid's
 * with the player idle (everything their buffs added to others included).
 */
export function simmedContribution(result: SimResult): number {
  const idle = result.sets.find((s) => s.name === IDLE_SET);
  return result.raidDps !== undefined && idle ? result.raidDps - idle.mean : result.baseline;
}

/** A variant's change against the baseline, as a share of the player's DPS, with its error. */
export function variantChange(result: SimResult, name: string) {
  const set = result.sets.find((s) => s.name === name);
  if (!set) {
    return undefined;
  }
  const idle = result.sets.find((s) => s.name === IDLE_SET);
  if (result.raidDps !== undefined && idle) {
    const contribution = result.raidDps - idle.mean;
    // A change to everyone (raid buffs) is the player's contribution under it, against theirs.
    const twin = result.sets.find((s) => s.name === idleTwin(name));
    return twin
      ? {
          change: (set.mean - twin.mean) / contribution - 1,
          error: Math.hypot(set.error, twin.error) / contribution,
        }
      : {
          change: (set.mean - result.raidDps) / contribution,
          error: set.error / contribution,
        };
  }
  return { change: set.mean / result.baseline - 1, error: set.error / set.mean };
}

/** The sim results as shares of the player's DPS, for Biggest gaps. */
export function simGapResults(
  result: SimResult,
  { variants, ilevelDelta, absent }: ReturnType<typeof variantsFor>,
): SimGapResults {
  const change = (name: string) => variantChange(result, name)?.change;
  const raid = change('raid');
  return {
    baselineDps: simmedContribution(result),
    talents: variants.some((v) => v.name === 'all_trees') ? (change('all_trees') ?? 0) : 0,
    ilvl: change('ilvl'),
    ilvlDelta: ilevelDelta >= 1 ? ilevelDelta : undefined,
    // The player's raid is the variant without the buffs; every buff is the baseline.
    raidBuffs: raid !== undefined ? 1 / (1 + raid) - 1 : undefined,
    missingBuffs: absent.map((buff) => buff.name),
  };
}

export type SimRun =
  | { state: 'idle' }
  | { state: 'running'; done: number }
  | { state: 'error'; error: string }
  | { state: 'done'; result: SimResult };

/**
 * Sims the player's gaps once everything they need has loaded: automatically when this browser
 * sims automatically (runner.ts), else when `run` is called. Cached results show at once.
 */
export function useSimGaps(inputs: SimGapInputs | null) {
  const plan = useMemo(() => (inputs ? variantsFor(inputs) : null), [inputs]);
  const input = useMemo(
    () =>
      inputs && plan
        ? simcInput(inputs.character, inputs.tree, plan.variants, {
            threads: Math.min(MAX_THREADS, navigator.hardwareConcurrency || 4),
            targetError: TARGET_ERROR,
            raidMetric: inputs.raidMetric,
            allies: inputs.allies,
          })
        : null,
    [inputs, plan],
  );
  const [run, setRun] = useState<SimRun>({ state: 'idle' });
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    setRun({ state: 'idle' });
    if (!input || !canSim() || !(requested || autoSim())) {
      return;
    }
    let cancelled = false;
    setRun({ state: 'running', done: 0 });
    runSim(input, (done) => !cancelled && setRun({ state: 'running', done })).then(
      (result) => !cancelled && setRun({ state: 'done', result }),
      (err: Error) => !cancelled && setRun({ state: 'error', error: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [input, requested]);

  useWakeLock(run.state === 'running');

  return {
    plan,
    run,
    results: run.state === 'done' && plan ? simGapResults(run.result, plan) : null,
    /** A sim is under way or about to start: show its results rather than log-only estimates. */
    pending:
      !!input &&
      canSim() &&
      (run.state === 'running' || (run.state === 'idle' && (requested || autoSim()))),
    /** Starts a sim that didn't start automatically. */
    start: () => setRequested(true),
  };
}
