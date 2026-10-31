"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  type ChatMessage,
  type Heartbeat,
  type EditedEvent,
  type HubState,
  applyEdit,
  type PairInfo,
  type Sender,
  chunkMessages,
  compile,
  summarize,
  trimHistory,
  busyLeft,
} from "@/lib/dev-eval";
import { DEBUG_EVENT, debugOn, devLog } from "@/lib/debug-client";
import { isKey } from "@lianki/debug-chat/storage-keys";
import { type ChatStrings, type VoiceTiming, cleanTiming } from "@lianki/debug-chat/wire";
import { voiceLatency } from "@lianki/debug-chat/latency";
import { liveTreeSource, progressSocketUrl } from "@/lib/progress-tree";
import { TABS_CHANNEL, joinTabs } from "@lianki/debug-chat/debug-chat-tabs";
import { speakReply } from "@lianki/debug-chat/DebugChat";
import { voice } from "@lianki/debug-chat/voice";
import { DebugChatHost } from "@lianki/debug-chat/DebugChatHost";
import { DebugPairModal } from "@lianki/debug-chat/DebugPairModal";
import {
  type PageErrorReporter,
  createPageErrorReporter,
  installPageErrorHooks,
  typedText,
} from "@lianki/debug-chat/page-errors";
import { grantUntil } from "@/lib/islands/rules";
import { islandStore } from "@/lib/islands/store";
import { useIslands } from "@/lib/islands/useIslands";

/** Hidden this long before the socket is dropped. */
const IDLE_MS = 30_000;
const TOAST_MS = 4_000;
/** Route changes settle this long before the socket's label is updated. */
const RELABEL_MS = 300;
/** The agent's avatar in the chat log: Lianki's own logo (public/icon-192.png). */
const AGENT_AVATAR = "/icon-192.png";
/** sessionStorage: this tab's page id (docs/monitoring.md, "Remote eval"). */
const TAB_KEY = "lk:debug-tab";
/** The build the page runs, on each page-error ("dev" under next dev). */
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
/** The chat lines cut out of page errors: the latest this many. */
const SENSITIVE_LINES = 50;

/** This page as the hub and the agent see it: path, `pwa` when installed, user agent. */
const pageLabel = () => {
  const standalone = matchMedia?.("(display-mode: standalone)").matches ? "pwa " : "";
  return `${location.pathname} ${standalone}${navigator.userAgent}`;
};

/**
 * Remote eval and the agent chat for a debug session (docs/monitoring.md,
 * "Remote eval (owner debug)" and "Friends"). Only while this device is in
 * debug mode (`lk:debug`) and the page is visible, it holds a WebSocket to
 * lianki-push's /api/version/debug, which accepts any signed-in user: the
 * owner gets the owner's thread and pairings, anyone else (a friend) their
 * own thread and only pairings made for them — shown as a "Preview" request.
 *
 * A sender (scripts/dev/eval.ts) asking to pair shows up here as a prompt with
 * its label and a short code it prints too; nothing runs unless the owner
 * allows it — for 8 hours at most (resumable with its token, so it is not
 * asked again in that time), or an hour for a friend's preview — and "End"
 * revokes it. Code it sends arrives
 * as {id, code, to}; it is run here, and the result (or error) goes back over
 * the socket to the sender and to /api/dev/log (Worker logs).
 *
 * The same socket carries the owner ⇄ agent chat (DebugChat): the history on
 * connect, then each new message; agent replies that arrive live are read
 * aloud. "Allow chat for 30 days" approves a sender for chat only.
 *
 * A page not in debug mode never opens the socket. Each run shows a toast, and
 * a badge is up while a session is approved, so it is never silent.
 * Reconnects only on events (the socket closing while still visible, coming
 * back to the page, debug turned on) — no timers that touch the network.
 */
/** The chat's user-facing strings, localized by the root layout (learning-partner.content.ts). */
export type PartnerStrings = ChatStrings & { unavailable: string };

