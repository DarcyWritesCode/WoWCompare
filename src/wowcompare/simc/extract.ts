import {
  AplAction,
  auraCheck,
  booleanBuffChecks,
  parseApl,
  positiveBuffChecks,
  references,
  requiredConjuncts,
} from './apl';

/** Actions that are APL plumbing or generic consumables, not spec cooldowns. */
const META_ACTIONS = new Set([
  'variable',
  'call_action_list',
  'run_action_list',
  'snapshot_stats',
  'auto_attack',
  'pool_resource',
  'wait',
  'cancel_buff',
  'invoke_external_buff',
  'use_item',
  'use_items',
  'potion',
]);

/** Racials and forms: real spells, but not something a spec profile should grade. */
const IGNORED_TOKENS = new Set([
  'potion',
  'berserking',
  'blood_fury',
  'fireblood',
  'ancestral_call',
  'bag_of_tricks',
  'arcane_torrent',
  'lights_judgment',
  'shadowmeld',
  'bloodlust',
  'cat_form',
  'bear_form',
  'moonkin_form',
  'prowl',
  'stealth',
]);

export interface AuraRequirement {
  token: string;
  on: 'player' | 'target';
  present: boolean;
}

export interface AplCooldown {
  token: string;
  order: number;
}

/**
 * "The APL only casts `token` while these auras are (or aren't) up." When not `strict`, the aura
 * is only favoured: some cast lines check for it, but not as a hard requirement.
 */
export interface AplRule {
  token: string;
  order: number;
  requires: AuraRequirement[];
  strict: boolean;
}

export interface AplProc {
  token: string;
  order: number;
  /** Actions the APL casts when the buff is up: the proc's consumers. */
  consumers: string[];
}

export interface AplDot {
  token: string;
  order: number;
}

export interface AplSummary {
  cooldowns: AplCooldown[];
  rules: AplRule[];
  procs: AplProc[];
  dots: AplDot[];
}

/** Variables the APL only ever resets, e.g. `regrowth`: actions gated on them never run. */
function disabledVariables(actions: AplAction[]): Set<string> {
  const ops = new Map<string, Set<string>>();
  for (const action of actions) {
    if (action.name === 'variable' && action.options.name) {
      const set = ops.get(action.options.name) ?? new Set();
      set.add(action.options.op ?? 'set');
      ops.set(action.options.name, set);
    }
  }
  return new Set(
    [...ops.entries()]
      .filter(([, set]) => set.size === 1 && set.has('reset'))
      .map(([name]) => name),
  );
}

function isDisabled(action: AplAction, disabled: Set<string>): boolean {
  return requiredConjuncts(action.options.if).some((conjunct) => {
    const match = /^variable\.([a-z0-9_]+)$/.exec(conjunct);
    return match !== null && disabled.has(match[1]);
  });
}

/** Lists only run on multiple targets; their dots aren't single-target uptime goals. */
const isAoeList = (list: string) => list.startsWith('aoe');

