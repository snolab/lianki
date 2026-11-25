/**
 * Li chat from the userscript pill (docs/userscript-li-chat.md): the gate,
 * then the frame. Behind the `ext.pill-chat` flag (lib/flags.ts), which
 * lianki.com reports per account (GET /api/ext/pill-chat); the userscript
 * keeps the last answer in its own storage, read on other sites.
 *
 * Order, and what may happen before each step:
 * 1. Entry: the pill shows "Li" only with the flag on for this account, in
 *    the top window, in an isolated world, and not on a "never" site. In the
 *    page's realm the entry only explains (nothing fetched).
 * 2. Tap (a trusted one): unless this host is allowed, the trust prompt.
 *    Dismiss = deny. **No network call to lianki.com for chat before allow.**
 * 3. Allowed: lianki.com is asked whether the flag is still on (the kill
 *    switch), then the lianki.com frame opens (src/partner-frame.ts): a
 *    cross-origin iframe in a closed shadow root, strict-origin handshake,
 *    a MessagePort after it. The ticket is fetched with GM_xmlhttpRequest
 *    and written only into that port.
 * 4. If the frame is navigated away (the page can reach `window.frames`), it
 *    is torn down: a second `load` means it is no longer our lianki.com page.
 *
 * The owner opens it with his partner ticket (`/api/debug/partner-ticket`,
 * his own thread); any other signed-in account, once `ext.pill-chat-users` is
 * on, with its own Li chat ticket (`/api/chat/li-ticket`, M2: that account's
 * thread only). lianki.com says which, in the answer to the kill-switch check.
 */
import { isolatedWorld } from "../packages/debug-chat/src/embed/guard";
import { EMBED_STRINGS, embedLang } from "../packages/debug-chat/src/ui-strings";
import { readShare } from "../packages/debug-chat/src/embed/share";
import { frameShell } from "./partner-frame";
import { PARTNER_POS_KEY, pageRealmNote } from "./partner";
import { pillChatStrings, type PillChatStrings } from "./pill-chat-strings";
import {
  PILLCHAT_ON_KEY,
  allowedHere,
  applyChoice,
  flagMirrorOn,
  flagRecheckDue,
  pillEntry,
  siteKey,
  trustStore,
  type TrustChoice,
} from "./pill-chat-trust";
import { blockedNote, sitesDialog, trustDialog } from "./pill-chat-ui";

/** lib/li-thread.ts HOST_ORIGIN_HEADER (unit/li-thread.test.ts keeps the two the same). */
export const HOST_ORIGIN_HEADER = "x-lianki-host-origin";

