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
  `lib/build/intlayer-direct-loader.cjs` (a Turbopack loader, browser code
  only) rewrites `useIntlayer("key", …)` from next-intlayer into
  `useDictionary(<that JSON>, …)` — the same call underneath — and the
  browser's `@intlayer/dictionaries-entry` is an empty stub
  (`lib/stubs/intlayer-no-dictionaries.mjs`, aliased in `next.config.mjs`).
  The server keeps the real entry. **Keys must be string literals**:
  `unit/intlayer-direct-loader.test.ts` fails on a client file it cannot
  rewrite. intlayer's own optimizer (`@intlayer/swc`) does not run on Next
  16.4's SWC (plugin ABI mismatch), hence the loader.
- **The chat and the pairing modal load when shown** (`React.lazy` in
  `DebugEval.tsx`); replies are read aloud through `voice()` directly.
- **`fonts.googleapis.com` is preconnected** (only its font host was).
- **Navigation preload** in `public/sw.js`: the page request leaves while the
  worker starts; the answer is still cached for offline as before.

## What is left

- **Server render CPU (~0.9 s p50 per page).** The biggest segment. Profile
  one render under `wrangler dev` (repeat requests: warm vs cold isolate),
  then cut what it spends; the server bundle still carries every dictionary.
- **App shell from the cache.** With the worker installed, answer `/home`
  from the cache at once and refresh it in the background: the launch would
  skip the server entirely. It needs a per-account guard (a cached page must
  never show to another account on the same device) and a data refresh after
  hydration, so it is a design change, not a tweak.
- **Fonts.** Two cross-origin stylesheets block first paint (155 KB
  `lxgw-wenkai-tc` CSS from jsDelivr, 227 KB Google Fonts CSS). Cached on a
  repeat launch, so it matters mainly on a first visit.
