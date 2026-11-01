/**
 * The Learning Partner on every site: the userscript's side
 * (docs/dev-debug-widget.md, "On every site"). Small on purpose: the chat
 * itself (React, the widget, its CSS) is a separate script,
 * public/partner-embed.js (scripts/build-partner-embed.ts), fetched only on
 * the owner's browser, only when he turned it on.
 *
 * Off by default for everyone. On only when:
 * 1. debug mode is on for this browser on lianki.com (the page's own switch,
 *    mirrored into the userscript's storage when he visits lianki.com);
 * 2. lianki.com hands out a partner ticket: the owner only (404 otherwise);
 * 3. this is the top window, and not a site he hid it on.
 *
 * Nothing here is visible to the page: no globals, no attributes, no events.
 * The ticket is fetched with GM_xmlhttpRequest (cross-origin, the lianki.com
 * session or lk:token) and goes straight into the socket's subprotocol list.
 */
import { type Blocker, isolatedWorld, partnerWanted } from "../packages/debug-chat/src/embed/guard";

/** GM keys, under the userscript's own namespace (not the app's `lk:` cards). */
export const PARTNER_ON_KEY = "lianki_partner_on";
export const PARTNER_HIDDEN_KEY = "lianki_partner_hidden";
const PARTNER_STORE_PREFIX = "lianki_partner_ls:";
/** The stop() of a partner that never started. */
export const NOOP = () => {};

type GmFetch = (
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; credentials?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export type PartnerHostDeps = {
  /** lianki.com, or the app the dev loader points at. */
  origin: string;
  /** Where the chat's script is: `${origin}/partner-embed.js`, or the dev server's. */
  src: string;
  gmFetch: GmFetch;
  getValue: (k: string, d?: any) => any;
  setValue: (k: string, v: any) => void;
  deleteValue: (k: string) => void;
  listValues?: () => string[];
  info: unknown;
  pageWindow: unknown;
  report: (what: string, detail: string) => void;
  /** The page's host, top-window flag, document and WebSocket (defaults: this page's; tests pass fakes). */
  host?: string;
  top?: boolean;
  doc?: Document;
  WebSocket?: new (url: string, protocols: string[]) => unknown;
};

/**
 * On lianki.com: mirror this browser's debug-mode switch (lk:agent, else
 * lk:debug, "1" = on) into the userscript's storage, where the other sites read it.
 */
export function mirrorPartnerSwitch(
  store: Pick<Storage, "getItem">,
  setValue: (k: string, v: any) => void,
) {
  try {
    const v = store.getItem("lk:agent") ?? store.getItem("lk:debug");
    setValue(PARTNER_ON_KEY, v === "1");
  } catch {}
}

/** Start the partner on this page, if it is wanted here. Resolves to its stop(). */
export async function startPartner(d: PartnerHostDeps): Promise<() => void> {
  const host = d.host ?? location.host;
  const hidden: string[] = (() => {
    try {
      const v = JSON.parse(d.getValue(PARTNER_HIDDEN_KEY, "[]"));
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  })();
  const wanted = partnerWanted({
    enabled: d.getValue(PARTNER_ON_KEY, false) === true,
    hiddenHosts: hidden,
    host,
    top: d.top ?? window.self === window.top,
  });
  if (!wanted) return NOOP;
  // Owner only: the ticket route answers 404 to anyone else. Asked once up
  // front, so nothing is downloaded or drawn for a non-owner.
  const ticket = async (): Promise<string | null> => {
    try {
      const r = await d.gmFetch(`${d.origin}/api/debug/partner-ticket`, {
        method: "POST",
        headers: { "x-lianki-userscript": "1" },
        credentials: "include",
      });
      if (!r.ok) return null;
      const body = await r.json();
      return typeof body?.ticket === "string" ? body.ticket : null;
    } catch {
      return null;
    }
  };
  const first = await ticket();
  if (!first) return NOOP;
  // The first ticket opens the first socket, if it is still fresh (it lives 60 s).
  let spare: { t: string; at: number } | null = { t: first, at: Date.now() };
  const nextTicket = async () => {
    const s = spare;
    spare = null;
    return s && Date.now() - s.at < 30_000 ? s.t : ticket();
  };

  const isolated = isolatedWorld(
    d.info as Parameters<typeof isolatedWorld>[0],
    d.pageWindow as { Object?: unknown } | undefined,
  );
  const blocked: Blocker | undefined = isolated ? undefined : "pageRealm";
  d.report("partner-mode", `${isolated ? "isolated" : "page-realm"} ${host}`);

  let code: string;
  try {
    const r = await d.gmFetch(d.src);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    code = await r.text();
  } catch (e) {
    d.report("partner-load", String((e as Error)?.message ?? e));
    return NOOP;
  }
  let built: {
    api: { mountPartner: (o: unknown) => { destroy(): void } };
    css: string[];
    rev: string;
  };
  try {
    // Indirect eval: the chat's script needs nothing from this scope but `gm`.
    const factory = (0, eval)(code) as (gm: unknown) => typeof built;
    const keys = () =>
      (d.listValues?.() ?? [])
        .filter((k) => k.startsWith(PARTNER_STORE_PREFIX))
        .map((k) => k.slice(PARTNER_STORE_PREFIX.length));
    built = factory({
      get: (k: string) => d.getValue(PARTNER_STORE_PREFIX + k, null),
      set: (k: string, v: string) => d.setValue(PARTNER_STORE_PREFIX + k, v),
      del: (k: string) => d.deleteValue(PARTNER_STORE_PREFIX + k),
      keys,
    });
  } catch (e) {
    // A page CSP without 'unsafe-eval', or Trusted Types: nothing can be drawn.
    d.report("partner-eval", String((e as Error)?.message ?? e));
    return NOOP;
  }
  let mounted: { destroy(): void } | null = null;
  try {
    mounted = built.api.mountPartner({
      doc: d.doc ?? document,
      css: built.css,
      appOrigin: d.origin,
      ticket: nextTicket,
      WebSocket: d.WebSocket ?? WebSocket,
      blocked,
      report: d.report,
      hide: () => {
        d.setValue(PARTNER_HIDDEN_KEY, JSON.stringify([...new Set([...hidden, host])]));
        mounted?.destroy();
        mounted = null;
      },
    });
  } catch (e) {
    d.report("partner-mount", String((e as Error)?.message ?? e));
  }
  return () => {
    mounted?.destroy();
    mounted = null;
  };
}
