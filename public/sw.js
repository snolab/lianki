// Lianki Service Worker — offline support. Registered site-wide by
// app/components/ServiceWorkerRegistration.tsx (scope "/").
//
// /words and /alphabet are built to work offline: their pages open from this
// cache, and their data (word lists, due words, unsent grades) lives in
// IndexedDB — see lib/words/idb.ts.
const CACHE_NAME = "lianki-v2";

/**
 * Caches the page writes itself, never cleared here on an update: the word
 * clips kept on the device (lib/words/audio-disk.ts, AUDIO_CACHE_NAME).
 */
const KEEP_CACHES = ["lianki-audio-v1"];

// Assets to pre-cache on install
const PRECACHE_URLS = ["/manifest.json"];

/** Pages whose shell must open offline even with a different ?query. */
const OFFLINE_SHELLS = ["/words", "/alphabet"];

/**
 * A my-<hash> or my-<name> box (devbox/README.md) runs `next dev`, whose chunk
 * names stay the same across edits and restarts. Cache-first /_next/static there
 * served the previous build's code next to the new one, and the page never
 * hydrated (2026-11-07: the box's spinner stayed, its fetch never went to
 * lianki.com). On a box this worker caches nothing, answers nothing, and drops
 * what an older one cached.
 *
 * Deliberately broader than the box host rule (lib/box-oauth/rules.ts,
 * isBoxHost): any my-*.lianki.com, since caching nothing is the safe side and a
 * static file cannot import it. unit/sw-box.test.ts holds that every host the
 * rule accepts is caught here.
 */
const SW_HOST = self.location.hostname || "";
const IS_BOX =
  SW_HOST.startsWith("my-") && SW_HOST.endsWith(".lianki.com") && SW_HOST.split(".").length === 3;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  if (IS_BOX) return;
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => (IS_BOX || k !== CACHE_NAME) && !KEEP_CACHES.includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// A page loaded before this worker took control sends the URLs it already
// fetched (its HTML and /_next/static chunks) so they are cached too.
//
// A page also tells it what the app-icon badge counts ({type: "badge-mode"}),
// for a push that carries counts only (badge section below).
self.addEventListener("message", (event) => {
  const data = event.data;
  if (IS_BOX || !data) return;
  if (data.type === "badge-mode") {
    event.waitUntil(rememberBadgeMode(data.mode));
    return;
  }
  if (data.type !== "cache" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        data.urls
          .filter((u) => typeof u === "string")
          .map((u) =>
            fetch(u)
              .then((res) => (cacheable(res) ? cache.put(u, res) : undefined))
              .catch(() => {}),
          ),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  // A box: everything straight from its dev server (IS_BOX above).
  if (IS_BOX) return;
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Skip API routes — always network only
  if (url.pathname.startsWith("/api/")) return;

  // The owner's same-origin live preview (lib/live-view/page-proxy.ts): a page
  // with ?live=<id>, and whatever it loads, comes from his dev server. Never
  // answered from the cache (dev chunk names are reused across edits) and
  // never cached (below), so nothing of it outlives the preview.
  if (url.searchParams.has("live") || /[?&]live=/.test(request.referrer || "")) return;

  // Hashed, immutable build output: cache first.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheThenNetwork(request));
    return;
  }
  if (url.pathname.startsWith("/_next/")) {
    event.respondWith(networkThenCache(request));
    return;
  }

  // HTML pages: network first, fall back to cache
  if (request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(request)
        .then(async (res) => {
          // Cache successful HTML responses (before the page gets it: keep()).
          if (cacheable(res)) await keep(request, res);
          return res;
        })
        .catch(async () => {
          const exact = await caches.match(request);
          if (exact) return exact;
          // /words?list=… shares one shell: any cached copy of the path will do.
          if (OFFLINE_SHELLS.includes(url.pathname)) {
            const shell =
              (await caches.match(request, { ignoreSearch: true })) ??
              (await caches.match(url.pathname));
            if (shell) return shell;
          }
          return caches.match("/en");
        }),
    );
    return;
  }

  // Everything else: stale-while-revalidate
  event.respondWith(networkThenCache(request));
});

async function cacheThenNetwork(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (cacheable(res)) await keep(request, res);
  return res;
}

async function networkThenCache(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request);
    if (cacheable(res)) await keep(request, res);
    return res;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}

