import { formatDuration, formatNumber } from 'common/format';
import { Panel } from 'interface';
import { ReactNode, useEffect, useMemo, useState } from 'react';

import { median, PASS_FRACTION, WARN_FRACTION } from '../benchmarks/aggregate';
import { biggestMistakes, Mistake } from '../benchmarks/mistakes';
import { LogSnapshot, ProfileResults } from '../metrics/results';
import { Profile } from '../profile/types';
import { classSpellMatcher } from '../simc/specs';
import AplExpectations from './AplExpectations';
import BenchmarkTable from './BenchmarkTable';
import BiggestMistakes from './BiggestMistakes';
import { CHART_COLORS, DpsStrip, StatTile } from './charts';
import CooldownDamage from './CooldownDamage';
import CooldownEntry from './CooldownEntry';
import ProfileResultsTable, { STATUS_COLORS } from './ProfileResultsTable';
import Suggestions from './Suggestions';
import { DPS_PER_ILVL, headline, Normalization, NO_NORMALIZATION } from './normalize';
import useBenchmarks, { BenchmarkInputs, BenchmarkKind, BenchmarkReference } from './useBenchmarks';
import WindowReels from './WindowReels';

/** Extra benchmarks, as offered on their buttons. */
const LOAD_HINTS: Partial<Record<BenchmarkKind, string>> = {
  sameBuild: 'Same build (1 log)',
  bestClose: 'Best close parse (1 log)',
  top10Close: 'Top 10 close median (up to 10 logs)',
};

const NORMALIZATION_KEY = 'wowcompare:normalization';

function readNormalization(): Normalization {
  try {
    return { ...NO_NORMALIZATION, ...JSON.parse(localStorage.getItem(NORMALIZATION_KEY) ?? '{}') };
  } catch {
    return NO_NORMALIZATION;
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
  mistakes: Mistake[];
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
  const worst = mistakes[0];

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
        {mistakes.length > 0 ? (
          <>
            The gaps that play can close start with{' '}
            {names(mistakes.slice(0, 3).map((m) => <strong key={m.key}>{m.title}</strong>))}; the
            list below puts a DPS figure on each.
          </>
        ) : (
          <>Nothing stands out against {reference.label}: your rotation metrics are on par.</>
        )}
      </p>

      {topDps.length > 1 && (
        <>
          <p className="text-muted" style={{ marginBottom: 0 }}>
            Your {unit} among the {topDps.length} reference logs (grey):
          </p>
          <DpsStrip you={mine} others={topDps} format={format} unit={unit} />
        </>
      )}
    </>
  );
}

/**
 * The Live Compare tab: this log against the #1 parse and the top 10 (loaded straight away), with
 * the other benchmarks one click each, plus the cooldown window reels. Each section is its own
 * panel, as on WoWAnalyzer's other tabs.
 */
export default function ProfileView({
  profile,
  unresolved,
  snapshot,
  benchmarkInputs,
}: {
  profile: Profile;
  /** SimC tokens the profile builder couldn't map to spells. */
  unresolved: string[];
  snapshot: LogSnapshot;
  /** Undefined outside boss fights, where there are no rankings to compare against. */
  benchmarkInputs: Omit<BenchmarkInputs, 'playerResults'> | undefined;
}) {
  const inputs = useMemo(
    () => benchmarkInputs && { ...benchmarkInputs, playerResults: snapshot.results },
    [benchmarkInputs, snapshot],
  );
  const { status, busy, load, available, rankingCount, columns, logs, reference, playerResults } =
    useBenchmarks(inputs);
  const results = playerResults ?? snapshot.results;
  useOpenDetailsForPrint();
  const [normalization, setNormalizationState] = useState(readNormalization);
  const setNormalization = (value: Normalization) => {
    setNormalizationState(value);
    try {
      localStorage.setItem(NORMALIZATION_KEY, JSON.stringify(value));
    } catch {
      // Not remembered; it still applies on this page.
    }
  };
  const source = profile.source;
  const mistakes = useMemo(
    () =>
      reference
        ? biggestMistakes(profile, snapshot, reference.logs, classSpellMatcher(profile.specId))
        : [],
    [profile, snapshot, reference],
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
          !benchmarkInputs && (
            <p className="text-muted">
              Benchmarks need a boss kill with rankings; showing this log on its own.
            </p>
          )
        )}
      </Panel>

      {reference && (
        <Panel
          title="Biggest mistakes"
          explanation={`What play would close against ${reference.label}, largest first.`}
        >
          <BiggestMistakes
            mistakes={mistakes}
            fightDps={snapshot.fightDps}
            referenceLabel={reference.label}
          />
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
            explanation={`From ${rankingCount} ranked parses. Close = ilvl ±5, kill time ±20%, raid size ±5.`}
          >
            <BenchmarkTable player={{ ...snapshot, results }} benchmarks={columns} />
          </Panel>

          <Panel
            title="APL expectations vs top parses"
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
        title="Cooldown windows"
        explanation="DPS per second around each window (highlighted); the dashed line is the fight average. Scroll sideways through the windows."
      >
        <WindowReels player={snapshot} benchmarks={logs} />
      </Panel>
    </>
  );
}
