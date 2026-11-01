/**
 * When the Learning Partner may run on another site, and why not
 * (docs/dev-debug-widget.md, "On every site"). Pure rules, tested in
 * unit/partner-embed.test.ts.
 */

/** Why the chat is not shown on this page; the note says so (ui-strings.ts EmbedStrings). */
export type Blocker = "pageRealm" | "connect" | "styles" | "script" | "load";

/** What the userscript manager tells us about where the script runs (its GM_info). */
export type ManagerInfo = {
  /** Violentmonkey: the mode it actually used, "page" or "content". */
  injectInto?: unknown;
  /** Tampermonkey / ScriptCat: "raw", "js" (or "javascript"), "dom". */
  sandboxMode?: unknown;
  scriptHandler?: unknown;
  /** The script's own metadata; Violentmonkey keeps the declared @inject-into here. */
  script?: unknown;
};

/**
 * Own properties only, through syntax alone: a null-prototype copy made by
 * object spread. No built-in is called (the page may have replaced
 * Object.keys, hasOwnProperty, getOwnPropertyDescriptor), and a getter the
 * page put on Object.prototype for a key the manager never set is not read.
 */
function own(o: unknown): Record<string, unknown> {
  if (!o || typeof o !== "object") return { __proto__: null } as Record<string, unknown>;
  try {
    return { __proto__: null, ...(o as object) } as Record<string, unknown>;
  } catch {
    return { __proto__: null } as Record<string, unknown>;
  }
}

/**
 * Is `v` one of these exact strings? Strict equality only: no toLowerCase,
 * no includes (the page may have replaced String/Array methods), so each
 * casing a manager uses is listed.
 */
function is(v: unknown, ...words: string[]): boolean {
  if (typeof v !== "string") return false;
  for (let k = 0; k < words.length; k++) if (v === words[k]) return true;
  return false;
}

/**
 * Does the script run in a world of its own (an extension's isolated or
 * USER_SCRIPT world), where the page's scripts cannot see its globals, patch
 * its eval or WebSocket, or read what it keeps in memory? Fail closed.
 *
 * Decided only from the manager's own GM_info (a binding in our scope, never
 * a page global), read as own properties through syntax:
 *
 * 1. Any page-injection word refuses: Violentmonkey's `injectInto: "page"`,
 *    a declared `@inject-into page` (`script.injectInto`), Tampermonkey's or
 *    ScriptCat's `sandboxMode` "raw" or "js"/"javascript".
 * 2. Then it needs a positive word from the manager: `injectInto: "content"`
 *    or `sandboxMode: "dom"`.
 * 3. Anything else (no word, an unknown manager, an unreadable GM_info) is
 *    the page's realm: the note, and nothing privileged.
 *
 * Never a page global: the page can make `window.Object` (or anything on
 * window) answer a new identity on every read, so no realm comparison is used.
 */
export function isolatedWorld(info: ManagerInfo | undefined): boolean {
  const i = own(info);
  const declared = own(i.script).injectInto;
  if (is(i.injectInto, "page", "Page", "PAGE") || is(declared, "page", "Page", "PAGE"))
    return false;
  if (is(i.sandboxMode, "raw", "Raw", "RAW", "js", "JS", "javascript", "JavaScript", "JAVASCRIPT"))
    return false;
  return is(i.injectInto, "content", "Content", "CONTENT") || is(i.sandboxMode, "dom", "DOM", "Dom");
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
