/**
 * The dev site as its own installable app, 「开发站」 (docs/dev-whole-page.md,
 * "The dev site as its own app"). On the whole-page dev server only
 * (LIANKI_DEV_WHOLE_PAGE=1), /manifest.json and /sw.js answer with the dev
 * variants below instead of public/manifest.json and public/sw.js: by a
 * next.config rewrite behind the LAN/tailnet guard, and by the preview gate
 * itself on the public host (scripts/dev/preview-gate.ts), which serves them
 * without a session — Chrome fetches a manifest and its icons without cookies.
 *
 * Nothing here names a host: the manifest's URLs are paths, so the same answer
 * is right on preview.lianki.com, dev.lianki.com (LIANKI_DEV_PUBLIC_HOST) and
 * the tailnet address alike.
 */
import { BADGE_ANY, BADGE_MASKABLE, type BadgeBox, badgePng, badgeSvg } from "./badge";

/** Where the badged icons are served (app/api/dev-whole-page/pwa/[file]/route.ts). */
export const DEV_PWA_PREFIX = "/api/dev-whole-page/pwa/";
/** Bump when the badge changes, so installed icons are fetched again. */
export const DEV_ICON_VERSION = "1";

export const DEV_APP_NAME = "Lianki 开发站";
export const DEV_APP_SHORT_NAME = "开发站";
/** Not "/": the installed dev app is never the same app as Lianki's, even if an origin were shared. */
export const DEV_APP_ID = "/?app=dev";

/** Badged icon file → the public icon it is made from, and where its badge sits. */
const ICONS: Record<string, { from: string; at: BadgeBox }> = {
  "icon-192.png": { from: "icon-192.png", at: BADGE_ANY },
  "icon-512.png": { from: "icon-512.png", at: BADGE_ANY },
  "icon-maskable-192.png": { from: "icon-maskable-192.png", at: BADGE_MASKABLE },
  "icon-maskable-512.png": { from: "icon-maskable-512.png", at: BADGE_MASKABLE },
};

type Manifest = Record<string, unknown>;

const icon = (file: string) => `${DEV_PWA_PREFIX}${file}?v=${DEV_ICON_VERSION}`;

/** The dev site's manifest: public/manifest.json with its own name, id and badged icons. */
export function devManifest(prod: Manifest): Manifest {
  return {
    ...prod,
    name: DEV_APP_NAME,
    short_name: DEV_APP_SHORT_NAME,
    description: "Lianki's preview build: trial code on production data.",
    id: DEV_APP_ID,
    start_url: typeof prod.start_url === "string" ? prod.start_url : "/home",
    scope: "/",
    icons: [
      { src: icon("icon.svg"), sizes: "any", type: "image/svg+xml" },
      { src: icon("icon-192.png"), sizes: "192x192", type: "image/png" },
      { src: icon("icon-512.png"), sizes: "512x512", type: "image/png" },
      {
        src: icon("icon-maskable-192.png"),
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: icon("icon-maskable-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

/**
 * The dev site's service worker. It makes the app installable and keeps
 * nothing: no precache, no cache reads or writes. Only top-level GET page
 * loads go through it, straight to the network (a short page when the Mac is
 * unreachable); chunks, HMR, APIs and sockets are never touched, so hot
 * reload works as without it. On activation it drops what an older worker
 * cached (public/sw.js before the dev rules), keeping only the word clips the
 * page stores itself.
 */
export const DEV_SW = `// Lianki 开发站 service worker: lib/dev-site/pwa.ts (DEV_SW). Caches nothing.
const KEEP_CACHES = ["lianki-audio-v1"];
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate" || e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).catch(
      () =>
        new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lianki 开发站</title><p style="font:16px system-ui;margin:2rem">开发站: the dev server is not reachable right now.</p>',
          { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    ),
  );
});
`;

/** A request path → the dev PWA file it asks for, or null (not one of ours). */
export function devPwaFile(pathname: string): string | null {
  if (pathname === "/manifest.json") return "manifest.json";
  if (pathname === "/sw.js") return "sw.js";
  if (!pathname.startsWith(DEV_PWA_PREFIX)) return null;
  const file = pathname.slice(DEV_PWA_PREFIX.length);
  return file === "manifest.json" || file === "sw.js" || file === "icon.svg" || file in ICONS
    ? file
    : null;
}

export type DevPwaAsset = { type: string; body: string | Uint8Array };

/**
 * One dev PWA file, made from the public file it is based on (`read` gets a
 * file of public/ by name). null: no such file.
 */
export function devPwaAsset(file: string, read: (name: string) => Uint8Array): DevPwaAsset | null {
  if (file === "manifest.json") {
    const prod = JSON.parse(new TextDecoder().decode(read("manifest.json"))) as Manifest;
    return {
      type: "application/manifest+json; charset=utf-8",
      body: JSON.stringify(devManifest(prod), null, 2),
    };
  }
  if (file === "sw.js") return { type: "text/javascript; charset=utf-8", body: DEV_SW };
  if (file === "icon.svg")
    return {
      type: "image/svg+xml; charset=utf-8",
      body: badgeSvg(new TextDecoder().decode(read("icon.svg"))),
    };
  const png = ICONS[file];
  return png ? { type: "image/png", body: badgePng(read(png.from), png.at) } : null;
}

/** devPwaAsset, each PNG drawn once per process; the manifest and SVG are read fresh. */
export function devPwaAssets(read: (name: string) => Uint8Array) {
  const made = new Map<string, DevPwaAsset | null>();
  return (file: string): DevPwaAsset | null => {
    if (!file.endsWith(".png")) return devPwaAsset(file, read);
    if (!made.has(file)) made.set(file, devPwaAsset(file, read));
    return made.get(file)!;
  };
}
