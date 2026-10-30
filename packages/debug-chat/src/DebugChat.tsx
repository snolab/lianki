"use client";

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type ChatMessage,
  MAX_CHAT,
  type PageInfo,
  type ChatStrings,
  type PairInfo,
  chatStrings,
  ROOT_NODE,
  type Sender,
  completeNode,
  dictatedDraft,
  draftSource,
  lineNode,
  type MessageSource,
  nodePath,
  pageParts,
  parseAddress,
  pathLabel,
  type VoiceTiming,
} from "./wire";
import { latencyRows, voiceLatency } from "./latency";
import { getKey, setKey } from "./storage-keys";
import { LiagentMark } from "./LiagentMark";
import { Avatar } from "./Avatar";
import { type AvatarSource, lineAvatar } from "./avatar-rules";
import {
  CLIP_SINK_KEY,
  VOICE_SENT_EVENT,
  appendDictation,
  isDictationBurst,
  clipSinkFrom,
  joinText,
} from "./mic";
import { LOCAL_STT_KEY, localSttFrom } from "./local-stt";
import { learnSttHint } from "./stt-hint";
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
import { Icon, POLISHED_ICON } from "./icons";
import { PolishedMark } from "./PolishedMark";
import { LINE_HALO, logSurface } from "./log-surface";
import { treeDefaults, uiStrings } from "./ui-strings";
import { TreeChips, navIndexOf } from "./TreeChips";
import {
  type TreeNavEvent,
  type TreeNavState,
  dragCells,
  dragOffset,
  initialNav,
  maxDetent,
  pinRow,
  pinScroll,
  treeNav,
} from "./tree-nav";
import { SPEECH_RATES, setSpeechRate, speechRate } from "./speech-rate";
import { type AnchorSide, placeBox } from "./anchor";
import { TreeFragment, useTreeSource as useFragmentSource } from "./TreeFragment";
import { FrontierLines, type RenderAvatar } from "./Frontier";
import type { Frontier } from "./frontier-view";
import {
  type TreeSource,
  type TreeStrings,
  treeStrings,
  useTreeSource,
} from "./StateTree";
import { type TreeNode, crumbs, frontier as frontierOf } from "./state-tree";

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
/**
 * The minimized bar's lines from a tree (state-tree.ts frontier()), in the
 * shape the bar draws (frontier-view.ts): a group as its ≈ summary and count,
 * its items with breadcrumbs and assignees; one item as its title.
 */
function toFrontierView(root: TreeNode | null): Frontier | undefined {
  if (!root) return undefined;
  const f = frontierOf(root);
  const line = (e: (typeof f)["done"]) =>
    e && {
      text: e.count > 1 && e.summary ? e.summary : e.title,
      count: e.count,
      assignee: e.assignee,
      items:
        e.count > 1 ? e.items.map((it) => ({ title: it.title, path: crumbs(it.path), assignee: it.assignee })) : undefined,
    };
  const out: Frontier = {};
  if (f.done) out.done = line(f.done);
  if (f.doing) out.doing = line(f.doing);
  if (f.next) out.next = line(f.next);
  return out.done || out.doing || out.next ? out : undefined;
}

/** Surface props with extra classes. */
const withClass = <T extends { className: string }>(p: T, cls: string): T => ({
  ...p,
  className: `${p.className} ${cls}`,
});
/** The tree button's gestures, for its title and aria-description. */
const TREE_HINT =
  "Tap: show or hide the state tree · drag right: open the focused node deeper · drag left: fold it · arrow keys: move";
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
    // Not laid out as the overlay yet (a hot-loaded widget's CSS still on its
    // way): its rect means nothing, and a refit would save a wild offset.
    if (getComputedStyle(box).position !== "fixed") return;
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

/** Legacy `lk:debug*` names; storage-keys reads `lk:agent*` first and writes both. */
const read = (key: string) => getKey(key);
const write = (key: string, v: string) => setKey(key, v);
const synth = () => (typeof speechSynthesis === "undefined" ? null : speechSynthesis);

/** The window event that sets the chat's target node (`detail`: a node path; "/" = main thread). */
export const CHAT_TARGET_EVENT = "lk:debug-chat-target";
/**
 * Address the chat's next messages to a state-tree node (the state tree's
 * selection calls this), or back to the main thread with "/". Also on
 * `globalThis.__lkDebugChat.setTarget`, for code that cannot import it.
 */
export function setTarget(path: string) {
  if (typeof window === "undefined") return;
  keepTarget(nodePath(path) ?? ROOT_NODE);
  window.dispatchEvent(new CustomEvent(CHAT_TARGET_EVENT, { detail: path }));
}
/**
 * The target outlives the component on the window: a hot-loaded widget
 * re-mounts on every rebuild (and may mount after a setTarget call).
 */
