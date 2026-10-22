import { formatNumber } from 'common/format';
import { SpellLink } from 'interface';

import { median } from '../benchmarks/aggregate';
import { CooldownWindowSet, LogSnapshot } from '../metrics/results';
import { STATUS_COLORS } from './ProfileResultsTable';
import { BenchmarkColumn } from './useBenchmarks';

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
}: {
  player: LogSnapshot;
  columns: BenchmarkColumn[];
}) {
  const shown = COLUMN_TITLES.map((title) => columns.find((c) => c.title === title)).filter(
    (c): c is BenchmarkColumn => c !== undefined && c.snapshots.length > 0,
  );
  const topLogs = columns.find((c) => c.title === 'Top 10 median')?.snapshots ?? [];

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

        return (
          <div key={set.token} style={{ overflowX: 'auto', marginBottom: 16 }}>
            <h3>
              Inside <SpellLink spell={set.spellId}>{set.label}</SpellLink>
            </h3>
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
        );
      })}
      <p className="text-muted">
        Casts per window × average damage per cast; damage that isn't cast directly (melee, procs,
        Convoke) is shown per window. Damage includes ticks and pets, so per-cast figures for DoTs
        and summons run high. Orange: below 90% of the top-10 median.
      </p>
    </>
  );
}