export function DebugEval({ strings }: { strings?: Partial<PartnerStrings> } = {}) {
  const [live, setLive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [state, setState] = useState<HubState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** The chat box stays up across reconnects, until debug mode is turned off. */
  const [chat, setChat] = useState(false);
  /** null on the owner's pages; a friend's chat status otherwise. */
  const [friend, setFriend] = useState<"open" | "blocked" | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  /** Who this page's user is, from the hub on connect: their own lines' avatar. */
  const [viewer, setViewer] = useState<Sender | undefined>(undefined);
  const sockRef = useRef<WebSocket | null>(null);
  const friendRef = useRef(false);
  /** The chat's lines, for page-errors to cut out (never sent with an error). */
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  /** The owner's page (a state arrived with no friend-status first): may hot-load the widget. */
  const [owner, setOwner] = useState(false);
  /** The agent's heartbeat (docs/monitoring.md, "Agent is working"). */
  const [busy, setBusy] = useState<{ label: string } | null>(null);
  const beatRef = useRef<(Heartbeat & { label: string }) | null>(null);
  /** Hub time of the newest agent reply: a beat older than it is stale. */
  const agentAtRef = useRef(0);
  const liveRef = useRef(false);
  const beatTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** One local timeout re-checks the spinner when it would lapse; no network. */
  const reBeat = () => {
    clearTimeout(beatTimer.current);
    const b = beatRef.current;
    const left = busyLeft(liveRef.current, b, agentAtRef.current, Date.now());
    setBusy(left > 0 && b ? { label: b.label } : null);
    if (left > 0) beatTimer.current = setTimeout(reBeat, left + 50);
  };
  /** The label the socket was last told (on connect, or by {type:"page"}). */
  const sentLabel = useRef("");
  const pathname = usePathname();
  const router = useRouter();
  // Hot islands (docs/dev-hot-islands.md): on only with the code-run grant below.
  useIslands();
  /** This device's tabs agree on one to read replies aloud (BroadcastChannel). */
  const tabsRef = useRef<ReturnType<typeof joinTabs> | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const join = () => {
      tabsRef.current = joinTabs(
        crypto.randomUUID(),
        new BroadcastChannel(TABS_CHANNEL),
        () => document.visibilityState === "visible" && document.hasFocus(),
      );
      tabsRef.current.mic(voice().state().mic);
    };
    const leave = () => {
      tabsRef.current?.leave();
      tabsRef.current = null;
    };
    const focus = () => {
      if (document.visibilityState === "visible") tabsRef.current?.focus();
    };
    const show = (e: PageTransitionEvent) => e.persisted && !tabsRef.current && join();
    join();
    // Voice diagnostics (output route, echo-guard drops, AEC settings) go to /api/dev/log.
    voice().setLog((ev) => devLog(ev));
    // A tab with the mic on reads replies aloud (hands-free), whichever is focused.
    const unsub = voice().subscribe((s) => tabsRef.current?.mic(s.mic));
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", show);
      unsub();
      leave();
    };
  }, []);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    let ws: WebSocket | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let hideToast: ReturnType<typeof setTimeout> | undefined;
    const opened = new WeakSet<WebSocket>();
    // Page errors (docs/dev-debug-widget.md, "Page errors"): hooked while the
    // socket is wanted, queued until the hub says this is the owner's page,
    // dropped for good on a friend's.
    const newReporter = () =>
      createPageErrorReporter({
        rev: BUILD_ID,
        pagePath: () => location.pathname,
        sensitive: () => [
          ...typedText(document),
          ...messagesRef.current.slice(-SENSITIVE_LINES).map((m) => m.text),
        ],
      });
    let reporter: PageErrorReporter = newReporter();
    let unhook: (() => void) | null = null;
    const unhookErrors = () => {
      unhook?.();
      unhook = null;
    };

    const run = async (sock: WebSocket, id: string, to: string, code: string) => {
      clearTimeout(hideToast);
      setToast(`eval ran · ${id}`);
      hideToast = setTimeout(() => setToast(null), TOAST_MS);
      const t0 = performance.now();
      let result: Record<string, unknown>;
      try {
        // `$lk.send(data)` streams a piece too big for the result (a screenshot)
        // back ahead of it, in chunks (scripts/dev/shot.ts).
        let part = 0;
        const value = await compile(code)({
          send(data) {
            const n = part++;
            for (const m of chunkMessages(id, to, n, String(data))) sock.send(JSON.stringify(m));
            return n;
          },
        });
        result = { ok: true, ms: Math.round(performance.now() - t0), value: summarize(value) };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        result = {
          ok: false,
          error: `${err.name}: ${err.message}`.slice(0, 1000),
          stack: (err.stack ?? "").slice(0, 2000),
        };
      }
      if (!friendRef.current) devLog({ ev: "eval-result", id, ...result });
      try {
        sock.send(JSON.stringify({ type: "result", id, to, ...result }));
      } catch {}
    };

    const connect = () => {
      if (ws) return;
      if (!unhook && !friendRef.current) unhook = installPageErrorHooks(window, reporter);
      const label = pageLabel();
      sentLabel.current = label;
      // This tab's id, kept across reloads, so a "this page" grant survives one.
      let tab = "";
      try {
        tab = sessionStorage.getItem(TAB_KEY) ?? "";
        if (!tab) sessionStorage.setItem(TAB_KEY, (tab = crypto.randomUUID().slice(0, 12)));
      } catch {}
      const sock = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/debug?label=${encodeURIComponent(label)}${tab ? `&tab=${tab}` : ""}`,
      );
      ws = sock;
      sockRef.current = sock;
      sock.onopen = () => {
        opened.add(sock);
        liveRef.current = true;
        setLive(true);
        setChat(true);
        if (!friendRef.current) devLog({ ev: "eval-socket", label });
      };
      sock.onmessage = (e) => {
        let msg: {
          type?: unknown;
          id?: unknown;
          to?: unknown;
          code?: unknown;
          messages?: unknown;
          message?: unknown;
          status?: unknown;
          retryIn?: unknown;
          sender?: unknown;
        };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (msg.type === "friend-status") {
          friendRef.current = true;
          // Never a friend's errors: nothing queued is sent, nothing more is kept.
          reporter.disable();
          unhookErrors();
          setFriend(msg.status === "blocked" ? "blocked" : "open");
          if (msg.status === "blocked") setChat(true);
          return;
        }
        if (msg.type === "me") {
          if (msg.sender && typeof msg.sender === "object") setViewer(msg.sender as Sender);
          return;
        }
        if (msg.type === "page-ended") {
          setWarning("Ended from another page. It reconnects when you come back to this page.");
          return;
        }
        if (msg.type === "rate-limited") {
          const min = Math.max(1, Math.ceil(Number(msg.retryIn) / 60_000) || 1);
          setWarning(`Too many messages: that one was not sent. Try again in ${min} min.`);
          return;
        }
        if (msg.type === "state") {
          setState(msg as HubState);
          // Friends hear friend-status before any state: no status yet = the owner.
          if (!friendRef.current) {
            setOwner(true);
            reporter.attach((m) => {
              if (sock.readyState !== WebSocket.OPEN) throw new Error("socket closed");
              sock.send(JSON.stringify(m));
            });
            // Hot islands follow the owner's code-run grant for this page.
            islandStore.setGrant(grantUntil(msg as HubState, Date.now()));
          }
          return;
        }
        if (msg.type === "busy") {
          const m = msg as { at?: unknown; label?: unknown };
          if (typeof m.at !== "number") return;
          beatRef.current = {
            beatAt: m.at,
            seenAt: Date.now(),
            label: typeof m.label === "string" ? m.label : "agent",
          };
          voiceLatency().ack();
          reBeat();
          return;
        }
        if (msg.type === "wake") {
          // The agent sets the mic's wake-word mode (docs/wake-word.md); the
          // page-wide mic session (packages/debug-chat mic-session.ts) applies it.
          const mode = (msg as { mode?: unknown }).mode;
          const mic = (globalThis as { __lkMic?: { wake?: (m: string) => void } }).__lkMic;
          if (mode === "active" || mode === "passive" || mode === "ignored") mic?.wake?.(mode);
          return;
        }
        if (msg.type === "history" && Array.isArray(msg.messages)) {
          const list = trimHistory(msg.messages as ChatMessage[]);
          for (const m of list)
            if (m.from === "agent") agentAtRef.current = Math.max(agentAtRef.current, m.at);
          setMessages(list);
          reBeat();
          return;
        }
        if (msg.type === "chat" && msg.message && typeof msg.message === "object") {
          const m = msg.message as ChatMessage;
          if (typeof m.text !== "string" || typeof m.id !== "string") return;
          setMessages((list) =>
            list.some((x) => x.id === m.id) ? list : trimHistory([...list, m]),
          );
          // Live replies only: history loaded on connect is never read out.
          if (m.from === "agent") {
            agentAtRef.current = Math.max(agentAtRef.current, Number(m.at) || 0);
            reBeat();
            // Every tab shows it; only one reads it aloud. speakReply queues it
            // (voice.ts): always read while the mic is on, else by the focus rule.
            // Never on a hidden page, never a quiet line, and not in quiet hours
            // unless it is loud (quiet-hours.ts): the line itself is the meta.
            const spoken = (tabsRef.current?.isSpeaker() ?? true) && speakReply(m.text, m);
            voiceLatency().heard(m, spoken === true);
          } else {
            setWarning(null);
            voiceLatency().heard(m);
          }
          return;
        }
        if (msg.type === "edited") {
          // The agent polished a voice line: it changes in place, and is never read aloud again.
          const e = msg as unknown as EditedEvent;
          if (typeof e.id !== "string" || typeof e.text !== "string") return;
          setMessages((list) => list.map((m) => applyEdit(m, e)));
          return;
        }
        if (msg.type !== "eval") return;
        if (typeof msg.id !== "string" || typeof msg.to !== "string") return;
        if (typeof msg.code !== "string" || !debugOn()) return;
        void run(sock, msg.id, msg.to, msg.code);
      };
      // Dropped by the network: reopen on that event if still wanted. One
      // that never opened was refused (a guest, or no push service here), and
      // one the hub closed on purpose (4xxx: blocked) stays closed: leave it
      // until the next visibility or debug event.
      sock.onclose = (e) => {
        if (ws !== sock) return;
        ws = null;
        reporter.detach();
        sockRef.current = null;
        liveRef.current = false;
        beatRef.current = null;
        reBeat();
        setLive(false);
        setState(null);
        if (opened.has(sock) && e.code < 4000 && wanted()) connect();
      };
    };
    const disconnect = () => {
      clearTimeout(idle);
      reporter.detach();
      if (!debugOn()) {
        islandStore.setGrant(null);
        setChat(false);
        setFriend(null);
        setOwner(false);
        friendRef.current = false;
        // Debug mode off: no hooks, and a fresh reporter for next time.
        unhookErrors();
        reporter.disable();
        reporter = newReporter();
      }
      const sock = ws;
      ws = null;
      sockRef.current = null;
      liveRef.current = false;
      beatRef.current = null;
      reBeat();
      setLive(false);
      setState(null);
      sock?.close();
    };
    const wanted = () => document.visibilityState === "visible" && debugOn();
    const update = () => {
      clearTimeout(idle);
      if (wanted()) connect();
      else if (!debugOn()) disconnect();
      else if (ws) idle = setTimeout(disconnect, IDLE_MS);
    };
    const onStorage = (e: StorageEvent) => {
      if (isKey(e.key, "lk:debug")) update();
    };

    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener(DEBUG_EVENT, update);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener(DEBUG_EVENT, update);
      window.removeEventListener("storage", onStorage);
      clearTimeout(hideToast);
      clearTimeout(beatTimer.current);
      disconnect();
      unhookErrors();
    };
  }, []);

  // The socket lives in the root layout, so it outlives client-side
  // navigation: tell the hub the new path (silently — the agent's side only),
  // once the route has settled. popstate/hashchange cover what usePathname misses.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const sock = sockRef.current;
        const label = pageLabel();
        if (!sock || sock.readyState !== WebSocket.OPEN || label === sentLabel.current) return;
        try {
          sock.send(JSON.stringify({ type: "page", label }));
          sentLabel.current = label;
        } catch {}
      }, RELABEL_MS);
    };
    check();
    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    return () => {
      clearTimeout(t);
      window.removeEventListener("popstate", check);
      window.removeEventListener("hashchange", check);
    };
  }, [pathname]);

  /**
   * Answer a pairing. Allow carries the pages it covers (ids, or "all"), and
   * `scope: "chat"` for a chat request too, so a hub from before requested
   * scopes still grants the right thing.
   */
  const answer = (type: "allow" | "deny" | "revoke", p: PairInfo, pages?: string[] | "all") => {
    const scope = type === "allow" && p.scope === "chat" && !friendRef.current ? "chat" : undefined;
    try {
      sockRef.current?.send(
        JSON.stringify({
          type,
          pair: p.pair,
          ...(scope ? { scope } : {}),
          ...(type === "allow" && pages ? { pages } : {}),
        }),
      );
    } catch {}
    if (!friendRef.current)
      devLog({ ev: `eval-${type}`, label: p.label, code: p.code, scope, pages });
  };
  const endPage = (id: string) => {
    try {
      sockRef.current?.send(JSON.stringify({ type: "end-page", id }));
    } catch {}
  };
  /** `to`: the state-tree node the line is addressed to (absent = the main thread). */
  const sendChat = (text: string, to?: string, opts?: { source?: "stt"; timing?: VoiceTiming }) => {
    const sock = sockRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    try {
      const id = crypto.randomUUID().slice(0, 12);
      // A voice line's timestamps ride along (an older hub drops them).
      const timing = opts?.source === "stt" ? cleanTiming(opts.timing) : undefined;
      // The mic's wake-word mode rides along, so the agent sees it (docs/wake-word.md).
      const mic = (
        globalThis as { __lkMic?: { view?: () => { state: string; wake?: string } } }
      ).__lkMic?.view?.();
      const wake = mic && mic.state !== "off" ? mic.wake : undefined;
      sock.send(
        JSON.stringify({
          type: "chat",
          id,
          text,
          ...(to ? { to } : {}),
          ...(opts?.source === "stt" ? { source: "stt" } : {}),
          ...(timing ? { timing } : {}),
          ...(wake === "active" || wake === "passive" ? { wake } : {}),
        }),
      );
      // Its reply is timed against it (latency.ts); main-thread lines only.
      if (timing && !to) voiceLatency().sent(id, text, timing);
      return true;
    } catch {
      return false;
    }
  };

  const pending = state?.pending ?? null;
  const sessions = state?.sessions ?? [];
  const isFriend = friend !== null;
  // The owner's tree: the bundled outline, with live progress laid over it.
  const ownerTree = useMemo(
    () =>
      typeof window === "undefined"
        ? undefined
        : liveTreeSource({
            base: async () => {
              const r = await fetch("/api/dev/state-tree", { cache: "no-store" });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.text();
            },
            url: progressSocketUrl(location),
            repo: "snolab/lianki",
          }),
    [],
  );
  if (!live && !toast && !chat) return null;
  return (
    <>
      {chat && (
        <DebugChatHost
          hot={owner && !isFriend}
          busy={busy}
          pages={state?.pages ?? []}
          selfPage={state?.self}
          onEndPage={endPage}
          onOpenPage={(path) => router.push(path)}
          live={live}
          listeners={state?.listeners ?? sessions.length}
          messages={messages}
          onSend={sendChat}
          nodes={state?.nodes}
          notice={
            friend === "blocked"
              ? (strings?.unavailable ?? "Chat is not available for this account.")
              : undefined
          }
          warning={warning ?? undefined}
          sessions={sessions}
          onEnd={(x) => answer("revoke", x)}
          onAddPage={(x) => state?.self && answer("allow", x, [state.self])}
          evalRan={!!toast}
          friend={isFriend}
          strings={strings}
          treeSource={owner && !isFriend ? ownerTree : undefined}
          treeRepo="snolab/lianki"
          agentAvatar={AGENT_AVATAR}
          viewer={viewer}
        />
      )}
      {/* A pairing request: a big modal on every open page of its audience. */}
      {pending && (
        <DebugPairModal
          pending={pending}
          friend={isFriend}
          pages={state?.pages ?? []}
          selfPage={state?.self}
          onAllow={(pages) => answer("allow", pending, pages)}
          onDeny={() => answer("deny", pending)}
        />
      )}
      {/* With the chat box up, the rest lives inside it (nothing debug floats on the page). */}
      {!chat && (
        <div
          aria-live="polite"
          data-debug-eval
          data-testid="debug-eval"
          className="fixed bottom-2 left-2 z-50 flex max-w-[calc(100vw-1rem)] flex-col items-start gap-1 text-xs"
          style={{ color: "oklch(0.98 0 0)" }}
        >
          {sessions.map((s) => (
            <div
              key={s.pair}
              data-testid="debug-menu-session"
              className="flex items-center gap-2 rounded-full py-0.5 pl-2 pr-0.5"
              style={{ background: "oklch(0.55 0.15 30 / 0.9)" }}
            >
              <span title={`until ${new Date(s.until ?? 0).toISOString()}`}>
                {isFriend ? "preview" : s.scope === "chat" ? "chat" : "eval"}: {s.label} · {s.code}
              </span>
              <button
                type="button"
                data-testid="debug-menu-session-end"
                onClick={() => answer("revoke", s)}
                className="rounded-full px-2"
                style={{ background: "oklch(0.3 0.05 30)" }}
              >
                End
              </button>
            </div>
          ))}
          {toast && (
            <span
              data-testid="debug-chat-icon-eval"
              className="pointer-events-none rounded px-2 py-0.5 shadow"
              style={{ background: "oklch(0.25 0.02 260 / 0.9)" }}
            >
              {toast}
            </span>
          )}
        </div>
      )}
    </>
  );
}