type TargetHolder = { __lkDebugChatTarget?: string };
const keptTarget = () =>
  typeof window === "undefined"
    ? ROOT_NODE
    : ((window as unknown as TargetHolder).__lkDebugChatTarget ?? ROOT_NODE);
const keepTarget = (p: string) => {
  if (typeof window !== "undefined") (window as unknown as TargetHolder).__lkDebugChatTarget = p;
};
if (typeof window !== "undefined")
  (window as unknown as { __lkDebugChat?: { setTarget: typeof setTarget } }).__lkDebugChat = {
    setTarget,
  };


/**
 * Read an agent reply aloud (voice.ts): queued behind any still being read,
 * one utterance per sentence, in the voice its script suggests. Only ever
 * called for a reply that arrived live, never for history. With the mic on it
 * is always read; otherwise only to someone typing here with the speaker on.
 * DebugEval calls this bundled copy; the hot-loaded chat shares the session.
 */
export function speakReply(text: string): boolean {
  return voice().reply(text);
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
  /**
   * Send a line; `to` is the state-tree node it is addressed to (absent = the
   * main thread). `opts.source` is "stt" when the line is the mic's text, unchanged;
   * then `opts.timing` carries its timestamps (latency.ts), when the mic left any.
   */
  onSend: (
    text: string,
    to?: string,
    opts?: { source?: MessageSource; timing?: VoiceTiming },
  ) => boolean;
  /** The nodes listeners are subscribed at: "@/…" completions. */
  nodes?: string[];
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
  /**
   * The tree panel's content, overriding `treeSource` (a host's own view).
   * Without either: the dev fragment at lk:tree-src, else "No tree source".
   */
  renderTree?: () => ReactNode;
  /**
   * Minimized, three lines above the bar: the last done, in progress, next
   * (Frontier.tsx). Overrides the lines computed from `treeSource`
   * (state-tree.ts frontier()).
   */
  frontier?: Frontier;
  /** Draws an assignee's avatar (the host's Avatar); else an initial on a hashed colour. */
  renderAvatar?: RenderAvatar;
  /**
   * The state tree (StateTree.tsx): a URL serving its markdown, or a function
   * returning markdown or nodes, or a feed. Shown by the tree button (and
   * the menu's "Tree"); loaded again each time the tree opens. Its frontier
   * feeds the minimized bar's lines.
   */
  treeSource?: TreeSource;
  /** `owner/repo` that a bare `#123` in the tree links to. */
  treeRepo?: string;
  /** The tree's strings, localized by the host (English defaults). */
  treeStrings?: Partial<TreeStrings>;
  /**
   * The agent's avatar on its lines: the host app's logo, as a URL or an
   * element. Absent: the agent name's initial.
   */
  agentAvatar?: AvatarSource;
  /** The viewer (hashed id, name, pictures in fallback order): their own lines' avatar. */
  viewer?: Sender;
  /** The host's own avatar for a line (its pictures are tried first). */
  avatarFor?: (m: ChatMessage) => Sender | undefined;
  /** The mark on a voice line the agent polished (default POLISHED_ICON, a sparkle). */
  polishedIcon?: ReactNode;
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

/** A log line's avatar, square: fixed, so a picture loading late shifts nothing. */
const AVATAR_PX = 18;

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
  renderTree,
  frontier,
  renderAvatar,
  treeSource,
  treeRepo,
  treeStrings: hostTreeText,
  agentAvatar,
  viewer,
  avatarFor,
  nodes = [],
  polishedIcon = POLISHED_ICON,
}: DebugChatProps) {
  const t = chatStrings(strings);
  const [open, setOpen] = useState(() => {
    const v = read(OPEN_KEY);
    return v === null ? !location.pathname.startsWith("/words") : v === "1";
  });
  const [speak, setSpeak] = useState(speechEnabled);
  /** How fast replies are read (speech-rate.ts; per device, default 1.5×). */
  const [rate, setRate] = useState(speechRate);
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
  // Expanding, minimizing or opening the tree refits (fit itself is fresh each render).
  useLayoutEffect(() => fit(root.current, open), [open, tree]);
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
  /** Keeps the box on screen (fit) on a resize. */
  const fitRef = useRef(() => {});
  fitRef.current = () => fit(root.current, open);
  /** The tree's scroll, kept across the sheet ⇄ column switch. */
  const treeScroll = useRef(0);
  /** Bumped each time the tree opens: the source loads again (never polled). */
  const [treeRev, setTreeRev] = useState(0);
  useEffect(() => {
    if (tree) setTreeRev((n) => n + 1);
  }, [tree]);
  /** The host's tree (StateTree.tsx), loaded while it is open or the bar shows its frontier. */
  const treeData = useTreeSource(treeSource, treeRev, treeRepo);
  /** Without a host tree: the dev fragment at lk:tree-src (TreeFragment.tsx). */
  const fetchedTree = useFragmentSource(tree && !renderTree && !treeSource);
  /** The widget's strings for the page's language (ui-strings.ts), under the host's. */
  const ui = uiStrings();
  /** The latest voice → reply breakdown (latency.ts), for the menu. */
  const [lastLatency, setLastLatency] = useState(() => voiceLatency().latest());
  useEffect(() => {
    const s = voiceLatency();
    setLastLatency(s.latest());
    return s.subscribe(() => setLastLatency(s.latest()));
  }, []);
  const treeText = { ...treeDefaults(), ...hostTreeText };
  /** The tree as treeNav sees it (index-path ids), and where its focus and depths are. */
  const navIx = useMemo(() => navIndexOf(treeData.root), [treeData.root]);
  const [nav, setNav] = useState<TreeNavState>(() => initialNav(navIx.ix));
  // A reloaded tree keeps the focus if that node is still there.
  useEffect(() => {
    setNav((s) =>
      s.focusId !== null && navIx.ix.parent.has(s.focusId) ? s : initialNav(navIx.ix),
    );
  }, [navIx]);
  /**
   * Rows' tops before a nav step (and which rows were on screen), so the step
   * can keep a row still: the focused one, or the one it folded into.
   */
  const navBefore = useRef<{
    tops: Map<string, number>;
    shown: Set<string>;
    prevFocus: string | null;
    expand: boolean;
  } | null>(null);
  /** The user scrolled the column just now: a nav step does not scroll it. */
  const userScrollAt = useRef(0);
  const depthSum = (e: Readonly<Record<string, number>>) =>
    Object.values(e).reduce((a, b) => a + b, 0);
  /** The minimized tree's own scroller (the floating box's tree body). */
  const treeBodyEl = useRef<HTMLDivElement | null>(null);
  /**
   * Minimized, the tree body takes its full height (30vh) from the first
   * drag until the tree closes: the floating box hangs from the bar, so a
   * body that resized with each level would move the whole tree up and down.
   */
  const [treeTall, setTreeTall] = useState(false);
  useEffect(() => {
    if (!tree) setTreeTall(false);
  }, [tree]);
  /** The tree's scroller: the chat's column expanded, its own body minimized. */
  const treeScroller = () => (open ? log.current : treeBodyEl.current);
  const navTo = (ev: TreeNavEvent) => {
    const el = treeScroller();
    const tops = new Map<string, number>();
    const shown = new Set<string>();
    const box = el?.getBoundingClientRect();
    for (const r of el?.querySelectorAll<HTMLElement>("[data-testid=tree-chips] [data-id]") ?? []) {
      const rr = r.getBoundingClientRect();
      tops.set(r.dataset.id!, rr.top);
      if (box && rr.bottom > box.top && rr.top < box.bottom) shown.add(r.dataset.id!);
    }
    setNav((s) => {
      const next = treeNav(navIx.ix, s, ev);
      // Nothing changed: no render follows, so nothing to anchor.
      if (next !== s)
        navBefore.current = {
          tops,
          shown,
          prevFocus: s.focusId,
          expand: depthSum(next.expanded) > depthSum(s.expanded),
        };
      return next;
    });
  };
  // After a step. While dragging (and on any fold) the row the eye is on
  // stays still — the focused one, else the one it folded into (pinRow) — so
  // the tree grows and shrinks around it instead of jumping. A tap or key
  // that expands brings the focused node and its new children into view
  // instead (unless the user is scrolling), as does a drag whose focus was
  // off screen when it began.
  useLayoutEffect(() => {
    const b = navBefore.current;
    navBefore.current = null;
    const el = treeScroller();
    if (!b || !el || nav.focusId === null) return;
    const rowOf = (id: string) =>
      el.querySelector<HTMLElement>(`[data-testid=tree-chips] [data-id="${id}"]`);
    const pin = pinRow({ focusId: b.prevFocus }, nav, b.shown);
    if (pin !== null && (nav.base !== undefined || !b.expand)) {
      const pinned = rowOf(pin);
      const was = b.tops.get(pin);
      if (pinned && was !== undefined)
        el.scrollTop = pinScroll({
          before: was,
          after: pinned.getBoundingClientRect().top,
          scrollTop: el.scrollTop,
          maxScroll: el.scrollHeight - el.clientHeight,
        });
      return;
    }
    const row = rowOf(nav.focusId);
    if (!row) return;
    if (b.expand) {
      if (Date.now() - userScrollAt.current < 600) return;
      const branch = row.closest("li") ?? row;
      const lines = el.querySelectorAll<HTMLElement>(
        `[data-testid=tree-line][data-id^="${nav.focusId}."]`,
      );
      const last = lines[lines.length - 1] ?? branch;
      const top = row.getBoundingClientRect().top;
      const bottom = last.getBoundingClientRect().bottom;
      const box = el.getBoundingClientRect();
      if (bottom > box.bottom) el.scrollTop += Math.min(bottom - box.bottom, top - box.top);
      else if (top < box.top) el.scrollTop -= box.top - top;
    }
  }, [nav, open]);
  /** The minimized bar's lines: the host's, else the tree's frontier. */
  const shownFrontier = frontier ?? toFrontierView(treeData.root);
  /** The tree overflows (or is scrolled): its top edge fades, as the log's. */
  const [treeFade, setTreeFade] = useState(false);
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
  /** The node the next line goes to: the chip in the bar ("/" = the main thread, no chip). */
  const [target, setTargetState] = useState(keptTarget);
  const targetRef = useRef(target);
  const aim = (p: string) => {
    const n = nodePath(p) ?? ROOT_NODE;
    targetRef.current = n;
    keepTarget(n);
    setTargetState(n);
  };
  useEffect(() => {
    const on = (e: Event) => aim(String((e as CustomEvent).detail ?? ROOT_NODE));
    window.addEventListener(CHAT_TARGET_EVENT, on);
    return () => window.removeEventListener(CHAT_TARGET_EVENT, on);
  }, []);
  /** Re-keys the drain bar on each keystroke; 0 while nothing is waiting. */
  const [armed, setArmed] = useState(0);
  const [offline, setOffline] = useState(false);
  /** Arrival order up to which the agent's lines count as read (see countUnread). */
  const [readSeq, setReadSeq] = useState(0);
  const draftRef = useRef("");
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The chat's one scroller: the tree (when open) and the log. */
  const log = useRef<HTMLDivElement | null>(null);
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
    let text = draftRef.current.trim();
    // A leading "@/words › prefetch " addresses that node, and keeps it as the target.
    const addr = parseAddress(text);
    let to = targetRef.current;
    if (addr) {
      if (!addr.complete) return false;
      to = addr.to;
      aim(to);
      text = addr.text;
      if (!text) {
        draftRef.current = "";
        setDraft("");
        return false;
      }
    }
    if (!text) return false;
    const source = draftSource(draftRef.current, pureDictation.current);
    // A voice line carries its timestamps (latency.ts): the latest utterance in it.
    const timing = source ? voiceLatency().take() : undefined;
    if (
      !sendRef.current(
        text,
        to === ROOT_NODE ? undefined : to,
        source ? { source, ...(timing ? { timing } : {}) } : undefined,
      )
    ) {
      setOffline(true);
      return false;
    }
    setOffline(false);
    // A typed line says which language the owner speaks: the mic's STT hint.
    if (!source) learnSttHint(text);
    // Sent: an interruption is over, and the queue (still relevant) reads on.
    voice().resume();
    draftRef.current = "";
    pureDictation.current = null;
    settledLen.current = 0;
    setDraft("");
    return true;
  };
  /**
   * The draft as dictation left it, while nothing typed is in it (else null):
   * a line sent while the draft still equals it is the mic's, `source: "stt"`.
   */
  const pureDictation = useRef<string | null>(null);
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
  }, [tree, open, typing, micActive]);
  const micPending = useRef(0);
  /** This browser can capture (the mic button shows inside the input). */
  const [hasMic, setHasMic] = useState(false);
  useEffect(() => setHasMic(canCapture()), []);
  /** Dimmed after the draft: partial transcripts, or "…" for those still out. */
  const [interim, setInterim] = useState("");
  const mirror = useRef<HTMLDivElement | null>(null);
  /** A transcript lands in the draft, as typed text would, but is never sent by itself. */
  const dictated = (t: string) => {
    voiceLatency().shown();
    const { draft: next, send } = appendDictation(draftRef.current, t);
    pureDictation.current = dictatedDraft(draftRef.current, pureDictation.current, next);
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
    // While the mic listens or transcribes, or an "@/node" is half typed, nothing
    // goes out by the debounce (Enter still sends).
    if (
      composing.current ||
      micOn.current ||
      micPending.current ||
      !draftRef.current.trim() ||
      parseAddress(draftRef.current)?.complete === false
    )
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
  /** Polished voice lines shown as first heard (their mark tapped). */
  const [rawIds, setRawIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRaw = (id: string) =>
    setRawIds((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  /** A polished line's text as shown, and its mark (nothing for any other line). */
  const polish = (m: ChatMessage) => {
    if (!m.edited || m.raw === undefined) return { text: m.text, mark: null };
    const raw = rawIds.has(m.id);
    return {
      text: raw ? (
        <span data-testid="debug-chat-raw" className="text-gray-500">
          {m.raw}
        </span>
      ) : (
        m.text
      ),
      mark: (
        <PolishedMark
          icon={polishedIcon}
          label={strings?.polished ? t.polished : ui.polished}
          showRaw={raw}
          onToggle={() => toggleRaw(m.id)}
        />
      ),
    };
  };
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
  /**
   * The tree button: a tap opens or closes the tree; a horizontal drag (axis
   * locked after 8 px) moves the tree's focused node through its detents —
   * right opens it a level per cell, left folds it (tree-nav.ts) — with a
   * live preview, resisting past a limit, committed on release. A vertical
   * drag does nothing; it never moves the bar (the mark does). ←/→/↑/↓ on the
   * focused button navigate the open tree.
   */
  const treeAxis = useRef(createAxisLock());
  const treeDragged = useRef(createDragFlag());
  const treePress = useRef({ cells: 0, limitAt: null as number | null });
  const navRef = useRef(nav);
  navRef.current = nav;
  /** The hint's text; it changes only with a level, so a move re-renders nothing. */
  const [treeHint, setTreeHint] = useState<string | null>(null);
  /** The hint follows the finger by a transform set straight on it, never by a render. */
  const treeHintEl = useRef<HTMLSpanElement | null>(null);
  const treeHintOffset = useRef(0);
  const hintText = (s: TreeNavState) => {
    const id = s.focusId;
    const node = id === null ? undefined : navIx.byId.get(id);
    const depth = id === null ? 0 : (s.expanded[id] ?? 0);
    const max = id === null ? 0 : maxDetent(navIx.ix, id);
    return node ? `${node.title} · ${depth}/${max}` : "—";
  };
  const moveHint = (dx: number, limitAt: number | null) => {
    treeHintOffset.current = Math.round(dragOffset(dx, limitAt ?? undefined) * 0.25);
    if (treeHintEl.current)
      treeHintEl.current.style.transform = `translateX(${treeHintOffset.current}px)`;
  };
  const treeGesture = {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      treeAxis.current.down(e.clientX, e.clientY);
      treeDragged.current.down();
      treePress.current = { cells: 0, limitAt: null };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const was = treeAxis.current.axis();
      const m = treeAxis.current.move(e.clientX, e.clientY);
      if (!m || m.axis !== "x" || !treeSource || renderTree) return;
      let s = navRef.current;
      const p = treePress.current;
      if (!was) {
        if (!tree) setPanel("tree");
        setTreeTall(true);
        s = treeNav(navIx.ix, s, { type: "dragStart" });
        navRef.current = s;
        navTo({ type: "dragStart" });
      }
      const cells = dragCells(m.dx, p.cells);
      // Inside a detent: only the hint moves (no state, no render, no reflow).
      if (was && cells === p.cells) {
        moveHint(m.dx, p.limitAt);
        return;
      }
      p.cells = cells;
      const next = treeNav(navIx.ix, s, { type: "dragMove", cells });
      // Where the limit was met: past it the hint only rubber-bands.
      p.limitAt = next.atLimit ? (p.limitAt ?? cells - Math.sign(cells)) : null;
      navRef.current = next;
      navTo({ type: "dragMove", cells });
      moveHint(m.dx, p.limitAt);
      setTreeHint(hintText(next));
    },
    onPointerUp: () => {
      const axis = treeAxis.current.up();
      if (!axis) return;
      treeDragged.current.dragEnded();
      if (axis === "x") navTo({ type: "dragEnd" });
      setTreeHint(null);
    },
    onPointerCancel: () => {
      if (treeAxis.current.up() === "x") navTo({ type: "dragCancel" });
      setTreeHint(null);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!tree || !e.key.startsWith("Arrow")) return;
      e.preventDefault();
      navTo({ type: "key", key: e.key });
    },
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

  /** The draft's "@/…" while it is typed: the listeners' nodes under it, to pick from. */
  const addressing = /^@\/\S*(?:\s*›\s*\S*)*$/.test(draft) ? parseAddress(draft) : null;
  const completions = addressing && !addressing.complete ? completeNode(draft, nodes) : [];
  /** The target a typed "@/node " would set (a preview), else the chip's. */
  const typed = parseAddress(draft);
  const preview = typed?.complete === true;
  const shownTarget = preview && typed ? typed.to : target;
  const pick = (n: string) => {
    aim(n);
    draftRef.current = "";
    setDraft("");
    input.current?.focus();
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
          ? t.listening.replace("{n}", String(listeners))
          : t.statusOffline;

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
        data-testid="debug-chat-tree-button"
        aria-label={ui.stateTree}
        aria-description={`${TREE_HINT}${evalSessions.length ? ` · ${conns}` : ""}`}
        title={TREE_HINT}
        aria-expanded={tree}
        aria-controls="debug-chat-tree"
        // Keeps the input's focus (and its draft): the tree only looks.
        onMouseDown={(e) => e.preventDefault()}
        {...treeGesture}
        onClick={() => !treeDragged.current.wasDrag() && setPanel((p) => (p === "tree" ? "none" : "tree"))}
        style={{ touchAction: "none" }}
        className="tap-40 relative flex h-8 w-10 shrink-0 items-center justify-center rounded-full text-base"
      >
        {treeHint && (
          // While dragging: the focused node and the depth it would open to.
          <span
            ref={treeHintEl}
            role="status"
            data-testid="debug-chat-tree-hint"
            className="pointer-events-none absolute start-0 bottom-full mb-2 whitespace-nowrap text-[10px] lk-halo"
            style={{ transform: `translateX(${treeHintOffset.current}px)` }}
          >
            {treeHint}
          </span>
        )}
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
          localStt={friend ? undefined : localSttFrom(read(LOCAL_STT_KEY))}
          label={pages.find((p) => p.id === selfPage)?.label ?? location.pathname}
          gesture={micGesture}
        />
      )}
    </>
  );
  /** What the tree panel shows: the host's view, the tree's chips, the dev fragment, or why none. */
  const treeContent =
    renderTree?.() ??
    (treeSource ? (
      <TreeChips
        root={treeData.root}
        nav={nav}
        ix={navIx.ix}
        byId={navIx.byId}
        onNav={navTo}
        empty={treeStrings(treeText).empty}
        status={
          treeData.error
            ? `${treeStrings(treeText).failed} (${treeData.error})`
            : treeData.root
              ? undefined
              : treeStrings(treeText).loading
        }
      />
    ) : fetchedTree ? (
      <TreeFragment state={fetchedTree} />
    ) : (
      <p data-testid="debug-chat-tree-empty" className="text-gray-500">
        {ui.noTreeSource}
      </p>
    ));
  /**
   * The state tree, shown as the log is (log-surface.ts): no box, translucent
   * text with the halo, click-through except for rows that opt in. Expanded,
   * it heads the chat's one column (the messages below it, one scroller);
   * minimized, it heads the floating box and scrolls by itself. ✕ (or the tree
   * button, or Escape) closes it, never taking the input's focus. Fades in
   * (opacity; at once under reduced motion).
   */
  const treePanel = (floating: boolean) => (
    <div
      id="debug-chat-tree"
      role="region"
      aria-label={ui.stateTree}
      data-testid="debug-chat-tree"
      data-mode={floating ? "floating" : "column"}
      className="pointer-events-none relative flex w-full min-w-0 max-w-full flex-row-reverse items-start transition-opacity duration-[180ms] starting:opacity-0 motion-reduce:transition-none"
    >
      <button
        type="button"
        data-testid="debug-chat-tree-close"
        aria-label={ui.closeTree}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPanel("none")}
        // Beside the tree, never over it (first in the DOM, last on screen).
        className="tap-40 pointer-events-auto shrink-0 px-1.5 text-[10px] text-gray-500"
      >
        ✕
      </button>
      {floating ? (
        <div
          ref={(el) => {
            if (el && el !== treeBodyEl.current) el.scrollTop = treeScroll.current;
            treeBodyEl.current = el;
          }}
          data-testid="debug-chat-tree-body"
          onScroll={onTreeScroll}
          {...withClass(
            logSurface({ expanded: typing || micActive || treeTall, fade: treeFade }),
            `min-w-0 flex-1 ${treeTall ? "h-[30vh]" : ""}`,
          )}
        >
          {treeContent}
        </div>
      ) : (
        <div data-testid="debug-chat-tree-body" className="min-w-0 flex-1 pb-1">
          {treeContent}
        </div>
      )}
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
          {floats.map((f) => {
            // The latest copy of the line: an edit changes it in place.
            const m = messages.find((x) => x.id === f.id) ?? f;
            const p = polish(m);
            return (
            <FloatLine
              key={m.id}
              m={m}
              text={p.text}
              mark={p.mark}
              epoch={floatEpoch}
              paused={floatHover || scrubbing}
              onHover={setFloatHover}
              onGone={() => dropFloat(m.id)}
            />
            );
          })}
        </ol>
  );
  /**
   * Minimized: the floating lines, the frontier and the tree hang over the
   * bar in one box, on the bar's side of the screen (anchor.ts), clamped
   * inside the viewport.
   */
  const floatBoxEl = !open && (floats.length > 0 || !!shownFrontier || tree) && (
    <div
      ref={setFloatBox}
      data-testid="debug-chat-float-box"
      data-side={place.side}
      style={{ left: place.left, textAlign: TEXT_ALIGN[place.side] }}
      className={`pointer-events-none absolute bottom-full mb-1 flex w-max max-w-[min(20rem,calc(100vw-16px))] flex-col gap-1 ${ALIGN_ITEMS[place.side]}`}
    >
      {tree && treePanel(true)}
      {floatsEl}
      {shownFrontier && (
        <FrontierLines frontier={shownFrontier} renderAvatar={renderAvatar} align={place.side} />
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
      {/* Reading speed, per device: from the next sentence on. */}
      <div
        role="radiogroup"
        aria-label="Reading speed"
        data-testid="debug-menu-rate"
        className="flex items-center gap-1 px-3 py-1"
      >
        <span className="me-1 text-gray-500">Speed</span>
        {SPEECH_RATES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={rate === r}
            data-rate={r}
            onClick={() => {
              setSpeechRate(r);
              setRate(r);
            }}
            className={`tap-40 rounded px-1.5 py-0.5 tabular-nums ${rate === r ? "font-semibold underline underline-offset-2" : "opacity-70"}`}
          >
            {r}×
          </button>
        ))}
      </div>
      {/* The last voice line's path to its reply (latency.ts), when there is one or the mic is on. */}
      {(lastLatency || vs.mic) && (
        <div data-testid="debug-menu-latency" className="px-3 py-1 text-gray-500">
          {lastLatency ? (
            (() => {
              const rows = latencyRows(lastLatency.breakdown, ui);
              return (
                <>
                  <div>
                    {ui.latency}
                    {rows.total && (
                      <span className="ms-1 font-semibold tabular-nums">{rows.total} s</span>
                    )}
                  </div>
                  <div className="tabular-nums">
                    {rows.parts.map(([k, v]) => `${k} ${v}`).join(" · ")}
                  </div>
                </>
              );
            })()
          ) : (
            ui.latencyNone
          )}
        </div>
      )}
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
      {treeSource && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={tree}
          data-testid="debug-menu-tree"
          // The tree button's panel (one panel at a time: the menu closes).
          onClick={() => setPanel("tree")}
          className="flex items-center gap-2 px-3 py-1.5 text-start"
        >
          <span aria-hidden className="w-[1em] text-center">
            ☰
          </span>
          {treeStrings(treeText).tree}
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
      aria-label={t.chatWith}
      onPointerDown={unlockSpeech}
      onKeyDown={unlockSpeech}
      // A live mic counts as focus: the box goes opaque as it does while typing.
      style={offset}
      className={`fixed right-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 flex w-[min(20rem,calc(100vw-1rem))] flex-col rounded-xl transition-opacity ${micActive ? "opacity-100" : "opacity-60 focus-within:opacity-100 active:opacity-100"} pointer-events-none lk-halo text-xs text-gray-800 dark:text-gray-100`}
    >
      {/* One column, one scroller: the state tree (when open) on top, the
      messages below it, the newest at the bottom. Hidden minimized. */}
      <div
        ref={log}
        data-testid="debug-chat-column"
        onScroll={onLogScroll}
        onWheel={() => {
          userScrollAt.current = Date.now();
        }}
        onTouchMove={() => {
          userScrollAt.current = Date.now();
        }}
        data-fade={fade || undefined}
        data-expanded={typing || undefined}
        hidden={!open}
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          // Shrunk: land on the newest lines again, now that the height settled.
          if (!typing && !micActive) log.current?.scrollTo({ top: log.current.scrollHeight });
          onLogScroll();
        }}
        {...logSurface({ expanded: typing || micActive, fade })}
      >
      {open && tree && treePanel(false)}
      <ol
        data-testid="debug-chat-log"
        className="m-0 list-none space-y-0.5 p-0"
      >
        {messages.length === 0 && (
          <li className="text-gray-500">{t.hint}</li>
        )}
        {/* A game-style log: one line per message, avatar then text, no bubbles. */}
        {messages.map((m, i) => {
          const who = lineAvatar(m, {
            friend,
            viewer,
            agentAvatar,
            avatarFor,
            agentName: t.name,
            you: t.you,
          });
          // The state-tree node a line belongs to: a muted subtitle and a left border by its hue.
          const node = lineNode(m);
          return (
            // The time only on hover (long press on a phone); the avatar's own title names who.
            <li
              key={m.id}
              data-testid="debug-chat-line"
              data-from={m.from}
              data-node={node?.node}
              title={node ? `${when(m.at)} · ${who.name} · ${node.subtitle}` : when(m.at)}
              className="flex items-start gap-1.5 leading-snug"
              style={
                node
                  ? { borderInlineStart: `2px solid ${node.border}`, paddingInlineStart: 4 }
                  : undefined
              }
            >
              {/* Screen readers hear the name once, from the sr-only span. */}
              <Avatar
                src={who.src}
                name={who.name}
                initialFrom={who.initialFrom}
                seed={who.seed}
                size={AVATAR_PX}
                hidden
              />
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-px">
                {node && (
                  <span
                    aria-hidden
                    data-testid="debug-chat-node"
                    className="block truncate text-[10px] leading-tight text-gray-500"
                  >
                    {node.subtitle}
                  </span>
                )}
                <span className="sr-only">
                  {who.name}
                  {node ? ` (${node.subtitle})` : ""}:{" "}
                </span>
                {polish(m).text}
                {polish(m).mark}
                {!agentOnline && m.from !== "agent" && i > lastAgent && (
                  <span
                    data-testid="debug-chat-queued"
                    className="ms-1 text-[10px] text-gray-500"
                    title={t.waitingTitle}
                  >
                    {t.waiting}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      </div>
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
        {open && (shownTarget !== ROOT_NODE || completions.length > 0) && (
          // The target node (a chip: × back to the main thread) and "@/…" completions.
          <div className="pointer-events-none absolute start-20 bottom-full mb-1 flex max-w-[calc(100%-6rem)] flex-col items-start gap-1">
            {completions.length > 0 && (
              <ul
                role="listbox"
                aria-label="Nodes to address"
                data-testid="debug-chat-nodes"
                style={{ background: INPUT_BG }}
                className="pointer-events-auto max-w-full list-none overflow-hidden rounded-lg border border-current/25 py-0.5 text-[11px] backdrop-blur"
              >
                {completions.map((n) => (
                  <li key={n} role="option" aria-selected={false}>
                    <button
                      type="button"
                      data-testid="debug-chat-node-option"
                      // Keeps the input's focus.
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => pick(n)}
                      className="block w-full truncate px-2 py-0.5 text-start"
                    >
                      {pathLabel(n)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {shownTarget !== ROOT_NODE && (
              <span
                data-testid="debug-chat-target"
                data-node={shownTarget}
                style={{
                  background: INPUT_BG,
                  borderColor: lineNode({ from: "owner", to: shownTarget })?.border,
                }}
                className={`pointer-events-auto inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 text-[10px] leading-4 text-gray-600 dark:text-gray-300 ${preview ? "opacity-70" : ""}`}
              >
                <span className="truncate">→ {pathLabel(shownTarget)}</span>
                {!preview && (
                  <button
                    type="button"
                    data-testid="debug-chat-target-clear"
                    aria-label="Send to the main thread instead"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => aim(ROOT_NODE)}
                    className="leading-none"
                  >
                    ×
                  </button>
                )}
              </span>
            )}
          </div>
        )}
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
                        : target !== ROOT_NODE
                          ? `Message ${pathLabel(target)}…`
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
                    if (completions[0]) return pick(completions[0]);
                    submit();
                  }}
                  onKeyDown={(e) => {
                    shiftEnter.current = e.key === "Enter" && e.shiftKey;
                    // "@/wo" + Tab (or Enter): the first completion becomes the target.
                    if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && completions[0]) {
                      e.preventDefault();
                      return pick(completions[0]);
                    }
                    // Backspace in an empty input drops the target chip.
                    if (e.key === "Backspace" && !draftRef.current && targetRef.current !== ROOT_NODE)
                      return aim(ROOT_NODE);
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
                    aria-label={`${busy.label || t.name} is working`}
                    title={`${busy.label || t.name} is working`}
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
  text,
  mark,
  epoch,
  paused,
  onHover,
  onGone,
}: {
  m: ChatMessage;
  /** What the line shows (a polished line's text, or its raw STT text), and its mark. */
  text: ReactNode;
  mark: ReactNode;
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
      // The app's "Turn off animations" (lib/motion-pref.ts) sets data-motion="off".
      reducedMotion:
        document.documentElement.dataset.motion === "off" ||
        matchMedia("(prefers-reduced-motion: reduce)").matches,
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
      {text}
      {mark}
    </li>
  );
}
