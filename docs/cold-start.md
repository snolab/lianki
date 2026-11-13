# Cold start (the installed app on a phone)

How long a cold launch of the PWA takes, where the time goes, and what keeps
it short. Started 2026-11-11, after "PWA 冷启动还有一秒多时间" on an Android 10
phone (Chrome 156, installed app).

## How it is measured

Playwright Chromium against production `https://lianki.com/home` as a guest,
a phone viewport, **4× CPU throttle** (CDP) and **fast 4G** (9 Mbit/s down,
1.5 up, 60 ms RTT) from a throttling CONNECT proxy, so the service worker's
own fetches are throttled too (CDP network throttling misses them). Each run
is a new browser profile:

- **no SW**: first visit, nothing cached.
- **SW**: one visit installs the worker and fills its cache, the browser
  quits, and a relaunch is measured — the installed app's cold start.

Points: TTFB (navigation → first byte), FCP, "hydrated" (the last link or
button on the page has React props), LCP, long-task total. The chat
(Learning Partner) does not open for a guest, so its load is not in these
runs. Server side: `lianki_metrics` (docs/monitoring.md), wall and CPU ms per
path, aggregates only.

## Baseline (2026-11-11, before)

P5/P50/P95 ms, 14–15 runs each; the Mac was busy (load 15–25), so absolute
client numbers are pessimistic, compare before/after only.

| segment                  | no SW          | SW (installed app) |
| ------------------------ | -------------- | ------------------ |
| TTFB                     | 1767/2436/4040 | 1935/2549/3667     |
| HTML end → FCP           | 484/564/775    | 34/52/105          |
| FCP → hydrated           | 1509/1593/2243 | 620/751/2142       |
| hydrated                 | 4224/4709/6250 | 2753/3304/5153     |
| JS decoded / transferred | 4858 / 1504 KB | 4858 / 0 KB        |

Server, last 24 h: `/home` wall p50 1153 / p95 2173 ms, **CPU p50 912 ms**;
every page route is about the same (`/sign-in` 888, `/list` 971 CPU).

Where it went:

1. **The server's render: about 1 s of CPU per page**, before the first
   byte. The largest segment; untouched so far (below).
2. **2.3 MB of the 4.9 MB of JS was every dictionary in all 16 locales**,
   on every page: next-intlayer's barrel imports `@intlayer/dictionaries-entry`,
   and Turbopack hoists it into one module, so any `useIntlayer` pulled all
   123 dictionaries. Parsed and run on every launch, cached or not.
3. **About 500 KB of chat code** (DebugChat, the mic, the pairing modal) on
   every page, also for guests, who never see the chat.
4. The service worker answered pages network-first with no navigation
   preload: the page request waited for the worker to boot. Small on a
   desktop (3 ms), more on a slow phone.

## What was changed

- **Each page ships only its dictionaries.**
  `lib/build/intlayer-direct-loader.cjs` (a Turbopack loader) rewrites
  `useIntlayer("key", …)` (next-intlayer, next-intlayer/server) into
  `useDictionary(<that JSON>, …)` and `getIntlayer("key", …)` (intlayer)
  into `getDictionary(<that JSON>, …)` — the same calls underneath — and
  `@intlayer/dictionaries-entry` is an empty stub
  (`lib/stubs/intlayer-no-dictionaries.mjs`, aliased in `next.config.mjs`).
  Browser since #905, server too since the cold-isolate change below.
  **Keys must be string literals**: `unit/intlayer-direct-loader.test.ts`
  fails on any file it cannot rewrite. intlayer's own optimizer (`@intlayer/swc`) does not run on Next
  16.4's SWC (plugin ABI mismatch), hence the loader.
- **The chat and the pairing modal load when shown** (`React.lazy` in
  `DebugEval.tsx`); replies are read aloud through `voice()` directly.
- **`fonts.googleapis.com` is preconnected** (only its font host was).
- **Navigation preload** in `public/sw.js`: the page request leaves while the
  worker starts; the answer is still cached for offline as before.