/**
 * Write a copy of `res` to the cache, and only then let the page have `res`.
 *
 * Never hand the page a response while its clone is still being written: in
 * WebKit (the owner's iPhone PWA) a page that navigated away before such a
 * response finished left the cache write hanging, and the next navigation in
 * that tab never started — no request reached the server for 30 s and more.
 * Seen as qa-sign-out timing out in WebKit only (Full QA, 2026-11-10). In the
 * Playwright image's WebKit, 100 runs of six quick navigations each: 6 hung
 * with the write in the background, none with it awaited, none with no cache
 * write at all (unit/sw-cache-write.test.ts holds the order). The cost: the
 * page gets a response once it has fully arrived, not as it streams. A failed
 * write (quota, private mode) still answers the page.
 */
async function keep(request, res) {
  try {
    await (await caches.open(CACHE_NAME)).put(request, res.clone());
  } catch {}
}

/** Kept for offline use: a good answer that is not the owner's live preview (x-lk-live). */
function cacheable(res) {
  return res.ok && !res.headers.has("x-lk-live");
}

// ── The app-icon badge (docs/app-badge.md; the page side is lib/app-badge.ts) ──
//
// A push sets the number on the installed app's icon: from the payload when it
// carries one ({badge: n} or {badge: {asks, due, mode?}}), else from one
// GET /api/badge (numbers only). No Badging API, or it refuses: nothing.
// Behind the flag `pwa.app-badge`: the endpoint answers {on: false} while it
// is off, and the badge is cleared.

const BADGE_MODES = ["off", "ask-cards", "due-cards", "both"];
const BADGE_MAX = 9999;
/** Where the page's last mode is kept across the worker's restarts (dropped on an update). */
const BADGE_CACHE = "lianki-badge-v1";
const BADGE_MODE_URL = "/__lk/badge-mode";
let badgeMode = null;

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** lib/app-badge.ts badgeCount, without the screen (a worker has none). */
function badgeNumber(mode, c) {
  if (mode === "off") return 0;
  const asks = mode === "due-cards" ? 0 : Math.floor(c.asks);
  const due = mode === "ask-cards" ? 0 : Math.floor(c.due);
  return Math.min(asks + due, BADGE_MAX);
}

async function rememberBadgeMode(mode) {
  if (!BADGE_MODES.includes(mode)) return;
  badgeMode = mode;
  try {
    const cache = await caches.open(BADGE_CACHE);
    await cache.put(BADGE_MODE_URL, new Response(mode));
  } catch {}
}

async function storedBadgeMode() {
  if (badgeMode) return badgeMode;
  try {
    const cache = await caches.open(BADGE_CACHE);
    const res = await cache.match(BADGE_MODE_URL);
    const mode = res ? await res.text() : null;
    if (BADGE_MODES.includes(mode)) badgeMode = mode;
  } catch {}
  return badgeMode;
}

async function setIconBadge(n) {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== "function") return false;
  try {
    if (n > 0) await nav.setAppBadge(Math.min(Math.floor(n), BADGE_MAX));
    else if (typeof nav.clearAppBadge === "function") await nav.clearAppBadge();
    else await nav.setAppBadge(0);
    return true;
  } catch {
    return false;
  }
}

async function badgeFromPush(data) {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== "function") return false;
  const b = data && data.badge;
  if (isCount(b)) return setIconBadge(b);
  if (b && typeof b === "object" && isCount(b.asks) && isCount(b.due)) {
    const mode = BADGE_MODES.includes(b.mode) ? b.mode : (await storedBadgeMode()) || "both";
    return setIconBadge(badgeNumber(mode, b));
  }
  const mode = await storedBadgeMode();
  if (mode === "off") return setIconBadge(0);
  try {
    const res = await fetch(mode ? `/api/badge?mode=${mode}` : "/api/badge", {
      credentials: "same-origin",
      cache: "no-store",
    });
    // Signed out, or the server failed: the number stays as it was.
    if (!res.ok) return false;
    const j = await res.json();
    return setIconBadge(j && j.on === true && isCount(j.count) ? j.count : 0);
  } catch {
    return false;
  }
}

self.addEventListener("push", (event) => {
  if (IS_BOX) return;
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {}
  event.waitUntil(badgeFromPush(data));
});
