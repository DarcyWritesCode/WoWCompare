/**
 * Benchmark job, run daily: rebuilds the classes scheduled for today (see
 * src/wowcompare/benchmarks/schedule.ts) plus any spec whose benchmarks have gone stale. For each
 * spec it builds the profile from SimC's current APL, then for every boss of the current raid
 * (Heroic and Mythic) fetches the rankings around the reference percentile and parses the #1 and
 * the reference candidates with the app's own parser. Publishes everything to Cloudflare KV, where
 * the app reads it read-only (functions/wc-api/). See README.md next to this file for setup.
 *
 * Built by Vite (`pnpm benchmarks:build`) so the parser's aliases, macros and asset imports
 * resolve exactly as in the app, then run with Node (`pnpm benchmarks:run`).
 */
import 'wowcompare/benchmarks/workerShim';

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { USE_WCL_V2 } from 'common/fetchWclApi';
import { setAccessToken } from 'common/wclV2/auth';
import { wclQuery, WclV2RateLimitError } from 'common/wclV2/graphql';
import ROLES from 'game/ROLES';
import Config from 'parser/Config';
import { parseLogSnapshot } from 'wowcompare/benchmarks/parseLog';
import {
  AplCommit,
  BenchmarkBundle,
  BenchmarkStatus,
  BundleStatus,
  bundleKey,
  isCurrentStatus,
  logKey,
  profileFingerprint,
  profileKey,
  PublishedProfile,
  SNAPSHOT_VERSION,
  SpecStatus,
  STATUS_KEY,
  STATUS_VERSION,
} from 'wowcompare/benchmarks/published';
import { fetchRankingsPool, RankedParse } from 'wowcompare/benchmarks/rankings';
import { isExternallyBuffed, selectReference } from 'wowcompare/benchmarks/reference';
import { slotAt, slotTimeUtc, STALE_AFTER_MS, WEEKDAY_NAMES } from 'wowcompare/benchmarks/schedule';
import { BENCHMARK_CONFIGS, SPEC_SLOTS } from 'wowcompare/benchmarks/specs';
import { LogSnapshot } from 'wowcompare/metrics/results';
import { aplUrl, setProfile } from 'wowcompare/profile/registry';
import { buildProfile } from 'wowcompare/simc/buildProfile';
import { getAdapter } from 'wowcompare/simc/specs';

/** WCL difficulty IDs, Mythic first so a run cut short by the time limit still covers it. */
const DIFFICULTIES = [5, 4];
/** A log that takes longer is skipped (and retried on the next run). */
const LOG_TIMEOUT_MS = 120_000;
/**
 * KV entries are rewritten weekly; this lets them outlive two missed weeks, then expire rather
 * than go stale forever.
 */
const KV_TTL_SECONDS = 21 * 24 * 60 * 60;
/** Parsed logs not reused for this long are dropped from the job's own cache (a week + slack). */
const CACHE_PRUNE_AFTER_MS = 9 * 24 * 60 * 60 * 1000;
/**
 * Pause before spending the last 10% of the hourly WCL budget. Four logs in flight spend ~100
 * points between checks, well inside the headroom.
 */
const RATE_LIMIT_HEADROOM = 0.1;
const RATE_LIMIT_CHECK_MS = 15_000;
/** How long to wait after a 429 when WCL won't even say when the budget resets. */
const RATE_LIMITED_WAIT_MS = 5 * 60_000;
/**
 * Cloudflare resources the job sets up itself with the deploy token (KV and Pages edit): the KV
 * namespace, and its binding on the Pages project that functions/wc-api/ reads.
 */
const KV_NAMESPACE_TITLE = 'wowcompare-benchmarks';
const PAGES_PROJECT = 'wowcompare'; // as in .github/workflows/deploy-pages.yml
const KV_BINDING = 'SNAPSHOTS';
/** Same directory the dev server reads (vite/publishedDataPlugin.ts). */
const LOCAL_DIR = path.resolve('node_modules/.cache/wowcompare-published');

