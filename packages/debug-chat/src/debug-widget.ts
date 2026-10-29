/**
 * Hot-loading the debug chat widget from a dev server (docs/dev-debug-widget.md)
 * — the pure pieces shared by the page (DebugChatHost.tsx) and
 * the dev server (scripts/dev/debug-widget-server.ts). No imports.
 *
 * The widget module is DebugChat built on its own as ESM, with every `react`
 * import rewritten to read `globalThis[REACT_GLOBAL]`: the page puts its own
 * React there (owner debug mode only, just before importing), so the widget's
 * component renders inside the page's React tree — one React, no second root.
 */

/** localStorage key: the widget module's URL, e.g. https://dev-mac.lianki.com/debug-chat.js. */
export const WIDGET_SRC_KEY = "lk:debug-widget-src";
/** Where the page hands the widget its React: {React, jsx, ReactDOM}. */
export const REACT_GLOBAL = "__lkReact";
/** Bumped when what the page expects of the module changes (its exports, DebugChat's props). */
export const WIDGET_API = 1;

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The widget URL from localStorage, if allowed: any https URL, or http on localhost. */
export function widgetSrc(raw: string | null | undefined): URL | null {
  if (!raw?.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL.has(u.hostname))) return u;
  return null;
}

/** The module URL for one build: a fresh `v` busts the browser's module cache. */
export function widgetUrl(src: URL, rev?: string): string {
  const u = new URL(src);
  if (rev) u.searchParams.set("v", rev);
  return u.href;
}

/** The dev server's SSE endpoint, next to the module. */
export const eventsUrl = (src: URL) => new URL("events", src).href;

/** What the page needs from the module. `Chat` is the DebugChat component. */
export type WidgetModule<C> = { Chat: C; css: string; rev: string };

/** Import the module (through `importer`) and check it is a widget this page can render. */
export async function loadWidget<C>(
  url: string,
  importer: (url: string) => Promise<Record<string, unknown>>,
): Promise<WidgetModule<C>> {
  const m = await importer(url);
  if (typeof m.DebugChat !== "function") throw new Error("the module exports no DebugChat");
  if (m.WIDGET_API !== WIDGET_API)
    throw new Error(`widget API ${String(m.WIDGET_API)}, this page wants ${WIDGET_API}`);
  return {
    Chat: m.DebugChat as C,
    css: typeof m.css === "string" ? m.css : "",
    rev: typeof m.rev === "string" ? m.rev : "",
  };
}

/** One line for the chat's menu, from whatever was thrown. */
export function failNote(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `dev widget failed (${msg.slice(0, 120)}); using the built-in chat`;
}
