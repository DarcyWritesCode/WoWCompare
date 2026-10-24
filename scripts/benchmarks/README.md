# Benchmarks

Live Compare scores a log against the median of 20 parses spread over the **90–95th percentile** for its
spec, boss and difficulty, and shows the #1 parse as the ceiling. Parsing those logs in the
viewer's browser is slow, so a GitHub Actions job (`.github/workflows/benchmarks.yml`) does it
once for everyone. It runs every two hours (00:47–10:47 UTC) and builds one spec per run: each
spec has a weekly slot, on its class's day in `src/wowcompare/benchmarks/schedule.ts`. The specs
page (`/specs`) shows each spec's slot and what was built.

For each spec it rebuilds:

1. The profile, from SimC's current APL (default branch): `profile-<specId>`.
2. For every Heroic and Mythic boss of the current raid: the #1 parse, the ranked parses around
   the target rank, and the parsed reference candidates: `bench-<specId>-<encounterId>-<difficulty>`.
3. Its entry in the status summary for the specs page: `status`.

The app reads all three through `functions/wc-api/` (`/wc-api/profiles/:spec`,
`/wc-api/benchmarks/:spec/:encounter/:difficulty`, `/wc-api/status`). See
`src/wowcompare/benchmarks/published.ts`.

## The reference

See `src/wowcompare/benchmarks/reference.ts`.

- **Why not the top 10.** The top parses are mostly groups set up to pump one player: Power
  Infusion, an Augmentation Evoker, short kills. Advice drawn from them is out of reach for most
  players.
- **Finding the band.** WCL's rankings list has no total and stops at rank 2,000. The ranks WCL
  gives the #1 log's players include `totalParses`, so the band is ranks `totalParses × 5%` to
  `× 10%`. The job fetches only the rankings pages holding its target ranks. If the band is past
  rank 2,000 (over 40,000 parses), the deepest ranks stand in.
- **Candidates.** 20 parses at evenly spaced ranks across the band (the whole band can be
  thousands of logs per spec, far past WCL's point budget). Kills more than 3 MADs shorter than
  usual are left out first. The median uses every candidate that parsed.
- **PI/Aug toggle.** Each log records the Power Infusion, Ebon Might and Prescience others put on
  the player. "Leave out PI/Aug-buffed logs" (on by default) drops logs over the thresholds from
  the median. With fewer than 5 left, it keeps them. About a third of candidates are buffed.

## Why this design

- **Read-only to viewers.** An earlier version let browsers upload parsed logs to a shared
  cache. Every input to its keys was public, so anyone could plant fake benchmark data that
  everyone would be scored against. Now only this job writes, using an API token.
- **One spec per run, weekly.** A spec's profile and benchmarks are rebuilt together in its slot,
  so the profile fingerprint matches its benchmarks all week. One spec (about 420 logs, ~2,300 WCL
  points) fits inside an hour's point budget, so runs rarely wait on WCL. Runs in slots with no
  spec (8 a week) catch up the stalest spec not completed within 8 days: a failed or cut-short
  run, or one never built.
- **The app uses the job's profile.** Snapshots are only valid with the profile they were parsed
  with, so the app loads the published profile instead of fetching the APL from GitHub itself.
  The bundle records the profile's `profileFingerprint`, and the app only uses its snapshots
  when the fingerprint matches.
- **Fallbacks.** The app parses logs itself (nothing is shared) when the profile was customized
  with accepted Suggestions, for bosses or specs the job didn't cover, and for the on-demand
  benchmarks (same build, closest parses). Without a bundle in v1 mode, only the top 100 parses
  are available, so the deepest of those stand in for the reference.
- **Current raid from Warcraft Logs.** The job asks WCL for the newest expansion's unfrozen zones
  that have Heroic and Mythic, so a new tier needs no code change. A new class needs a line in
  `schedule.ts`; `schedule.test.ts` fails until it has one.

## Setup

1. **Warcraft Logs API client.** Create a client at https://www.warcraftlogs.com/api/clients (any
   redirect URL; the client-credentials flow doesn't use it). Add repository secrets
   `WCL_CLIENT_ID` and `WCL_CLIENT_SECRET`.
2. **KV namespace.** Nothing to do. On its first run the job creates the `wowcompare-benchmarks`
   namespace, binds it to the `wowcompare` Pages project as `SNAPSHOTS`, and starts a deploy so
   the binding takes effect.
3. **API token.** The job reuses the deploy token, `CLOUDFLARE_API_TOKEN`. It needs
   _Account → Workers KV Storage → Edit_ on top of _Cloudflare Pages → Edit_. Tokens made from the
   "Edit Cloudflare Workers" template already have both. Without them the job fails with HTTP 403.
   `CLOUDFLARE_ACCOUNT_ID` is already set for deploys.
4. Run it once by hand: Actions → _Benchmarks_ → _Run workflow_. To try it narrowly first, pass
   e.g. `--spec Druid:Feral --difficulty 5`. `--spec Druid --spec Evoker` builds those classes in
   that order; `--all` builds everything (pass `--max-minutes 330` too).
5. To choose which stale specs free slots catch up first, set the repository variable
   `BENCHMARK_ARGS` to e.g. `--first Druid --first Evoker --first DeathKnight`. Every spec is also
   built in its own weekly slot regardless.

## Limits to watch

- **WCL points.** About 5.4 points per parsed log, so roughly 650 logs an hour within the
  3,600-point budget, shared with anything else using the same API client (including local runs).
  A spec is about 420 logs. The job checks `rateLimitData` every 15s and pauses every worker for
  the hourly reset before using the last 10%. If WCL still answers 429, it waits for the reset and
  retries. Logs already parsed with the same profile come from `actions/cache` and cost nothing.
- **Time.** Parsing stops at `--max-minutes` (110 by default, so a run ends before the next slot),
  and whatever is left waits for a free slot. A spec only counts as complete when every boss built;
  otherwise it's caught up. Changing what "complete" means (e.g. how reference logs are chosen)
  needs a bump of `STATUS_VERSION` in `published.ts`, which makes every spec due again.
- **Actions minutes.** The repository is private: 42 runs a week of roughly 5–10 minutes each
  (setup is ~4), about 1,500 minutes a month.
- **KV writes.** The free plan allows 1,000 a day. A spec writes one profile, about 20 bundles and
  the status: at most ~140 a day. Entries expire after 21 days, so a spec that misses two weeks
  drops out rather than going stale.

## Running it locally

Without WCL credentials, build in v1 mode, which goes through WoWAnalyzer's API (keep runs small).
`--local` writes to `node_modules/.cache/wowcompare-published/`, which `pnpm start` serves at
`/wc-api/` (`vite/publishedDataPlugin.ts`):

    VITE_WCL_API_VERSION=1 DISABLE_CHECKER_PLUGIN=1 pnpm benchmarks:build
    pnpm benchmarks:run --local --spec Druid:Feral --encounter 3176 --difficulty 5

With credentials (`WCL_CLIENT_ID` and `WCL_CLIENT_SECRET` in the environment), build without the
override. You can then leave out `--encounter` to get the current raid.

Options: `--spec` (repeatable, in order: `Druid`, `Feral` or `Druid:Feral`), `--all` (every spec,
after any `--spec` ones), `--first` (with the schedule: due specs to build first), `--encounter`,
`--difficulty`, `--max-minutes`, `--concurrency` (logs fetched at once, default 4), `--cache-dir`. Without `--spec` or `--all`, the schedule decides.
`GITHUB_TOKEN`, if set, is used to look up SimC commit dates.
