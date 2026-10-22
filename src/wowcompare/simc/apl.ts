/**
 * Minimal SimulationCraft APL reader: enough structure to pull out which cooldowns, buffs and
 * dots an APL cares about. It does not evaluate expressions.
 */

export interface AplAction {
  /** Action list name; `default` for the main `actions=` list. */
  list: string;
  /** Action token, e.g. `tigers_fury`, `call_action_list`. */
  name: string;
  options: Record<string, string>;
  /** Position in the file, for ordering. */
  index: number;
}

export function parseApl(text: string): AplAction[] {
  const actions: AplAction[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const match = /^actions(?:\.([A-Za-z0-9_]+))?\+?=\/?(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, list = 'default', body] = match;
    const [name, ...parts] = splitTopLevel(body, ',');
    const options: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq > 0) {
        options[part.slice(0, eq)] = part.slice(eq + 1);
      }
    }
    actions.push({ list, name: name.trim(), options, index: actions.length });
  }
  return actions;
}

/** Splits on `separator` outside parentheses. */
export function splitTopLevel(expr: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const char = expr[i];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (depth === 0 && char === separator) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/** Strips one layer of parentheses wrapping the whole expression. */
function unwrap(expr: string): string {
  let current = expr.trim();
  while (current.startsWith('(') && closingParen(current) === current.length - 1) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

/** Index of the parenthesis closing the one at index 0. */
function closingParen(expr: string): number {
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    if (expr[i] === '(') {
      depth += 1;
    } else if (expr[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Disjuncts that only cover the end of the fight, e.g. `fight_remains<5`. */
const END_OF_FIGHT = /^fight_remains\s*[<>=]/;

/**
 * The conditions that must all hold for the action to run, when the expression is a plain
 * conjunction. End-of-fight escape hatches (`...|fight_remains<5`) are ignored; any other `|`
 * at the top level means there is no single required set, and nothing is returned.
 */
export function requiredConjuncts(expr: string | undefined): string[] {
  if (!expr) {
    return [];
  }
  const disjuncts = splitTopLevel(unwrap(expr), '|')
    .map((d) => d.trim())
    .filter((d) => !END_OF_FIGHT.test(d));
  if (disjuncts.length !== 1) {
    return [];
  }
  return splitTopLevel(unwrap(disjuncts[0]), '&').map((c) => c.trim());
}

/** `buff.x.up` / `buff.x.react` → present; `!buff.x.up` / `buff.x.down` → absent. */
export function auraCheck(
  conjunct: string,
): { kind: 'buff' | 'debuff' | 'dot'; token: string; present: boolean } | null {
  const match = /^(!?)(buff|debuff|dot)\.([a-z0-9_]+)\.(up|react|down|ticking)$/.exec(conjunct);
  if (!match) {
    return null;
  }
  const [, not, kind, token, state] = match;
  const present = (state !== 'down') !== (not === '!');
  return { kind: kind as 'buff' | 'debuff' | 'dot', token, present };
}

/** Every `prefix.token` reference in an expression, e.g. all `buff.*` tokens. */
export function references(expr: string | undefined, prefix: string): string[] {
  if (!expr) {
    return [];
  }
  const pattern = new RegExp(`(?:^|[^a-z0-9_.])${prefix}\\.([a-z0-9_]+)`, 'g');
  return [...expr.matchAll(pattern)].map((m) => m[1]);
}

/** Positive checks of a buff anywhere in an expression (`buff.x.up`/`react`, not negated; stack counts aren't procs). */
export function positiveBuffChecks(expr: string | undefined): string[] {
  if (!expr) {
    return [];
  }
  return [...expr.matchAll(/(^|[^!a-z0-9_.])buff\.([a-z0-9_]+)\.(up|react)\b/g)].map((m) => m[2]);
}

/**
 * Positive buff checks used as boolean terms (after `&`, `|`, `(` or at the start), leaving out
 * arithmetic like `2+(2*buff.bs_inc.up)`.
 */
export function booleanBuffChecks(expr: string | undefined): string[] {
  if (!expr) {
    return [];
  }
  return [...expr.matchAll(/(^|[&|(])buff\.([a-z0-9_]+)\.(up|react)(?=$|[&|)])/g)].map((m) => m[2]);
}
