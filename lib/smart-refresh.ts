/**
 * Smart refresh: the "New version · Refresh" button only when the page you are
 * on would load different code (docs/shipping.md, "Smart refresh").
 *
 *   build time   scripts/build/route-fingerprints.ts reads the Next build's
 *                client reference manifests and writes, per route, a hash of
 *                the client chunks and CSS that route loads, plus one for the
 *                shared shell (runtime, polyfills, the root layout, global CSS).
 *   deploy       the main Worker hands that file to lianki-push with its build
 *                id (lib/announce-build.ts); the hub keeps the last few builds.
 *   page         connects with its own build id; the hub answers with what
 *                changed between that build and the serving one (versionNews),
 *                and the page decides from its route (refreshDecision).
 *
 * Everything here is pure: it runs in the build script, in lianki-push and in
 * the browser alike.
 */

/**
 * The main Worker's publish carries its fingerprints in this header (JSON,
 * URI-encoded); the body stays the bare build id that an older lianki-push
 * reads, since the main Worker deploys first.
 */
export const FINGERPRINTS_HEADER = "x-lk-fingerprints";

/** What a build loads on the client: written at build time, one per deploy. */
export type RouteFingerprints = {
  build: string;
  /** Every page asks to refresh, whatever changed (a security fix). */
  force?: boolean;
  /** Hash of the shared shell: runtime, polyfills, root layout, global CSS. */
  shell: string;
  /** Route pattern ("/words", "/read/[id]") → hash of its own client chunks. */
  routes: Record<string, string>;
};

/**
 * What lianki-push tells one page about the serving build. `shell` and `routes`
 * are relative to the page's own build; both absent means "cannot tell" (the
 * hub never saw that build's fingerprints), and the page asks to refresh as it
 * always did.
 */
export type VersionNews = {
  build: string;
  force?: true;
  /** The shared shell changed: every page is out of date. */
  shell?: boolean;
  /** Every route of the new build → 1 if its code changed (or is new), 0 if not. */
  routes?: Record<string, 0 | 1>;
};

/**
 * Short, stable hash: two FNV-1a 32 passes with different offsets, 16 hex
 * digits — fingerprints, not security.
 */
export function fnv1a(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (a >>> 15);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a) + hex(b);
}

/**
 * A client reference manifest key ("/(app)/read/[id]/page") as the URL pattern
 * it serves ("/read/[id]"): route groups and parallel slots dropped. Null for
 * Next's own pages (/_not-found, /_global-error) and intercepting routes.
 */
export function routePattern(key: string): string | null {
  if (!key.endsWith("/page")) return null;
  const segs = key.slice(0, -"/page".length).split("/").filter(Boolean);
  if (segs.some((s) => s.startsWith("_") || /^\(\.+\)/.test(s))) return null;
  const kept = segs.filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  return `/${kept.join("/")}`;
}

/** How specific a pattern segment is: higher wins (static beats dynamic). */
function rank(seg: string): number {
  if (seg.startsWith("[[...")) return 0;
  if (seg.startsWith("[...")) return 1;
  if (seg.startsWith("[")) return 2;
  return 3;
}

/** Does `pattern` serve `pathname`? */
export function matches(pattern: string, pathname: string): boolean {
  const pat = pattern.split("/").filter(Boolean);
  const path = pathname.split("/").filter(Boolean);
  for (let i = 0; i < pat.length; i++) {
    const seg = pat[i];
    if (seg.startsWith("[[...")) return true;
    if (seg.startsWith("[...")) return path.length > i;
    if (i >= path.length) return false;
    if (seg.startsWith("[")) continue;
    let part = path[i];
    try {
      part = decodeURIComponent(part);
    } catch {}
    if (seg !== part) return false;
  }
  return pat.length === path.length;
}

