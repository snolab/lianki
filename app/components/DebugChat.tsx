"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  MAX_CHAT,
  type PageInfo,
  type PairInfo,
  pageParts,
  pickLang,
  pickVoice,
} from "@/lib/dev-eval";
import { Icon } from "./icons";

/** Typing pauses this long before the draft is sent. */
const DEBOUNCE_MS = 3_000;
/**
 * Dictation lands as one burst: more than BURST_CHARS arriving at once and
 * ending a sentence goes out at once, without waiting for the debounce.
 */
const BURST_CHARS = 10;
const ENDS_SENTENCE = /[。．.!?！？]$/;
const OPEN_KEY = "lk:debug-chat-open";
/** How long "Tap again to end the chat" waits for the second tap. */
const END_CONFIRM_MS = 3_000;
const SPEAK_KEY = "lk:debug-chat-speak";
const POS_KEY = "lk:debug-chat-pos";
/** The input and its grip: the page shows through at about half. */
const INPUT_BG = "color-mix(in oklch, var(--background) 55%, transparent)";
/** Older lines dissolve at the log's top edge (only once there is more than fits). */
const FADE = "linear-gradient(to bottom, transparent, black 2.5rem)";

/**
 * Drag the box (by its header, or the collapsed pill) anywhere on screen: an
 * offset from its bottom-right home, kept on screen and remembered. A press
 * that moves under 5 px is still a click.
 */
function useDrag() {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const v = JSON.parse(read(POS_KEY) ?? "null") as { x: number; y: number } | null;
      return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  });
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(
    null,
  );
  const dragged = useRef(false);
  const handle = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest("button:not([data-drag-handle])")) return;
      drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, moved: false };
      dragged.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      // Keep the whole box on screen: its rect at the start, moved by the delta.
      const box = (
        e.currentTarget.closest("[data-debug-chat]") as HTMLElement
      ).getBoundingClientRect();
      const left = box.left - (pos.x - d.x);
      const top = box.top - (pos.y - d.y);
      const x = d.x + Math.max(-left, Math.min(innerWidth - box.width - left, dx));
      const y = d.y + Math.max(-top, Math.min(innerHeight - box.height - top, dy));
      setPos({ x, y });
    },
    onPointerUp: () => {
      const d = drag.current;
      drag.current = null;
      if (!d?.moved) return;
      dragged.current = true;
      setPos((p) => {
        write(POS_KEY, JSON.stringify(p));
        return p;
      });
    },
    onPointerCancel: () => (drag.current = null),
    style: { touchAction: "none" as const, cursor: "grab" },
  };
  /** The click that ends a drag is not a click. */
  const wasDrag = () => {
    const d = dragged.current;
    dragged.current = false;
    return d;
  };
  return { offset: { transform: `translate(${pos.x}px, ${pos.y}px)` }, handle, wasDrag };
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {}
};
const synth = () => (typeof speechSynthesis === "undefined" ? null : speechSynthesis);

/** Whether agent replies are read aloud on this device (on unless turned off). */
const speechEnabled = () => read(SPEAK_KEY) !== "0";

/**
 * Read an agent reply aloud, after any still being read: the language comes
 * from its script (pickLang), with a matching installed voice if there is one.
 * Only ever called for a reply that arrived live, never for history.
 */
export function speakReply(text: string) {
  const s = synth();
  if (!s || !speechEnabled()) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = pickLang(text);
  const voice = pickVoice(s.getVoices(), u.lang);
  if (voice) u.voice = voice;
  s.speak(u);
}

/** Drop whatever is being read and queued — the owner has started typing. */
function cancelSpeech() {
  const s = synth();
  if (s && (s.speaking || s.pending)) s.cancel();
}

let unlocked = false;
/** iOS speaks only after a user gesture: an empty utterance on the first one unlocks it. */
function unlockSpeech() {
  const s = synth();
  if (unlocked || !s) return;
  unlocked = true;
  s.speak(new SpeechSynthesisUtterance(""));
}

const pad = (n: number) => String(n).padStart(2, "0");
/** HH:MM:SS today, YYYY-MM-DD HH:MM before — local time, ISO order. */
function when(at: number) {
  const d = new Date(at);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return day === today ? `${hm}:${pad(d.getSeconds())}` : `${day} ${hm}`;
}