/** Which cooldowns, procs and dots an APL tracks, as SimC tokens (resolved to spells later). */
export function summarizeApl(text: string): AplSummary {
  const all = parseApl(text);
  const disabled = disabledVariables(all);
  const actions = all.filter((a) => a.list !== 'precombat' && !isDisabled(a, disabled));
  const actionNames = new Set(actions.map((a) => a.name));
  const firstIndex = (token: string) => {
    const found = actions.find(
      (a) =>
        a.name === token ||
        Object.values(a.options).some((value) => new RegExp(`\\b${token}\\b`).test(value)),
    );
    return found?.index ?? Number.MAX_SAFE_INTEGER;
  };

  // Cooldowns: anything the APL tracks with `cooldown.x`, plus the casts in its cooldown lists.
  const cooldownTokens = new Set<string>([
    ...actions.flatMap((a) => Object.values(a.options).flatMap((v) => references(v, 'cooldown'))),
    ...actions.filter((a) => /^(cooldowns?|cds?)$/.test(a.list)).map((a) => a.name),
  ]);
  for (const token of [...cooldownTokens]) {
    if (META_ACTIONS.has(token) || IGNORED_TOKENS.has(token)) {
      cooldownTokens.delete(token);
    }
  }
  // Auras the APL requires on every line that casts `token` (top-level `&` conditions).
  const requiredAuras = (token: string): AuraRequirement[] => {
    const perLine = actions
      .filter((a) => a.name === token)
      .map((a) =>
        requiredConjuncts(a.options.if)
          .map(auraCheck)
          .filter((check): check is NonNullable<ReturnType<typeof auraCheck>> => check !== null)
          .map((check) => ({
            token: check.token,
            on: check.kind === 'buff' ? ('player' as const) : ('target' as const),
            present: check.present,
          })),
      );
    if (perLine.length === 0) {
      return [];
    }
    return perLine[0].filter((req) =>
      perLine.every((line) =>
        line.some((other) => other.token === req.token && other.present === req.present),
      ),
    );
  };

  const cooldowns: AplCooldown[] = [...cooldownTokens].map((token) => ({
    token,
    order: firstIndex(token),
  }));

  // Rules: any cast the APL only makes under particular buffs/debuffs (forms and stealth aside).
  const rules: AplRule[] = [...actionNames]
    .filter((token) => !META_ACTIONS.has(token) && !IGNORED_TOKENS.has(token))
    .map((token) => ({
      token,
      order: firstIndex(token),
      requires: requiredAuras(token).filter((req) => !IGNORED_TOKENS.has(req.token)),
    }))
    .filter((rule) => rule.requires.length > 0)
    .map((rule) => ({ ...rule, strict: true }));

  // Preferences: casts whose conditions check a cooldown's buff without requiring it, e.g. Rake
  // `if=(buff.tigers_fury.up|remains<cooldown.tigers_fury.remains)&...` favours Tiger's Fury.
  for (const action of actions) {
    if (META_ACTIONS.has(action.name) || IGNORED_TOKENS.has(action.name)) {
      continue;
    }
    for (const buff of booleanBuffChecks(action.options.if)) {
      const known = rules.some(
        (rule) => rule.token === action.name && rule.requires.some((req) => req.token === buff),
      );
      if (cooldownTokens.has(buff) && buff !== action.name && !known) {
        rules.push({
          token: action.name,
          order: action.index,
          requires: [{ token: buff, on: 'player', present: true }],
          strict: false,
        });
      }
    }
  }

  // Procs: buffs the APL waits for before casting something, other than cooldown windows,
  // forms and stealth (which are actions themselves).
  const consumers = new Map<string, Set<string>>();
  for (const action of actions) {
    if (META_ACTIONS.has(action.name)) {
      continue;
    }
    for (const token of positiveBuffChecks(action.options.if)) {
      if (cooldownTokens.has(token) || actionNames.has(token) || IGNORED_TOKENS.has(token)) {
        continue;
      }
      const set = consumers.get(token) ?? new Set();
      set.add(action.name);
      consumers.set(token, set);
    }
  }
  const procs: AplProc[] = [...consumers.entries()].map(([token, set]) => ({
    token,
    order: firstIndex(token),
    consumers: [...set],
  }));

  // Dots: actions the APL refreshes (`refreshable`), outside AoE-only lists.
  const dotTokens = new Set<string>();
  for (const action of actions) {
    if (isAoeList(action.list) || META_ACTIONS.has(action.name)) {
      continue;
    }
    const conditions = `${action.options.if ?? ''} ${action.options.target_if ?? ''}`;
    if (/(^|[^.a-z_])refreshable\b/.test(conditions)) {
      dotTokens.add(action.name);
    }
  }
  const dots: AplDot[] = [...dotTokens].map((token) => ({ token, order: firstIndex(token) }));

  const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;
  return {
    cooldowns: cooldowns.sort(byOrder),
    rules: rules.sort(byOrder),
    procs: procs.sort(byOrder),
    dots: dots.sort(byOrder),
  };
}
