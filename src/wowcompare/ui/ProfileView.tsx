import { formatDuration, formatNumber } from 'common/format';
import { Panel } from 'interface';
import { ReactNode, useMemo } from 'react';

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
import useBenchmarks, { BenchmarkInputs, BenchmarkKind, BenchmarkReference } from './useBenchmarks';
import WindowReels from './WindowReels';

/** Extra benchmarks, as offered on their buttons. */
const LOAD_HINTS: Partial<Record<BenchmarkKind, string>> = {
  sameBuild: 'Same build (1 log)',
  bestClose: 'Best close parse (1 log)',
  top10Close: 'Top 10 close median (up to 10 logs)',
};

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
}: {
  player: LogSnapshot;
  results: ProfileResults;
  reference: BenchmarkReference;
  mistakes: Mistake[];
}) {
  const topDps = reference.logs.map((log) => log.fightDps).filter((dps) => dps > 0);
  const referenceDps = median(topDps);
  const share = referenceDps ? player.fightDps / referenceDps : null;
  const counts = statusCounts(results);
  const worst = mistakes[0];

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <StatTile
          label="Your DPS"
          value={formatNumber(player.fightDps)}
          sub={`over ${formatDuration(player.durationMs)}`}
          color={CHART_COLORS.you}
        />
        {referenceDps && (
          <StatTile
            label={`${reference.label.replace(/^the /, '')} DPS`}
            value={formatNumber(referenceDps)}
            sub={share !== null && `you're at ${Math.round(share * 100)}%`}
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
            You did <strong>{Math.round(share * 100)}%</strong> of {reference.label}'s DPS. Some of
            that is gear, raid comp and kill time, which play can't close.{' '}
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
            Your DPS among the {topDps.length} reference logs (grey):
          </p>
          <DpsStrip you={player.fightDps} others={topDps} />
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
          className="btn btn-default btn-sm"
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
          <Summary player={snapshot} results={results} reference={reference} mistakes={mistakes} />
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