const { values: args } = parseArgs({
  options: {
    /** Write to the dev server's directory instead of Cloudflare KV. */
    local: { type: 'boolean', default: false },
    /**
     * Only these specs, in this order, whatever the schedule says: a WCL class (`Druid`), spec
     * (`Feral`) or both (`Druid:Feral`).
     */
    spec: { type: 'string', multiple: true, default: [] },
    /**
     * With the schedule: in a free slot, catch up these classes or specs first, in this order, if
     * they're stale, e.g. to choose the order of a first release.
     */
    first: { type: 'string', multiple: true, default: [] },
    /** Every spec, whatever the schedule says (after any `--spec` ones). */
    all: { type: 'boolean', default: false },
    /** These encounter IDs instead of the current raid (required in v1 mode). */
    encounter: { type: 'string', multiple: true, default: [] },
    difficulty: { type: 'string', multiple: true, default: [] },
    /** Default: done before the next two-hourly run; pass more for `--all`. */
    'max-minutes': { type: 'string', default: '110' },
    concurrency: { type: 'string', default: '4' },
    'cache-dir': { type: 'string', default: 'node_modules/.cache/wc-benchmarks-cache' },
  },
});

const startedAt = Date.now();
const deadline = startedAt + Number(args['max-minutes']) * 60_000;
const cacheDir = path.resolve(args['cache-dir']);

const say = (message: string) =>
  process.stdout.write(`[${((Date.now() - startedAt) / 60_000).toFixed(1)}m] ${message}\n`);
// The parser logs a lot per log ("Ability is missing from spellbook", event counts); keep errors.
console.log = console.info = console.debug = console.warn = () => undefined;

class OutOfTime extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (see scripts/benchmarks/README.md)`);
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await fn(item);
      }
    }),
  );
}

/** A client-credentials token for the WCL v2 API. */
async function wclClientToken(): Promise<string> {
  const id = requireEnv('WCL_CLIENT_ID');
  const secret = requireEnv('WCL_CLIENT_SECRET');
  const response = await fetch('https://www.warcraftlogs.com/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!response.ok) {
    throw new Error(`WCL token request failed: HTTP ${response.status}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Keeps the job under the WCL hourly point budget, waiting for the reset when it runs low. */
class RateBudget {
  private checkedAt = 0;
  /** Set while waiting for the reset; every caller waits on it, not just the one that found it. */
  private pause: Promise<void> | null = null;

  async ensure() {
    if (Date.now() > deadline) {
      throw new OutOfTime();
    }
    if (this.pause) {
      return this.pause;
    }
    if (!USE_WCL_V2 || Date.now() - this.checkedAt < RATE_LIMIT_CHECK_MS) {
      return;
    }
    this.checkedAt = Date.now();
    const limit = await this.limits();
    if (limit && limit.pointsSpentThisHour < limit.limitPerHour * (1 - RATE_LIMIT_HEADROOM)) {
      return;
    }
    return this.waitForReset(limit);
  }

  /** Runs `fn`, waiting out the reset and trying again whenever WCL answers 429. */
  async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      await this.ensure();
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof WclV2RateLimitError)) {
          throw err;
        }
        say('WCL rate limited (429)');
        await this.waitForReset(await this.limits());
      }
    }
  }

  private async limits() {
    try {
      const data = await wclQuery<{
        rateLimitData: { limitPerHour: number; pointsSpentThisHour: number; pointsResetIn: number };
      }>('query { rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }', {});
      return data.rateLimitData;
    } catch (err) {
      if (err instanceof WclV2RateLimitError) {
        return null;
      }
      throw err;
    }
  }

  private waitForReset(limit: Awaited<ReturnType<RateBudget['limits']>>): Promise<void> {
    this.pause ??= (async () => {
      const waitMs = limit ? (limit.pointsResetIn + 5) * 1000 : RATE_LIMITED_WAIT_MS;
      if (Date.now() + waitMs > deadline) {
        throw new OutOfTime();
      }
      say(
        `${limit ? `WCL budget at ${limit.pointsSpentThisHour}/${limit.limitPerHour} points` : 'WCL rate limited'}; waiting ${Math.ceil(waitMs / 60_000)} min`,
      );
      await sleep(waitMs);
    })().finally(() => {
      this.pause = null;
    });
    return this.pause;
  }
}

/**
 * WCL zones that pass the checks below but aren't a raid to benchmark: test realms, and
 * "Complete Raid" pseudo-zones (full-clear rankings with their own encounter IDs).
 */
const NOT_A_RAID = /\((PTR|Beta)\)|Complete Raid/i;

