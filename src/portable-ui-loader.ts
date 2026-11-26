/**
 * 随身Li's chat window: the main site's own (packages/debug-chat DebugChat),
 * not a second one built here (owner, 2026-11-26). It is the Learning
 * Partner's script, public/partner-embed.js (scripts/build-partner-embed.ts:
 * its own React, the widget's CSS, storage and network shadowed), whose
 * `mountPortable` draws DebugChat in a closed shadow root and feeds it only
 * through the chat-only broker the userscript hands it.
 *
 * It is ~1.2 MB, so it is not in lianki.user.js: fetched from lianki.com with
 * GM_xmlhttpRequest the first time 随身Li shows on a page, evaluated in the
 * manager's world, once per page. Null when that is not possible (offline, a
 * page CSP without eval, an old build): the caller shows the plain panel.
 */
import type { PortableUi } from "./portable-li";

type GmFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The widget's localStorage lives here in GM storage, never in the site's. */
export const PORTABLE_STORE_PREFIX = "lianki_portable_ls:";

export function portableUiLoader(d: {
  src: string;
  gmFetch: GmFetch;
  getValue: (k: string, d?: any) => any;
  setValue: (k: string, v: any) => void;
  deleteValue: (k: string) => void;
  report: (what: string, detail: string) => void;
  /** Indirect eval by default; tests pass their own. */
  evaluate?: (code: string) => unknown;
}): () => Promise<PortableUi | null> {
  let loading: Promise<PortableUi | null> | undefined;
  const load = async (): Promise<PortableUi | null> => {
    let code: string;
    try {
      const r = await d.gmFetch(d.src);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      code = await r.text();
    } catch (e) {
      d.report("portable-load", String((e as Error)?.message ?? e));
      loading = undefined; // a later show may try again
      return null;
    }
    try {
      const factory = (d.evaluate ?? ((c: string) => (0, eval)(c)))(code) as (gm: unknown) => {
        api?: { mountPortable?: (o: unknown) => { destroy(): void } };
        css?: string[];
      };
      const built = factory({
        get: (k: string) => d.getValue(PORTABLE_STORE_PREFIX + k, null),
        set: (k: string, v: string) => d.setValue(PORTABLE_STORE_PREFIX + k, v),
        del: (k: string) => d.deleteValue(PORTABLE_STORE_PREFIX + k),
        keys: () => [],
      });
      const mount = built?.api?.mountPortable;
      if (typeof mount !== "function" || !Array.isArray(built.css)) {
        d.report("portable-load", "no mountPortable in this build");
        return null;
      }
      const css = built.css;
      return { mount: (o) => mount({ ...o, css, report: d.report }) };
    } catch (e) {
      // A page CSP without 'unsafe-eval', or Trusted Types.
      d.report("portable-eval", String((e as Error)?.message ?? e));
      return null;
    }
  };
  return () => (loading ??= load());
}
