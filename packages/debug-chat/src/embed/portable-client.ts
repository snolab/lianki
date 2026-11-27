/**
 * 随身Li's connection (portable Li: chatting with Li on any website through
 * the userscript; docs/userscript-li-chat.md, "Portable Li: the panel"). It
 * drives the same DebugChat the main site shows, but only over the userscript's
 * chat-only broker: `call` is the userscript's GM_xmlhttpRequest client
 * (src/page-chat-http-client.ts), which knows two operations, read and send.
 * Nothing here can address a node, attach page content, eval, pair or reach
 * any other route; such an attempt is refused locally and turns into the hint
 * that the advanced action belongs on lianki.com.
 *
 * Event-driven: one long-poll read runs while the page is visible; it starts
 * again on the next visibility change or send after a failure. No timers.
 */
import type { ChatMessage, ChatReplayRange } from "../wire";
import { uuidv4 } from "../uuid";

/** The broker's operations (lib/page-chat-http-wire.ts PageChatHttpAction), structurally. */
export type PortableInput =
  | { op: "read"; afterSeq?: number; wait: boolean }
  | { op: "send"; id: string; text: string };
/** The broker's answers (lib/page-chat-http-wire.ts PageChatHttpResult), structurally. */
export type PortableResult =
  | { ok: false; error: string }
  | { ok: true; kind: "hello"; principal: string }
  | { ok: true; kind: "accepted"; id: string; seq: number }
  | { ok: true; kind: "history"; range: ChatReplayRange; pending?: string; warning?: string };
export type PortableCall = (
  input: PortableInput,
  principal?: string,
  signal?: AbortSignal,
) => Promise<PortableResult>;

export type PortableOutgoing = { id: string; text: string; rejected?: string };
export type PortableState = {
  live: boolean;
  messages: ChatMessage[];
  outgoing: PortableOutgoing[];
  busy: { label: string } | null;
  /** "failed": the connection or a send failed. "advanced": he tried what only lianki.com does. */
  problem?: "failed" | "advanced";
};

export type PortableClientDeps = {
  call: PortableCall;
  principal: string;
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  /** The spinner's label while Li is replying. */
  busyLabel: string;
  /** The reason on a line that could not be sent. */
  failedLabel: string;
  /** Close the connection; only account-changed proves the stored consent belongs to another account. */
  onInvalidAccount: (reason?: string) => void;
};

export type PortableClient = {
  get(): PortableState;
  subscribe(fn: () => void): () => void;
  /** DebugChat's onSend: false keeps the draft (refused or not sendable). */
  send(text: string, to?: string, opts?: { context?: unknown; attachments?: unknown }): boolean;
  stop(): void;
};

/** Most lines kept, as the old panel did. */
export const PORTABLE_HISTORY_MAX = 200;
const INVALID = new Set(["account-changed", "signed-out", "off"]);

/** Merge one history range into the kept lines (pruned, removed, bounded, ordered). */
export function mergeRange(kept: ChatMessage[], r: ChatReplayRange): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of kept) if ((m.seq ?? 0) > r.prunedThroughSeq || m.seq === undefined) byId.set(m.id, m);
  for (const m of r.messages) byId.set(m.id, m);
  for (const m of r.removed) byId.delete(m.id);
  const all = [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return all.length > PORTABLE_HISTORY_MAX ? all.slice(all.length - PORTABLE_HISTORY_MAX) : all;
}

/** A send DebugChat offers that the chat-only broker must not carry. */
export function isAdvanced(to?: string, opts?: { context?: unknown; attachments?: unknown }): boolean {
  return !!to || opts?.context != null || (Array.isArray(opts?.attachments) && opts.attachments.length > 0);
}

