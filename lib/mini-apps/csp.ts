/**
 * The Content-Security-Policy a mini app runs under (docs/mini-apps.md,
 * "Isolation"), modelled on Claude Artifacts: scripts only inline or from the
 * CDN allowlist (config miniApps.scriptOrigins) and Lianki's own /m/ files
 * (the SDK, the style pack, the presets); stylesheets only inline, from
 * Google Fonts (miniApps.styleOrigins) or /m/; no network at all
 * (connect-src 'none'): every capability goes through the host over
 * postMessage. Pure; the route and the page compose it from live config.
 */

/** A source list as stored in config: https only, a host and an optional path; deduplicated. */
export function parseSources(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{2,5})?(?:\/[A-Za-z0-9._~/-]*)?$/.test(s))
      continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export type CspInput = {
  scripts: readonly string[];
  styles: readonly string[];
  fonts: readonly string[];
  /** Origins whose /m/ files (the SDK, the style pack, the presets) load: Lianki's, and the app's own. */
  assets: string | readonly string[];
  /** Who may frame it (the host page's origin); header only. */
  ancestors?: string;
  /** The sandbox flags; header only (a <meta> cannot carry it). */
  sandbox?: string;
};

/** The policy, for a response header (with frame-ancestors and sandbox when given). */
export function miniAppCsp(i: CspInput): string {
  const own = (typeof i.assets === "string" ? [i.assets] : i.assets)
    .map((a) => `${a.replace(/\/+$/, "")}/m/`)
    .join(" ");
  const d = [
    "default-src 'none'",
    // Single-file apps are inline by nature; eval for JSX-in-the-browser presets.
    ["script-src 'unsafe-inline' 'unsafe-eval'", own, ...i.scripts].join(" "),
    ["style-src 'unsafe-inline'", own, ...i.styles].join(" "),
    ["font-src data:", own, ...i.fonts].join(" "),
    "img-src data: blob:",
    "media-src data: blob:",
    "worker-src blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (i.ancestors) d.push(`frame-ancestors ${i.ancestors}`);
  if (i.sandbox) d.push(`sandbox ${i.sandbox}`);
  return d.join("; ");
}

/** The same policy for a <meta http-equiv> inside srcdoc (no frame-ancestors, no sandbox). */
export function miniAppCspMeta(i: CspInput): string {
  return miniAppCsp({ ...i, ancestors: undefined, sandbox: undefined });
}

/**
 * The iframe's sandbox flags. Never allow-same-origin on a shared origin:
 * without it the app's origin is opaque (no cookies, no storage of anyone's,
 * no reaching the parent). Only a per-app origin on another site gets it,
 * so its browser storage is its own (like an artifact's).
 */
export function sandboxFlags(sameOrigin: boolean): string {
  return sameOrigin ? "allow-scripts allow-forms allow-same-origin" : "allow-scripts allow-forms";
}

/** An exact version in a CDN path: react@18.3.1, three@0.160.0, /ajax/libs/x/1.2.3/, jquery-3.7.1. */
const PINNED = /(?:@|\/|-)v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\/|\.|$)/;

/**
 * Every external <script src> and <link href> in the file: from an allowed
 * source, and a script pinned to an exact version (Artifacts' rule). Same-site
 * /m/ paths are always fine. Returns the first problem, or null.
 */
export function checkExternalRefs(
  html: string,
  allow: { scripts: readonly string[]; styles: readonly string[] },
): { error: "script-source" | "script-unpinned" | "style-source"; url: string } | null {
  const tags = html.matchAll(/<(script|link)\b([^>]*)>/gi);
  for (const [, tag, attrs] of tags) {
    const isScript = tag!.toLowerCase() === "script";
    const m = (isScript ? /\ssrc\s*=\s*["']?([^"'\s>]+)/i : /\shref\s*=\s*["']?([^"'\s>]+)/i).exec(
      attrs!,
    );
    if (!m) continue;
    const url = m[1]!;
    if (!isScript && !/\brel\s*=\s*["']?stylesheet/i.test(attrs!)) continue;
    if (/^\/m\/[A-Za-z0-9._/-]+$/.test(url) && !url.includes("..")) continue;
    const list = isScript ? allow.scripts : allow.styles;
    const ok = url.startsWith("https://") && list.some((s) => startsWithSource(url, s));
    if (!ok) return { error: isScript ? "script-source" : "style-source", url };
    if (isScript && !PINNED.test(new URL(url).pathname)) return { error: "script-unpinned", url };
  }
  return null;
}

/** CSP matching: a source with a path ending "/" matches below it; otherwise the host. */
function startsWithSource(url: string, source: string): boolean {
  const u = new URL(url);
  const s = new URL(source);
  if (u.origin !== s.origin) return false;
  if (s.pathname === "/" || s.pathname === "") return true;
  return s.pathname.endsWith("/") ? u.pathname.startsWith(s.pathname) : u.pathname === s.pathname;
}