## Server render on a cold isolate (2026-11-11)

Every request to the `lianki` Worker took **1.4–2 s to first byte**, warm or
not, while `wrangler tail` showed the Worker itself spending 26–66 ms on
it — the same for a request `worker.ts` refuses before OpenNext runs
(`POST /api/x`, same-site guard: 403 in 2.0 s P50). The time was spent before
the handler ran: a fresh isolate for every request.

Why: the isolate did not fit. Workers give an isolate 128 MB; under
`wrangler dev` (workerd) this Worker's heap was **131 MB right after
startup and 162 MB after one page render**. The unminified script (62 MB
uploaded) is held in the heap whole, and a third of it was dictionaries: three
server copies of every dictionary in all 16 locales, plus the visual editor's
unmerged copy (unused: the editor is not configured). A Worker over its limit
is not kept, so every request paid the start again — and then the cold
module loading of its first render (`lianki_metrics`: `/home` CPU P5 9 ms,
P50 260–912 ms).

What changed (heap measured the same way, `wrangler dev`, inspector
`Runtime.getHeapUsage` after GC):

| build                                  | after startup | after first renders |
| -------------------------------------- | ------------- | ------------------- |
| before                                 | 131 MB        | 160–162 MB          |
| dictionaries direct on the server too  | 104 MB        | 121–126 MB          |
| + minified (`wrangler.jsonc` `minify`) | **77 MB**     | **94–97 MB**        |

- The direct-dictionary loader now runs on the server as well (above); the
  server bundle (`handler.mjs`) went from 50.7 MB to 36.4 MB.
- `@intlayer/unmerged-dictionaries-entry` is an empty stub too
  (`lib/stubs/intlayer-no-unmerged.mjs`): 5.7 MB of the Worker.
