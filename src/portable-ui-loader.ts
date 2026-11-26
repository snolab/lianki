/**
 * 随身Li's chat window where the lianki.com frame is refused (a site's CSP
 * frame-src): the main site's own DebugChat, not a second one built here
 * (owner, 2026-11-26), bundled into the userscript (src/portable-window.ts,
 * filled by scripts/portable-window-plugin.ts). No eval, no remote code: it
 * is part of the script the manager injected. Its body runs only here, the
 * first time the window is needed on a page.
 *
 * `mountPortable` (packages/debug-chat/src/embed/partner-embed.tsx) draws it
 * in a closed shadow root and feeds it only through the chat-only broker.
 * Its localStorage lives in GM storage under its own prefix, never the site's.
 */
import type { PortableUi } from "./portable-li";
import type { PortableWindowFactory } from "./portable-window";

export const PORTABLE_STORE_PREFIX = "lianki_portable_ls:";
/** The widget's storage keys kept across pages: the account- and site-scoped drafts only. */
export const keptPortableKey = (k: string) => k.includes("portable~");

export function portableUiBundled(d: {
  /** src/portable-window.ts's default export: null in a build without the plugin. */
  factory: PortableWindowFactory | null;
  /** The chat's strings per locale (portable-window.ts portableChatStrings). */
  chatStrings?: Record<string, Record<string, string>> | null;
  getValue: (k: string, d?: any) => any;
  setValue: (k: string, v: any) => void;
  deleteValue: (k: string) => void;
  report: (what: string, detail: string) => void;
}): () => Promise<PortableUi | null> {
  let made: PortableUi | null | undefined;
  const make = (): PortableUi | null => {
    if (!d.factory) return null;
    try {
      // Only the composer's drafts (scoped `portable~<account>~<site>`) are kept;
      // every other widget preference (fold, dock, position, compact) lives in
      // memory for this page, so the window always starts from 随身Li's defaults,
      // never from a main-site float position or a minimized state.
      const mem = new Map<string, string>();
      const kept = (k: string) => keptPortableKey(k);
      const built = d.factory({
        get: (k) => (kept(k) ? d.getValue(PORTABLE_STORE_PREFIX + k, null) : (mem.get(k) ?? null)),
        set: (k, v) => (kept(k) ? d.setValue(PORTABLE_STORE_PREFIX + k, v) : void mem.set(k, v)),
        del: (k) => (kept(k) ? d.deleteValue(PORTABLE_STORE_PREFIX + k) : void mem.delete(k)),
        keys: () => [...mem.keys()],
      });
      const mount = built?.api?.mountPortable;
      if (typeof mount !== "function" || !Array.isArray(built.css)) {
        d.report("portable-window", "no mountPortable in this build");
        return null;
      }
      const css = built.css;
      return {
        mount: (o) =>
          mount({
            ...o,
            css,
            report: d.report,
            chatStrings: d.chatStrings?.[o.locale] ?? d.chatStrings?.en,
          }),
      };
    } catch (e) {
      d.report("portable-window", String((e as Error)?.message ?? e));
      return null;
    }
  };
  return async () => (made === undefined ? (made = make()) : made);
}