/**
 * The bosses of the current raid(s): unfrozen zones of the newest expansion that has any, with
 * both Heroic and Mythic. Comes from WCL so a new tier or expansion needs no code change.
 */
interface Encounter {
  id: number;
  name: string | null;
}

async function currentRaidEncounters(): Promise<Encounter[]> {
  const data = await wclQuery<{
    worldData: {
      expansions: {
        id: number;
        name: string;
        zones: {
          name: string;
          frozen: boolean;
          difficulties: { id: number }[] | null;
          encounters: { id: number; name: string }[] | null;
        }[];
      }[];
    };
  }>(
    'query { worldData { expansions { id name zones { name frozen difficulties { id } encounters { id name } } } } }',
    {},
  );
  const expansions = [...data.worldData.expansions].sort((a, b) => b.id - a.id);
  for (const expansion of expansions) {
    const raids = expansion.zones.filter(
      (zone) =>
        !zone.frozen &&
        !NOT_A_RAID.test(zone.name) &&
        DIFFICULTIES.every((id) => zone.difficulties?.some((d) => d.id === id)) &&
        (zone.encounters?.length ?? 0) > 0,
    );
    if (raids.length > 0) {
      say(`Current raid: ${expansion.name}: ${raids.map((zone) => zone.name).join(', ')}`);
      return raids.flatMap((zone) => zone.encounters!);
    }
  }
  throw new Error('No current raid zone found on Warcraft Logs');
}

/** Parsed logs from earlier runs (kept between GitHub Actions runs with actions/cache). */
class SnapshotCache {
  private readonly dir = path.join(cacheDir, 'snapshots');

  constructor() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(key: string) {
    return path.join(this.dir, `${sha1(key)}.json`);
  }

  get(key: string): LogSnapshot | null {
    const file = this.file(key);
    if (!fs.existsSync(file)) {
      return null;
    }
    const now = new Date();
    fs.utimesSync(file, now, now); // still in use: keep it past the next prune
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LogSnapshot;
  }

  set(key: string, snapshot: LogSnapshot) {
    fs.writeFileSync(this.file(key), JSON.stringify(snapshot));
  }

  prune() {
    for (const name of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > CACHE_PRUNE_AFTER_MS) {
        fs.rmSync(file);
      }
    }
  }
}

/** A Cloudflare account API call; returns the response's `result`. */
async function cloudflare<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${requireEnv('CLOUDFLARE_ACCOUNT_ID')}${pathname}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${requireEnv('CLOUDFLARE_API_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Cloudflare ${method} ${pathname.split('?')[0]} failed: HTTP ${response.status} ${await response.text()}`,
    );
  }
  return ((await response.json()) as { result: T }).result;
}

/**
 * The KV namespace's ID, creating the namespace and binding it to the Pages project if needed.
 * A new binding only takes effect on the next deploy, which the workflow then triggers.
 */
async function ensureKvNamespace(): Promise<string> {
  const namespaces = await cloudflare<{ id: string; title: string }[]>(
    'GET',
    '/storage/kv/namespaces?per_page=100',
  );
  let id = namespaces.find((namespace) => namespace.title === KV_NAMESPACE_TITLE)?.id;
  if (!id) {
    id = (
      await cloudflare<{ id: string }>('POST', '/storage/kv/namespaces', {
        title: KV_NAMESPACE_TITLE,
      })
    ).id;
    say(`Created KV namespace ${KV_NAMESPACE_TITLE}`);
  }
  const project = await cloudflare<{
    deployment_configs: {
      production: { kv_namespaces?: Record<string, { namespace_id: string }> | null };
    };
  }>('GET', `/pages/projects/${PAGES_PROJECT}`);
  if (project.deployment_configs.production.kv_namespaces?.[KV_BINDING]?.namespace_id !== id) {
    // PATCH merges into the existing production config.
    await cloudflare('PATCH', `/pages/projects/${PAGES_PROJECT}`, {
      deployment_configs: { production: { kv_namespaces: { [KV_BINDING]: { namespace_id: id } } } },
    });
    say(
      `Bound it to Pages project ${PAGES_PROJECT} as ${KV_BINDING}; applies from the next deploy`,
    );
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'redeploy=true\n');
    }
  }
  return id;
}