/**
 * The owner ⇄ agent chat (docs/monitoring.md, "Chat with the agent"): a small
 * box at the bottom right of a debug-mode page that holds the debug socket.
 * Whatever is typed goes out DEBOUNCE_MS after the last keystroke (or at once
 * on Enter; Shift+Enter is a newline; or at once when dictation drops in more
 * than BURST_CHARS ending a sentence), never in the middle of an IME
 * composition. Translucent until touched or typed in. Replies appear in the log above and are read aloud (the
 * speaker toggle turns that off). Text only — nothing is rendered as HTML.
 */
export type DebugChatProps = {
  live: boolean;
  listeners: number;
  messages: ChatMessage[];
  onSend: (text: string) => boolean;
  /** Approved senders, listed in the grip's menu with an End button each. */
  sessions?: PairInfo[];
  onEnd?: (s: PairInfo) => void;
  /** A sender waiting for the owner's answer: one compact line in the icon row. */
  pending?: PairInfo | null;
  onAnswer?: (type: "allow" | "deny", p: PairInfo, scope?: "chat") => void;
  /** Code just ran on this page: the eval icon pulses for a moment. */
  evalRan?: boolean;
  /** A friend's page: pairings are previews (no chat scope to grant). */
  friend?: boolean;
  /** Shown instead of the input when this account cannot chat (blocked). */
  notice?: string;
  /** A one-line note above the input (a message dropped by the rate limit). */
  warning?: string;
  /**
   * The agent's heartbeat says it is working on a message (DebugEval decides,
   * from real beats only): a spinner at the right end of the input.
   */
  working?: { label: string } | null;
  /** A line in the grip's menu (where this widget was loaded from, or why not). */
  note?: string;
  /** This audience's open debug pages (tabs, devices), one row each in the menu. */
  pages?: PageInfo[];
  /** Which of `pages` is this one. */
  selfPage?: string;
  /** Close that page's socket (the hub ends it with PAGE_ENDED). */
  onEndPage?: (id: string) => void;
  /** Open a path in this tab (client-side, so the chat and its socket stay). */
  onOpenPage?: (path: string) => void;
};