/** The pattern Next would pick for `pathname`, as its router does: the most specific one. */
export function matchRoute(pathname: string, patterns: Iterable<string>): string | null {
  let best: string | null = null;
  let bestKey: number[] = [];
  for (const p of patterns) {
    if (!matches(p, pathname)) continue;
    const key = p.split("/").filter(Boolean).map(rank).concat(Number.MAX_SAFE_INTEGER); // a longer static path wins a tie
    if (best === null || compare(key, bestKey) > 0) {
      best = p;
      bestKey = key;
    }
  }
  return best;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Shapes of the Next build this reads (Turbopack, Next 16). */
export type ClientManifest = {
  entryJSFiles?: Record<string, string[]>;
  entryCSSFiles?: Record<string, { path: string; inlined?: boolean; content?: string }[]>;
};

/** Entries shared by every page: the root layout and Next's global error page. */
const isShellEntry = (entry: string) =>
  entry === "[project]/app/layout" || entry.endsWith("/builtin/global-error");

/**
 * Per-route fingerprints from the build's client reference manifests.
 *
 * `manifests` maps a manifest key ("/(app)/words/page") to its manifest;
 * `shellFiles` are the files every page loads before any route (rootMainFiles,
 * polyfills); `hashOf(file)` is the hash of one file's content. A route's hash
 * covers the chunks and CSS of its own layouts and page, minus the shell's —
 * so a change to the shell moves `shell` alone, and a change to one route's
 * code moves that route alone (or every route sharing the changed chunk).
 */
export function computeFingerprints(opts: {
  build: string;
  force?: boolean;
  manifests: Record<string, ClientManifest>;
  shellFiles: string[];
  hashOf: (file: string) => string;
}): RouteFingerprints {
  const shell = new Set(opts.shellFiles);
  const files = (m: ClientManifest, pick: (entry: string) => boolean) => {
    const out = new Set<string>();
    for (const [entry, list] of Object.entries(m.entryJSFiles ?? {}))
      if (pick(entry)) for (const f of list) out.add(f);
    for (const [entry, list] of Object.entries(m.entryCSSFiles ?? {}))
      if (pick(entry))
        for (const c of list)
          out.add(c.inlined && c.content ? `inline:${fnv1a(c.content)}` : c.path);
    return out;
  };
  const digest = (set: Iterable<string>) =>
    fnv1a(
      [...set]
        .map((f) => (f.startsWith("inline:") ? f : opts.hashOf(f)))
        .sort()
        .join("\n"),
    );
  for (const m of Object.values(opts.manifests))
    for (const f of files(m, isShellEntry)) shell.add(f);
  const routes: Record<string, string> = {};
  for (const [key, m] of Object.entries(opts.manifests)) {
    const pattern = routePattern(key);
    if (pattern === null) continue;
    const own = [...files(m, (e) => !isShellEntry(e))].filter((f) => !shell.has(f));
    routes[pattern] = digest(own);
  }
  return {
    build: opts.build,
    ...(opts.force ? { force: true } : {}),
    shell: digest(shell),
    routes,
  };
}

/**
 * What changed between the page's build (`from`) and the serving one (`to`),
 * for that page. Without either fingerprint it says only the build: the page
 * then asks to refresh, as before smart refresh.
 */
export function versionNews(
  build: string,
  from: RouteFingerprints | undefined,
  to: RouteFingerprints | undefined,
): VersionNews {
  const news: VersionNews = { build };
  if (to?.force) news.force = true;
  if (!from || !to || to.build !== build) return news;
  news.shell = from.shell !== to.shell;
  news.routes = {};
  for (const [route, hash] of Object.entries(to.routes))
    news.routes[route] = from.routes[route] === hash ? 0 : 1;
  return news;
}

/**
 * Should the page at `pathname`, built as `own`, ask to refresh for `news`?
 *
 *   same     the page is the serving build: nothing to do
 *   prompt   its code changed (or the shell did, or it is forced, or it cannot
 *            tell): offer the refresh
 *   quiet    a new build, but nothing this page loads changed — remember it,
 *            and ask again when the page moves to another route
 */
export function refreshDecision(
  news: VersionNews,
  own: string,
  pathname: string,
): "same" | "prompt" | "quiet" {
  if (news.build === own) return "same";
  if (news.force || !news.routes || news.shell !== false) return "prompt";
  const route = matchRoute(pathname, Object.keys(news.routes));
  // A page no route pattern names (a rewrite, a 404): cannot tell, so ask.
  if (route === null) return "prompt";
  return news.routes[route] ? "prompt" : "quiet";
}

/** Parse one message from lianki-push; null when it is not version news. */
export function parseNews(data: unknown): VersionNews | null {
  let v: unknown;
  try {
    v = JSON.parse(String(data));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.build !== "string" || !o.build) return null;
  const news: VersionNews = { build: o.build };
  if (o.force === true) news.force = true;
  if (typeof o.shell === "boolean" && o.routes && typeof o.routes === "object") {
    news.shell = o.shell;
    news.routes = {};
    for (const [k, x] of Object.entries(o.routes as Record<string, unknown>))
      news.routes[k] = x ? 1 : 0;
  }
  return news;
}

/** Validate a fingerprint file (from the main Worker); null when malformed. */
export function parseFingerprints(v: unknown): RouteFingerprints | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.build !== "string" || !o.build || typeof o.shell !== "string") return null;
  if (!o.routes || typeof o.routes !== "object") return null;
  const routes: Record<string, string> = {};
  for (const [k, h] of Object.entries(o.routes as Record<string, unknown>))
    if (typeof h === "string") routes[k] = h;
  return { build: o.build, ...(o.force === true ? { force: true } : {}), shell: o.shell, routes };
}
