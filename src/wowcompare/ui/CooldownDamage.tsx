import { formatNumber } from 'common/format';
import { SpellLink } from 'interface';
import { ReactNode } from 'react';

import { median } from '../benchmarks/aggregate';
import { CooldownWindowSet, LogSnapshot } from '../metrics/results';
import { STATUS_COLORS } from './ProfileResultsTable';
import { CHART_COLORS } from './charts';
import { BenchmarkColumn } from './useBenchmarks';

/** Abilities drawn in each cooldown's chart; the table below lists them all. */
const CHART_ROWS = 8;

interface ChartRow {
  token: string;
  spellId: number;
  mine: Stat;
  reference: Stat;
}

/** Paired bars per ability: the player's damage per window above the reference's. */
function DamageChart({ rows, referenceLabel }: { rows: ChartRow[]; referenceLabel: string }) {
  const shown = [...rows]
    .sort(
      (a, b) =>
        Math.max(b.mine.damagePerWindow ?? 0, b.reference.damagePerWindow ?? 0) -
        Math.max(a.mine.damagePerWindow ?? 0, a.reference.damagePerWindow ?? 0),
    )
    .slice(0, CHART_ROWS);
  const max = Math.max(
    1,
    ...shown.flatMap((r) => [r.mine.damagePerWindow ?? 0, r.reference.damagePerWindow ?? 0]),
  );
  const bar = (value: number | null, color: string, label: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 12 }} title={label}>
      <div
        style={{
          width: `${((value ?? 0) / max) * 100}%`,
          minWidth: value ? 2 : 0,
          height: 8,
          background: color,
          borderRadius: 2,
        }}
      />
      <span className="text-muted" style={{ fontSize: '0.8em', whiteSpace: 'nowrap' }}>
        {value ? formatNumber(value) : '—'}
      </span>
    </div>
  );
  return (
    <div style={{ maxWidth: 640, marginBottom: 8 }}>
      {shown.map((row) => (
        <div
          key={row.token}
          style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 8, marginBottom: 6 }}
        >
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <SpellLink spell={row.spellId} />
          </div>
          <div style={{ paddingRight: 48 }}>
            {bar(row.mine.damagePerWindow, CHART_COLORS.you, 'You')}
            {bar(row.reference.damagePerWindow, CHART_COLORS.referenceFill, referenceLabel)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One sentence on how the player's windows compare, naming the biggest shortfall. */
function describe(
  cooldown: ReactNode,
  rows: ChartRow[],
  referenceLabel: string,
  /** The player's whole-fight DPS as a share of the reference's, for context on gear. */
  dpsShare: number | null,
) {
  const total = (pick: (r: ChartRow) => number | null) =>
    rows.reduce((sum, r) => sum + (pick(r) ?? 0), 0);
  const mine = total((r) => r.mine.damagePerWindow);
  const top = total((r) => r.reference.damagePerWindow);
  if (top <= 0) {
    return null;
  }
  const worst = [...rows].sort(
    (a, b) =>
      (a.mine.damagePerWindow ?? 0) -
      (a.reference.damagePerWindow ?? 0) -
      ((b.mine.damagePerWindow ?? 0) - (b.reference.damagePerWindow ?? 0)),
  )[0];
  const gap = (worst.reference.damagePerWindow ?? 0) - (worst.mine.damagePerWindow ?? 0);
  return (
    <p>
      Your {cooldown} windows deal <strong>{Math.round((mine / top) * 100)}%</strong> of{' '}
      {referenceLabel}'s damage per window
      {dpsShare !== null && ` (across the whole fight you're at ${Math.round(dpsShare * 100)}%)`}.
      {gap > 0 && (
        <>
          {' '}
          The biggest shortfall is <SpellLink spell={worst.spellId} />: {formatNumber(gap)} less per
          window
          {worst.mine.castsPerWindow !== null &&
            worst.reference.castsPerWindow !== null &&
            worst.reference.perCast !== null &&
            ` (${worst.mine.castsPerWindow.toFixed(1)} vs ${worst.reference.castsPerWindow.toFixed(1)} casts)`}
          .
        </>
      )}
    </p>
  );
}

/** Columns shown, by benchmark title; the rest would make the table too wide. */
const COLUMN_TITLES = ['#1', 'Top 10 median', 'Same build', 'Best close'];
/** An ability is listed if the player uses it or at least this share of top-10 logs do. */
const COMMON_IN_TOP = 0.5;
/** You vs the top-10 median: below this fraction is flagged. */
const BEHIND = 0.9;

interface Stat {
  castsPerWindow: number | null;
  perCast: number | null;
  damagePerWindow: number | null;
}

function statsFor(snapshots: LogSnapshot[], cooldown: string, ability: string): Stat {
  const sets = snapshots
    .map((s) => s.windows.find((set) => set.token === cooldown))
    .filter((set): set is CooldownWindowSet => set !== undefined && set.windows.length > 0);
  const perLog = sets.map((set) => {
    const found = set.abilities.find((a) => a.token === ability);
    return {
      castsPerWindow: (found?.casts ?? 0) / set.windows.length,
      perCast: found && found.casts > 0 ? found.damage / found.casts : null,
      damagePerWindow: (found?.damage ?? 0) / set.windows.length,
    };
  });
  return {
    castsPerWindow: median(perLog.map((l) => l.castsPerWindow)),
    perCast: median(perLog.map((l) => l.perCast).filter((v): v is number => v !== null)),
    damagePerWindow: median(perLog.map((l) => l.damagePerWindow)),
  };
}

function StatCell({
  stat,
  reference,
  uncast,
}: {
  stat: Stat;
  reference?: Stat;
  /** Damage nobody casts directly (melee, procs, Convoke): show damage per window instead. */
  uncast: boolean;
}) {
  const color = (mine: number | null, ref: number | null | undefined) =>
    reference && mine !== null && ref && mine < ref * BEHIND ? STATUS_COLORS.warn : undefined;
  if (uncast) {
    return (
      <td style={{ whiteSpace: 'nowrap' }}>
        <span style={{ color: color(stat.damagePerWindow, reference?.damagePerWindow) }}>
          {stat.damagePerWindow ? `${formatNumber(stat.damagePerWindow)} / window` : '—'}
        </span>
      </td>
    );
  }
  return (
    <td style={{ whiteSpace: 'nowrap' }}>
      <span style={{ color: color(stat.castsPerWindow, reference?.castsPerWindow) }}>
        {stat.castsPerWindow === null ? '—' : stat.castsPerWindow.toFixed(1)}
      </span>
      {' × '}
      <span style={{ color: color(stat.perCast, reference?.perCast) }}>
        {stat.perCast === null ? '—' : formatNumber(stat.perCast)}
      </span>
    </td>
  );
}

/**
 * For each cooldown, the big damage abilities inside its windows: casts per window and average
 * damage per cast, for the player and the benchmarks. Lower values than the top-10 median show in
 * orange in the player's column.
 */
export default function CooldownDamage({
  player,
  columns,
  topLogs,
  referenceLabel,
}: {
  player: LogSnapshot;
  columns: BenchmarkColumn[];
  /** The reference logs (top 10, else #1) the player is flagged against. */
  topLogs: LogSnapshot[];
  referenceLabel: string;
}) {
  const referenceDps = median(topLogs.map((log) => log.fightDps).filter((dps) => dps > 0));
  const dpsShare = referenceDps ? player.fightDps / referenceDps : null;
  const shown = COLUMN_TITLES.map((title) => columns.find((c) => c.title === title)).filter(
    (c): c is BenchmarkColumn => c !== undefined && c.snapshots.length > 0,
  );

  return (
    <>
      {player.windows.map((set) => {
        // The player's abilities plus any that most top logs use.
        const counts = new Map<string, { count: number; spellId: number; damage: number }>();
        for (const log of topLogs) {
          for (const ability of log.windows.find((s) => s.token === set.token)?.abilities ?? []) {
            const entry = counts.get(ability.token) ?? {
              count: 0,
              spellId: ability.spellId,
              damage: 0,
            };
            entry.count += 1;
            entry.damage += ability.damage;
            counts.set(ability.token, entry);
          }
        }
        const rows = new Map<string, number>(set.abilities.map((a) => [a.token, a.spellId]));
        [...counts.entries()]
          .filter(([, c]) => topLogs.length > 0 && c.count / topLogs.length >= COMMON_IN_TOP)
          .sort((a, b) => b[1].damage - a[1].damage)
          .forEach(([token, c]) => rows.has(token) || rows.set(token, c.spellId));
        if (rows.size === 0) {
          return null;
        }

        const chartRows: ChartRow[] = [...rows.entries()].map(([token, spellId]) => ({
          token,
          spellId,
          mine: statsFor([player], set.token, token),
          reference: statsFor(topLogs, set.token, token),
        }));

        return (
          <div key={set.token} style={{ marginBottom: 24 }}>
            <h3>
              Inside <SpellLink spell={set.spellId}>{set.label}</SpellLink>
            </h3>
            {topLogs.length > 0 && (
              <>
                {describe(
                  <SpellLink spell={set.spellId}>{set.label}</SpellLink>,
                  chartRows,
                  referenceLabel,
                  dpsShare,
                )}
                <DamageChart rows={chartRows} referenceLabel={referenceLabel} />
              </>
            )}
            <details>
              <summary className="text-muted" style={{ cursor: 'pointer' }}>
                Casts and damage per cast, every benchmark
              </summary>
              <div style={{ overflowX: 'auto' }}>
                <table className="table table-condensed">
                  <thead>
                    <tr>
                      <th>Ability</th>
                      <th>You</th>
                      {shown.map((column) => (
                        <th key={column.title}>{column.title}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows.entries()].map(([token, spellId]) => {
                      const reference = statsFor(topLogs, set.token, token);
                      const mine = statsFor([player], set.token, token);
                      const uncast = !mine.perCast && !reference.perCast;
                      return (
                        <tr key={token}>
                          <td>
                            <SpellLink spell={spellId} />
                          </td>
                          <StatCell
                            stat={mine}
                            reference={topLogs.length > 0 ? reference : undefined}
                            uncast={uncast}
                          />
                          {shown.map((column) => (
                            <StatCell
                              key={column.title}
                              stat={statsFor(column.snapshots, set.token, token)}
                              uncast={uncast}
                            />
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        );
      })}
      <p className="text-muted">
        Gold bars are you, grey bars {referenceLabel}; the table gives casts per window × average
        damage per cast; damage that isn't cast directly (melee, procs, Convoke) is shown per
        window. Damage includes ticks and pets, so per-cast figures for DoTs and summons run high.
        Orange: below 90% of {referenceLabel}.
      </p>
    </>
  );
}