- The Worker is minified (names kept).
- DebugEval mounts in the browser only (`DebugEvalLazy.tsx`): its first
  render was always empty, yet the server evaluated the chat's whole module
  graph for every page (≈ 50–80 ms of a cold render's CPU locally).

Measuring production TTFB: `curl` from Tokyo, one fresh connection per
request, 10 rounds of `/robots.txt` (a middleware redirect), `/en`,
`/home`, `/sign-in` and the refused `POST /api/x`.

## The chat at once (2026-11-14)

Owner, 2026-11-14 ~01:00 JST: the page paints fast, but the Learning Partner
appears about 3 s later. The chat rendered only once the hub's socket had
opened (`setChat(true)` in `onopen`), and only then fetched its code
(`React.lazy`): page → hydrate → DebugEval's chunk → socket open → the chat's
chunk → render → history.

What changed:

- **The last lines on the device.** `lib/chat-cache.ts`: the newest
  `chat.cacheLines` (config, default 40; 0 = off) lines of the signed-in
  account's thread in localStorage (`lk:chat-cache`), written once the hub's
  history is in. On a page load DebugEval reads them in its first render and
  shows the chat at once, marked `data-cached` (status still "reconnecting…")
  until the hub's history replaces them: the hub wins, deduped by id
  (`reconcileHistory`). Isolation: one entry per device, keyed by the account
  id the server rendered the page for (`account`, root layout); a page for
  another account, or with no session, never shows it and drops it; sign-out
  drops it (`lib/sign-out.ts`). Each line passes an allowlist (`cacheLine`)
  that keeps nothing docs/chat-history.md says is never kept (page context,
  screen text, raw STT, parts, timings, speaker tags, page labels, avatars,
  emails, attachment ids). Not on a box (no session there).
- **The chat's chunk prefetched.** `DebugEvalLazy.tsx` schedules a one-shot
  `import()` of the module React.lazy loads (`lib/chat-host-loader.ts`) in
  idle time right after hydration (`requestIdleCallback`, else 200 ms), beside
  DebugEval's own chunk, only for a signed-in viewer whose chat is wanted
  (partner open, or debug mode: `lib/chat-prefetch.ts`), never a guest.

**Measured** with `scripts/qa/measure-chat-visible.mjs`: the local OpenNext
build under `wrangler dev` (`qa:all --prepare`), a throwaway account in debug
mode, iPhone viewport, 4× CPU, and a stand-in hub in the page that opens
600 ms after it is made and sends the history 300 ms later (lianki-push does
not run locally). The first load fills the device's copy; the next is
measured. 10–15 runs each, P5/P50/P95 ms from navigation; the Mac was busy
(load 8–15), so compare before/after only.

| case                          | before: FCP → chat | after: FCP → chat | after: chat / hub's lines |
| ----------------------------- | ------------------ | ----------------- | ------------------------- |
| warm HTTP cache, no throttle  | 1135/1152/1161     | **251/527/545**   | 624 / 1216                |
| fast 4G (warm)                | 1101/1138/1157     | **491/522/540**   | 708 / 1292                |
| fast 4G, cold HTTP cache      | 1100/1110/1119     | **481/489/512**   | 837 / 1419                |
| fast 4G, cold, no device copy | 1100/1110/1119     | 1060/1097/1155    | 1442 / 1443               |

- The device copy takes **~600 ms** off "chat visible" here; on production the
  saving is the whole socket open plus the history (the 3 s he saw), since the
  copy no longer waits for either.
- The prefetch alone (no copy yet: first visit on a device) saved ≈ 15 ms in
  these runs: locally the chat's chunk arrives well within the socket's
  600 ms. It matters when the network is slower than the hub.
- What is left before the chat paints: DebugEval's own chunk after hydration
  and the first render of DebugChat (≈ 250–300 ms at 4× CPU).

## What is left

- **App shell from the cache** (design note below).
- **Cold render CPU** once isolates are kept: module loading for a page's
  first render (Turbopack module instantiation, Next's app-page runtime) is
  still ~300 ms locally. The server-side chunk graph per route is the place
  to look (`scripts`: the inspector profile, attributed by chunk).
- **Fonts.** Two cross-origin stylesheets block first paint (155 KB
  `lxgw-wenkai-tc` CSS from jsDelivr, 227 KB Google Fonts CSS). Cached on a
  repeat launch, so it matters mainly on a first visit.

## Design note: the app shell from the service worker (not built)

**Idea.** With the worker installed, answer a navigation to an app page (the
PWA's `start_url`, `/home`, first) from the cache at once, then fetch the
page in the background and swap in the fresh data. A relaunch would paint
from the device, not after a server round trip (~1.5–2 s today).

**The risk: another account's page.** A cached page is rendered for one
account (name, avatar, lists, counts). On a shared device, after a sign-out or
a switch of account, the cache must never answer with the previous account's
page — not even for the moment before the refresh.

**Proposed shape.**

- Cache only a **shell**: the page rendered with no account data (the layout,
  nav, empty states), from a dedicated route (e.g. `/home?shell=1`, or a
  render flag that leaves every per-user part to the client). Per-user data
  arrives by the same client fetches the pages already make, after hydration.
- Key the shell by **build** and **locale** only (never by account); the
  service worker drops shells of other builds on activate.
- On sign-out, sign-in and account switch, the page tells the worker to drop
  every cached HTML (`{type: "forget-pages"}`), and the worker keeps no HTML
  of signed-in pages besides the shell (today's network-first copies, kept
  for offline, are account-specific: they would go behind the same rule).
- Serve the shell only for `mode: "navigate"` requests of the app routes
  that support it, only when the device is signed in (a cookie the worker
  cannot read: the page sets a non-secret marker in Cache Storage at sign-in),
  and fall back to the network on any doubt.
- A page served from the shell revalidates at once; its "fresh" state is
  what the user acts on (no write from stale data).

**Cost.** Each app route that wants this needs its per-user parts to render
on the client, not the server — a change to how those pages are built, so
it goes route by route, `/home` first, behind a flag.
