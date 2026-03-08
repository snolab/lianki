// Lianki Service Worker — offline support for / and /list pages
const CACHE_NAME = "lianki-v1";
const OFFLINE_PAGES = ["/en", "/en/list", "/"];

// Assets to pre-cache on install
const PRECACHE_URLS = ["/manifest.json"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Skip API routes — always network only
  if (url.pathname.startsWith("/api/")) return;

  // Skip Next.js internals
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
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match("/en"))),
    );
    return;
  }

  // Everything else: stale-while-revalidate
  event.respondWith(networkThenCache(request));
});

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
