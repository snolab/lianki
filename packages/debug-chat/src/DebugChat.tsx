"use client";

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  MAX_CHAT,
  type PageInfo,
  type PairInfo,
  pageParts,
} from "./wire";
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
import { createAxisLock, createDragFlag, createTapper, scrubBack } from "./tap-gesture";
import {
  FADE_MS,
  FLOAT_MAX,
  type FloatPhase,
  countUnread,
  createArrivals,
  createFloatLife,
  dwellMs,
  minimizeFloat,
} from "./float-lines";
import { Icon } from "./icons";
import { LINE_HALO, logSurface } from "./log-surface";
import { type AnchorSide, placeBox } from "./anchor";
import { TreeFragment, useTreeSource } from "./TreeFragment";
import { FrontierLines, type RenderAvatar } from "./Frontier";
import type { Frontier } from "./frontier-view";

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
/** In the input while the bar is held. */
const DRAG_HINT = "drag: move · tap: minimize · double-tap: menu";
/** The mark's gestures, for its title and aria-description. */
const MARK_HINT = "Tap: minimize or restore · double-tap: menu · drag: move the chat";
const ALIGN_ITEMS = { left: "items-start", center: "items-center", right: "items-end" } as const;
const TEXT_ALIGN = { left: "left", center: "center", right: "right" } as const;
/** Wide enough for the tree and the log side by side. */
const WIDE_QUERY = "(min-width: 768px)";
/**
 * Two columns, `tree | log`, with everything else (warning, bar) spanning
 * both. Placed from the box, so the log's own markup stays as it is.
 */
const TWO_COL =
  "grid grid-cols-[2fr_3fr] items-end gap-x-3 *:col-span-2 [&_[data-tree-col]]:col-span-1 [&_[data-testid=debug-chat-log]]:col-span-1";
/** The mic's extra gesture, for its title and aria-description. */
const MIC_SCRUB_HINT = "Drag up or down (or press ↑/↓) to scroll back through the chat";
/** A minimized scrub shows this many lines at a time. */
const SCRUB_LINES = 3;
const POS_KEY = "lk:debug-chat-pos";
/** The chat bar: the page shows through at about half. */
const INPUT_BG = "color-mix(in oklch, var(--background) 55%, transparent)";

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
      if ((e.target as HTMLElement).closest("button:not([data-drag-handle]), textarea")) return;
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
      // Keep the chat bar on screen, up to the very top under the notch: its
      // rect at the start, moved by the delta. The click-through log above it
      // may go off-screen.
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
   * A press that began elsewhere (the mic, once it locked horizontally) moves
   * the box from here on, as if it had started on a handle at (px, py).
   */
  const begin = (px: number, py: number) => {
    setHolding(true);
    drag.current = { px, py, x: pos.x, y: pos.y, moved: false };
  };
  /**
   * Bring the chat bar back on screen, e.g. after restoring the box where the
   * minimized bar was, or on a smaller screen. Expanded, the bar will span the
   * box (its width still animating now), so the box's own edges count.
   */
  const fit = (box: HTMLElement | null, wide: boolean) => {
    const bar = box?.querySelector("[data-debug-chat-row]")?.getBoundingClientRect();
    if (!box || !bar) return;
    const full = box.getBoundingClientRect();
    const row = { left: wide ? full.left : bar.left, right: wide ? full.right : bar.right };
    const top = safeTop();
    const dx = row.left < 0 ? -row.left : row.right > innerWidth ? innerWidth - row.right : 0;
    const dy =
      bar.top < top ? top - bar.top : bar.bottom > innerHeight ? innerHeight - bar.bottom : 0;
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
    begin,
    wasDrag,
    holding,
    fit,
  };
}

