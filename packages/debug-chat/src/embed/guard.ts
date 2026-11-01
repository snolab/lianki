/**
 * When the Learning Partner may run on another site, and why not
 * (docs/dev-debug-widget.md, "On every site"). Pure rules, tested in
 * unit/partner-embed.test.ts.
 */

/** Why the chat is not shown on this page; the note says so (ui-strings.ts EmbedStrings). */
export type Blocker = "pageRealm" | "connect" | "styles" | "script" | "load";

/** What the userscript manager tells us about where the script runs. */
export type ManagerInfo = {
  /** Violentmonkey: "page" or "content". */
  injectInto?: unknown;
  /** Tampermonkey / ScriptCat: "raw", "js" (or "javascript"), "dom". */
  sandboxMode?: unknown;
  scriptHandler?: unknown;
};

/**
 * Does the script run in a world of its own (an extension's isolated or
 * USER_SCRIPT world), where the page's scripts cannot see its globals, patch
 * its WebSocket, or read what it keeps in memory?
 *
 * The strongest signal is a realm check: the page's window (unsafeWindow) has
 * another `Object` than ours. Then the managers' own words: Violentmonkey's
 * `injectInto: "content"`, Tampermonkey's and ScriptCat's `sandboxMode: "dom"`.
 * Anything else (page injection, "raw", an unknown manager) counts as the
 * page's own realm: the chat stays off there.
 */
export function isolatedWorld(
  info: ManagerInfo | undefined,
  pageWindow: { Object?: unknown } | undefined,
  ownObject: unknown = Object,
): boolean {
  try {
    if (pageWindow && pageWindow.Object && pageWindow.Object !== ownObject) return true;
  } catch {
    // A cross-world wrapper that throws on access is another world too.
    return true;
  }
  const inject = String(info?.injectInto ?? "").toLowerCase();
  if (inject === "content") return true;
  const sandbox = String(info?.sandboxMode ?? "").toLowerCase();
  return sandbox === "dom";
}

/** A CSP report that is about us: our hub or app origin, in a directive we need. */
export function cspBlocker(
  e: { blockedURI?: string; effectiveDirective?: string; violatedDirective?: string },
  origins: string[],
): Blocker | null {
  const dir = (e.effectiveDirective || e.violatedDirective || "").split(" ")[0];
  const uri = e.blockedURI ?? "";
  const ours = origins.some((o) => {
    try {
      const u = new URL(o);
      return uri.startsWith(o) || uri.startsWith(`wss://${u.host}`) || uri.startsWith(`ws://${u.host}`);
    } catch {
      return false;
    }
  });
  if (dir === "connect-src" && ours) return "connect";
  // An inline style or script the page refuses: `blockedURI` is "inline"
  // (or "eval", "trusted-types-sink"); we only add these inside our root.
  if (dir.startsWith("style-src") && (uri === "inline" || ours)) return "styles";
  if (dir.startsWith("script-src") && (uri === "eval" || uri === "inline" || ours)) return "script";
  if (dir === "require-trusted-types-for" || dir === "trusted-types") return "script";
  return null;
}

/** The note's text: the blocker's sentence with the feature's name in it. */
export function blockerText(
  b: Blocker,
  strings: Record<Blocker, string>,
  name: string,
): string {
  return strings[b].replaceAll("{name}", name);
}

/**
 * Whether to try at all, before any network: the owner turned it on
 * (debug mode on lianki.com, mirrored into the userscript's own storage),
 * and this site is not one he hid it on.
 */
export function partnerWanted(o: {
  enabled: boolean;
  hiddenHosts: string[];
  host: string;
  top: boolean;
}): boolean {
  return o.top && o.enabled && !o.hiddenHosts.includes(o.host);
}
