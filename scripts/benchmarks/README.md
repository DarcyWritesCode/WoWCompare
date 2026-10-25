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
- **Few parses.** Only parses inside the band count: on a boss with under 10 parses (early
  Mythic) the band holds none, and Live Compare shows no reference rather than the near-top
  parses that used to stand in (#1 stays as the ceiling). Buff effects don't depend on it: they're
  fitted from every boss and difficulty of the spec, so Mythic uses what Heroic measured.
- **Candidates.** 20 parses at evenly spaced ranks across the band (the whole band can be
  thousands of logs per spec, far past WCL's point budget). Kills more than 3 MADs shorter than
  usual are left out first. The median uses every candidate that parsed.
- **PI/Aug toggle.** Each log records the Power Infusion, Ebon Might and Prescience others put on
  the player. "Leave out PI/Aug-buffed logs" (on by default) drops logs over the thresholds from
  the median. With fewer than 5 left, it keeps them. About a third of candidates are buffed.

## Buff effects (cooldown line-ups)

"Have Tiger's Fury up during Berserk" estimates need to know how much a buff adds to a cooldown's
windows. See `src/wowcompare/benchmarks/buffEffects.ts`.

- **Measure.** Each window records the share of it each buff was up (overlap). Up-at-the-cast
  missed buffs pressed just after the cooldown, e.g. Tiger's Fury after Berserk. On held-out
  Feral logs, overlap explained 36% of Berserk windows' strength vs 6% for up-at-cast.
- **Method.** Window strength (window DPS / the log's average) regressed on buff overlaps and
  resources at the cast, within each log, with every other buff as a control, ridge-regularized.
  Compared on planted effects of known size in real windows, this was the only strategy that
  stayed accurate when buffs, resources or Bloodlust and potions coincide; pooling windows
  across logs (the earlier method) or comparing within logs without controls were off by 0.04 to
  0.14 window strength. 90% intervals come from resampling logs, and only effects whose interval
  excludes zero are used.
- **Guards.** Planted effects are random; real buffs aren't, and the first real Frost DK fit
  (418 logs) had Icy Talons tripling Pillar of Frost and Pillar adding 83% to Breath of
  Sindragosa. So an effect is only used when at least 20 logs have the buff clearly up (75%+ of a
  window) in one window and clearly not (25% or less) in another (Icy Talons is up 96–100% of
  every Pillar), and when the fit with only resources as controls agrees in sign and within 3x;
  the smaller of the two is used.
- **Cooldown pairs.** Two cooldowns overlapping is measured once, from both cooldowns' windows:
  either side gives the damage per second of overlap. Pillar's 15s rarely covers 75%+ or 25%- of
  a 27s Breath, so that side alone had 3 usable logs and swung from +0.83 to +0.05 with the
  controls; pooled it's +0.45 (+0.76 resources only) from 421. Order within a pair (Tiger's Fury
  just before Convoke) isn't modelled; the overlap share already covers most of it.
- **Data.** Any one boss's reference logs are far too few (no strategy was usable at 15 logs), so
  effects pool every boss and difficulty of a spec, over the most recent 3,000 logs within 28 days
  (`EFFECT_LOGS_PER_SPEC`), and need 200 logs per cooldown. Scheduled builds add their logs, and
  collector runs (`--collect`, hourly 12:17–23:17 UTC, when no build runs) parse more spread over the
  50–95th percentile (`COLLECT_BAND`), specs with the fewest logs first: wider and lower than the
  reference band, since the reference band's players rarely miss a line-up and effects need
  windows where one was missed. The rows live in the
  job's cache (`effects/<specId>.jsonl`); the fit is published as `effects-<specId>`.
- **What's suggested.** Only the APL's own cooldowns overlapping each other: a proc or passive buff
  being up during a window reflects how the window went, not a choice. Procs the profile tracks
  (Apex Predator's Craving, Rime) are judged on being spent instead ("Spend X before it's
  wasted"): getting few is luck, letting them expire isn't.

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
  Collector runs spend the hours builds leave idle, up to the same limit: roughly 6,000 logs a
  day across all specs.
- **Time.** Parsing stops at `--max-minutes` (110 by default, so a run ends before the next slot),
  and whatever is left waits for a free slot. A spec only counts as complete when every boss built;
  otherwise it's caught up. Changing what "complete" means (e.g. how reference logs are chosen)
  needs a bump of `STATUS_VERSION` in `published.ts`, which makes every spec due again.
- **Actions minutes.** The repository is public, so GitHub-hosted runner minutes are free. The
  schedule is 42 builds and 84 collector runs a week.
- **KV writes.** The free plan allows 1,000 a day. A spec writes one profile, about 20 bundles,
  its buff effects and the status: at most ~150 a day for builds. Collector runs write one
  effects entry per spec they collect for: about 50 a day. Entries expire after 21 days, so a spec that misses two weeks
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