type GmFetch = (
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; credentials?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export type PillChatDeps = {
  origin: string;
  gmFetch: GmFetch;
  getValue: (k: string, d?: any) => any;
  setValue: (k: string, v: any) => void;
  /** GM_info: where the manager runs us (guard.ts isolatedWorld). */
  info: unknown;
  report?: (what: string, detail: string) => void;
  /** The top window's hostname, top-window flag, document, window (tests pass fakes). */
  hostname?: string;
  /** The top window's origin (tests pass one). */
  hostOrigin?: string;
  path?: string;
  /** The page's full address, read only when he presses Share in the frame (tests pass one). */
  href?: () => string;
  top?: boolean;
  doc?: Document;
  win?: Window;
  strings?: PillChatStrings;
  /** The frame shell and the prompt (tests pass fakes). */
  frame?: typeof frameShell;
  prompt?: (host: string) => Promise<TrustChoice>;
  now?: () => number;
};

export type OpenResult =
  | "hidden"
  | "note"
  | "closed"
  | "denied"
  | "never"
  | "off"
  | "ready"
  | "blocked"
  | "busy";

/** On lianki.com: ask for this account's flag (at most once a minute) and keep the answer. */
export async function mirrorPillChatFlag(
  d: Pick<PillChatDeps, "origin" | "gmFetch" | "getValue" | "setValue" | "now">,
): Promise<boolean | null> {
  const now = d.now?.() ?? Date.now();
  if (!flagRecheckDue(d.getValue(PILLCHAT_ON_KEY, null), now)) return null;
  const on = await askFlag(d);
  d.setValue(PILLCHAT_ON_KEY, JSON.stringify({ on, at: now }));
  return on;
}

async function askFlag(d: Pick<PillChatDeps, "origin" | "gmFetch">): Promise<boolean> {
  return (await askAccess(d)) !== null;
}

/**
 * Which ticket lianki.com says this account opens Li with (lib/pill-chat-route.ts):
 * the owner's partner ticket, or the account's own; null = off. An answer
 * without a known kind is the owner's (a server from before M2).
 */
async function askAccess(d: Pick<PillChatDeps, "origin" | "gmFetch">): Promise<TicketKind | null> {
  try {
    const r = await d.gmFetch(`${d.origin}/api/ext/pill-chat`, { credentials: "include" });
    if (!r.ok) return null;
    const body = await r.json();
    if (body?.on !== true) return null;
    return body.ticket === "account" ? "account" : "owner";
  } catch {
    return null;
  }
}

type TicketKind = "owner" | "account";

/**
 * Where each kind of ticket is minted: the owner's partner ticket (his own
 * thread), or the account-scoped Li chat ticket (M2: that account's own thread).
 */
export const TICKET_PATHS: Record<TicketKind, string> = {
  owner: "/api/debug/partner-ticket",
  account: "/api/chat/li-ticket",
};

export function pillChat(d: PillChatDeps) {
  const doc = d.doc ?? document;
  const win = d.win ?? (globalThis as unknown as Window);
  const host = siteKey(d.hostname ?? location.hostname);
  const top = d.top ?? window.self === window.top;
  const strings = d.strings ?? pillChatStrings();
  const store = trustStore(d);
  const once = new Set<string>();
  const isolated = isolatedWorld(d.info as Parameters<typeof isolatedWorld>[0]);
  const report = d.report ?? (() => {});
  let open: { destroy(): void } | null = null;
  let busy = false;
  let note: (() => void) | null = null;

  const entry = () =>
    pillEntry({
      flagOn: flagMirrorOn(d.getValue(PILLCHAT_ON_KEY, null)),
      top,
      isolated,
      decision: host ? store.decision(host) : null,
      host,
    });

  const prompt = d.prompt ?? ((h: string) => trustDialog({ doc, win, strings, host: h }).result);

  /** Which ticket this account opens Li with, as lianki.com said right before the frame opened. */
  let kind: TicketKind = "owner";
  const ticket = async (): Promise<string | null> => {
    try {
      const r = await d.gmFetch(`${d.origin}${TICKET_PATHS[kind]}`, {
        method: "POST",
        // The top window's origin (scheme, host, port: never the path or query),
        // read here in the userscript's world: with ext.pill-chat-per-origin on,
        // lianki.com binds the ticket to this site's own thread (lib/li-thread.ts).
        headers: {
          "x-lianki-userscript": "1",
          [HOST_ORIGIN_HEADER]: d.hostOrigin ?? location.origin,
        },
        credentials: "include",
      });
      if (!r.ok) return null;
      const body = await r.json();
      return typeof body?.ticket === "string" ? body.ticket : null;
    } catch {
      return null;
    }
  };

  const close = () => {
    open?.destroy();
    open = null;
    note?.();
    note = null;
  };

  /** The pill's Li tap. Only call it from a trusted user event. */
  async function openChat(): Promise<OpenResult> {
    const e = entry();
    if (e === "hidden" || !host) return "hidden";
    if (e === "note") {
      note?.();
      note = pageRealmNote(doc, d.origin, () => store.set(host, "never"));
      return "note";
    }
    if (open) {
      close();
      return "closed";
    }
    if (busy) return "busy";
    busy = true;
    try {
      if (!allowedHere(store, once, host)) {
        const choice = await prompt(host);
        if (!applyChoice(store, once, host, choice)) return choice === "never" ? "never" : "denied";
      }
      // Allowed: from here on lianki.com may be asked. The flag first (kill switch).
      const access = await askAccess(d);
      if (!access) {
        d.setValue(PILLCHAT_ON_KEY, JSON.stringify({ on: false, at: d.now?.() ?? Date.now() }));
        return "off";
      }
      kind = access;
      const shell = (d.frame ?? frameShell)({
        doc,
        win,
        origin: d.origin,
        // Host + path for the agent, never the query or hash.
        label: `${host}${d.path ?? location.pathname}`.slice(0, 300),
        ticket,
        // Read only now, on his Share press in the frame (M3): link without query or hash.
        share: (what) =>
          readShare(what, {
            href: d.href ? d.href() : location.href,
            title: doc.title,
            selection: doc.getSelection?.()?.toString() ?? "",
          }),
        gripLabel: EMBED_STRINGS[embedLang()].grip,
        pos: {
          get: () => {
            const p = d.getValue(PARTNER_POS_KEY, null);
            return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
          },
          set: (p) => d.setValue(PARTNER_POS_KEY, { x: Math.round(p.x), y: Math.round(p.y) }),
        },
      });
      // A second load means the page navigated our iframe (it learns the
      // frame's WindowProxy from the frame's "up" message): whatever loaded
      // is not ours, so it goes.
      let loads = 0;
      shell.iframe.addEventListener("load", () => {
        if (++loads > 1) {
          report("pill-chat-navigated", host);
          if (open === shell) close();
          else shell.destroy();
        }
      });
      open = shell;
      const how = await shell.result;
      report("pill-chat-frame", `${how} ${host}`);
      if (how === "ready" && open === shell) return "ready";
      if (open === shell) open = null;
      shell.destroy();
      note?.();
      note = blockedNote({ doc, win, strings, origin: d.origin });
      return "blocked";
    } finally {
      busy = false;
    }
  }

  /** The sites list (the userscript menu's "Li chat: sites…"): forget a decision. */
  function manage(onChange?: (host: string) => void) {
    return sitesDialog({ doc, win, strings, store, onChange });
  }

  return {
    entry,
    open: openChat,
    close,
    manage,
    strings,
    isOpen: () => !!open,
    /** The flag, as lianki.com last said for this account (the menu item shows only then). */
    flagOn: () => top && flagMirrorOn(d.getValue(PILLCHAT_ON_KEY, null)),
  };
}
