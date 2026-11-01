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
import { blockerText, isolatedWorld, partnerWanted } from "../packages/debug-chat/src/embed/guard";
import { EMBED_NAME, EMBED_STRINGS, embedLang } from "../packages/debug-chat/src/ui-strings";
import { frameShell } from "./partner-frame";

/** GM keys, under the userscript's own namespace (not the app's `lk:` cards). */
export const PARTNER_ON_KEY = "lianki_partner_on";
export const PARTNER_HIDDEN_KEY = "lianki_partner_hidden";
/** The frame shell's offset from the bottom-right corner (drag), per device. */
export const PARTNER_POS_KEY = "lianki_partner_pos";
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
  report: (what: string, detail: string) => void;
  /** The page's host, top-window flag, document and WebSocket (defaults: this page's; tests pass fakes). */
  host?: string;
  top?: boolean;
  doc?: Document;
  WebSocket?: new (url: string, protocols: string[]) => unknown;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
  path?: string;
  /** The frame shell (src/partner-frame.ts); tests pass a fake. */
  frame?: typeof frameShell;
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
  // In the page's own realm, the page could replace eval, WebSocket or any
  // global we touch: no ticket is asked for, nothing is evaluated, and no
  // callback is handed out. Only the note, drawn by this (trusted) code.
  const isolated = isolatedWorld(d.info as Parameters<typeof isolatedWorld>[0]);
  d.report("partner-mode", `${isolated ? "isolated" : "page-realm"} ${host}`);
  const hideHere = () =>
    d.setValue(PARTNER_HIDDEN_KEY, JSON.stringify([...new Set([...hidden, host])]));
  if (!isolated) return pageRealmNote(d.doc ?? document, d.origin, hideHere);
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

  // First the lianki.com frame: typing inside it is private from this page.
  // The handshake decides (not a site list): ready → the frame; blocked (CSP
  // frame-src/child-src, a blocking extension, no answer) → read-only below.
  const lang = embedLang();
  const shell = (d.frame ?? frameShell)({
    doc: d.doc ?? document,
    win: d.win ?? (globalThis as unknown as Window),
    origin: d.origin,
    label: `${host}${d.path ?? location.pathname}`.slice(0, 300),
    ticket: nextTicket,
    gripLabel: EMBED_STRINGS[lang].grip,
    pos: {
      get: () => {
        const p = d.getValue(PARTNER_POS_KEY, null);
        return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
      },
      set: (p) => d.setValue(PARTNER_POS_KEY, { x: Math.round(p.x), y: Math.round(p.y) }),
    },
  });
  const how = await shell.result;
  d.report("partner-frame", `${how} ${host}`);
  if (how === "ready") return () => shell.destroy();
  shell.destroy();

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
      readOnly: true,
      report: d.report,
      hide: () => {
        hideHere();
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

/** Set CSS through the CSSOM (no stylesheet, so no CSP question), each `!important`. */
const styleAll = (el: HTMLElement, css: [string, string][]) => {
  for (const [k, v] of css) el.style.setProperty(k, v, "important");
};

/**
 * The page-realm note, from trusted userscript code only: plain DOM in a
 * closed shadow root on a div, styled through the CSSOM, with nothing secret
 * in it and no callback handed to any code but our own click listener (which
 * only hides it on this site).
 */
export function pageRealmNote(doc: Document, origin: string, hideHere: () => void): () => void {
  const lang = embedLang();
  const t = EMBED_STRINGS[lang];
  const host = doc.createElement("div");
  styleAll(host, [
    ["all", "initial"],
    ["display", "block"],
    ["position", "fixed"],
    ["right", "8px"],
    ["bottom", "8px"],
    ["z-index", "2147483647"],
  ]);
  const root = host.attachShadow({ mode: "closed" });
  const box = doc.createElement("div");
  box.setAttribute("role", "status");
  styleAll(box, [
    ["all", "initial"],
    ["display", "flex"],
    ["gap", "8px"],
    ["align-items", "flex-start"],
    ["max-width", "min(320px, calc(100vw - 16px))"],
    ["padding", "10px 12px"],
    ["border-radius", "12px"],
    ["background", "oklch(0.97 0.01 82 / 0.92)"],
    ["color", "oklch(0.25 0.02 65)"],
    ["border", "1px solid oklch(0.25 0.02 65 / 0.15)"],
    ["font", "13px/18px system-ui, sans-serif"],
  ]);
  const text = doc.createElement("div");
  text.textContent = blockerText("pageRealm", t, EMBED_NAME[lang]);
  const link = doc.createElement("a");
  link.href = origin;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t.openLianki;
  styleAll(link, [
    ["display", "block"],
    ["margin-top", "4px"],
    ["color", "oklch(0.45 0.12 250)"],
    ["text-decoration", "underline"],
  ]);
  text.append(link);
  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", t.hideHere);
  close.title = t.hideHere;
  styleAll(close, [
    ["all", "initial"],
    ["width", "40px"],
    ["height", "40px"],
    ["margin", "-10px -8px -10px 0"],
    ["font", "18px/40px system-ui, sans-serif"],
    ["text-align", "center"],
    ["cursor", "pointer"],
    ["color", "oklch(0.25 0.02 65)"],
  ]);
  const remove = () => host.remove();
  close.addEventListener("click", () => {
    hideHere();
    remove();
  });
  box.append(text, close);
  root.append(box);
  (doc.documentElement ?? doc.body).append(host);
  return remove;
}
