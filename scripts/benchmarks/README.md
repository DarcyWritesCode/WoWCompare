# Benchmarks

Live Compare scores a log against the median of parses around the **90th percentile** for its
spec, boss and difficulty, and shows the #1 parse as the ceiling. Parsing those logs in the
viewer's browser is slow, so a GitHub Actions job (`.github/workflows/benchmarks.yml`) does it
once for everyone. It runs daily and rebuilds each class once a week, on its day in
`src/wowcompare/benchmarks/schedule.ts`. The specs page (`/specs`) shows that day and what was
built.

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
- **Finding the 90th percentile.** WCL's rankings list has no total and stops at rank 2,000. The
  ranks WCL gives the #1 log's players include `totalParses`, so the target rank is
  `totalParses × 10%`. The job fetches the rankings pages around it. If the target is past rank
  2,000, the deepest ranks stand in.
- **Candidates.** The 20 parses nearest the target rank. Kills more than 3 MADs shorter than
  usual are left out first.
- **PI/Aug toggle.** Each log records the Power Infusion, Ebon Might and Prescience others put on
  the player. "Leave out PI/Aug-buffed logs" (on by default) drops logs over the thresholds from
  the median. With fewer than 5 left, it keeps them. About a third of reference logs are buffed,
  hence 20 candidates for a median of 10.

## Why this design

- **Read-only to viewers.** An earlier version let browsers upload parsed logs to a shared
  cache. Every input to its keys was public, so anyone could plant fake benchmark data that
  everyone would be scored against. Now only this job writes, using an API token.
- **Weekly, by class.** Each spec's profile and benchmarks are rebuilt together on its class's
  day, so the profile fingerprint matches its benchmarks all week. Specs not completed within
  8 days (a failed or cut-short run, or never built) are caught up on any day, oldest first.
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
4. Run it once by hand: Actions → _Benchmarks_ → _Run workflow_. To try it narrowly first,
   pass e.g. `--spec Druid:Feral --difficulty 5`. For a first release, `--spec Druid --spec Evoker
--all` builds those classes first, then the rest. A run that hits the time limit leaves the
   rest to the daily catch-up.

## Limits to watch

- **WCL points.** About 5.4 points per parsed log, so roughly 650 logs an hour within the
  3,600-point budget. The job checks `rateLimitData` every 30s and waits for the hourly reset
  before using the last 5%. A day is up to 6 specs × 10 bosses × 2 difficulties × 21 logs
  ≈ 2,500 logs, about 4 hours. Logs already parsed with the same profile come from
  `actions/cache` and cost nothing.
- **Time.** Parsing stops at `--max-minutes` (330), and whatever is left waits for the daily
  catch-up.
- **KV writes.** The free plan allows 1,000 a day. A day writes one profile and about 20 bundles
  per spec, plus the status entry after each spec: roughly 130. Entries expire after 21 days, so
  a class that misses two weeks drops out rather than going stale.

## Running it locally

Without WCL credentials, build in v1 mode, which goes through WoWAnalyzer's API (keep runs small).
`--local` writes to `node_modules/.cache/wowcompare-published/`, which `pnpm start` serves at
`/wc-api/` (`vite/publishedDataPlugin.ts`):

    VITE_WCL_API_VERSION=1 DISABLE_CHECKER_PLUGIN=1 pnpm benchmarks:build
    pnpm benchmarks:run --local --spec Druid:Feral --encounter 3176 --difficulty 5

With credentials (`WCL_CLIENT_ID` and `WCL_CLIENT_SECRET` in the environment), build without the
override. You can then leave out `--encounter` to get the current raid.

Options: `--spec` (repeatable, in order: `Druid`, `Feral` or `Druid:Feral`), `--all` (every spec,
after any `--spec` ones), `--encounter`, `--difficulty`, `--max-minutes`, `--concurrency` (logs
fetched at once, default 4), `--cache-dir`. Without `--spec` or `--all`, the schedule decides.
`GITHUB_TOKEN`, if set, is used to look up SimC commit dates.