export function DebugChat({
  live,
  listeners,
  messages,
  onSend,
  sessions = [],
  onEnd,
  pending = null,
  onAnswer,
  evalRan = false,
  friend = false,
  notice,
  warning,
  working = null,
  note,
  pages = [],
  selfPage,
  onEndPage,
  onOpenPage,
}: DebugChatProps) {
  const [open, setOpen] = useState(() => {
    const v = read(OPEN_KEY);
    return v === null ? !location.pathname.startsWith("/words") : v === "1";
  });
  const [speak, setSpeak] = useState(speechEnabled);
  const { offset, handle, wasDrag } = useDrag();
  /** The grip's menu (double tap): status, read-aloud, minimize. */
  const [menu, setMenu] = useState(false);
  const lastGripTap = useRef(0);
  /** The chat session whose End was tapped once: a second tap within END_CONFIRM_MS ends it. */
  const [endArmed, setEndArmed] = useState<string | null>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(endTimer.current), []);
  const [draft, setDraft] = useState("");
  /** Re-keys the drain bar on each keystroke; 0 while nothing is waiting. */
  const [armed, setArmed] = useState(0);
  const [offline, setOffline] = useState(false);
  const [seen, setSeen] = useState(messages.length);
  const draftRef = useRef("");
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const log = useRef<HTMLOListElement | null>(null);
  /** The log is scrolled to its end (new messages follow it there). */
  const atEnd = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  /** Messages that arrived while scrolled up: a dot on the scroll-down button. */
  const [below, setBelow] = useState(0);
  const shown = useRef(messages.length);
  /** The log overflows (or is scrolled): its top edge fades. */
  const [fade, setFade] = useState(false);
  const onLogScroll = () => {
    const el = log.current;
    if (!el) return;
    setFade(el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0);
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    atEnd.current = end;
    setScrolledUp(!end);
    if (end) setBelow(0);
  };
  const input = useRef<HTMLTextAreaElement | null>(null);
  // The log is click-through, so it can't be swiped: a vertical swipe on the
  // input scrolls it instead (unless the draft itself is long enough to scroll).
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    let y = 0;
    let swiping = false;
    const down = (e: TouchEvent) => {
      y = e.touches[0].clientY;
      swiping = false;
    };
    const move = (e: TouchEvent) => {
      const list = log.current;
      if (!list || el.scrollHeight > el.clientHeight + 1) return;
      const ny = e.touches[0].clientY;
      if (!swiping && Math.abs(ny - y) < 6) return;
      swiping = true;
      list.scrollTop -= ny - y;
      y = ny;
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
    };
  }, [open]);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  useEffect(() => {
    synth()?.getVoices(); // starts loading them, so the first reply finds one
    return () => clearTimeout(timer.current);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    setSeen(messages.length);
    const added = messages.length - shown.current;
    shown.current = messages.length;
    // Follow new messages only from the end (or the owner's own, just sent);
    // scrolled up, they wait under the scroll-down button's dot.
    const mine = added > 0 && messages.at(-1)?.from !== "agent";
    if (atEnd.current || mine) {
      log.current?.scrollTo({ top: log.current.scrollHeight });
      atEnd.current = true;
      setScrolledUp(false);
      setBelow(0);
    } else if (added > 0) setBelow((n) => n + added);
    const el = log.current;
    if (el) setFade(el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0);
  }, [messages, open]);

  const submit = () => {
    clearTimeout(timer.current);
    setArmed(0);
    const text = draftRef.current.trim();
    if (!text) return;
    if (!sendRef.current(text)) return setOffline(true);
    setOffline(false);
    draftRef.current = "";
    settledLen.current = 0;
    setDraft("");
  };
  /** The draft's length when it last changed outside an IME composition. */
  const settledLen = useRef(0);
  /** The key going down is Shift+Enter: its line break stays a line break. */
  const shiftEnter = useRef(false);
  const arm = () => {
    clearTimeout(timer.current);
    if (!composing.current) {
      const text = draftRef.current;
      const burst = text.length - settledLen.current > BURST_CHARS;
      settledLen.current = text.length;
      if (burst && ENDS_SENTENCE.test(text.trim())) return submit();
    }
    if (composing.current || !draftRef.current.trim()) return setArmed(0);
    setArmed((n) => n + 1);
    timer.current = setTimeout(submit, DEBOUNCE_MS);
  };
  const toggle = (v: boolean) => {
    if (v) atEnd.current = true;
    setOpen(v);
    write(OPEN_KEY, v ? "1" : "0");
  };
  const toggleSpeak = () => {
    const v = !speak;
    setSpeak(v);
    write(SPEAK_KEY, v ? "1" : "0");
    if (!v) synth()?.cancel();
  };

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const conns = `${plural(pages.length, "page")} · ${plural(sessions.length, "session")}`;
  /** First tap arms (END_CONFIRM_MS), the second does it. */
  const twoStep = (key: string, act: () => void) => {
    clearTimeout(endTimer.current);
    if (endArmed === key) {
      setEndArmed(null);
      return act();
    }
    setEndArmed(key);
    endTimer.current = setTimeout(() => setEndArmed(null), END_CONFIRM_MS);
  };
  const unread = messages.slice(seen).filter((m) => m.from === "agent").length;
  const dot = live ? "oklch(0.68 0.16 150)" : "oklch(0.62 0.02 70)";
  const status = notice
    ? "chat unavailable"
    : offline
      ? "not connected — your draft is kept"
      : !live
        ? "reconnecting…"
        : listeners
          ? `agent listening (${listeners})`
          : "connected · no agent listening";

  if (!open)
    return (
      <button
        type="button"
        data-debug-chat
        data-drag-handle
        {...handle}
        style={{ ...handle.style, ...offset }}
        onClick={() => !wasDrag() && toggle(true)}
        onPointerDown={(e) => {
          unlockSpeech();
          handle.onPointerDown(e);
        }}
        aria-label={`Open chat with the agent${unread ? `, ${unread} new` : ""}`}
        className="fixed right-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 flex items-center lk-halo opacity-60 transition-opacity active:opacity-100 gap-1.5 px-3 py-1 text-xs text-gray-700 dark:text-gray-200"
      >
        <span className="size-2 rounded-full" style={{ background: dot }} />
        chat
        {unread > 0 && (
          <span className="rounded-full bg-blue-600 px-1.5 text-[10px] text-white">{unread}</span>
        )}
      </button>
    );

  return (
    <section
      data-debug-chat
      aria-label="Chat with the agent"
      onPointerDown={unlockSpeech}
      onKeyDown={unlockSpeech}
      style={offset}
      className="fixed right-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 flex w-[min(20rem,calc(100vw-1rem))] opacity-60 transition-opacity focus-within:opacity-100 active:opacity-100 pointer-events-none flex-col rounded-xl lk-halo text-xs text-gray-800 dark:text-gray-100"
    >
      {(pending || evalRan || sessions.some((x) => x.scope !== "chat")) && (
        <div aria-label="Debug connections" className="flex items-center gap-1 px-2 pt-1">
          {sessions
            .filter((x) => x.scope !== "chat")
            .map((x) => (
              <span
                key={x.pair}
                title={`${friend ? "preview" : "eval"}: ${x.label} · ${x.code}`}
                className={`inline-flex size-4 items-center justify-center rounded-full text-[9px] text-white ${evalRan ? "animate-pulse" : "opacity-70"}`}
                style={{ background: "oklch(0.55 0.15 30)" }}
              >
                <Icon name="play" />
              </span>
            ))}
          {pending && (
            // A sender asks to pair: one line, its code and the three answers.
            <span
              role="alertdialog"
              aria-label={`${pending.label} wants to run code or chat; code ${pending.code}`}
              className="pointer-events-auto inline-flex items-center gap-1 rounded-full py-0.5 ps-1.5 pe-0.5 text-[10px] text-white"
              style={{ background: "oklch(0.45 0.12 30)" }}
              title={
                friend
                  ? `${pending.label} wants to preview a change on this page for 1 hour. Allow only if the agent told you the same code in the chat.`
                  : `${pending.label} wants to run code on your debug pages, or to chat. Allow only if your terminal shows the same code.`
              }
            >
              <Icon name="lock" />
              <b className="font-mono tracking-wider">{pending.code}</b>
              <button
                type="button"
                onClick={() => onAnswer?.("allow", pending)}
                className="rounded-full px-1.5"
                style={{ background: "oklch(0.55 0.15 145)" }}
                title="Allow code and chat for 1 hour"
              >
                1h
              </button>
              {!friend && (
                <button
                  type="button"
                  onClick={() => onAnswer?.("allow", pending, "chat")}
                  className="rounded-full px-1.5"
                  style={{ background: "oklch(0.5 0.1 230)" }}
                  title="Chat only, for 30 days"
                >
                  chat
                </button>
              )}
              <button
                type="button"
                onClick={() => onAnswer?.("deny", pending)}
                className="rounded-full px-1.5"
                style={{ background: "oklch(0.4 0.02 260)" }}
                aria-label="Deny"
              >
                ✕
              </button>
            </span>
          )}
        </div>
      )}
      <ol
        ref={log}
        onScroll={onLogScroll}
        data-fade={fade || undefined}
        style={fade ? { maskImage: FADE, WebkitMaskImage: FADE } : undefined}
        className="max-h-[30vh] min-h-12 space-y-0.5 overflow-y-auto px-2 py-1.5"
      >
        {messages.length === 0 && (
          <li className="text-gray-500">Type here; it is sent 3 s after you stop.</li>
        )}
        {/* A game-style log: one line per message, "name: text", no bubbles. */}
        {messages.map((m) => (
          // The time only on hover (long press on a phone): name and text are the line.
          <li
            key={m.id}
            title={when(m.at)}
            className="whitespace-pre-wrap break-words leading-snug"
          >
            <span
              className="me-1 font-medium"
              style={{
                color: m.from !== "agent" ? "oklch(0.55 0.13 250)" : "oklch(0.55 0.14 150)",
              }}
            >
              {m.from !== "agent" ? "you" : m.label || "agent"}:
            </span>
            {m.text}
          </li>
        ))}
      </ol>
      {warning && (
        <div role="alert" className="px-2 pt-1 text-[10px]" style={{ color: "oklch(0.6 0.17 45)" }}>
          {warning}
        </div>
      )}
      {notice ? (
        <p
          role="status"
          data-debug-chat-notice
          className="pointer-events-auto px-2 py-2 text-gray-600 dark:text-gray-400"
        >
          {notice}
        </p>
      ) : (
        <>
          {/* The log above is click-through: taps reach the page under it. Only the
          grip and the input take pointer events. */}
          <div className="relative flex items-stretch gap-1">
            {scrolledUp && (
              // The row stays click-through; only the button takes taps.
              <div className="pointer-events-none absolute inset-x-0 bottom-full mb-1 flex justify-end">
                <button
                  type="button"
                  data-debug-chat-bottom
                  aria-label={
                    below
                      ? `Scroll to the newest message, ${below} new`
                      : "Scroll to the newest message"
                  }
                  onClick={() =>
                    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" })
                  }
                  style={{ background: INPUT_BG }}
                  className="pointer-events-auto relative inline-flex size-6 items-center justify-center rounded-full border border-current/25 text-sm leading-none text-gray-600 dark:text-gray-300"
                >
                  ↓
                  {below > 0 && (
                    <span
                      aria-hidden
                      className="absolute end-0 top-0 size-2 rounded-full"
                      style={{ background: "oklch(0.6 0.2 22)" }}
                    />
                  )}
                </button>
              </div>
            )}
            {/* No title bar: the grip drags the box, and a double tap on it opens
            the menu (status, read-aloud, minimize). Its dot is the connection. */}
            <button
              type="button"
              data-drag-handle
              aria-label={`Drag the chat box; ${conns}; double tap for its menu`}
              aria-expanded={menu}
              title={status}
              {...handle}
              onClick={(e) => {
                if (wasDrag()) return;
                const second = e.timeStamp - lastGripTap.current < 350;
                lastGripTap.current = second ? 0 : e.timeStamp;
                if (second) setMenu((m) => !m);
              }}
              style={{ ...handle.style, background: INPUT_BG }}
              className="pointer-events-auto relative flex w-9 shrink-0 flex-col items-center justify-center rounded-lg border border-current/25 text-base leading-none text-gray-500"
            >
              ⠿{/* Pages·sessions under the glyph (e.g. "2·1"); spelled out in the label. */}
              <span data-debug-chat-count className="text-[9px] leading-none tabular-nums">
                {pages.length}·{sessions.length}
              </span>
              <span
                aria-hidden
                className="absolute end-0.5 top-0.5 size-1.5 rounded-full"
                style={{ background: dot }}
              />
            </button>
            {menu && (
              <div
                role="menu"
                data-debug-chat-menu
                style={{ background: INPUT_BG }}
                className="pointer-events-auto absolute bottom-full start-0 mb-1 flex min-w-48 flex-col rounded-lg border border-current/25 py-1 text-xs backdrop-blur"
              >
                <span className="px-3 py-1 text-gray-500" aria-live="polite">
                  {status}
                </span>
                {note && (
                  <span data-debug-chat-note className="px-3 py-1 text-gray-500">
                    {note}
                  </span>
                )}
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={speak}
                  onClick={toggleSpeak}
                  className="flex items-center gap-2 px-3 py-1.5 text-start"
                >
                  <Icon name="speakerHigh" weight={speak ? "fill" : "regular"} />
                  {speak ? "Replies read aloud" : "Replies silent"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    toggle(false);
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-start"
                >
                  <span className="w-[1em] text-center">–</span>
                  Minimize
                </button>
                {/* Every open page of this chat; ending this one asks twice. */}
                {pages.map((pg) => {
                  const self = pg.id === selfPage;
                  const key = `page:${pg.id}`;
                  const { path, device } = pageParts(pg.label);
                  return (
                    <div
                      key={pg.id || pg.label}
                      data-debug-chat-page={self ? "self" : "other"}
                      className="flex items-center gap-2 px-3 py-1 text-gray-500"
                    >
                      {/* Tap: open that path here (other tabs and devices can't be focused). */}
                      <button
                        type="button"
                        data-debug-chat-open={path}
                        title={pg.label}
                        onClick={() => {
                          setMenu(false);
                          if (!self) onOpenPage?.(path);
                        }}
                        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-start"
                      >
                        <span className="truncate text-gray-700 dark:text-gray-200">{path}</span>
                        <span className="shrink-0 text-[10px]">
                          {[device, self ? "this page" : ""].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                      {pg.id && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (self) twoStep(key, () => onEndPage?.(pg.id));
                            else onEndPage?.(pg.id);
                          }}
                          className="underline"
                          style={endArmed === key ? { color: "oklch(0.58 0.19 25)" } : undefined}
                        >
                          {endArmed === key ? "Tap again" : "End"}
                        </button>
                      )}
                    </div>
                  );
                })}
                {sessions
                  .filter((x) => x.scope !== "chat")
                  .map((x) => (
                    <div key={x.pair} className="flex items-center gap-2 px-3 py-1 text-gray-500">
                      <span className="min-w-0 flex-1 truncate">
                        {friend ? "preview" : "eval"}: {x.label} · {x.code}
                      </span>
                      <button type="button" onClick={() => onEnd?.(x)} className="underline">
                        End
                      </button>
                    </div>
                  ))}
                {/* Ending the chat grant ends the chat itself: apart, in red, two taps. */}
                {sessions
                  .filter((x) => x.scope === "chat")
                  .map((x) => (
                    <button
                      key={x.pair}
                      type="button"
                      data-debug-chat-end={endArmed === x.pair ? "armed" : "idle"}
                      title={`chat: ${x.label} · ${x.code}`}
                      onClick={() => twoStep(x.pair, () => onEnd?.(x))}
                      className="mx-2 my-1 rounded px-2 py-1 text-start font-medium"
                      style={{
                        color: "oklch(0.98 0 0)",
                        background:
                          endArmed === x.pair ? "oklch(0.5 0.21 25)" : "oklch(0.58 0.19 25 / 0.85)",
                      }}
                    >
                      {endArmed === x.pair
                        ? "Tap again to end the chat"
                        : "End chat with the agent (revokes the 30-day grant)"}
                    </button>
                  ))}
              </div>
            )}
            {armed > 0 && (
              <div
                key={armed}
                aria-hidden
                className="lk-drain absolute inset-x-0 top-0 h-0.5 bg-blue-600/60"
              />
            )}
            <div className="relative flex min-w-0 flex-1">
              <textarea
                ref={input}
                rows={1}
                value={draft}
                maxLength={MAX_CHAT}
                placeholder="Message the agent…"
                aria-label="Message the agent"
                onChange={(e) => {
                  draftRef.current = e.target.value;
                  setDraft(e.target.value);
                  setOffline(false);
                  cancelSpeech();
                  arm();
                }}
                onCompositionStart={() => {
                  composing.current = true;
                  clearTimeout(timer.current);
                  setArmed(0);
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                  arm();
                }}
                // Android's keyboards report every key as 229, so Enter never
                // reaches onKeyDown as "Enter": the line break itself is the cue.
                onBeforeInput={(e) => {
                  const type = (e.nativeEvent as InputEvent).inputType;
                  if (type !== "insertLineBreak" && type !== "insertParagraph") return;
                  if (composing.current || (e.nativeEvent as InputEvent).isComposing) return;
                  if (shiftEnter.current) return; // Shift+Enter: a newline, as on desktop
                  e.preventDefault();
                  submit();
                }}
                onKeyDown={(e) => {
                  shiftEnter.current = e.key === "Enter" && e.shiftKey;
                  if (e.key !== "Enter" || e.shiftKey) return;
                  // Enter that confirms an IME candidate (Safari reports it as 229
                  // after compositionend) must not send.
                  if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
                  e.preventDefault();
                  submit();
                }}
                style={{ background: INPUT_BG }}
                className="pointer-events-auto block min-w-0 flex-1 resize-none pe-6 rounded-lg border border-current/25 px-2 py-1 text-base outline-none placeholder:text-gray-400"
              />
              {working && (
                // Up only while real heartbeats arrive (DebugEval): never a guess.
                <span
                  role="status"
                  data-debug-chat-working
                  aria-label={`${working.label || "agent"} is working`}
                  title={`${working.label || "agent"} is working`}
                  className="pointer-events-none absolute end-1.5 top-1/2 -translate-y-1/2"
                >
                  <svg viewBox="0 0 16 16" className="size-3.5 animate-spin" aria-hidden>
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      fill="none"
                      strokeWidth="2"
                      stroke="oklch(0.6 0.02 70 / 0.35)"
                    />
                    <path
                      d="M8 2a6 6 0 0 1 6 6"
                      fill="none"
                      strokeWidth="2"
                      strokeLinecap="round"
                      stroke="oklch(0.55 0.14 150)"
                    />
                  </svg>
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
