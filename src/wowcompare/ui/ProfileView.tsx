import { LogSnapshot } from '../metrics/results';
import BenchmarkTable from './BenchmarkTable';
import ProfileResultsTable from './ProfileResultsTable';
import useBenchmarks, { BenchmarkInputs } from './useBenchmarks';
import WindowReels from './WindowReels';

/** The Profile tab: this log's results, the benchmark comparison and the cooldown window reels. */
export default function ProfileView({
  snapshot,
  benchmarkInputs,
}: {
  snapshot: LogSnapshot;
  /** Undefined outside boss fights, where there are no rankings to compare against. */
  benchmarkInputs: BenchmarkInputs | undefined;
}) {
  const { status, columns, logs, load } = useBenchmarks(benchmarkInputs);

  return (
    <>
      <ProfileResultsTable results={snapshot.results} />

      {benchmarkInputs && (
        <>
          <h2>Benchmarks</h2>
          {columns ? (
            <BenchmarkTable player={snapshot} benchmarks={columns} />
          ) : (
            <button type="button" className="btn btn-primary" onClick={load} disabled={!!status}>
              Load benchmarks
            </button>
          )}{' '}
          {status && <p className="text-muted">{status}</p>}
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