/** env(safe-area-inset-left/right) in px (a landscape notch). */
function safeSides() {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)";
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const v = {
    left: Number.parseFloat(cs.paddingLeft) || 0,
    right: Number.parseFloat(cs.paddingRight) || 0,
  };
  probe.remove();
  return v;
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
  /** The state tree sheet's content (the tree button); without it, "No tree source". */
  renderTree?: () => ReactNode;
  /**
   * Minimized, three lines above the bar: the last done, in progress, next
   * (Frontier.tsx). Computed by the host.
   */
  frontier?: Frontier;
  /** Draws an assignee's avatar (the host's Avatar); else an initial on a hashed colour. */
  renderAvatar?: RenderAvatar;
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
  renderTree,
  frontier,
  renderAvatar,
}: DebugChatProps) {
  const [open, setOpen] = useState(() => {
    const v = read(OPEN_KEY);
    return v === null ? !location.pathname.startsWith("/words") : v === "1";
  });
  const [speak, setSpeak] = useState(speechEnabled);
  const { offset, handle, begin, wasDrag, holding, fit } = useDrag();
  /** The box: its bar is kept on screen, expanded or minimized. */
  const root = useRef<HTMLElement | null>(null);
  // Only expanding or minimizing refits (fit itself is fresh each render).
  /**
   * One panel at a time over the log: the menu (status, read-aloud, pages,
   * sessions; a double tap on the mark) or the state tree (the tree button).
   * Opening one closes the other.
   */
  const [panel, setPanel] = useState<"none" | "menu" | "tree">("none");
  const menu = panel === "menu";
  const tree = panel === "tree";
  const setMenu = (v: boolean) => setPanel((p) => (v ? "menu" : p === "menu" ? "none" : p));
  /** A wide screen (768px and up): the open tree is a column beside the log. */
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = matchMedia(WIDE_QUERY);
    setWide(mq.matches);
    const change = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  /** Wide, open and the tree up: `tree | log` side by side. */
  const twoCol = open && tree && wide;
  // Expanding, minimizing or widening refits (fit itself is fresh each render).
  useLayoutEffect(() => fit(root.current, open), [open, twoCol]);
  /** The floating box's side and left edge (px from the bar row's left), anchor.ts. */
  const [place, setPlace] = useState<{ side: AnchorSide; left: number }>({
    side: "left",
    left: 0,
  });
  const rowBox = useRef<HTMLDivElement | null>(null);
  const barEl = useRef<HTMLDivElement | null>(null);
  const floatBox = useRef<HTMLDivElement | null>(null);
  const placeRef = useRef(() => {});
  placeRef.current = () => {
    const bar = barEl.current?.getBoundingClientRect();
    const row = rowBox.current?.getBoundingClientRect();
    if (!bar || !row) return;
    const { left: insetLeft, right: insetRight } = safeSides();
    const p = placeBox({
      barLeft: bar.left,
      barRight: bar.right,
      boxWidth: floatBox.current?.getBoundingClientRect().width ?? 0,
      vw: document.documentElement.clientWidth || innerWidth,
      insetLeft,
      insetRight,
    });
    const next = { side: p.side, left: p.left - row.left };
    setPlace((cur) => (cur.side === next.side && cur.left === next.left ? cur : next));
  };
  // Re-placed when what it holds changes, after a drag, and on any resize
  // (window, rotation, the visual viewport, the box's own size). All events.
  useLayoutEffect(() => placeRef.current());
  useEffect(() => {
    const again = () => {
      placeRef.current();
      fitRef.current();
    };
    addEventListener("resize", again);
    addEventListener("orientationchange", again);
    visualViewport?.addEventListener("resize", again);
    return () => {
      removeEventListener("resize", again);
      removeEventListener("orientationchange", again);
      visualViewport?.removeEventListener("resize", again);
    };
  }, []);
  /** The box comes and goes: a ref callback watches each one's size. */
  const boxRo = useRef<ResizeObserver | null>(null);
  const setFloatBox = (el: HTMLDivElement | null) => {
    if (floatBox.current === el) return;
    boxRo.current?.disconnect();
    floatBox.current = el;
    if (el && typeof ResizeObserver !== "undefined") {
      boxRo.current = new ResizeObserver(() => placeRef.current());
      boxRo.current.observe(el);
    }
  };
  /** Keeps the box on screen (fit) on a resize: wide two columns too. */
  const fitRef = useRef(() => {});
  fitRef.current = () => fit(root.current, open);
  /** The tree's scroll, kept across the sheet ⇄ column switch. */
  const treeScroll = useRef(0);
  /** Until the host passes `renderTree`: the dev fragment at lk:tree-src (TreeFragment.tsx). */
  const fetchedTree = useTreeSource(tree && !renderTree);
  /** The tree overflows (or is scrolled): its top edge fades, as the log's. */
  const [treeFade, setTreeFade] = useState(false);
  const treeBodyEl = useRef<HTMLDivElement | null>(null);
  const onTreeScroll = () => {
    const el = treeBodyEl.current;
    if (!el) return;
    treeScroll.current = el.scrollTop;
    setTreeFade(el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0);
  };
  // Escape closes the tree. It is caught before the mic's own Escape (which
  // turns it off): closing the tree never does. (The tree is click-through, as
  // the log: taps outside it are the page's, and leave it open.)
  useEffect(() => {
    if (!tree) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPanel("none");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [tree]);
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
  /** Arrival order up to which the agent's lines count as read (see countUnread). */
  const [readSeq, setReadSeq] = useState(0);
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
  /**
   * The input grows with its text up to INPUT_MAX_PX (5 lines at 16px), then
   * scrolls inside itself. Empty, it is one line (rows=1, its CSS min height):
   * nothing is measured, since a placeholder measured in a narrow slot (the
   * bar minimized, or mid-transition) wraps to several lines — the 4-line
   * input seen on iOS. Measured from `height: auto`, and again whenever its
   * width changes (ResizeObserver: expanding, rotating).
   */
  const fitInput = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = "";
    if (!el.value || el.clientWidth < 40) return;
    el.style.height = "auto";
    // scrollHeight leaves out the border; the box's height includes it.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, INPUT_MAX_PX)}px`;
  };
  useEffect(() => {
    const el = input.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitInput();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    fitInput();
    if (caretToEnd.current) {
      caretToEnd.current = false;
      const end = el.value.length;
      el.setSelectionRange(end, end);
      el.scrollTop = el.scrollHeight;
    }
  }, [draft, open]);
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
  // The tree's fade follows its size: on opening, switching mode, expanding.
  useLayoutEffect(() => {
    if (tree) onTreeScroll();
  }, [tree, twoCol, typing, micActive]);
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
      setPanel("none");
      toggle(!open);
    },
    double: () => setPanel((p) => (p === "menu" ? "none" : "menu")),
  };
  /**
   * Minimized, the log is hidden and messages float above the bar instead
   * (float-lines.ts): those that arrive while minimized, or the lines a scrub
   * on the mic brings back. Each fades on its own after its dwell.
   */
  const [floats, setFloats] = useState<ChatMessage[]>([]);
  /** Bumped on each scrub step and release: every floating line's dwell starts over. */
  const [floatEpoch, setFloatEpoch] = useState(0);
  /** Hovered or touched, or a scrub under way: the dwell timers wait. */
  const [floatHover, setFloatHover] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  /** How many lines back from the newest the scrub is (0 = the newest SCRUB_LINES). */
  const back = useRef(0);
  /** When each message first reached this widget (float-lines.ts createArrivals). */
  const arrivals = useRef<ReturnType<typeof createArrivals> | null>(null);
  arrivals.current ??= createArrivals();
  const wasOpen = useRef(open);
  useEffect(() => {
    const now = Date.now();
    const { fresh, history } = (arrivals.current ??= createArrivals()).see(messages, now);
    // Open, everything is read; so is the history loading in.
    if (open || history) setReadSeq(arrivals.current.seq());
    const minimizing = wasOpen.current && !open;
    wasOpen.current = open;
    if (open) {
      back.current = 0;
      setFloats([]);
      return;
    }
    if (minimizing) {
      // Just minimized: the latest message floats as if unread, its dwell
      // starting now (its FloatLine mounts with this render).
      const last = minimizeFloat(messages, now, arrivals.current.at);
      setFloats(last ? [last] : []);
      setFloatEpoch((e) => e + 1);
      return;
    }
    // Every message that reaches us while minimized floats, either way (own
    // sends, typed or spoken, and replies) — never the history loading in.
    if (history || !fresh.length) return;
    setFloats((f) =>
      [...f.filter((x) => !fresh.some((y) => y.id === x.id)), ...fresh].slice(-FLOAT_MAX),
    );
  }, [messages, open]);
  const dropFloat = (id: string) =>
    setFloats((f) => {
      const next = f.filter((x) => x.id !== id);
      if (!next.length) back.current = 0;
      return next;
    });
  /** Show the SCRUB_LINES lines that end `n` back from the newest. */
  const scrubTo = (n: number) => {
    back.current = n;
    const end = messages.length - n;
    setFloats(messages.slice(Math.max(0, end - SCRUB_LINES), end));
    setFloatEpoch((e) => e + 1);
  };
  /**
   * A press on the mic: a tap toggles it (MicButton); locked vertically it
   * scrubs the history (minimized) or scrolls the log (expanded); locked
   * horizontally it moves the box. Either lock swallows the click.
   */
  const micAxis = useRef(createAxisLock());
  const micDragged = useRef(createDragFlag());
  const micPress = useRef({ x: 0, y: 0, back: 0, scroll: 0 });
  const micGesture = {
    description: MIC_SCRUB_HINT,
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      micAxis.current.down(e.clientX, e.clientY);
      micDragged.current.down();
      micPress.current = {
        x: e.clientX,
        y: e.clientY,
        back: floats.length ? back.current : 0,
        scroll: log.current?.scrollTop ?? 0,
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const was = micAxis.current.axis();
      const m = micAxis.current.move(e.clientX, e.clientY);
      if (!m) return;
      if (m.axis === "x") {
        if (!was) begin(micPress.current.x, micPress.current.y);
        handle.onPointerMove(e);
        return;
      }
      if (open) {
        const list = log.current;
        if (list) list.scrollTop = micPress.current.scroll - m.dy;
        return;
      }
      if (!was) setScrubbing(true);
      const n = scrubBack(micPress.current.back, m.dy, Math.max(0, messages.length - 1));
      if (!was || n !== back.current) scrubTo(n);
    },
    onPointerUp: () => {
      const axis = micAxis.current.up();
      if (!axis) return;
      micDragged.current.dragEnded();
      if (axis === "x") handle.onPointerUp();
      else if (!open) {
        setScrubbing(false);
        setFloatEpoch((e) => e + 1); // the dwell starts over from the release
      }
    },
    onPointerCancel: () => {
      const axis = micAxis.current.up();
      if (axis === "x") handle.onPointerCancel();
      if (axis === "y") setScrubbing(false);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (open || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const from = floats.length ? back.current : -1;
      const n = Math.max(0, Math.min(Math.max(0, messages.length - 1), from + (e.key === "ArrowUp" ? 1 : -1)));
      scrubTo(n);
    },
    wasDrag: () => micDragged.current.wasDrag(),
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
  /** Room at the input's right end for the busy spinner. */
  const inputPad = busy ? "pe-6" : "pe-2";
  const unread = countUnread(messages, (id) => arrivals.current?.seqOf(id), readSeq);
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
   * The bar's controls, left of the input: drag any of them (or the bar's
   * edge) to move the box. The liagent mark: a tap minimizes or restores
   * (after 280 ms), a double tap opens the menu. The tree button opens the
   * state tree sheet (with the eval/preview sessions' count on it). Each is its
   * own drag handle, so its click still lands on it. The mic is the bar's last control (micEl).
   */
  const controls = (
    <>
      <button
        type="button"
        data-drag-handle
        data-testid="debug-chat-pill-min"
        aria-label={open ? "Minimize chat" : `Restore chat${unread ? `, ${unread} new` : ""}`}
        aria-description={MARK_HINT}
        title={MARK_HINT}
        aria-expanded={open}
        {...handle}
        onPointerDown={(e) => {
          unlockSpeech();
          handle.onPointerDown(e);
        }}
        onClick={() => !wasDrag() && gripTaps.current?.tap()}
        style={handle.style}
        className="tap-40 relative flex h-8 w-10 shrink-0 items-center justify-center rounded-full"
      >
        <LiagentMark size={18} />
        <span
          aria-hidden
          className="absolute end-1.5 top-1 size-1.5 rounded-full"
          style={{ background: dot }}
        />
      </button>
      <button
        type="button"
        data-drag-handle
        data-testid="debug-chat-tree-button"
        aria-label="State tree"
        aria-description={evalSessions.length ? conns : undefined}
        aria-expanded={tree}
        aria-controls="debug-chat-tree"
        {...handle}
        // Keeps the input's focus (and its draft): the sheet only looks.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => !wasDrag() && setPanel((p) => (p === "tree" ? "none" : "tree"))}
        style={handle.style}
        className="tap-40 relative flex h-8 w-10 shrink-0 items-center justify-center rounded-full text-base"
      >
        <TreeIcon />
        {evalSessions.length > 0 && (
          // The eval/preview sessions, as before: their count, pulsing when code just ran.
          <span
            aria-hidden
            data-testid="debug-chat-evals"
            className={`absolute end-0.5 top-0 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[8px] leading-none text-white tabular-nums ${evalRan ? "animate-pulse" : ""}`}
            style={{ background: "oklch(0.55 0.15 30)" }}
          >
            {evalSessions.length}
          </span>
        )}
      </button>
    </>
  );
  /**
   * The mic, after the input: at the bar's far right when expanded, and next
   * to the connections when minimized (the input's slot is 0 wide then). It is
   * always this one node, so its live state and gestures survive the switch.
   */
  const micEl = (
    <>
      {hasMic && !notice && (
        // Mounted in both states, as the same node: hands-free voice goes on
        // while minimized.
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
          gesture={micGesture}
        />
      )}
    </>
  );
  /**
   * The state tree, shown as the log is (log-surface.ts): no box, translucent
   * text with the halo, click-through except for rows that opt in, the same
   * fade and the same compact/expanded rule. On a phone (or minimized) it
   * takes the log's place; on a wide screen with the chat open it is the left
   * column beside the log (`twoCol`). Its scroll carries over between the
   * two; ✕ (or the tree button, or Escape) closes it, never taking the
   * input's focus. Fades in (opacity; at once under reduced motion).
   */
  const treePanel = (column: boolean) => (
    <div
      id="debug-chat-tree"
      role="region"
      aria-label="State tree"
      data-testid="debug-chat-tree"
      data-mode={column ? "column" : "inline"}
      data-tree-col={column || undefined}
      className="pointer-events-none relative flex min-w-0 flex-col transition-opacity duration-[180ms] starting:opacity-0 motion-reduce:transition-none"
    >
      <button
        type="button"
        data-testid="debug-chat-tree-close"
        aria-label="Close the state tree"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPanel("none")}
        className="tap-40 pointer-events-auto absolute end-0 top-0 z-10 px-1.5 text-[10px] text-gray-500"
      >
        ✕
      </button>
      <div
        ref={(el) => {
          // The inline tree and the column are different nodes: the scroll carries over.
          if (el && el !== treeBodyEl.current) el.scrollTop = treeScroll.current;
          treeBodyEl.current = el;
        }}
        data-testid="debug-chat-tree-body"
        onScroll={onTreeScroll}
        {...logSurface({ expanded: typing || micActive, fade: treeFade })}
      >
        {renderTree?.() ??
          (fetchedTree ? (
            <TreeFragment state={fetchedTree} />
          ) : (
            <p data-testid="debug-chat-tree-empty" className="text-gray-500">
              No tree source
            </p>
          ))}
      </div>
    </div>
  );
  const floatsEl = floats.length > 0 && (
        // Minimized: the lines that arrived (or a scrub brought back), newest
        // at the bottom, each fading on its own. Hover or touch holds them.
        <ol
          data-testid="debug-chat-floats"
          aria-live="polite"
          className={`flex flex-col gap-0.5 ${ALIGN_ITEMS[place.side]}`}
        >
          {floats.map((m) => (
            <FloatLine
              key={m.id}
              m={m}
              epoch={floatEpoch}
              paused={floatHover || scrubbing}
              onHover={setFloatHover}
              onGone={() => dropFloat(m.id)}
            />
          ))}
        </ol>
  );
  /**
   * Minimized: the floating lines, the frontier and the tree hang over the
   * bar in one box, on the bar's side of the screen (anchor.ts), clamped
   * inside the viewport.
   */
  const floatBoxEl = !open && (floats.length > 0 || !!frontier || tree) && (
    <div
      ref={setFloatBox}
      data-testid="debug-chat-float-box"
      data-side={place.side}
      style={{ left: place.left, textAlign: TEXT_ALIGN[place.side] }}
      className={`pointer-events-none absolute bottom-full mb-1 flex w-max max-w-[min(20rem,calc(100vw-16px))] flex-col gap-1 ${ALIGN_ITEMS[place.side]}`}
    >
      {tree && treePanel(false)}
      {floatsEl}
      {frontier && (
        <FrontierLines frontier={frontier} renderAvatar={renderAvatar} align={place.side} />
      )}
    </div>
  );
  /** The menu (a double tap on the mark), open or minimized. */
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

  return (
    <section
      ref={root}
      data-debug-chat
      // Minimized keeps its old test id: the bar alone, plus floating lines.
      data-testid={open ? "debug-chat" : "debug-chat-minimized"}
      data-minimized={!open || undefined}
      aria-label="Chat with the agent"
      onPointerDown={unlockSpeech}
      onKeyDown={unlockSpeech}
      // A live mic counts as focus: the box goes opaque as it does while typing.
      // Wide with the tree open: twice as wide, two columns, opaque glass.
      data-two-col={twoCol || undefined}
      style={offset}
      className={`fixed right-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 transition-opacity ${twoCol ? `w-[min(44rem,calc(100vw-1rem))] ${micActive ? "opacity-100" : "opacity-60 focus-within:opacity-100 active:opacity-100"} ${TWO_COL}` : `flex w-[min(20rem,calc(100vw-1rem))] flex-col rounded-xl ${micActive ? "opacity-100" : "opacity-60 focus-within:opacity-100 active:opacity-100"}`} pointer-events-none lk-halo text-xs text-gray-800 dark:text-gray-100`}
    >
      {open && tree && treePanel(twoCol)}
      <ol
        ref={log}
        data-testid="debug-chat-log"
        onScroll={onLogScroll}
        data-fade={fade || undefined}
        data-expanded={typing || undefined}
        // Hidden minimized, and on a phone while the tree shows in its place.
        hidden={!open || (tree && !twoCol)}
        onTransitionEnd={() => {
          // Shrunk: land on the newest lines again, now that the height settled.
          if (!typing && !micActive) log.current?.scrollTo({ top: log.current.scrollHeight });
          onLogScroll();
        }}
        {...logSurface({ expanded: typing || micActive, fade })}
      >
        {messages.length === 0 && (
          <li className="text-gray-500">Type here; it is sent 3 s after you stop.</li>
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
                title="The agent is offline: this is delivered when it is back"
              >
                · waiting for the agent
              </span>
            )}
          </li>
        ))}
      </ol>
      {open && warning && (
        <div
          role="alert"
          data-testid="debug-chat-warning"
          className="px-2 pt-1 text-[10px]"
          style={{ color: "oklch(0.6 0.17 45)" }}
        >
          {warning}
        </div>
      )}
      {/* The log above is click-through: taps reach the page under it. Only the
      bar takes pointer events. Its width animates as two grid columns, the
      bar's and a spacer's, trading 1fr ⇄ 0fr: minimized, the bar's column is
      only as wide as its controls (the input's slot is 0 wide). */}
      <div
        ref={rowBox}
        // 180 ms; reduced motion switches at once.
        className="relative grid transition-[grid-template-columns] duration-[180ms] ease-out motion-reduce:transition-none"
        // Settled: measure the input again at its full width, and place the
        // floating box against the bar's final size.
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          fitInput();
          placeRef.current();
        }}
        style={{ gridTemplateColumns: open ? "1fr 0fr" : "0fr 1fr" }}
      >
        {open && scrolledUp && (
          // The row stays click-through; only the button takes taps.
          <div className="pointer-events-none absolute inset-x-0 bottom-full mb-1 flex justify-end">
            <button
              type="button"
              data-testid="debug-chat-bottom"
              // Keeps the input's focus, so the log stays open.
              onPointerDown={(e) => e.preventDefault()}
              aria-label={
                below ? `Scroll to the newest message, ${below} new` : "Scroll to the newest message"
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
        {/* One container: [minimize | connections | input | mic]; minimized, the
        input's slot closes to 0 and leaves [minimize | connections | mic]. No title bar:
        the mark drags the box, minimizes it and opens the menu (status,
        read-aloud, pages, sessions); its dot is the connection. No End chat
        here: the chat hibernates and wakes by itself. */}
        <div
          ref={barEl}
          data-debug-chat-row
          data-testid="debug-chat-pill"
          data-debug-chat-pill
          title={status}
          // The bar's own edge drags too; its buttons and the input handle themselves.
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button, textarea, p")) return;
            handle.onPointerDown(e);
          }}
          onPointerMove={(e) => e.target === e.currentTarget && handle.onPointerMove(e)}
          onPointerUp={(e) => e.target === e.currentTarget && handle.onPointerUp()}
          onPointerCancel={(e) => e.target === e.currentTarget && handle.onPointerCancel()}
          style={{ background: INPUT_BG }}
          className={`pointer-events-auto relative flex items-end rounded-[1.125rem] border border-current/25 text-gray-600 backdrop-blur-md backdrop-saturate-150 dark:text-gray-300 ${open ? "p-0.5" : "p-px"}`}
        >
          {armed > 0 && (
            <div
              key={armed}
              aria-hidden
              className="lk-drain absolute inset-x-3 top-0 h-0.5 bg-blue-600/60"
            />
          )}
          {controls}
          {/* The input: gone while minimized (inert, so it can't take focus or
          be read), fading out as its slot closes. */}
          <div
            data-testid="debug-chat-input-slot"
            inert={!open}
            aria-hidden={!open || undefined}
            className={`relative flex w-0 min-w-0 flex-1 transition-opacity duration-[180ms] ease-out motion-reduce:transition-none ${open ? "opacity-100" : "max-h-8 overflow-hidden opacity-0"}`}
          >
            {notice ? (
              <p
                role="status"
                data-testid="debug-chat-notice"
                className="min-w-0 flex-1 px-2 py-2 text-gray-600 dark:text-gray-400"
              >
                {notice}
              </p>
            ) : (
              <>
                {interim && (
                  // A mirror of the draft, invisible, then the interim text dimmed:
                  // it shows where the transcript will land.
                  <div
                    ref={mirror}
                    aria-hidden
                    className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border border-transparent px-2 py-1 text-base ${inputPad}`}
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
                          ? "Message the agent…"
                          : "Agent offline — your message waits for it…"
                  }
                  onScroll={(e) => {
                    if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
                  }}
                  aria-label="Message the agent"
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
                  // A drag on a long draft scrolls its text, never the page or the box.
                  className={`block h-[2.125rem] max-h-32 min-h-[2.125rem] min-w-0 flex-1 resize-none self-end overflow-y-auto overscroll-contain touch-pan-y border border-transparent bg-transparent px-2 py-1 text-base outline-none placeholder:text-gray-400 ${inputPad}`}
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
              </>
            )}
          </div>
          {micEl}
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
        <span aria-hidden />
        {floatBoxEl}
        {menuEl}
      </div>
    </section>
  );
}

/** An outline tree (a root and two branches), for the state tree button. */
function TreeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="10" width="7" height="4.5" rx="1.5" />
      <rect x="14" y="16.5" width="7" height="4.5" rx="1.5" />
      <path d="M6.5 8v10.75H14M6.5 12.25H14" />
    </svg>
  );
}

/**
 * One floating line of the minimized chat: "name: text", up for its dwell
 * (float-lines.ts), then a slow opacity fade (none under reduced motion).
 * `epoch` restarts it; `paused` holds it, back at full opacity if fading.
 */
function FloatLine({
  m,
  epoch,
  paused,
  onHover,
  onGone,
}: {
  m: ChatMessage;
  epoch: number;
  paused: boolean;
  onHover: (on: boolean) => void;
  onGone: () => void;
}) {
  const [phase, setPhase] = useState<FloatPhase>("dwell");
  const life = useRef<ReturnType<typeof createFloatLife> | null>(null);
  const live = useRef({ paused, onGone });
  live.current = { paused, onGone };
  // A new epoch (a scrub step or its release) starts the line over: full dwell, then the fade.
  useEffect(() => {
    setPhase("dwell");
    const l = createFloatLife({
      ms: dwellMs(m.text),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      paused: live.current.paused,
      onPhase: (p) => (p === "gone" ? live.current.onGone() : setPhase(p)),
    });
    life.current = l;
    return () => l.cancel();
  }, [epoch, m.id, m.text]);
  useEffect(() => {
    if (paused) life.current?.pause();
    else life.current?.resume();
  }, [paused]);
  const fading = phase === "fade";
  return (
    <li
      data-testid="debug-chat-float"
      data-from={m.from}
      data-fading={fading || undefined}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onPointerCancel={() => onHover(false)}
      // Text only, with a strong halo: no background, no box (they float over the page).
      style={{ textShadow: LINE_HALO, transitionDuration: `${FADE_MS}ms` }}
      // The fade runs FADE_MS (ease-out, opacity only); held (touched), the line
      // snaps back to full at once. Reduced motion: no fade, it just goes.
      className={`${fading ? "opacity-0 transition-opacity ease-out" : "opacity-100 transition-none"} pointer-events-auto line-clamp-3 max-w-full whitespace-pre-wrap break-words py-0.5 leading-snug motion-reduce:transition-none`}
    >
      <span
        className="me-1 font-medium"
        style={{ color: m.from !== "agent" ? "oklch(0.55 0.13 250)" : "oklch(0.55 0.14 150)" }}
      >
        {m.from !== "agent" ? "you" : m.label || "agent"}:
      </span>
      {m.text}
    </li>
  );
}