/** Where published data goes: Cloudflare KV, or the dev server's directory with `--local`. */
class Store {
  private constructor(
    private readonly local: boolean,
    private readonly namespaceId: string | null,
  ) {
    if (local) {
      fs.mkdirSync(LOCAL_DIR, { recursive: true });
    }
  }

  static async open(local: boolean): Promise<Store> {
    return new Store(local, local ? null : await ensureKvNamespace());
  }

  private valuePath(key: string) {
    return `/storage/kv/namespaces/${this.namespaceId}/values/${encodeURIComponent(key)}`;
  }

  async put(key: string, value: unknown) {
    const body = JSON.stringify(value);
    if (this.local) {
      fs.writeFileSync(path.join(LOCAL_DIR, `${key}.json`), body);
    } else {
      await cloudflare('PUT', `${this.valuePath(key)}?expiration_ttl=${KV_TTL_SECONDS}`, body);
    }
    stats.published += 1;
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.local) {
      const file = path.join(LOCAL_DIR, `${key}.json`);
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null;
    }
    // KV values come back raw, not in Cloudflare's `{ result }` envelope.
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${requireEnv('CLOUDFLARE_ACCOUNT_ID')}${this.valuePath(key)}`,
      { headers: { Authorization: `Bearer ${requireEnv('CLOUDFLARE_API_TOKEN')}` } },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Cloudflare GET ${key} failed: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

const stats = { published: 0, parsed: 0, reused: 0, failedLogs: 0, failedBosses: 0 };

const specName = (config: Config) => `${config.spec.wclSpecName} ${config.spec.wclClassName}`;

/**
 * The specs to rebuild, in order: `--spec` entries in the order given, then every other spec with
 * `--all`. Without either, one spec: the one whose weekly slot this run is, else the stalest spec
 * not completed within `STALE_AFTER_MS` (a failed or cut-short run, or never built), preferring
 * `--first` ones.
 */
function specsToBuild(status: BenchmarkStatus): Config[] {
  /** Specs matching each name, in the order named. */
  const named = (names: string[], from: Config[]) => [
    ...new Set(
      names.flatMap((wanted) =>
        from.filter((config) => {
          const { wclClassName, wclSpecName } = config.spec;
          return [wclClassName, wclSpecName, `${wclClassName}:${wclSpecName}`].some(
            (name) => name.toLowerCase() === wanted.toLowerCase(),
          );
        }),
      ),
    ),
  ];
  if (args.all || args.spec.length > 0) {
    const ordered = named(args.spec, BENCHMARK_CONFIGS);
    return args.all
      ? [...ordered, ...BENCHMARK_CONFIGS.filter((c) => !ordered.includes(c))]
      : ordered;
  }
  const now = slotAt(new Date());
  const label = `${WEEKDAY_NAMES[now.day]} ${slotTimeUtc(now.slot)}`;
  const scheduled = BENCHMARK_CONFIGS.find((config) => {
    const slot = SPEC_SLOTS.get(config.spec.id);
    return slot?.day === now.day && slot.slot === now.slot;
  });
  if (scheduled) {
    say(`${label}: ${specName(scheduled)}'s weekly slot`);
    return [scheduled];
  }
  const completedAt = (config: Config) => status.specs[config.spec.id]?.completedAt ?? 0;
  const stale = BENCHMARK_CONFIGS.filter(
    (config) => Date.now() - completedAt(config) > STALE_AFTER_MS,
  ).sort((a, b) => completedAt(a) - completedAt(b));
  const next = named(args.first, stale)[0] ?? stale[0];
  say(
    next
      ? `${label}: free slot, catching up ${specName(next)} (${stale.length} stale)`
      : `${label}: free slot, nothing stale`,
  );
  return next ? [next] : [];
}

async function fetchText(url: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await withTimeout(fetch(url), 15_000, url);
      if (response.ok) {
        return await response.text();
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      if (attempt >= 3) {
        throw new Error(`Fetching ${url} failed: ${(err as Error).message}`);
      }
      await sleep(attempt * 5_000);
    }
  }
}

/**
 * The SimC commit that last touched the APL, for the specs page. Uses `GITHUB_TOKEN` when set
 * (Actions provides one), since unauthenticated calls are limited to 60 an hour.
 */