export function createPortableClient(d: PortableClientDeps): PortableClient {
  let state: PortableState = { live: false, messages: [], outgoing: [], busy: null };
  const subs = new Set<() => void>();
  const set = (p: Partial<PortableState>) => {
    state = { ...state, ...p };
    for (const f of subs) f();
  };
  let stopped = false;
  let controller: AbortController | undefined;
  let afterSeq: number | undefined;
  let awaitingSeq: number | undefined;

  const invalid = (error: string) => {
    if (!INVALID.has(error)) return false;
    stop();
    d.onInvalidAccount(error);
    return true;
  };

  const read = async (signal: AbortSignal) => {
    while (!signal.aborted && !stopped && d.doc.visibilityState !== "hidden") {
      let r: PortableResult;
      try {
        r = await d.call(
          { op: "read", ...(afterSeq === undefined ? {} : { afterSeq }), wait: afterSeq !== undefined },
          d.principal,
          signal,
        );
      } catch {
        if (!signal.aborted) set({ live: false, busy: null, problem: "failed" });
        return;
      }
      if (signal.aborted || stopped) return;
      if (!r.ok) {
        if (r.error === "cancelled" || invalid(r.error)) return;
        set({ live: false, busy: null, problem: "failed" });
        return;
      }
      if (r.kind !== "history") {
        set({ live: false, busy: null, problem: "failed" });
        return;
      }
      afterSeq = r.range.throughSeq;
      const messages = mergeRange(state.messages, r.range);
      if (awaitingSeq !== undefined && messages.some((m) => m.from === "agent" && (m.seq ?? 0) > awaitingSeq!))
        awaitingSeq = undefined;
      // Li was asked and the hub has stopped working on it without a reply.
      const lost = awaitingSeq !== undefined && !r.pending;
      if (lost) awaitingSeq = undefined;
      set({
        live: true,
        messages,
        busy: r.pending ? { label: d.busyLabel } : null,
        problem: lost ? "failed" : state.problem === "failed" ? undefined : state.problem,
      });
    }
  };

  const start = () => {
    if (stopped || controller || d.doc.visibilityState === "hidden") return;
    const c = new AbortController();
    controller = c;
    void read(c.signal).finally(() => {
      if (controller === c) controller = undefined;
    });
  };
  const stop = () => {
    controller?.abort();
    controller = undefined;
  };
  const visible = () => {
    if (d.doc.visibilityState === "hidden") {
      stop();
      set({ live: false });
    } else start();
  };
  d.doc.addEventListener("visibilitychange", visible);
  start();

  /** Sends in flight: stop() aborts each (the GM request is cancelled, nothing lands after). */
  const sending = new Set<AbortController>();
  const deliver = async (line: PortableOutgoing) => {
    const ac = new AbortController();
    sending.add(ac);
    let r: PortableResult;
    try {
      r = await d.call({ op: "send", id: line.id, text: line.text }, d.principal, ac.signal);
    } catch {
      r = { ok: false, error: ac.signal.aborted ? "cancelled" : "unavailable" };
    } finally {
      sending.delete(ac);
    }
    if (stopped || ac.signal.aborted) return;
    if (!r.ok && r.error === "cancelled") {
      // Cancelled, not failed: the row goes, nothing is left pending.
      set({ outgoing: state.outgoing.filter((o) => o.id !== line.id) });
      return;
    }
    if (r.ok && r.kind === "accepted") {
      const mine: ChatMessage = { id: line.id, from: "owner", label: "", text: line.text, at: Date.now(), seq: r.seq };
      awaitingSeq = state.messages.some((m) => m.from === "agent" && (m.seq ?? 0) > r.seq) ? undefined : r.seq;
      set({
        outgoing: state.outgoing.filter((o) => o.id !== line.id),
        messages: state.messages.some((m) => m.id === line.id) ? state.messages : [...state.messages, mine],
        ...(awaitingSeq !== undefined ? { busy: { label: d.busyLabel } } : {}),
        problem: undefined,
      });
      // A parked long read already wakes on acceptance; start one only if none runs.
      start();
      return;
    }
    if (!r.ok && invalid(r.error)) return;
    set({
      outgoing: state.outgoing.map((o) => (o.id === line.id ? { ...o, rejected: d.failedLabel } : o)),
      problem: "failed",
    });
  };

  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    send(text, to, opts) {
      if (stopped) return false;
      if (isAdvanced(to, opts)) {
        set({ problem: "advanced" });
        return false;
      }
      const clean = text.trim();
      if (!clean) return false;
      // Broker ids are [A-Za-z0-9_-]{8,64}.
      const line = { id: uuidv4().replace(/-/g, "_"), text: clean };
      set({ outgoing: [...state.outgoing.filter((o) => !o.rejected), line], problem: undefined });
      void deliver(line);
      start();
      return true;
    },
    stop() {
      stopped = true;
      stop();
      for (const ac of sending) ac.abort();
      sending.clear();
      d.doc.removeEventListener("visibilitychange", visible);
      subs.clear();
    },
  };
}
