import makeWclUrl from 'common/makeWclUrl';
import { makePlainUrl } from 'interface/makeAnalyzerUrl';
import { Link } from 'react-router-dom';

import { BenchmarkLog } from './useBenchmarks';

/** Every parsed benchmark log, with links to it on Warcraft Logs and in this app. */
export default function BenchmarkLogList({ logs }: { logs: BenchmarkLog[] }) {
  if (logs.length === 0) {
    return <p className="text-muted">No benchmark logs loaded yet.</p>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table table-condensed">
        <thead>
          <tr>
            <th>Benchmark</th>
            <th>Log</th>
            <th className="hidden-print">Open</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.key}>
              <td>{log.roles.join(', ')}</td>
              <td>{log.description}</td>
              <td className="hidden-print" style={{ whiteSpace: 'nowrap' }}>
                <a
                  href={makeWclUrl(log.reportCode, { fight: log.fightId, type: 'damage-done' })}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Warcraft Logs
                </a>
                {' · '}
                <Link
                  to={makePlainUrl(
                    log.reportCode,
                    log.fightId,
                    undefined,
                    undefined,
                    log.playerName,
                  )}
                >
                  Analyze
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
