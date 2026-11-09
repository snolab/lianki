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
 * The first slice reuses the owner's partner ticket (`/api/debug/partner-ticket`,
 * owner only); an account-scoped ticket for users is the next milestone.
 */
import { isolatedWorld } from "../packages/debug-chat/src/embed/guard";
import { EMBED_STRINGS, embedLang } from "../packages/debug-chat/src/ui-strings";
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
  path?: string;
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
  try {
    const r = await d.gmFetch(`${d.origin}/api/ext/pill-chat`, { credentials: "include" });
    if (!r.ok) return false;
    const body = await r.json();
    return body?.on === true;
  } catch {
    return false;
  }
}

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
      if (!(await askFlag(d))) {
        d.setValue(PILLCHAT_ON_KEY, JSON.stringify({ on: false, at: d.now?.() ?? Date.now() }));
        return "off";
      }
      const shell = (d.frame ?? frameShell)({
        doc,
        win,
        origin: d.origin,
        // Host + path for the agent, never the query or hash.
        label: `${host}${d.path ?? location.pathname}`.slice(0, 300),
        ticket,
        gripLabel: EMBED_STRINGS[embedLang()].grip,
        pos: {
          get: () => {
            const p = d.getValue(PARTNER_POS_KEY, null);
            return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
          },
          set: (p) => d.setValue(PARTNER_POS_KEY, { x: Math.round(p.x), y: Math.round(p.y) }),
        },
      });
      // A second load means the page navigated our iframe (it can reach
      // window.frames): whatever loaded is not ours, so it goes.
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
