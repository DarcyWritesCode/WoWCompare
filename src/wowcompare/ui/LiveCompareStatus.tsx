import { formatNumber } from 'common/format';
import { MouseEvent, useEffect, useState } from 'react';

import {
  BenchmarkStatus,
  BundleStatus,
  fetchBenchmarkStatus,
  SpecStatus,
} from '../benchmarks/published';
import { REFERENCE_LABEL } from '../benchmarks/reference';
import { nextRun, runTimeUtc, updateDay, WEEKDAY_NAMES } from '../benchmarks/schedule';
import { hasSimcApl } from '../profile/registry';

const DIFFICULTY_NAMES: Record<number, string> = { 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };

/** Fetched once per page, shared by every spec card. */
let statusRequest: Promise<BenchmarkStatus | null> | null = null;

function useBenchmarkStatus() {
  const [status, setStatus] = useState<BenchmarkStatus | null>(null);
  useEffect(() => {
    statusRequest ??= fetchBenchmarkStatus();
    let live = true;
    statusRequest.then((value) => live && setStatus(value));
    return () => {
      live = false;
    };
  }, []);
  return status;
}

const formatDate = (at: number | string) =>
  new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The spec cards are links; keep clicks on the details from opening the example report. */
const stop = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

function BundleCell({ bundle }: { bundle: BundleStatus | undefined }) {
  if (!bundle) {
    return <td>—</td>;
  }
  const tooltip = [
    `Built ${new Date(bundle.builtAt).toLocaleString()}`,
    bundle.totalParses !== null && `${formatNumber(bundle.totalParses)} ranked parses`,
    `${bundle.logs} logs parsed${bundle.buffed ? `, ${bundle.buffed} with PI/Aug` : ''}`,
    bundle.failed > 0 && `${bundle.failed} failed`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <td title={tooltip} style={{ whiteSpace: 'nowrap' }}>
      {bundle.ranks ? `#${bundle.ranks[0]}–${bundle.ranks[1]}` : '—'} · {bundle.logs}
      {bundle.failed > 0 && <span className="text-muted"> ({bundle.failed} failed)</span>}
    </td>
  );
}

function Details({ spec }: { spec: SpecStatus }) {
  const difficulties = [...new Set(spec.bundles.map((b) => b.difficulty))].sort((a, b) => b - a);
  const encounters = [...new Map(spec.bundles.map((b) => [b.encounterId, b])).values()];
  return (
    <div onClick={stop} style={{ cursor: 'default', marginTop: 4 }}>
      <table className="table table-condensed" style={{ fontSize: 'smaller', marginBottom: 0 }}>
        <thead>
          <tr>
            <th>Boss</th>
            {difficulties.map((d) => (
              <th key={d} title="Reference ranks · logs parsed">
                {DIFFICULTY_NAMES[d] ?? d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {encounters.map((e) => (
            <tr key={e.encounterId}>
              <td>{e.encounterName ?? e.encounterId}</td>
              {difficulties.map((d) => (
                <BundleCell
                  key={d}
                  bundle={spec.bundles.find(
                    (b) => b.encounterId === e.encounterId && b.difficulty === d,
                  )}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Live Compare's benchmark data for one spec, on the specs page: when it's rebuilt, when it last
 * was, which SimC APL it uses and which logs it compares against.
 */
export default function LiveCompareStatus({
  specId,
  wclClassName,
}: {
  specId: number;
  wclClassName: string;
}) {
  const status = useBenchmarkStatus();
  const [open, setOpen] = useState(false);
  if (!hasSimcApl(specId)) {
    return (
      <div className="text-muted" style={{ fontSize: 'smaller' }}>
        Live Compare: no SimC APL for this spec.
      </div>
    );
  }
  const day = updateDay(wclClassName);
  const run = nextRun(day);
  const localTime = run.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const localDay = run.toLocaleDateString(undefined, { weekday: 'long' });
  const spec = status?.specs[specId];
  const parses = spec?.bundles.flatMap((b) => (b.totalParses ? [b.totalParses] : [])) ?? [];
  const logs = spec?.bundles.reduce((sum, b) => sum + b.logs, 0) ?? 0;
  const buffed = spec?.bundles.reduce((sum, b) => sum + b.buffed, 0) ?? 0;

  return (
    <div style={{ fontSize: 'smaller', marginTop: 4 }}>
      <div title={`${WEEKDAY_NAMES[day]}s from ${runTimeUtc()}`}>
        Live Compare: updated <strong>{localDay}s</strong> (from ~{localTime} your time)
        {spec && (
          <>
            {' '}
            · last built {formatDate(spec.completedAt ?? spec.profileBuiltAt)}
            {!spec.completedAt && ' (partly)'}
            {spec.aplCommit && <> · APL from SimC {formatDate(spec.aplCommit.date)}</>}
          </>
        )}
      </div>
      {spec && spec.bundles.length > 0 ? (
        <div>
          {spec.bundles.length} boss × difficulty benchmarks · {REFERENCE_LABEL}
          {parses.length > 0 &&
            ` of ${formatNumber(Math.min(...parses))}–${formatNumber(Math.max(...parses))} parses`}{' '}
          · {logs} logs{buffed > 0 && ` (${buffed} with PI/Aug)`}{' '}
          <button
            type="button"
            className="btn btn-link btn-xs"
            style={{ padding: 0, verticalAlign: 'baseline' }}
            onClick={(e) => {
              stop(e);
              setOpen(!open);
            }}
          >
            {open ? 'hide details' : 'details'}
          </button>
          {open && <Details spec={spec} />}
        </div>
      ) : (
        <div className="text-muted">Not built yet.</div>
      )}
    </div>
  );
}
