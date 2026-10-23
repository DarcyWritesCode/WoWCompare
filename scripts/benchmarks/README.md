# Nightly benchmarks

Live Compare scores a log against the #1 parse and the top-10 median for its spec, boss and
difficulty. Parsing those 10 logs in the viewer's browser is slow, so a nightly GitHub Actions
job (`.github/workflows/benchmarks.yml`) does it once for everyone:

1. For every spec with a SimC APL, it builds the profile from SimC's current APL (default
   branch) and publishes it (`profile-<specId>`).
2. For every Heroic and Mythic boss of the current raid, it fetches the spec's rankings and parses
   the top 10 with the app's own parser (`bench-<specId>-<encounterId>-<difficulty>`).

The app reads both through `functions/wc-api/` (`/wc-api/profiles/:spec`,
`/wc-api/benchmarks/:spec/:encounter/:difficulty`). See `src/wowcompare/benchmarks/published.ts`.

## Why this design

- **Read-only to viewers.** An earlier version let browsers upload parsed logs to a shared
  cache. Every input to its keys was public, so anyone could plant fake benchmark data that
  everyone would be scored against. Now only this job writes, using an API token.
- **The app uses the job's profile.** Snapshots are only valid with the profile they were parsed
  with, so the app loads the published profile instead of fetching the APL from GitHub itself.
  If SimC changes the APL during the day, the app keeps using the nightly profile until the next
  run. The bundle records the profile's `profileFingerprint`, and the app only uses its snapshots
  when the fingerprint matches.
- **Fallbacks.** The app parses logs itself (nothing is shared) when the profile was customized
  with accepted Suggestions, for bosses or specs the job didn't cover, and for the on-demand
  benchmarks (same build, closest parses). Rankings come from the bundle whenever there is one.
- **Current raid from Warcraft Logs.** The job asks WCL for the newest expansion's unfrozen zones
  that have Heroic and Mythic, so a new tier needs no code change.

## Setup

1. **Warcraft Logs API client.** Create a client at https://www.warcraftlogs.com/api/clients (any
   redirect URL; the client-credentials flow doesn't use it). Add repository secrets
   `WCL_CLIENT_ID` and `WCL_CLIENT_SECRET`.
2. **KV namespace.** `pnpm dlx wrangler kv namespace create wowcompare-benchmarks`, then in the
   Cloudflare dashboard bind it to the `wowcompare` Pages project as `SNAPSHOTS` (Settings →
   Bindings, Production). Add its ID as the secret `WC_KV_NAMESPACE_ID`.
3. **API token.** The job reuses the deploy token, `CLOUDFLARE_API_TOKEN`. It needs
   _Account → Workers KV Storage → Edit_ on top of _Cloudflare Pages → Edit_. Tokens made from the
   "Edit Cloudflare Workers" template already have both. Without it, KV writes fail with HTTP 403.
   `CLOUDFLARE_ACCOUNT_ID` is already set for deploys.
4. Run it once by hand: Actions → _Nightly benchmarks_ → _Run workflow_. To try it narrowly first,
   pass e.g. `--spec Druid:Feral --difficulty 5`.

## Limits to watch

- **WCL points.** The job checks `rateLimitData` every 30s and waits for the hourly reset before
  using the last 5%. The first run parses everything, about 33 specs × bosses × 2 difficulties ×
  10 logs, and may not finish in one night. Later runs only parse logs that are new to a top 10.
  Parsed logs are kept between runs with `actions/cache`. Mythic is done first.
- **Time.** Parsing stops at `--max-minutes` (330), and whatever is left waits for the next night.
- **KV writes.** The free plan allows 1,000 writes a day. An entry is only rewritten when its
  profile or top-10 lineup changed, or every 3 days to renew its 7-day expiry. That works out to
  well under one write per spec × boss × difficulty per day.

## Running it locally

Without WCL credentials, build in v1 mode, which goes through WoWAnalyzer's API (keep runs small).
`--local` writes to `node_modules/.cache/wowcompare-published/`, which `pnpm start` serves at
`/wc-api/` (`vite/publishedDataPlugin.ts`):

    VITE_WCL_API_VERSION=1 DISABLE_CHECKER_PLUGIN=1 pnpm benchmarks:build
    pnpm benchmarks:run --local --spec Druid:Feral --encounter 3176 --difficulty 5

With credentials (`WCL_CLIENT_ID` and `WCL_CLIENT_SECRET` in the environment), build without the
override. You can then leave out `--encounter` to get the current raid.

Options: `--spec` (repeatable, `Feral` or `Druid:Feral`), `--encounter`, `--difficulty`,
`--max-minutes`, `--concurrency` (logs fetched at once, default 4), `--cache-dir`.
