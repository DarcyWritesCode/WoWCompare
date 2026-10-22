import { useMemo } from 'react';

import { PASS_FRACTION, WARN_FRACTION } from '../benchmarks/aggregate';
import { LogSnapshot } from '../metrics/results';
import { Profile } from '../profile/types';
import AplExpectations from './AplExpectations';
import BenchmarkTable from './BenchmarkTable';
import BiggestMistakes from './BiggestMistakes';
import CooldownDamage from './CooldownDamage';
import CooldownEntry from './CooldownEntry';
import ProfileResultsTable from './ProfileResultsTable';
import Suggestions from './Suggestions';
import useBenchmarks, { BenchmarkInputs, BenchmarkKind } from './useBenchmarks';
import WindowReels from './WindowReels';

/** Extra benchmarks, as offered on their buttons. */
const LOAD_HINTS: Partial<Record<BenchmarkKind, string>> = {
  sameBuild: 'Same build (1 log)',
  bestClose: 'Best close parse (1 log)',
  top10Close: 'Top 10 close median (up to 10 logs)',
};

/**
 * The Live Compare tab: this log against the #1 parse and the top 10 (loaded straight away), with
 * the other benchmarks one click each, plus the cooldown window reels.
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

  return (
    <>
      {source && (
        <p className="text-muted">
          Built from SimC's <a href={source.url}>{source.file}</a> APL (
          {source.live
            ? `fetched ${new Date(source.retrievedAt ?? Date.now()).toLocaleString()}`
            : 'bundled snapshot; the live APL could not be fetched'}
          ). Rank follows APL priority order.{' '}
          {reference &&
            `Colours compare against ${reference.label}: pass at ${PASS_FRACTION * 100}%, warn at ${WARN_FRACTION * 100}%.`}
          {unresolved.length > 0 && ` Not mapped to spells yet: ${unresolved.join(', ')}.`}
        </p>
      )}

      {benchmarkInputs && (
        <>
          {status && <p className="text-muted">{status}</p>}
          {reference && (
            <>
              <h2>Biggest mistakes</h2>
              <BiggestMistakes
                profile={profile}
                player={snapshot}
                topLogs={reference.logs}
                referenceLabel={reference.label}
              />
            </>
          )}
          {available.length > 0 && (
            <p>
              Compare with more:{' '}
              {available.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="btn btn-default"
                  style={{ marginRight: 8, marginBottom: 4 }}
                  disabled={busy}
                  onClick={() => load(kind)}
                >
                  {LOAD_HINTS[kind]}
                </button>
              ))}
            </p>
          )}
        </>
      )}

      <ProfileResultsTable results={results} />

      {columns && reference && (
        <>
          <h2>Benchmarks</h2>
          <BenchmarkTable player={{ ...snapshot, results }} benchmarks={columns} />
          <p className="text-muted">
            From {rankingCount} ranked parses. Close = ilvl ±5, kill time ±20%, raid size ±5.
          </p>

          <h2>Damage inside cooldowns</h2>
          <CooldownDamage
            player={snapshot}
            columns={columns}
            topLogs={reference.logs}
            referenceLabel={reference.label}
          />

          <h2>Going into cooldowns</h2>
          <CooldownEntry
            specId={profile.specId}
            player={snapshot}
            topLogs={reference.logs}
            referenceLabel={reference.label}
          />

          <h2>APL expectations vs top parses</h2>
          <p className="text-muted">
            What the APL asks for, and how often {reference.label} actually does it. "Favoured"
            lines are ones the APL prefers under a buff without requiring it.
          </p>
          <AplExpectations player={snapshot.results} topLogs={reference.logs} />

          <h2>Suggestions</h2>
          <Suggestions
            profile={profile}
            player={snapshot}
            topLogs={reference.logs}
            allLogs={[snapshot, ...logs.map((log) => log.snapshot)]}
          />
        </>
      )}

      <h2>Cooldown windows</h2>
      <p className="text-muted">
        DPS per second around each window (highlighted); the dashed line is the fight average.
        Scroll sideways through the windows.
      </p>
      <WindowReels player={snapshot} benchmarks={logs} />
    </>
  );
}
