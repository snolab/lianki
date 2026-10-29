"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  MAX_CHAT,
  type PageInfo,
  type ChatStrings,
  type PairInfo,
  chatStrings,
  pageParts,
} from "./wire";
import { getKey, setKey } from "./storage-keys";
import { LiagentMark } from "./LiagentMark";
import {
  CLIP_SINK_KEY,
  VOICE_SENT_EVENT,
  appendDictation,
  isDictationBurst,
  clipSinkFrom,
  joinText,
} from "./mic";
import { DebugMic, canCapture, playSentTick } from "./MicButton";
import { SPEAK_KEY, type VoiceState, speechEnabled, voice } from "./voice";
import { cloudOut, outMode } from "./voice-out";
import { createDragFlag, createTapper } from "./tap-gesture";
import { Icon } from "./icons";

/** Typing pauses this long before the draft is sent. */
const DEBOUNCE_MS = 3_000;
/**
 * Dictation lands as one burst: AUTO_SEND_MIN (3) or more characters arriving
 * at once and ending a sentence (。．.!?！？) go out at once, without waiting
 * for the debounce (isDictationBurst). Keyboards and IMEs edit a character at
 * a time, so 3 at once is dictation. Spoken sentences follow the same rule.
 */
const OPEN_KEY = "lk:debug-chat-open";
/** How long "Tap again to end the chat" waits for the second tap. */
const END_CONFIRM_MS = 3_000;
/** In the input while the pill is held. */
const DRAG_HINT = "drag: move · tap: minimize · double-tap or ⋯: menu";
const POS_KEY = "lk:debug-chat-pos";
/** The input and its pill: the page shows through at about half. */
const INPUT_BG = "color-mix(in oklch, var(--background) 55%, transparent)";
/** Older lines dissolve at the log's top edge (only once there is more than fits). */
const FADE = "linear-gradient(to bottom, transparent, black 2.5rem)";
/** The compact log (input not focused) fades over less, so its 3 lines stay legible. */
const FADE_SHORT = "linear-gradient(to bottom, transparent, black 0.9rem)";

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
  /** The click that ends a drag is not a tap (cleared on the next press, or after 400 ms). */
  const dragged = useRef(createDragFlag());
  /** The pill is held down: the input shows how to use it. */
  const [holding, setHolding] = useState(false);
  const handle = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest("button:not([data-drag-handle])")) return;
      setHolding(true);
      drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, moved: false };
      dragged.current.down();
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      // Keep the input row (pill + input) on screen, up to the very top under
      // the notch: its rect at the start, moved by the delta. The click-through
      // log above it may go off-screen. The collapsed pill is its own row.
      const box = e.currentTarget.closest("[data-debug-chat]") as HTMLElement;
      const row = (box.querySelector("[data-debug-chat-row]") ?? box).getBoundingClientRect();
      const left = row.left - (pos.x - d.x);
      const top = row.top - (pos.y - d.y);
      const x = d.x + Math.max(-left, Math.min(innerWidth - row.width - left, dx));
      const y = d.y + Math.max(safeTop() - top, Math.min(innerHeight - row.height - top, dy));
      setPos({ x, y });
    },
    onPointerUp: () => {
      setHolding(false);
      const d = drag.current;
      drag.current = null;
      if (!d?.moved) return;
      dragged.current.dragEnded();
      setPos((p) => {
        write(POS_KEY, JSON.stringify(p));
        return p;
      });
    },
    onPointerCancel: () => {
      setHolding(false);
      drag.current = null;
    },
    style: { touchAction: "none" as const, cursor: "grab" },
  };
  /**
   * Bring the row (pill + input, or the minimized pill) back on screen, e.g.
   * after restoring the box where the small mark was, or on a smaller screen.
   */
  const fit = (box: HTMLElement | null) => {
    const row = box?.querySelector("[data-debug-chat-row]")?.getBoundingClientRect();
    if (!row) return;
    const top = safeTop();
    const dx = row.left < 0 ? -row.left : row.right > innerWidth ? innerWidth - row.right : 0;
    const dy =
      row.top < top ? top - row.top : row.bottom > innerHeight ? innerHeight - row.bottom : 0;
    if (!dx && !dy) return;
    setPos((p) => {
      const next = { x: p.x + dx, y: p.y + dy };
      write(POS_KEY, JSON.stringify(next));
      return next;
    });
  };
  /** The click that ends a drag is not a click. */
  const wasDrag = () => dragged.current.wasDrag();
  return {
    offset: { transform: `translate(${pos.x}px, ${pos.y}px)` },
    handle,
    wasDrag,
    holding,
    fit,
  };
}

