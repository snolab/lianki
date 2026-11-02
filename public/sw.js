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

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && !KEEP_CACHES.includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// A page loaded before this worker took control sends the URLs it already
// fetched (its HTML and /_next/static chunks) so they are cached too.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cache" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        data.urls
          .filter((u) => typeof u === "string")
          .map((u) =>
            fetch(u)
              .then((res) => (res.ok ? cache.put(u, res) : undefined))
              .catch(() => {}),
          ),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Skip API routes — always network only
  if (url.pathname.startsWith("/api/")) return;

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
        .then((res) => {
          // Cache successful HTML responses
          const cloned = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
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
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkThenCache(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}