async function aplCommit(simcFile: string): Promise<AplCommit | null> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const response = await withTimeout(
      fetch(
        `https://api.github.com/repos/simulationcraft/simc/commits?path=ActionPriorityLists/default/${simcFile}.simc&per_page=1`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      ),
      15_000,
      'GitHub commits',
    );
    const [commit] = response.ok
      ? ((await response.json()) as { sha: string; commit: { committer: { date: string } } }[])
      : [];
    return commit ? { sha: commit.sha, date: commit.commit.committer.date } : null;
  } catch {
    return null;
  }
}

/** Builds and publishes the spec's profile from SimC's current APL, and selects it for parsing. */
async function publishProfile(config: Config, store: Store): Promise<PublishedProfile> {
  const adapter = getAdapter(config.spec.id)!;
  const url = aplUrl(adapter);
  const text = await fetchText(url);
  const { profile, unresolved } = buildProfile(adapter, text, {
    kind: 'simc',
    file: adapter.simcFile,
    url,
    live: true,
    retrievedAt: Date.now(),
  });
  const published: PublishedProfile = {
    snapshotVersion: SNAPSHOT_VERSION,
    profile,
    unresolved,
    builtAt: Date.now(),
    aplCommit: await aplCommit(adapter.simcFile),
  };
  setProfile(config.spec.id, profile);
  await store.put(profileKey(config.spec.id), published);
  return published;
}