/** env(safe-area-inset-top) in px (the notch), measured once per drag. */
function safeTop() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top)";
  document.body.append(probe);
  const v = Number.parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return v;
}

/** Legacy `lk:debug*` names; storage-keys reads `lk:agent*` first and writes both. */
const read = (key: string) => getKey(key);
const write = (key: string, v: string) => setKey(key, v);
const synth = () => (typeof speechSynthesis === "undefined" ? null : speechSynthesis);


/**
 * Read an agent reply aloud (voice.ts): queued behind any still being read,
 * one utterance per sentence, in the voice its script suggests. Only ever
 * called for a reply that arrived live, never for history. With the mic on it
 * is always read; otherwise only to someone typing here with the speaker on.
 * DebugEval calls this bundled copy; the hot-loaded chat shares the session.
 */
export function speakReply(text: string) {
  voice().reply(text);
}

let unlocked = false;
/** iOS speaks only after a user gesture: an empty utterance on the first one unlocks it. */
function unlockSpeech() {
  const s = synth();
  if (unlocked || !s) return;
  unlocked = true;
  s.speak(new SpeechSynthesisUtterance(""));
  // The cloud voice's <audio> element too (lk:voice-out = "cloud").
  if (outMode() === "cloud") cloudOut()?.unlock();
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
 * on Enter; Shift+Enter is a newline; or at once when dictation drops in
 * 3+ characters ending a sentence), never in the middle of an IME
 * composition. Translucent until touched or typed in. Replies appear in the log above and are read aloud (the
 * speaker toggle turns that off). Text only — nothing is rendered as HTML.
 */
export type DebugChatProps = {
  live: boolean;
  listeners: number;
  messages: ChatMessage[];
  onSend: (text: string) => boolean;
  /** Approved senders, listed in the pill's menu with an End button each. */
  sessions?: PairInfo[];
  onEnd?: (s: PairInfo) => void;
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
  busy?: { label: string } | null;
  /** A line in the pill's menu (where this widget was loaded from, or why not). */
  note?: string;
  /** This audience's open debug pages (tabs, devices), one row each in the menu. */
  pages?: PageInfo[];
  /** Which of `pages` is this one. */
  selfPage?: string;
  /** Close that page's socket (the hub ends it with PAGE_ENDED). */
  onEndPage?: (id: string) => void;
  /** Open a path in this tab (client-side, so the chat and its socket stay). */
  onOpenPage?: (path: string) => void;
  /** Add this page to a pairing that was authorized for other pages only. */
  onAddPage?: (s: PairInfo) => void;
  /** User-facing strings, localized by the host (English defaults in wire.ts). */
  strings?: Partial<ChatStrings>;
};

/** The voice session before the page has one (server render, first paint). */
const QUIET: VoiceState = {
  mic: false,
  speaking: false,
  hold: false,
  ducked: false,
  queued: 0,
  paused: false,
};

/** The input grows to about five lines, then scrolls inside itself. */
const INPUT_MAX_PX = 128;

