/**
 * Nightly benchmark job: builds each spec's profile from SimC's current APL, then for every boss
 * of the current raid (Heroic and Mythic) fetches the spec's rankings and parses the top 10 logs
 * with the app's own parser. Publishes both to Cloudflare KV, where the app reads them read-only
 * (functions/wc-api/). See README.md next to this file for setup.
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
import { wclQuery } from 'common/wclV2/graphql';
import ROLES from 'game/ROLES';
import configs from 'parser';
import Config from 'parser/Config';
import { parseLogSnapshot } from 'wowcompare/benchmarks/parseLog';
import {
  BenchmarkBundle,
  bundleKey,
  logKey,
  profileFingerprint,
  profileKey,
  PublishedProfile,
  SNAPSHOT_VERSION,
} from 'wowcompare/benchmarks/published';
import { fetchRankings } from 'wowcompare/benchmarks/rankings';
import { LogSnapshot } from 'wowcompare/metrics/results';
import { aplUrl, hasSimcApl, setProfile } from 'wowcompare/profile/registry';
import { buildProfile } from 'wowcompare/simc/buildProfile';
import { getAdapter } from 'wowcompare/simc/specs';

/** WCL difficulty IDs, Mythic first so a run cut short by the time limit still covers it. */
const DIFFICULTIES = [5, 4];
/** Logs parsed per boss: the app auto-loads the #1 parse and the top-10 median. */
const TOP_N = 10;
/** A log that takes longer is skipped (and retried on the next run). */
const LOG_TIMEOUT_MS = 120_000;
/** KV entries outlive a few failed nightly runs, then expire rather than go stale forever. */
const KV_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Unchanged entries are rewritten this often anyway, to renew their TTL. */
const REWRITE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** Parsed logs not reused for this long are dropped from the job's own cache. */
const CACHE_PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Pause before spending the last 5% of the hourly WCL budget. */
const RATE_LIMIT_HEADROOM = 0.05;
const RATE_LIMIT_CHECK_MS = 30_000;
/** Same directory the dev server reads (vite/publishedDataPlugin.ts). */
const LOCAL_DIR = path.resolve('node_modules/.cache/wowcompare-published');