/** Parses `parse` for `config`, reusing the job's cache; null if it failed. */
async function snapshotOf(
  config: Config,
  fingerprint: string,
  parse: RankedParse,
  cache: SnapshotCache,
  budget: RateBudget,
): Promise<LogSnapshot | null> {
  const ref = {
    reportCode: parse.reportCode,
    fightId: parse.fightId,
    playerName: parse.name,
    serverName: parse.serverName,
  };
  const cacheKey = `v${SNAPSHOT_VERSION}:${fingerprint}:${logKey(ref)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    stats.reused += 1;
    return cached;
  }
  try {
    const snapshot = await budget.retry(() =>
      withTimeout(parseLogSnapshot(config, ref), LOG_TIMEOUT_MS, logKey(ref)),
    );
    if (snapshot) {
      cache.set(cacheKey, snapshot);
      stats.parsed += 1;
    }
    return snapshot;
  } catch (err) {
    if (err instanceof OutOfTime) {
      throw err;
    }
    stats.failedLogs += 1;
    say(`  ${logKey(ref)}: ${(err as Error).message}`);
    return null;
  }
}

/** The #1 and the reference candidates for one spec on one boss and difficulty. */
async function publishBundle(
  config: Config,
  published: PublishedProfile,
  encounter: Encounter,
  difficulty: number,
  store: Store,
  cache: SnapshotCache,
  budget: RateBudget,
): Promise<BundleStatus | null> {
  const { spec } = config;
  const rankings = await budget.retry(() =>
    fetchRankingsPool({
      encounterId: encounter.id,
      difficulty,
      className: spec.wclClassName,
      specName: spec.wclSpecName,
      metric: spec.role === ROLES.HEALER ? 'hps' : 'dps',
    }),
  );
  if (!rankings.top) {
    return null;
  }
  const bundle: BenchmarkBundle = {
    snapshotVersion: SNAPSHOT_VERSION,
    specId: spec.id,
    encounterId: encounter.id,
    difficulty,
    builtAt: 0,
    profileFingerprint: profileFingerprint(published.profile),
    ...rankings,
    reference: selectReference(rankings.pool, rankings.totalParses),
    snapshots: {},
  };
  const { candidates } = bundle.reference;
  const parses = [rankings.top, ...candidates.filter((c) => c !== rankings.top)];
  let failed = 0;
  await eachLimit(parses, Number(args.concurrency), async (parse) => {
    const snapshot = await snapshotOf(config, bundle.profileFingerprint, parse, cache, budget);
    if (snapshot) {
      bundle.snapshots[logKey({ ...parse, playerName: parse.name })] = snapshot;
    } else if (candidates.includes(parse)) {
      failed += 1;
    }
  });
  bundle.builtAt = Date.now();
  await store.put(bundleKey(spec.id, encounter.id, difficulty), bundle);

  const parsed = candidates
    .map((c) => bundle.snapshots[logKey({ ...c, playerName: c.name })])
    .filter((snapshot): snapshot is LogSnapshot => !!snapshot);
  const ranks = candidates.map((c) => c.rank);
  return {
    encounterId: encounter.id,
    encounterName: encounter.name,
    difficulty,
    builtAt: bundle.builtAt,
    totalParses: rankings.totalParses,
    ranks: ranks.length > 0 ? [Math.min(...ranks), Math.max(...ranks)] : null,
    logs: parsed.length,
    buffed: parsed.filter(isExternallyBuffed).length,
    failed,
  };
}

/** Rebuilds one spec: its profile, then every boss and difficulty, updating `status` as it goes. */
async function buildSpec(
  config: Config,
  encounters: Encounter[],
  difficulties: number[],
  status: BenchmarkStatus,
  store: Store,
  cache: SnapshotCache,
  budget: RateBudget,
) {
  const published = await publishProfile(config, store);
  const previous = status.specs[config.spec.id];
  const entry: SpecStatus = {
    specId: config.spec.id,
    profileBuiltAt: published.builtAt,
    aplCommit: published.aplCommit,
    completedAt: null,
    // Earlier bundles stay listed until rebuilt.
    bundles: previous?.bundles ?? [],
  };
  status.specs[config.spec.id] = entry;
  let failures = 0;
  for (const difficulty of difficulties) {
    for (const encounter of encounters) {
      const label = `${specName(config)}, ${encounter.name ?? encounter.id}, difficulty ${difficulty}`;
      try {
        const bundle = await publishBundle(
          config,
          published,
          encounter,
          difficulty,
          store,
          cache,
          budget,
        );
        if (bundle) {
          entry.bundles = [
            ...entry.bundles.filter(
              (b) => b.encounterId !== encounter.id || b.difficulty !== difficulty,
            ),
            bundle,
          ];
        }
        say(label);
      } catch (err) {
        if (err instanceof OutOfTime) {
          throw err;
        }
        stats.failedBosses += 1;
        failures += 1;
        say(`${label}: ${(err as Error).message}`);
      }
    }
  }
  // Bosses no longer in the current raid drop out of the summary.
  entry.bundles = entry.bundles.filter((b) => encounters.some((e) => e.id === b.encounterId));
  // A spec with failed bosses stays incomplete, so the next run's catch-up retries it.
  entry.completedAt = failures === 0 ? Date.now() : null;
}

async function main() {
  if (USE_WCL_V2) {
    setAccessToken(await wclClientToken(), 'client');
  } else if (args.encounter.length === 0) {
    throw new Error('v1 mode (no WCL credentials) needs --encounter');
  }
  const store = await Store.open(args.local);
  const cache = new SnapshotCache();
  const budget = new RateBudget();

  const published = await store.get<BenchmarkStatus>(STATUS_KEY);
  const status: BenchmarkStatus = isCurrentStatus(published)
    ? published
    : { snapshotVersion: SNAPSHOT_VERSION, version: STATUS_VERSION, updatedAt: 0, specs: {} };
  const saveStatus = async () => {
    status.updatedAt = Date.now();
    await store.put(STATUS_KEY, status);
  };

  const specs = specsToBuild(status);
  const encounters: Encounter[] =
    args.encounter.length > 0
      ? args.encounter.map((id) => ({ id: Number(id), name: null }))
      : await currentRaidEncounters();
  const difficulties = args.difficulty.length > 0 ? args.difficulty.map(Number) : DIFFICULTIES;
  say(`${specs.length} specs × ${encounters.length} bosses × ${difficulties.length} difficulties`);

  try {
    for (const config of specs) {
      try {
        await buildSpec(config, encounters, difficulties, status, store, cache, budget);
      } catch (err) {
        if (err instanceof OutOfTime) {
          throw err;
        }
        say(`${specName(config)}: ${(err as Error).message}`);
      }
      // After each spec, so a run that's killed still leaves the summary current.
      await saveStatus();
    }
  } catch (err) {
    if (!(err instanceof OutOfTime)) {
      throw err;
    }
    await saveStatus();
    say('Out of time; the rest is left for the next run.');
  } finally {
    cache.prune();
  }

  say(
    `Done. Published ${stats.published}; logs parsed ${stats.parsed}, reused ${stats.reused}, failed ${stats.failedLogs}; bosses failed ${stats.failedBosses}.`,
  );
  // Fail the workflow only when nothing worked, so one bad log or boss doesn't page anyone. A day
  // with nothing due is fine.
  return specs.length === 0 || stats.published > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