export function DebugChat({
  live,
  listeners,
  messages,
  onSend,
  sessions = [],
  onEnd,
  evalRan = false,
  friend = false,
  notice,
  warning,
  busy = null,
  note,
  pages = [],
  selfPage,
  onEndPage,
  onOpenPage,
  onAddPage,
  strings,
}: DebugChatProps) {
  const t = chatStrings(strings);
  const [open, setOpen] = useState(() => {
    const v = read(OPEN_KEY);
    return v === null ? !location.pathname.startsWith("/words") : v === "1";
  });
  const [speak, setSpeak] = useState(speechEnabled);
  const { offset, handle, wasDrag, holding, fit } = useDrag();
  /** The box or the minimized mark: whichever is up is kept on screen. */
  const root = useRef<HTMLElement | null>(null);
  // Only a switch between the box and the mark refits (fit itself is fresh each render).
  useLayoutEffect(() => fit(root.current), [open]);
  /** The pill's menu: status, read-aloud, pages, sessions. */
  const [menu, setMenu] = useState(false);
  /** The pill's mark: one tap minimizes or restores, two open the menu (the single waits for a second). */
  const gripAct = useRef({ single: () => {}, double: () => {} });
  const gripTaps = useRef<ReturnType<typeof createTapper> | null>(null);
  gripTaps.current ??= createTapper({
    onSingle: () => gripAct.current.single(),
    onDouble: () => gripAct.current.double(),
  });
  useEffect(() => () => gripTaps.current?.cancel(), []);
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
  /**
   * The input has focus: the log opens to 30vh. Otherwise it shows only the
   * last 3 lines, scrolled to the end.
   */
  const [typing, setTyping] = useState(false);
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
  /** Dictated text just landed: put the caret after it and show the end. */
  const caretToEnd = useRef(false);
  /** The input grows with its text up to INPUT_MAX_PX, then scrolls inside itself. */
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`;
    if (caretToEnd.current) {
      caretToEnd.current = false;
      const end = el.value.length;
      el.setSelectionRange(end, end);
      el.scrollTop = el.scrollHeight;
    }
  }, [draft]);
  // The log is click-through, so it can't be swiped: a vertical swipe on the
  // empty input scrolls it instead. Only the pill moves the box.
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
      // Empty input: the swipe scrolls the log. With text in it, it scrolls the text.
      if (!list || el.value.length > 0) return;
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
  /** The voice session (voice.ts): mic on, reading, sentences queued. */
  const [vs, setVs] = useState<VoiceState>(QUIET);
  useEffect(() => {
    const v = voice();
    setVs(v.state());
    return v.subscribe(setVs);
  }, []);
  // The tab hiding stops the reading — unless the mic is on (hands-free).
  useEffect(() => {
    const hide = () =>
      document.visibilityState !== "visible" && !voice().state().mic && voice().stop();
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  // Compact again (the input lost focus): back to the newest lines.
  useLayoutEffect(() => {
    if (typing) return;
    const el = log.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
    atEnd.current = true;
    setScrolledUp(false);
    setBelow(0);
  }, [typing]);
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

  /** Send the draft; true when it went out. */
  const submit = (): boolean => {
    clearTimeout(timer.current);
    setArmed(0);
    const text = draftRef.current.trim();
    if (!text) return false;
    if (!sendRef.current(text)) {
      setOffline(true);
      return false;
    }
    setOffline(false);
    // Sent: an interruption is over, and the queue (still relevant) reads on.
    voice().resume();
    draftRef.current = "";
    settledLen.current = 0;
    setDraft("");
    return true;
  };
  /** The draft's length when it last changed outside an IME composition. */
  const settledLen = useRef(0);
  /** The key going down is Shift+Enter: its line break stays a line break. */
  const shiftEnter = useRef(false);
  /** The mic is listening, or has transcripts out: the debounce waits for it. */
  const micOn = useRef(false);
  /** The mic is on (drives the open log too: iOS drops input focus on a button tap). */
  const [micActive, setMicActive] = useState(false);
  const micPending = useRef(0);
  /** This browser can capture (the mic button shows inside the input). */
  const [hasMic, setHasMic] = useState(false);
  useEffect(() => setHasMic(canCapture()), []);
  /** Dimmed after the draft: partial transcripts, or "…" for those still out. */
  const [interim, setInterim] = useState("");
  const mirror = useRef<HTMLDivElement | null>(null);
  /** A transcript lands in the draft, as typed text would, but is never sent by itself. */
  const dictated = (t: string) => {
    const { draft: next, send } = appendDictation(draftRef.current, t);
    caretToEnd.current = true;
    draftRef.current = next;
    settledLen.current = next.length; // not a typed "burst"
    setDraft(next);
    setOffline(false);
    // A spoken sentence goes out at once, with a soft tick (typed sends are silent);
    // anything else waits for the usual rules.
    if (send) {
      if (submit()) {
        const sound = playSentTick();
        window.dispatchEvent(new CustomEvent(VOICE_SENT_EVENT, { detail: { sound } }));
      }
      return;
    }
    arm();
  };
  const arm = () => {
    clearTimeout(timer.current);
    if (!composing.current) {
      const text = draftRef.current;
      const burst = isDictationBurst(settledLen.current, text);
      settledLen.current = text.length;
      if (burst) return submit();
    }
    // While the mic listens or transcribes, nothing goes out by the debounce (Enter still sends).
    if (composing.current || micOn.current || micPending.current || !draftRef.current.trim())
      return setArmed(0);
    setArmed((n) => n + 1);
    timer.current = setTimeout(submit, DEBOUNCE_MS);
  };
  const toggle = (v: boolean) => {
    if (v) atEnd.current = true;
    setOpen(v);
    write(OPEN_KEY, v ? "1" : "0");
  };
  gripAct.current = {
    single: () => {
      setMenu(false);
      toggle(!open);
    },
    double: () => setMenu((m) => !m),
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const conns = plural(
    pages.length + sessions.filter((x) => x.scope !== "chat").length,
    "connection",
  );
  const toggleSpeak = () => {
    const v = !speak;
    setSpeak(v);
    write(SPEAK_KEY, v ? "1" : "0");
    if (!v && !voice().state().mic) voice().stop();
  };

  /** A pairing authorized for some pages only, not including this one. */
  const addable = (x: PairInfo) => !!x.pages && !!selfPage && !x.pages.includes(selfPage);
  const reachNote = (x: PairInfo) =>
    x.pages ? ` · ${x.pages.length === 1 ? "1 page" : `${x.pages.length} pages`} only` : "";
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
  const evalSessions = sessions.filter((x) => x.scope !== "chat");
  /** Room at the input's right end: the mic (32px), and the busy spinner left of it. */
  const inputPad = hasMic ? (busy ? "pe-14" : "pe-9") : "pe-6";
  const unread = messages.slice(seen).filter((m) => m.from === "agent").length;
  /** An agent is listening (the hub's listener count, pushed on every change). */
  const agentOnline = live && listeners > 0;
  // Green: an agent is listening. Amber: connected, but no agent. Grey: no connection.
  const dot = agentOnline
    ? "oklch(0.68 0.16 150)"
    : live
      ? "oklch(0.75 0.13 75)"
      : "oklch(0.62 0.02 70)";
  /** Your lines after the agent last spoke wait for it while it is offline. */
  const lastAgent = messages.findLastIndex((m) => m.from === "agent");
  const status = notice
    ? "chat unavailable"
    : offline
      ? "not connected — your draft is kept"
      : !live
        ? "reconnecting…"
        : listeners
          ? `agent listening (${listeners})`
          : "agent offline · messages wait until it is back";

  /**
   * The pill: drag it anywhere to move the box. Left, the liagent mark: a tap
   * minimizes or restores (after 280 ms), a double tap opens the menu. Right,
   * the other connections (eval/preview sessions) or ⋯: a tap opens the menu.
   * Each zone is its own drag handle, so its click still lands on it.
   */
  const pill = (
    <div
      data-testid="debug-chat-pill"
      data-debug-chat-pill
      className={`pointer-events-auto relative flex shrink-0 items-stretch rounded-full border border-current/25 text-gray-600 dark:text-gray-300 ${open ? "" : "opacity-60 transition-opacity active:opacity-100"}`}
      style={{ background: INPUT_BG }}
      title={status}
    >
      <button
        type="button"
        data-drag-handle
        data-testid="debug-chat-pill-min"
        aria-label={open ? "Minimize chat" : `Restore chat${unread ? `, ${unread} new` : ""}`}
        aria-expanded={open}
        {...handle}
        onPointerDown={(e) => {
          unlockSpeech();
          handle.onPointerDown(e);
        }}
        onClick={() => !wasDrag() && gripTaps.current?.tap()}
        style={handle.style}
        className="relative flex min-h-8 w-8 items-center justify-center rounded-s-full"
      >
        <LiagentMark size={18} />
        <span
          aria-hidden
          className="absolute end-0.5 top-1 size-1.5 rounded-full"
          style={{ background: dot }}
        />
      </button>
      <span aria-hidden className="my-1.5 w-px bg-current opacity-25" />
      <button
        type="button"
        data-drag-handle
        data-testid="debug-chat-pill-menu"
        aria-label={`Open chat menu (${conns})`}
        aria-expanded={menu}
        {...handle}
        onClick={() => !wasDrag() && setMenu((m) => !m)}
        style={handle.style}
        className="relative flex min-h-8 min-w-8 items-center justify-center gap-0.5 rounded-e-full px-1 text-[10px] tabular-nums"
      >
        {evalSessions.length > 0 ? (
          <>
            <span
              aria-hidden
              className={`inline-flex size-3.5 items-center justify-center rounded-full text-[8px] text-white ${evalRan ? "animate-pulse" : "opacity-80"}`}
              style={{ background: "oklch(0.55 0.15 30)" }}
            >
              <Icon name="play" />
            </span>
            {evalSessions.length}
          </>
        ) : (
          <span aria-hidden className="text-sm leading-none">
            ⋯
          </span>
        )}
      </button>
      {!open && unread > 0 && (
        <span
          data-testid="debug-chat-pill-unread"
          className="pointer-events-none absolute -end-1.5 -top-1.5 rounded-full px-1 text-[10px] leading-4 text-white"
          style={{ background: "oklch(0.55 0.2 260)" }}
        >
          {unread}
        </span>
      )}
    </div>
  );
  /** The menu (the pill's ⋯, or a double tap on its mark), open or minimized. */
  const menuEl = menu && (
    <div
      role="menu"
      data-testid="debug-menu"
      style={{ background: INPUT_BG }}
      className="pointer-events-auto absolute bottom-full start-0 mb-1 flex max-h-[60vh] min-w-48 flex-col overflow-y-auto rounded-lg border border-current/25 py-1 text-xs backdrop-blur"
    >
      <span data-testid="debug-menu-status" className="px-3 py-1 text-gray-500" aria-live="polite">
        {status}
      </span>
      {note && (
        <span data-testid="debug-menu-note" className="px-3 py-1 text-gray-500">
          {note}
        </span>
      )}
      <button
        type="button"
        role="menuitemcheckbox"
        data-testid="debug-menu-speak"
        // The mic forces read-aloud on for its session; the setting itself is kept.
        aria-checked={speak || vs.mic}
        aria-disabled={vs.mic}
        title={
          vs.mic
            ? "The mic is on: replies are always read aloud (your setting is back when it stops)"
            : "Replies are read aloud while you're typing here (the input has focus)"
        }
        onClick={() => !vs.mic && toggleSpeak()}
        className={`flex items-center gap-2 px-3 py-1.5 text-start ${vs.mic ? "opacity-70" : ""}`}
      >
        <Icon name="speakerHigh" weight={speak || vs.mic ? "fill" : "regular"} />
        {vs.mic ? "Replies read aloud (mic on)" : speak ? "Replies read aloud" : "Replies silent"}
      </button>
      {vs.queued > 0 && (
        <button
          type="button"
          role="menuitem"
          data-testid="debug-menu-stop-reading"
          onClick={() => {
            voice().stop();
            setMenu(false);
          }}
          className="flex items-center gap-2 px-3 py-1.5 text-start"
        >
          <span aria-hidden className="inline-block size-2.5 rounded-sm bg-current" />
          Stop reading{vs.queued > 1 ? ` (${vs.queued} sentences left)` : ""}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        data-testid="debug-menu-minimize"
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
            data-testid="debug-menu-page"
            data-self={self || undefined}
            className="flex items-center gap-2 px-3 py-1 text-gray-500"
          >
            {/* Tap: open that path here (other tabs and devices can't be focused). */}
            <button
              type="button"
              data-testid="debug-menu-page-open"
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
                data-testid="debug-menu-page-end"
                onClick={(e) => {
                  e.stopPropagation();
                  if (self) twoStep(key, () => onEndPage?.(pg.id));
                  else onEndPage?.(pg.id);
                }}
                className="text-[10px] underline opacity-70"
                style={endArmed === key ? { color: "oklch(0.58 0.19 25)" } : undefined}
              >
                {endArmed === key ? "tap again" : "disconnect"}
              </button>
            )}
          </div>
        );
      })}
      {sessions
        .filter((x) => x.scope !== "chat")
        .map((x) => (
          <div
            key={x.pair}
            data-testid="debug-menu-session"
            data-pair={x.pair}
            className="flex items-center gap-2 px-3 py-1 text-gray-500"
          >
            <span className="min-w-0 flex-1 truncate">
              {friend ? "preview" : "eval"}: {x.label} · {x.code}
              {reachNote(x)}
            </span>
            {addable(x) && (
              <button
                type="button"
                data-testid="debug-menu-session-add"
                onClick={() => onAddPage?.(x)}
                className="underline"
              >
                Add this page
              </button>
            )}
            <button
              type="button"
              data-testid="debug-menu-session-end"
              onClick={() => onEnd?.(x)}
              className="underline"
            >
              End
            </button>
          </div>
        ))}
      {/* Ending the chat grant ends the chat itself: apart, in red, two taps. */}
      {sessions
        .filter((x) => x.scope === "chat" && addable(x))
        .map((x) => (
          <button
            key={`add-${x.pair}`}
            type="button"
            data-testid="debug-menu-session-add"
            onClick={() => onAddPage?.(x)}
            className="px-3 py-1 text-start text-gray-500 underline"
          >
            Let the agent's chat reach this page too{reachNote(x)}
          </button>
        ))}
    </div>
  );

  if (!open)
    return (
      // Minimized: only the pill, where it sits in the box (same anchor and
      // offset), so it moves with the box and restores in place.
      <div
        ref={(el) => {
          root.current = el;
        }}
        data-debug-chat
        data-testid="debug-chat-minimized"
        style={offset}
        className="pointer-events-none fixed right-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 flex w-[min(20rem,calc(100vw-1rem))] text-xs"
      >
        <div data-debug-chat-row className="relative flex">
          {pill}
          {menuEl}
        </div>
      </div>
    );

  return (
    <section
      ref={root}
      data-debug-chat
      data-testid="debug-chat"
      aria-label={t.chatWith}
      onPointerDown={unlockSpeech}
      onKeyDown={unlockSpeech}
      style={offset}
      // A live mic counts as focus: the box goes opaque as it does while typing.
      className={`fixed right-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 flex w-[min(20rem,calc(100vw-1rem))] transition-opacity ${micActive ? "opacity-100" : "opacity-60 focus-within:opacity-100 active:opacity-100"} pointer-events-none flex-col rounded-xl lk-halo text-xs text-gray-800 dark:text-gray-100`}
    >
      <ol
        ref={log}
        data-testid="debug-chat-log"
        onScroll={onLogScroll}
        data-fade={fade || undefined}
        data-expanded={typing || undefined}
        onTransitionEnd={() => {
          // Shrunk: land on the newest lines again, now that the height settled.
          if (!typing && !micActive) log.current?.scrollTo({ top: log.current.scrollHeight });
          onLogScroll();
        }}
        style={
          fade
            ? {
                maskImage: typing || micActive ? FADE : FADE_SHORT,
                WebkitMaskImage: typing || micActive ? FADE : FADE_SHORT,
              }
            : undefined
        }
        className={`min-h-12 space-y-0.5 overflow-y-auto px-0 py-1.5 transition-[max-height] duration-150 ease-out motion-reduce:transition-none ${typing || micActive ? "max-h-[30vh]" : "max-h-[4.1rem]"}`}
      >
        {messages.length === 0 && (
          <li className="text-gray-500">{t.hint}</li>
        )}
        {/* A game-style log: one line per message, "name: text", no bubbles. */}
        {messages.map((m, i) => (
          // The time only on hover (long press on a phone): name and text are the line.
          <li
            key={m.id}
            data-testid="debug-chat-line"
            data-from={m.from}
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
            {!agentOnline && m.from !== "agent" && i > lastAgent && (
              <span
                data-testid="debug-chat-queued"
                className="ms-1 text-[10px] text-gray-500"
                title={t.waitingTitle}
              >
                {t.waiting}
              </span>
            )}
          </li>
        ))}
      </ol>
      {warning && (
        <div
          role="alert"
          data-testid="debug-chat-warning"
          className="px-2 pt-1 text-[10px]"
          style={{ color: "oklch(0.6 0.17 45)" }}
        >
          {warning}
        </div>
      )}
      {notice ? (
        <p
          role="status"
          data-testid="debug-chat-notice"
          className="pointer-events-auto px-2 py-2 text-gray-600 dark:text-gray-400"
        >
          {notice}
        </p>
      ) : (
        <>
          {/* The log above is click-through: taps reach the page under it. Only the
          grip and the input take pointer events. */}
          <div data-debug-chat-row className="relative flex items-stretch gap-1">
            {scrolledUp && (
              // The row stays click-through; only the button takes taps.
              <div className="pointer-events-none absolute inset-x-0 bottom-full mb-1 flex justify-end">
                <button
                  type="button"
                  data-testid="debug-chat-bottom"
                  // Keeps the input's focus, so the log stays open.
                  onPointerDown={(e) => e.preventDefault()}
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
            {/* No title bar: the pill drags the box, minimizes it and opens the
            menu (status, read-aloud, pages, sessions). Its dot is the connection.
            No End chat here: the chat hibernates and wakes by itself. */}
            {pill}
            {menuEl}
            {armed > 0 && (
              <div
                key={armed}
                aria-hidden
                className="lk-drain absolute inset-x-0 top-0 h-0.5 bg-blue-600/60"
              />
            )}
            <div className="relative flex min-w-0 flex-1">
              {interim && (
                // A mirror of the draft, invisible, then the interim text dimmed:
                // it shows where the transcript will land.
                <div
                  ref={mirror}
                  aria-hidden
                  className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-lg border border-transparent px-2 py-1 text-base ${inputPad}`}
                >
                  <span className="invisible">{draft}</span>
                  <span data-testid="debug-chat-mic-pending" className="text-gray-400">
                    {joinText(draft, interim).slice(draft.length)}
                  </span>
                </div>
              )}
              <textarea
                ref={input}
                data-testid="debug-chat-input"
                data-drag-hint={holding || undefined}
                rows={1}
                // 16px: iOS zooms the whole page into any input under 16px.
                value={draft}
                maxLength={MAX_CHAT}
                placeholder={
                  holding
                    ? DRAG_HINT
                    : interim
                      ? ""
                      : agentOnline
                        ? t.message
                        : t.offline
                }
                onScroll={(e) => {
                  if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
                }}
                aria-label={t.message.replace(/…$/, "")}
                onChange={(e) => {
                  draftRef.current = e.target.value;
                  setDraft(e.target.value);
                  setOffline(false);
                  // Typing pauses the reading; a send (or, mic on, a blur) reads on.
                  voice().interrupt("typing");
                  arm();
                }}
                onFocus={() => setTyping(true)}
                onBlur={() => {
                  setTyping(false);
                  // Mic on: hands-free, the reading goes on. Off: it was only for the input.
                  if (voice().state().mic) voice().resume();
                  else voice().stop();
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
                // A drag on a long draft scrolls its text, never the page or the box.
                className={`pointer-events-auto block min-w-0 flex-1 resize-none overflow-y-auto overscroll-contain touch-pan-y rounded-lg border border-current/25 px-2 py-1 text-base outline-none placeholder:text-gray-400 ${inputPad}`}
              />
              {holding && draft && (
                // The draft hides the placeholder: the hint sits over it instead.
                <span
                  data-testid="debug-chat-drag-hint"
                  className="pointer-events-none absolute inset-x-1 top-0.5 truncate rounded px-1 text-[10px] text-gray-500"
                  style={{ background: INPUT_BG }}
                >
                  {DRAG_HINT}
                </span>
              )}
              {busy && (
                // Up only while real heartbeats arrive (DebugEval): never a guess.
                <span
                  role="status"
                  data-testid="debug-chat-busy"
                  aria-label={`${busy.label || "agent"} is working`}
                  title={`${busy.label || "agent"} is working`}
                  className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${hasMic ? "end-9" : "end-1.5"}`}
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
              {hasMic && (
                <DebugMic
                  onText={dictated}
                  onPending={(n, text) => {
                    micPending.current = n;
                    setInterim(text);
                    arm(); // stops a debounce under way, or restarts it once all is in
                  }}
                  onActive={(on) => {
                    micOn.current = on;
                    setMicActive(on);
                    arm();
                  }}
                  clipSink={friend ? undefined : clipSinkFrom(read(CLIP_SINK_KEY))}
                  label={pages.find((p) => p.id === selfPage)?.label ?? location.pathname}
                />
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
