/**
 * Hot-swappable islands (docs/dev-hot-islands.md) — the pure rules shared by
 * the page (loader.ts, Island.tsx) and the dev server
 * (scripts/dev/islands-server.ts). No imports beyond types.
 *
 * An island is a whole smart component — its own fetching, hooks and view —
 * that the page renders built in. On the owner's page, with a live code-run
 * grant, it can instead render the same island built from the dev machine's
 * working tree and imported over the tailnet.
 */
import type { HubState } from "@/lib/dev-eval";

/** localStorage key: the islands module's URL, e.g. https://<tailnet-host>/lianki-islands/islands.js. */
export const ISLANDS_SRC_KEY = "lk:slots-src";
/** Where the page hands the remote module its own module instances: { [specifier]: namespace }. */
export const MODULES_GLOBAL = "__lkModules";
/** Bumped when what the page expects of the module itself changes (its exports). */
export const ISLANDS_API = 1;

/**
 * The only origins the page will import an island from: https on the
 * tailnet (`tailscale serve`), or this machine. One constant, on purpose.
 */
export const ISLAND_ORIGINS = {
  httpsHostSuffixes: [".ts.net"],
  localHosts: ["localhost", "127.0.0.1", "[::1]"],
} as const;

/**
 * The modules a remote island reads from the page instead of bundling its own
 * copy, so contexts, stores and hooks are the page's own instances. The dev
 * build rewrites these imports (scripts/dev/islands-build.ts); the page fills
 * them in host-modules.ts — a test keeps the two lists equal.
 */
export const SHARED_MODULES = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "next/link",
  "next/navigation",
  "next/image",
  "next-intlayer",
  "zod",
  "@/lib/auth-client",
  "@/lib/debug-client",
  "@/lib/dates",
  "@/lib/app-locale",
  "@/lib/islands/Island",
  // The swipe's headless core: its contexts and hooks must be the page's.
  "@/lib/words/swipe-core",
] as const;
// Not shared on purpose: lib/islands/shared-state.ts and actions.ts. Their
// state lives in localStorage and window events, so a remote island's own copy
// talks to the page's — and validates with its own contract version.
export type SharedModule = (typeof SHARED_MODULES)[number];

/** The islands module URL from localStorage, if its origin is allowed. */
export function islandsSrc(raw: string | null | undefined): URL | null {
  if (!raw?.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = (ISLAND_ORIGINS.localHosts as readonly string[]).includes(u.hostname);
  if (local && (u.protocol === "http:" || u.protocol === "https:")) return u;
  if (u.protocol !== "https:") return null;
  return ISLAND_ORIGINS.httpsHostSuffixes.some((s) => u.hostname.endsWith(s)) ? u : null;
}

/** The module URL for one build: a fresh `v` busts the browser's module cache. */
export function islandsUrl(src: URL, rev?: string): string {
  const u = new URL(src);
  if (rev) u.searchParams.set("v", rev);
  return u.href;
}

/** The dev server's SSE endpoint, next to the module. */
export const islandsEventsUrl = (src: URL) => new URL("events", src).href;

/**
 * Until when this page holds a live code-run (eval) grant, from the hub's
 * state: the latest `until` of an eval pairing that covers this page, or null.
 * A chat-only pairing never counts; a friend's page never gets here.
 */
export function grantUntil(state: Pick<HubState, "sessions" | "self"> | null, now: number) {
  let best: number | null = null;
  for (const s of state?.sessions ?? []) {
    if (s.scope === "chat") continue;
    if (s.pages && !(state?.self && s.pages.includes(state.self))) continue;
    const until = s.until ?? Number.POSITIVE_INFINITY;
    if (until > now && (best === null || until > best)) best = until;
  }
  return best;
}

/** A value React can render as a component: a function, or a memo/forwardRef/lazy object. */
export const isComponent = (v: unknown) =>
  typeof v === "function" || (typeof v === "object" && v !== null && "$$typeof" in v);

export type IslandsModule<C> = {
  islands: Record<string, C>;
  css: string;
  rev: string;
  /** One line per island that was skipped, and why. */
  skipped: string[];
};

/**
 * Check an imported module: it must export `islands` ({ [name]: Component })
 * and `versions` ({ [name]: contract version }). An island whose contract
 * version differs from the page's, or that the page does not know, is skipped
 * (it keeps rendering built in).
 */
export function checkIslandsModule<C>(
  m: Record<string, unknown>,
  want: Readonly<Record<string, number>>,
): IslandsModule<C> {
  if (m.ISLANDS_API !== ISLANDS_API)
    throw new Error(`islands API ${String(m.ISLANDS_API)}, this page wants ${ISLANDS_API}`);
  const all = m.islands;
  if (!all || typeof all !== "object") throw new Error("the module exports no islands");
  const versions = (m.versions ?? {}) as Record<string, unknown>;
  const islands: Record<string, C> = {};
  const skipped: string[] = [];
  for (const [name, c] of Object.entries(all as Record<string, unknown>)) {
    if (!(name in want)) skipped.push(`${name}: this page has no such island`);
    else if (versions[name] !== want[name])
      skipped.push(`${name}: contract v${String(versions[name])}, this page wants v${want[name]}`);
    else if (!isComponent(c)) skipped.push(`${name}: not a component`);
    else islands[name] = c as C;
  }
  return {
    islands,
    skipped,
    css: typeof m.css === "string" ? m.css : "",
    rev: typeof m.rev === "string" ? m.rev : "",
  };
}

/** An SSE `slot-reload` payload: the new rev and the islands whose code changed. */
export function parseReload(data: string): { rev: string; names: string[] } | null {
  try {
    const v = JSON.parse(data) as { rev?: unknown; names?: unknown };
    if (typeof v.rev !== "string" || !Array.isArray(v.names)) return null;
    return { rev: v.rev, names: v.names.filter((n): n is string => typeof n === "string") };
  } catch {
    return null;
  }
}

/** One line for the devLog and the islands status, from whatever was thrown. */
export function errLine(e: unknown): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return msg.slice(0, 300);
}