const { values: args } = parseArgs({
  options: {
    /** Write to the dev server's directory instead of Cloudflare KV. */
    local: { type: 'boolean', default: false },
    /** Only these specs, by WCL spec name (`Feral`) or `Class:Spec` (`Druid:Feral`). */
    spec: { type: 'string', multiple: true, default: [] },
    /** These encounter IDs instead of the current raid (required in v1 mode). */
    encounter: { type: 'string', multiple: true, default: [] },
    difficulty: { type: 'string', multiple: true, default: [] },
    'max-minutes': { type: 'string', default: '330' },
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

  async ensure() {
    if (Date.now() > deadline) {
      throw new OutOfTime();
    }
    if (!USE_WCL_V2 || Date.now() - this.checkedAt < RATE_LIMIT_CHECK_MS) {
      return;
    }
    this.checkedAt = Date.now();
    const { rateLimitData: limit } = await wclQuery<{
      rateLimitData: { limitPerHour: number; pointsSpentThisHour: number; pointsResetIn: number };
    }>('query { rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }', {});
    if (limit.pointsSpentThisHour < limit.limitPerHour * (1 - RATE_LIMIT_HEADROOM)) {
      return;
    }
    const waitMs = (limit.pointsResetIn + 5) * 1000;
    if (Date.now() + waitMs > deadline) {
      throw new OutOfTime();
    }
    say(
      `WCL budget at ${limit.pointsSpentThisHour}/${limit.limitPerHour} points; waiting ${Math.ceil(waitMs / 60_000)} min for the reset`,
    );
    await sleep(waitMs);
  }
}

/**
 * The bosses of the current raid(s): unfrozen zones of the newest expansion that has any, with
 * both Heroic and Mythic. Comes from WCL so a new tier or expansion needs no code change.
 */
async function currentRaidEncounters(): Promise<number[]> {
  const data = await wclQuery<{
    worldData: {
      expansions: {
        id: number;
        name: string;
        zones: {
          name: string;
          frozen: boolean;
          difficulties: { id: number }[] | null;
          encounters: { id: number }[] | null;
        }[];
      }[];
    };
  }>(
    'query { worldData { expansions { id name zones { name frozen difficulties { id } encounters { id } } } } }',
    {},
  );
  const expansions = [...data.worldData.expansions].sort((a, b) => b.id - a.id);
  for (const expansion of expansions) {
    const raids = expansion.zones.filter(
      (zone) =>
        !zone.frozen &&
        DIFFICULTIES.every((id) => zone.difficulties?.some((d) => d.id === id)) &&
        (zone.encounters?.length ?? 0) > 0,
    );
    if (raids.length > 0) {
      say(`Current raid: ${expansion.name}: ${raids.map((zone) => zone.name).join(', ')}`);
      return raids.flatMap((zone) => zone.encounters!.map((encounter) => encounter.id));
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

/**
 * Where published data goes: Cloudflare KV, or the dev server's directory with `--local`. KV
 * writes are skipped when nothing changed since a recent write, to stay inside KV's daily write
 * limit (1,000 on the free plan).
 */
class Store {
  private readonly manifestFile = path.join(cacheDir, 'kv-manifest.json');
  private readonly manifest: Record<string, { hash: string; writtenAt: number }> = {};

  constructor(private readonly local: boolean) {
    if (local) {
      fs.mkdirSync(LOCAL_DIR, { recursive: true });
    } else if (fs.existsSync(this.manifestFile)) {
      this.manifest = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
    }
  }

  /** Writes `value` unless `identity` (its content minus timestamps) is unchanged and recent. */
  async put(key: string, value: unknown, identity: unknown): Promise<boolean> {
    const body = JSON.stringify(value);
    if (this.local) {
      fs.writeFileSync(path.join(LOCAL_DIR, `${key}.json`), body);
      return true;
    }
    const hash = sha1(JSON.stringify(identity));
    const previous = this.manifest[key];
    if (previous?.hash === hash && Date.now() - previous.writtenAt < REWRITE_AFTER_MS) {
      return false;
    }
    const account = requireEnv('CLOUDFLARE_ACCOUNT_ID');
    const namespace = requireEnv('WC_KV_NAMESPACE_ID');
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}?expiration_ttl=${KV_TTL_SECONDS}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${requireEnv('CLOUDFLARE_API_TOKEN')}`,
          'Content-Type': 'application/json',
        },
        body,
      },
    );
    if (!response.ok) {
      throw new Error(
        `KV write of ${key} failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    this.manifest[key] = { hash, writtenAt: Date.now() };
    return true;
  }

  save() {
    if (!this.local) {
      fs.writeFileSync(this.manifestFile, JSON.stringify(this.manifest));
    }
  }
}

const stats = { published: 0, unchanged: 0, parsed: 0, reused: 0, failedLogs: 0, failedBosses: 0 };

function selectedSpecs(): Config[] {
  const wanted = args.spec.map((s) => s.toLowerCase());
  return configs.filter((config) => {
    const { wclClassName, wclSpecName } = config.spec;
    const names = [wclSpecName, `${wclClassName}:${wclSpecName}`].map((n) => n.toLowerCase());
    return (
      config.parser !== undefined &&
      hasSimcApl(config.spec.id) &&
      (wanted.length === 0 || names.some((name) => wanted.includes(name)))
    );
  });
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
  };
  setProfile(config.spec.id, profile);
  const written = await store.put(profileKey(config.spec.id), published, {
    version: SNAPSHOT_VERSION,
    fingerprint: profileFingerprint(profile),
    unresolved,
  });
  stats[written ? 'published' : 'unchanged'] += 1;
  return published;
}

/** Rankings plus the parsed top 10 for one spec on one boss and difficulty. */
async function publishBundle(
  config: Config,
  published: PublishedProfile,
  encounterId: number,
  difficulty: number,
  store: Store,
  cache: SnapshotCache,
  budget: RateBudget,
) {
  const { spec } = config;
  await budget.ensure();
  const rankings = await fetchRankings({
    encounterId,
    difficulty,
    className: spec.wclClassName,
    specName: spec.wclSpecName,
    metric: spec.role === ROLES.HEALER ? 'hps' : 'dps',
  });
  if (rankings.length === 0) {
    return;
  }

  const fingerprint = profileFingerprint(published.profile);
  const snapshots: Record<string, LogSnapshot> = {};
  await eachLimit(rankings.slice(0, TOP_N), Number(args.concurrency), async (parse) => {
    const ref = {
      reportCode: parse.reportCode,
      fightId: parse.fightId,
      playerName: parse.name,
      serverName: parse.serverName,
    };
    const cacheKey = `v${SNAPSHOT_VERSION}:${fingerprint}:${logKey(ref)}`;
    let snapshot = cache.get(cacheKey);
    if (snapshot) {
      stats.reused += 1;
    } else {
      await budget.ensure();
      try {
        snapshot = await withTimeout(parseLogSnapshot(config, ref), LOG_TIMEOUT_MS, logKey(ref));
      } catch (err) {
        stats.failedLogs += 1;
        say(`  ${logKey(ref)}: ${(err as Error).message}`);
        return;
      }
      if (!snapshot) {
        return;
      }
      cache.set(cacheKey, snapshot);
      stats.parsed += 1;
    }
    snapshots[logKey(ref)] = snapshot;
  });

  const bundle: BenchmarkBundle = {
    snapshotVersion: SNAPSHOT_VERSION,
    specId: spec.id,
    encounterId,
    difficulty,
    builtAt: Date.now(),
    profileFingerprint: fingerprint,
    rankings,
    snapshots,
  };
  // Rankings shift a little every day; only a new profile or top-10 lineup forces a rewrite
  // before the periodic one, which keeps KV writes down.
  const identity = { fingerprint, logs: Object.keys(snapshots).sort() };
  const written = await store.put(bundleKey(spec.id, encounterId, difficulty), bundle, identity);
  stats[written ? 'published' : 'unchanged'] += 1;
}

async function main() {
  if (USE_WCL_V2) {
    setAccessToken(await wclClientToken(), 'client');
  } else if (args.encounter.length === 0) {
    throw new Error('v1 mode (no WCL credentials) needs --encounter');
  }
  const store = new Store(args.local);
  const cache = new SnapshotCache();
  const budget = new RateBudget();

  const specs = selectedSpecs();
  const encounters =
    args.encounter.length > 0 ? args.encounter.map(Number) : await currentRaidEncounters();
  const difficulties = args.difficulty.length > 0 ? args.difficulty.map(Number) : DIFFICULTIES;
  say(`${specs.length} specs × ${encounters.length} bosses × ${difficulties.length} difficulties`);

  // Profiles first: a bundle is only usable with the profile it was parsed with.
  const profiles = new Map<number, PublishedProfile>();
  for (const config of specs) {
    try {
      profiles.set(config.spec.id, await publishProfile(config, store));
    } catch (err) {
      say(`${config.spec.wclSpecName} ${config.spec.wclClassName}: ${(err as Error).message}`);
    }
  }

  try {
    for (const difficulty of difficulties) {
      for (const encounterId of encounters) {
        for (const config of specs) {
          const published = profiles.get(config.spec.id);
          if (!published) {
            continue;
          }
          const label = `${config.spec.wclSpecName} ${config.spec.wclClassName}, encounter ${encounterId}, difficulty ${difficulty}`;
          try {
            await publishBundle(config, published, encounterId, difficulty, store, cache, budget);
            say(label);
          } catch (err) {
            if (err instanceof OutOfTime) {
              throw err;
            }
            stats.failedBosses += 1;
            say(`${label}: ${(err as Error).message}`);
          }
        }
      }
    }
  } catch (err) {
    if (!(err instanceof OutOfTime)) {
      throw err;
    }
    say('Out of time; the rest is left for the next run.');
  } finally {
    store.save();
    cache.prune();
  }

  say(
    `Done. Published ${stats.published}, unchanged ${stats.unchanged}; logs parsed ${stats.parsed}, reused ${stats.reused}, failed ${stats.failedLogs}; bosses failed ${stats.failedBosses}.`,
  );
  // Fail the workflow only when nothing worked, so one bad log or boss doesn't page anyone.
  return stats.published + stats.unchanged > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
