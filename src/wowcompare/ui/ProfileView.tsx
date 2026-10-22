import { PASS_FRACTION, WARN_FRACTION } from '../benchmarks/aggregate';
import { LogSnapshot } from '../metrics/results';
import { Profile } from '../profile/types';
import AplExpectations from './AplExpectations';
import BenchmarkTable from './BenchmarkTable';
import BiggestMistakes from './BiggestMistakes';
import CooldownDamage from './CooldownDamage';
import ProfileResultsTable from './ProfileResultsTable';
import Suggestions from './Suggestions';
import useBenchmarks, { BenchmarkInputs } from './useBenchmarks';
import WindowReels from './WindowReels';

/** The Profile tab: this log's results, the benchmark comparison and the cooldown window reels. */
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
  const { status, columns, logs, playerResults, load } = useBenchmarks(
    benchmarkInputs && { ...benchmarkInputs, playerResults: snapshot.results },
  );
  const results = playerResults ?? snapshot.results;
  const topLogs = logs
    .filter((log) => log.roles.some((role) => role.startsWith('Top 10')))
    .map((log) => log.snapshot);
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
          {playerResults
            ? `Colours compare against the top-10 median: pass at ${PASS_FRACTION * 100}%, warn at ${WARN_FRACTION * 100}%.`
            : 'Load benchmarks to colour results against the top-10 median.'}
          {unresolved.length > 0 && ` Not mapped to spells yet: ${unresolved.join(', ')}.`}
        </p>
      )}
      <ProfileResultsTable results={results} />

      {benchmarkInputs && (
        <>
          {columns && (
            <>
              <h2>Biggest mistakes</h2>
              <BiggestMistakes profile={profile} player={snapshot} topLogs={topLogs} />
            </>
          )}
          <h2>Benchmarks</h2>
          {columns ? (
            <BenchmarkTable player={{ ...snapshot, results }} benchmarks={columns} />
          ) : (
            <button type="button" className="btn btn-primary" onClick={load} disabled={!!status}>
              Load benchmarks
            </button>
          )}{' '}
          {status && <p className="text-muted">{status}</p>}
        </>
      )}

      {columns && (
        <>
          <h2>Damage inside cooldowns</h2>
          <CooldownDamage player={snapshot} columns={columns} />
        </>
      )}

      {columns && (
        <>
          <h2>APL expectations vs top parses</h2>
          <p className="text-muted">
            What the APL asks for, and how often the top 10 parses actually do it. "Favoured" lines
            are ones the APL prefers under a buff without requiring it.
          </p>
          <AplExpectations player={snapshot.results} topLogs={topLogs} />
        </>
      )}

      {columns && (
        <>
          <h2>Suggestions</h2>
          <Suggestions
            profile={profile}
            player={snapshot}
            topLogs={topLogs}
            allLogs={[snapshot, ...logs.map((log) => log.snapshot)]}
          />
        </>
      )}

      <h2>Cooldown windows</h2>
      <p className="text-muted">
        DPS per second around each window (highlighted); the dashed line is the fight average.
        Scroll sideways through the windows.
        {benchmarkInputs && !columns && ' Load benchmarks to compare with a benchmark log.'}
      </p>
      <WindowReels player={snapshot} benchmarks={logs} />
    </>
  );
}
