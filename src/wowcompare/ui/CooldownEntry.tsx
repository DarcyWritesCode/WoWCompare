import { formatPercentage } from 'common/format';
import { SpellLink } from 'interface';

import { median } from '../benchmarks/aggregate';
import { CooldownWindowSet, LogSnapshot } from '../metrics/results';
import { classSpellMatcher } from '../simc/specs';
import { STATUS_COLORS } from './ProfileResultsTable';
import { CompareBar, CompareLegend, tint } from './charts';

/** A buff is listed if it's up going into most of the player's or the top logs' windows. */
const COMMON = 0.5;
/** Below this fraction of the reference is flagged. */
const BEHIND = 0.9;

interface Row {
  key: string;
  label: React.ReactNode;
  mine: number | null;
  top: number | null;
  /** How to show the values. */
  format: (value: number | null) => string;
  /** Fractions (0–1) get a bar; counts like stacks don't. */
  fraction?: boolean;
}

const pct = (value: number | null) => (value === null ? '—' : `${formatPercentage(value, 0)}%`);

/** Per log: the median over its windows. Across logs: the median of those. */
function stat(sets: CooldownWindowSet[], value: (set: CooldownWindowSet) => number | null) {
  return median(sets.map(value).filter((v): v is number => v !== null));
}

function rowsFor(
  set: CooldownWindowSet,
  topSets: CooldownWindowSet[],
  isClassSpell: (spellId: number, token: string) => boolean,
): Row[] {
  const states = (s: CooldownWindowSet) => s.entryStates ?? [];
  const resourceNames = new Set(states(set).flatMap((e) => Object.keys(e.resources)));
  const rows: Row[] = [...resourceNames].map((name) => {
    const at = (s: CooldownWindowSet) =>
      median(
        states(s)
          .map((e) => e.resources[name])
          .filter((v): v is number => typeof v === 'number'),
      );
    return {
      key: `resource-${name}`,
      label: `${name} at the cast (of max)`,
      mine: at(set),
      top: stat(topSets, at),
      format: pct,
      fraction: true,
    };
  });

  const share = (s: CooldownWindowSet, token: string) =>
    states(s).length > 0 ? states(s).filter((e) => e.buffs[token]).length / states(s).length : null;
  const stacks = (s: CooldownWindowSet, token: string) =>
    median(states(s).flatMap((e) => (e.buffs[token] ? [e.buffs[token].stacks] : [])));
  const tokens = new Map<string, { name: string; spellId: number }>();
  for (const s of [set, ...topSets]) {
    for (const state of states(s)) {
      for (const [token, buff] of Object.entries(state.buffs)) {
        // Class buffs only: flasks, food, enchants and trinket procs aren't lined up by play.
        if (isClassSpell(buff.spellId, token)) {
          tokens.set(token, tokens.get(token) ?? buff);
        }
      }
    }
  }
  for (const [token, buff] of tokens) {
    const mine = share(set, token);
    const top = stat(topSets, (s) => share(s, token));
    if ((mine ?? 0) < COMMON && (top ?? 0) < COMMON) {
      continue;
    }
    rows.push({
      key: `buff-${token}`,
      label: (
        <>
          <SpellLink spell={buff.spellId}>{buff.name}</SpellLink> up
        </>
      ),
      mine,
      top,
      format: pct,
      fraction: true,
    });
    const myStacks = stacks(set, token);
    const topStacks = stat(topSets, (s) => stacks(s, token));
    if ((myStacks ?? 1) > 1 || (topStacks ?? 1) > 1) {
      rows.push({
        key: `stacks-${token}`,
        label: (
          <>
            <SpellLink spell={buff.spellId}>{buff.name}</SpellLink> stacks
          </>
        ),
        mine: myStacks,
        top: topStacks,
        format: (v) => (v === null ? '—' : v.toFixed(1)),
      });
    }
  }
  return rows;
}

/**
 * What the player brings into each cooldown (pooled resources, buffs and stacks lined up)
 * against the reference logs, e.g. Astral Power and Starlord stacks going into Incarnation.
 */
export default function CooldownEntry({
  specId,
  player,
  topLogs,
  referenceLabel,
}: {
  specId: number;
  player: LogSnapshot;
  topLogs: LogSnapshot[];
  referenceLabel: string;
}) {
  const isClassSpell = classSpellMatcher(specId);
  return (
    <>
      <CompareLegend referenceLabel={referenceLabel} range={false} />
      {player.windows.map((set) => {
        const topSets = topLogs
          .map((log) => log.windows.find((s) => s.token === set.token))
          .filter(
            (s): s is CooldownWindowSet => s !== undefined && (s.entryStates?.length ?? 0) > 0,
          );
        const rows = rowsFor(set, topSets, isClassSpell);
        if (rows.length === 0) {
          return null;
        }
        return (
          <div key={set.token} style={{ overflowX: 'auto', marginBottom: 16 }}>
            <h3>
              Going into <SpellLink spell={set.spellId}>{set.label}</SpellLink>
            </h3>
            <table className="table table-condensed">
              <thead>
                <tr>
                  <th />
                  <th>You</th>
                  <th>Top median</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td
                      style={tint(
                        row.mine !== null && row.top && row.mine < row.top * BEHIND
                          ? STATUS_COLORS.warn
                          : undefined,
                      )}
                    >
                      {row.format(row.mine)}
                    </td>
                    <td>{row.format(row.top)}</td>
                    <td>
                      {row.fraction && (
                        <CompareBar
                          value={row.mine}
                          reference={row.top}
                          title={`You ${row.format(row.mine)}, top median ${row.format(row.top)}`}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <p className="text-muted">
        Measured at each cooldown cast: resources as a share of their maximum, and how often each
        class buff was already up (with its stacks). Orange: below 90% of {referenceLabel}.
      </p>
    </>
  );
}
