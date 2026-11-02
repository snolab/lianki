/**
 * The Learning Partner's connection on another site (docs/dev-debug-widget.md,
 * "On every site"): DebugEval's chat half, and nothing else. No eval, no
 * pairing, no clips, no page errors: the hub refuses those on a ticket socket
 * anyway, and this never sends them.
 *
 * Each connect asks the userscript for a fresh ticket (60 s, single use,
 * fetched with GM_xmlhttpRequest) and offers it in Sec-WebSocket-Protocol,
 * never in the URL. The ticket lives in this closure only for the moment of
 * the upgrade. Event-driven like DebugEval: it connects while the page is
 * visible, drops the socket after 30 s hidden, reconnects on a close only
 * when the socket had opened and the page is still visible. No timers that
 * touch the network.
 */
import { applyEdit, type ChatMessage, type EditedEvent, type Sender } from "../wire";
import type { Blocker } from "./guard";

export const PARTNER_SUBPROTOCOL = "lianki-partner";
const IDLE_MS = 30_000;
const HISTORY_MAX = 200;
/** Close codes the hub uses on purpose (4xxx): stay closed until the next visibility event. */
const ON_PURPOSE = 4000;

export type PartnerState = {
  live: boolean;
  listeners: number;
  messages: ChatMessage[];
  viewer?: Sender;
  busy: { label: string } | null;
  warning?: string;
  /** Set when this page cannot have the chat (the note shows instead). */
  blocked?: Blocker;
};

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

export type PartnerDeps = {
  /** wss://lianki.com/api/version/debug */
  url: string;
  /** A fresh ticket, or null (not the owner, signed out, tickets off). */
  ticket: () => Promise<string | null>;
  open: (url: string, protocols: string[]) => WsLike;
  /** This page as the agent sees it: host + path (never the query), user agent. */
  label: () => string;
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  /** A CSP violation about us arrived (guard.ts cspBlocker): the socket will not open. */
  onBlocked?: (b: Blocker) => void;
  now?: () => number;
};

export type PartnerClient = {
  get(): PartnerState;
  subscribe(fn: () => void): () => void;
  send(text: string, to?: string): boolean;
  block(b: Blocker): void;
  stop(): void;
};

const trim = (list: ChatMessage[]) =>
  list.length > HISTORY_MAX ? list.slice(list.length - HISTORY_MAX) : list;

export function createPartnerClient(d: PartnerDeps): PartnerClient {
  let state: PartnerState = { live: false, listeners: 0, messages: [], busy: null };
  const subs = new Set<() => void>();
  const set = (p: Partial<PartnerState>) => {
    state = { ...state, ...p };
    for (const f of subs) f();
  };
  let ws: WsLike | null = null;
  let connecting = false;
  let stopped = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let sentLabel = "";

  const visible = () => d.doc.visibilityState === "visible";

  const onMessage = (raw: unknown) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "me" && msg.sender && typeof msg.sender === "object")
      return set({ viewer: msg.sender as Sender });
    if (msg.type === "state")
      return set({ listeners: typeof msg.listeners === "number" ? msg.listeners : 0 });
    if (msg.type === "history" && Array.isArray(msg.messages))
      return set({ messages: trim(msg.messages as ChatMessage[]) });
    if (msg.type === "busy" && typeof msg.label === "string")
      return set({ busy: { label: msg.label } });
    if (msg.type === "chat" && msg.message && typeof msg.message === "object") {
      const m = msg.message as ChatMessage;
      if (typeof m.text !== "string" || typeof m.id !== "string") return;
      if (state.messages.some((x) => x.id === m.id)) return;
      return set({
        messages: trim([...state.messages, m]),
        ...(m.from === "agent" ? { busy: null } : { warning: undefined }),
      });
    }
    if (msg.type === "edited" && typeof msg.id === "string" && typeof msg.text === "string") {
      const e = msg as unknown as EditedEvent;
      return set({ messages: state.messages.map((m) => applyEdit(m, e)) });
    }
    if (msg.type === "rate-limited") return set({ warning: "Too many messages: try again soon." });
    // Everything else (eval, pending, clips, answered) is not for this page.
  };

  const connect = async () => {
    if (ws || connecting || stopped || state.blocked) return;
    connecting = true;
    let ticket: string | null = null;
    try {
      ticket = await d.ticket();
    } catch {}
    connecting = false;
    if (!ticket || stopped || ws || !visible() || state.blocked) return;
    const label = d.label();
    sentLabel = label;
    let sock: WsLike;
    try {
      sock = d.open(`${d.url}?label=${encodeURIComponent(label)}`, [PARTNER_SUBPROTOCOL, ticket]);
    } catch {
      // A synchronous throw is CSP refusing the URL (or a bad URL): not again.
      return block("connect");
    }
    ticket = null;
    ws = sock;
    let opened = false;
    sock.onopen = () => {
      opened = true;
      set({ live: true });
    };
    sock.onmessage = (e) => onMessage(e.data);
    sock.onerror = () => {};
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      set({ live: false, busy: null });
      if (opened && e.code < ON_PURPOSE && visible()) void connect();
    };
  };

  const disconnect = () => {
    clearTimeout(idle);
    const s = ws;
    ws = null;
    set({ live: false, busy: null });
    try {
      s?.close(1000);
    } catch {}
  };

  const update = () => {
    clearTimeout(idle);
    if (visible()) void connect();
    else if (ws) idle = setTimeout(disconnect, IDLE_MS);
  };

  const block = (b: Blocker) => {
    if (state.blocked) return;
    disconnect();
    set({ blocked: b });
    d.onBlocked?.(b);
  };

  d.doc.addEventListener("visibilitychange", update);
  update();

  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    send(text, to) {
      const s = ws;
      if (!s || s.readyState !== 1) return false;
      try {
        // The page moved (an SPA): say where it is now, before the line.
        const label = d.label();
        if (label !== sentLabel) {
          s.send(JSON.stringify({ type: "page", label }));
          sentLabel = label;
        }
        const id = crypto.randomUUID().slice(0, 12);
        s.send(JSON.stringify({ type: "chat", id, text, ...(to ? { to } : {}) }));
        return true;
      } catch {
        return false;
      }
    },
    block,
    stop() {
      stopped = true;
      d.doc.removeEventListener("visibilitychange", update);
      disconnect();
      subs.clear();
    },
  };
}

/**
 * The page as the agent sees it: the host and path, never the query or the
 * fragment (they can hold tokens), then the user agent. Bounded.
 */
export function pageLabel(loc: { host: string; pathname: string }, ua: string): string {
  return `${loc.host}${loc.pathname} ${ua}`.slice(0, 300);
}
