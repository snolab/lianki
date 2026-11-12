"use client";

import { evalTrustStrings } from "./eval-trust-strings";
import { shortPage } from "./short-page";
import { type AdaptState, voiceAdapt } from "./adaptive";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useCallback,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { useUi } from "@lianki/ui-state";
import { chatFold, chatPrefs, chatUi } from "./ui-store";
import { lineTier, richOf, spokenOf } from "./rich-text";
import { RichBody, RichLine } from "./RichText";
import {
  COMPACT_BLUR_MS,
  COMPACT_SCROLL_MS,
  compactLines,
  foldIn,
  holdAtLeast,
  isCompact,
} from "./compact-view";
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
  type SttTag,
  sttTagText,
  type AttachmentRef,
  type ChatContext,
} from "./wire";
import { latencyLines, viaAt, voiceLatency } from "./latency";
import { getKey, setKey } from "./storage-keys";
import { LiagentMark } from "./LiagentMark";
import { Avatar } from "./Avatar";
import { type AvatarSource, lineAvatar, runStarts, runsOf } from "./avatar-rules";
import {
  VOICE_SENT_EVENT,
  appendDictation,
  isDictationBurst,
  joinText,
} from "./mic";
import { CLIPS_AUTOSTOP_MIN, activeSink } from "./clips";
import { clipsAction, clipsDevice, clipsLive } from "./clips-store";
import { ClipsBadge } from "./ClipsBadge";
import { LOCAL_STT_KEY, localSttRoute } from "./local-stt";
import { learnSttHint } from "./stt-hint";
import { DevMenuGroup } from "./DevMenuGroup";
import { AttachButton, AttachChip, AttachMenu, QuoteBlock, useAddItems, usePageSelection } from "./AttachMenu";
import { EtaBar, EtaList } from "./EtaBar";
import { LinkChip } from "./LinkChip";
import { type EvalLink, type EvalSession, selectionState } from "./link-state";
import { GanttFull } from "./GanttFull";
import { type EtaTask, etaClock, etaParts, etaPartsText, etaTasks } from "./eta";
import { type ChatFiles, createPendingFiles, dragHasFiles, filesFrom } from "./files";
import { InboxPanel, PendingChips, SentFiles } from "./FileChips";
import {
  BAR_CONTROL,
  INPUT_START,
  NO_SELECT,
  TAP_44_CSS,
  TEXT_SELECT,
  barGeometry,
  STRIP_INSET_PX,
  stripTopRadius,
} from "./bar-geometry";
import { DebugMic, canCapture, pageCues, pageMic, pttRecorder, voiceDevice } from "./MicButton";
import { CUE_SEND_KEY, CUE_SPEECH_KEY, cueOn, setCue } from "./cues";
import { micTaps } from "./mic-taps";
import { PASSAGE_END_MS, mergeVerdict } from "./voice-merge";
import { VoiceMark, VoiceprintPanel, panelDeps } from "./VoiceprintPanel";
import { clearSpeaker, takeSpeaker } from "./voiceprint";
import { SPEAK_KEY, type VoiceState, speechEnabled, unheard, voice } from "./voice";
import { hideStops, isDesktop } from "./voice-bg";
import {
  type ReadingLeft,
  initialRead,
  readStep,
  readingLeft,
  toResume,
  sentenceCount,
  sentenceRanges,
  sentenceState,
} from "./read-progress";
import { cloudOut, existingCtx, noSpeechVoices, outMode } from "./voice-out";
import { UNLOCK_EVENTS, activationNow, unlockOnGesture } from "./speech-unlock";
import { AEC_EVENT, aecOn, applyAec } from "./aec";
import { type SpeakMeta, isWithdrawn } from "./speak-rules";
import { createAxisLock, createDragFlag, createTapper, scrubBack } from "./tap-gesture";
import {
  FADE_MS,
  FLOAT_MAX,
  type FloatPhase,
  countUnread,
  createArrivals,
  createFloatLife,
  dwellMs,
  fifoDwellMs,
  minimizeFloat,
} from "./float-lines";
import { Icon, POLISHED_ICON } from "./icons";
import { useMessageDetails } from "./MessageDetails";
import { PolishedMark } from "./PolishedMark";
import { LINE_SELECTABLE } from "./copy-line";
import { type Held, logEngaged, typingLook } from "./log-engage";
import { wireLogHold } from "./log-hold-dom";
import {
  JUMP_END_PX,
  JUMP_GAP_PX,
  JUMP_H_PX,
  asksAbove,
  jumpLabel,
  jumpRoom,
  jumpTop,
  jumpWidth,
  nearestAbove,
  openAskIds,
} from "./ask-above";
import { lineIn, watchAsksAbove } from "./ask-above-dom";
import { installSelectFence } from "./select-fence-dom";
import {
  barInGlass,
  BAR_IN_GLASS_TRANSITION,
  glassAroundLog,
  panelOpaque,
  showTypingGlass,
  typingGlassLook,
  typingGlassMotion,
} from "./typing-glass";
import {
  LINE_HALO,
  SHEET_FILTER,
  anchorScrollTop,
  fullLogBox,
  fullLogHeight,
  foldBackTo,
  fullLogPad,
  keepEndGap,
  logSurface,
  nearEnd,
  pickAnchor,
  repinEnd,
  stillAtEnd,
  sheetScrim,
} from "./log-surface";
import { treeDefaults, uiStrings } from "./ui-strings";
import { chatExtra } from "./chat-ui-locales";
import {
  NEW_ATTR,
  SCRUB_ATTR,
  SCRUB_PULSE_MS,
  SHIMMER_CSS,
  createNewLines,
  newShimmer,
} from "./shimmer";
import { type PttState, createPttGesture } from "./ptt";
import { WAITING_INK, lastPendingIndex, waitingMark } from "./waiting-mark";
import { TreeChips } from "./TreeChips";
import { keepTree, navIndexOf, restoreTree } from "./tree-keep";
import {
  type TreeNavEvent,
  type TreeNavState,
  initialNav,
  pinRow,
  pinScroll,
  treeNav,
} from "./tree-nav";
import { SPEECH_RATES, setSpeechRate, speechRate } from "./speech-rate";
import { notePrefWrite } from "@lianki/ui-state/account";
import { confirmLeave } from "@lianki/ui-state/dirty";
import { ANCHOR_GUTTER_PX, type AnchorSide, placeBox } from "./anchor";
import {
  type Fold,
  type FoldEvent,
  type FoldState,
  HANDLE_SHAPE,
  HANDLE_SIZE,
  floatSide,
  foldNext,
  handleTop,
  handleTouch,
  mirrorShift,
  mirrored,
  nearestEdge,
  pushedAgainst,
} from "./fold";
import { keyboardLift } from "./keyboard-lift";
import {
  FULL_H_VAR,
  FULL_LOG_STYLE,
  FULL_PB_VAR,
  FULL_SCREEN_STYLE,
  FULL_SIDEBAR_STYLE,
  FULL_TOP_VAR,
  SIDEBAR_QUERY,
  escapeLeaves,
  fullBarSpan,
  sidebarReserve,
  fullBottomPad,
  fullScreenAllowed,
  fullScreenBack,
  fullScreenBox,
  fullScreenOn,
  dragLeavesFull,
  dropEntersFull,
  FULL_HINT_HAPTIC_MS,
  FULL_HINT_STYLE,
  fullHintStep,
} from "./full-screen";
import { onChatOpen } from "./island-bus";
import { createJoystick, deadZoneSpeed, joystickTune } from "./joystick";
import { type ScrollBox, forwardWheel } from "./wheel-forward";
import { AskCard } from "./AskCard";
import type { AskChoices } from "./ask";
import { VOICE_CAPTURE_EVENT, createJoiner, isBlip, voiceTune } from "./voice-tune";
import { TreeFragment, useTreeSource as useFragmentSource } from "./TreeFragment";
import { FrontierLines, type RenderAvatar } from "./Frontier";
import { withLane } from "./voices";
import { LaneTag, laneAvatar } from "./LaneMark";
import { PUBLIC_ROUTE_LIST, publicSttAvailable, readConsent, writeConsent } from "./public-stt";
import { SttServersCard } from "./SttServersCard";
import { MicCaret } from "./MicCaret";
import { type Frontier, treeFrontier } from "./frontier-view";
import {
  type TreeSource,
  type TreeStrings,
  treeStrings,
  useTreeSource,
} from "./StateTree";

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
/** Text inside the mirrored row stays left to right; LTR adds no box of its own. */
const LTR_TEXT = { direction: "ltr" } as const;
const LTR = { display: "contents", direction: "ltr" } as const;
const ALIGN_ITEMS = { left: "items-start", center: "items-center", right: "items-end" } as const;
const TEXT_ALIGN = { left: "left", center: "center", right: "right" } as const;
/** Surface props with extra classes. */
const withClass = <T extends { className: string }>(p: T, cls: string): T => ({
  ...p,
  className: `${p.className} ${cls}`,
});
/** The mic's extra gesture, for its title and aria-description. */
const MIC_PTT_HINT = "Hold to talk: one line, sent when you let go (slide away to cancel). Tap: always listening. ↑/↓: scroll back through the chat";
/** The light haptic when a press becomes push to talk (navigator.vibrate; none on iOS). */
const PTT_HAPTIC_MS = 10;
/** A minimized scrub shows this many lines at a time. */
const SCRUB_LINES = 3;
const POS_KEY = "lk:debug-chat-pos";
/** After an up-arrow tap, how long its card is put back at the top if the run reflows. */
const REALIGN_MS = 1500;
/** The chat bar: the page shows through at about half. */
const INPUT_BG = "color-mix(in oklch, var(--background) 55%, transparent)";
/**
 * The bottom strip's glass while the progress bar shows (owner, 2026-11-10):
 * the bar's own look (INPUT_BG, backdrop-blur-md, saturate 150%) over both,
 * so the input row with no progress bar looks as it always did.
 */
const STRIP_GLASS = {
  background: INPUT_BG,
  backdropFilter: "blur(12px) saturate(1.5)",
  WebkitBackdropFilter: "blur(12px) saturate(1.5)",
} as const;

/**
 * Drag the box (by its header, or the collapsed pill) anywhere on screen: an
 * offset from its bottom-right home, kept on screen and remembered. A press
 * that moves under 5 px is still a click.
 */
/**
 * Where a drag left the bar and its box: their spans, viewport px (fold.ts
 * edges); `bottom` is the bar's resting bottom (full-screen.ts dropEntersFull).
 */
type DropSpan = { left: number; right: number; boxLeft: number; boxRight: number; bottom: number };

/** Full screen as a drag sees it: on now, and the way out when the drag leaves it upward. */
type DragFull = { now: () => boolean; leave: () => void };

function useDrag(
  onDrop?: (at: DropSpan) => void,
  fullDrag?: DragFull,
  /** Where the bar would rest after each move; null once the press is over (the full-screen hint). */
  onMove?: (at: DropSpan | null) => void,
) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const v = JSON.parse(read(POS_KEY) ?? "null") as { x: number; y: number } | null;
      return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  });
  const drag = useRef<{
    px: number;
    py: number;
    x: number;
    y: number;
    moved: boolean;
    /** The bar's span after the last move, and its box: the drop's edge (fold.ts). */
    last?: DropSpan;
  } | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  /** The click that ends a drag is not a tap (cleared on the next press, or after 400 ms). */
  const dragged = useRef(createDragFlag());
  /** The pill is held down: the input shows how to use it. */
  const [holding, setHolding] = useState(false);
  /**
   * Move the box to follow the pointer. Keep the chat bar on screen, up to
   * the very top under the notch: its rect at the start, moved by the delta.
   * The click-through log above it may go off-screen.
   */
  const moveTo = (box: HTMLElement | null, cx: number, cy: number) => {
    const d = drag.current;
    if (!d || !box) return;
    const dx = cx - d.px;
    const dy = cy - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    // Full screen does not move: a drag up past FULL_LEAVE_PX leaves it, and
    // the panel, back where it was, follows the finger from the next move on
    // (this frame's rect is still the full-screen bar's).
    if (fullDrag?.now()) {
      if (dragLeavesFull({ full: true, dy })) fullDrag.leave();
      return;
    }
    const row = (box.querySelector("[data-debug-chat-row]") ?? box).getBoundingClientRect();
    const left = row.left - (pos.x - d.x);
    const top = row.top + liftOf(box) - (pos.y - d.y);
    const x = d.x + Math.max(-left, Math.min(innerWidth - row.width - left, dx));
    const y = d.y + Math.max(safeTop() - top, Math.min(innerHeight - row.height - top, dy));
    // The box as it will be once this move renders.
    const by = x - pos.x;
    const b = box.getBoundingClientRect();
    d.last = {
      left: left + x - d.x,
      right: left + x - d.x + row.width,
      boxLeft: b.left + by,
      boxRight: b.right + by,
      bottom: top + y - d.y + row.height,
    };
    moveRef.current?.(d.last);
    setPos({ x, y });
  };
  /**
   * The host's bottom island may dock above (or leave) the bar now, and only
   * now (lib/nav/nav-core.ts, CHAT_MOVED_EVENT): after the new place is painted.
   */
  const moved = () =>
    requestAnimationFrame(() => dispatchEvent(new CustomEvent("lk:chat-moved")));
  /** The press is over: a drag is saved, and its drop told (the fold's edge, fold.ts). */
  const end = () => {
    setHolding(false);
    const d = drag.current;
    drag.current = null;
    moveRef.current?.(null);
    if (!d?.moved) return;
    dragged.current.dragEnded();
    setPos((p) => {
      write(POS_KEY, JSON.stringify(p));
      return p;
    });
    if (d.last) dropRef.current?.(d.last);
    moved();
  };
  /** Move the box sideways by dx, saved: the pill kept in place as the box mirrors (fold.ts). */
  const shift = (dx: number) => {
    if (!dx) return;
    setPos((p) => {
      const next = { x: p.x + dx, y: p.y };
      write(POS_KEY, JSON.stringify(next));
      return next;
    });
  };
  const handle = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest("button:not([data-drag-handle]), textarea")) return;
      setHolding(true);
      drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, moved: false };
      dragged.current.down();
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) =>
      moveTo(e.currentTarget.closest("[data-debug-chat]") as HTMLElement, e.clientX, e.clientY),
    onPointerUp: () => end(),
    onPointerCancel: () => {
      setHolding(false);
      drag.current = null;
      moveRef.current?.(null);
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
    const lifted = box?.querySelector("[data-debug-chat-row]")?.getBoundingClientRect();
    if (!box || !lifted) return;
    // Not laid out as the overlay yet (a hot-loaded widget's CSS still on its
    // way): its rect means nothing, and a refit would save a wild offset.
    if (getComputedStyle(box).position !== "fixed") return;
    // Where it rests: the keyboard lift is transient and never saved.
    const kb = liftOf(box);
    const bar = { ...lifted.toJSON(), top: lifted.top + kb, bottom: lifted.bottom + kb } as {
      left: number;
      right: number;
      top: number;
      bottom: number;
    };
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
    // The keyboard lift (keyboard-lift.ts) is a CSS variable set straight on
    // the box from visualViewport events: no render, and never saved.
    offset: { transform: `translate(${pos.x}px, calc(${pos.y}px - var(${KB_LIFT_VAR}, 0px)))` },
    /** The box's sideways offset from its home: full screen keeps the bar at the panel's span. */
    dx: pos.x,
    handle,
    begin,
    moveTo,
    end,
    shift,
    moved,
    wasDrag,
    holding,
    fit,
  };
}

/** A sentence read aloud: a quieter grey, still legible (light and dark). */
const SPOKEN_STYLE = { color: "light-dark(oklch(0.5 0.01 260), oklch(0.72 0.01 260))" };
/** The sentence being read: a soft highlight behind it. */
const SPEAKING_STYLE = {
  background: "light-dark(oklch(0.92 0.06 90 / 0.7), oklch(0.36 0.055 22.3 / 0.7))",
  borderRadius: 3,
  padding: "0 2px",
  transition: "background-color 150ms ease-in-out",
};
/** The full-screen log's wipe in and out. */
const WIPE = "clip-path 200ms ease-out";
/** The input-started full-screen log fades in and out, as the bar does the other way. */
const FADE = "opacity 200ms ease-out";
/**
 * The glass sheet behind the full-screen log (log-surface.ts SHEET_SCRIM):
 * a light or dark scrim under a 20px blur. Near-opaque where nothing blurs
 * (no backdrop-filter, or reduced transparency), and then the log's lines
 * get the strong halo too. Where light-dark() is missing (older Safari),
 * the scrim is the page's own colour at the same alpha.
 */
const sheetLook = () => {
  const has = (prop: string, v: string) => typeof CSS !== "undefined" && CSS.supports(prop, v);
  const blur =
    has("backdrop-filter", SHEET_FILTER) || has("-webkit-backdrop-filter", SHEET_FILTER);
  const reduce =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-transparency: reduce)").matches;
  const solid = !blur || reduce;
  const background = has("color", "light-dark(#000, #fff)")
    ? sheetScrim(solid)
    : `color-mix(in oklch, var(--background) ${solid ? 92 : 72}%, transparent)`;
  return { background, solid };
};

/** The box's keyboard lift, px (0 when the keyboard covers nothing). */
const KB_LIFT_VAR = "--lk-kb-lift";
const liftOf = (box: HTMLElement) =>
  Number.parseFloat(box.style.getPropertyValue(KB_LIFT_VAR)) || 0;

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

/** env(safe-area-inset-bottom) in px (the home indicator), measured once per drag. */
function safeBottom() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)";
  document.body.append(probe);
  const v = Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  return v;
}

/** env(safe-area-inset-top) in px (the notch), measured once per drag. */
function safeTop() {
  return safeInset("top");
}

/** env(safe-area-inset-<side>) in px, through a probe. */
function safeInset(side: "top" | "bottom") {
  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;visibility:hidden;padding-${side}:env(safe-area-inset-${side})`;
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const v = Number.parseFloat(side === "top" ? cs.paddingTop : cs.paddingBottom) || 0;
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
 * `meta` is the line itself (its id and quiet): a hidden page and a quiet
 * line keep it silent (speak-rules.ts).
 */
export function speakReply(text: string, meta?: SpeakMeta): boolean {
  return voice().reply(text, meta);
}

let unlocked = false;
/**
 * iOS speaks only after a user gesture: an empty utterance on the first one
 * unlocks it. A press that is not yet an activation (a touch's pointerdown,
 * speech-unlock.ts) waits for the one that is. True: nothing left to unlock.
 */
function unlockSpeech(): boolean {
  const s = synth();
  if (unlocked || !s) return true;
  if (activationNow() === false) return false;
  unlocked = true;
  s.speak(new SpeechSynthesisUtterance(""));
  // The cloud voice's <audio> element too: lk:voice-out = "cloud", or a
  // device with no speechSynthesis voices, whose replies the cloud reads.
  if (outMode() === "cloud" || noSpeechVoices() || getKey("lk:agent-local-tts") !== "off")
    cloudOut()?.unlock();
  return true;
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
    opts?: {
      source?: MessageSource;
      timing?: VoiceTiming;
      /** Which recognizer made a voice line's text (wire.ts SttTag). */
      stt?: SttTag;
      speakerProof?: string[];
      /** Attached with the + menu (AttachMenu.tsx): the page selection and where. */
      context?: ChatContext;
      /** Files sent with the line (files.ts): the host's refs, already uploaded. */
      attachments?: AttachmentRef[];
      /** This spoken line asks to amend that one (voice-merge.ts); the hub decides. */
      continues?: string;
    },
  ) => boolean;
  /** The speech after a merged line went quiet: the passage is over (hub: polish-due). */
  onPassageEnd?: () => void;
  /** The undo on a merged line: split it back into the lines it was made from. */
  onUnmerge?: (id: string) => void;
  /**
   * A tap on an ask card (AskCard.tsx): the page sends {type:"answer",
   * askId, choices}; the hub stamps it. Absent (an older page): the choice
   * goes as a typed line instead.
   */
  onAnswer?: (askId: string, choices: AskChoices) => boolean;
  /** The nodes listeners are subscribed at: "@/…" completions. */
  nodes?: string[];
  /** Approved senders, listed in the pill's menu with an End button each. */
  sessions?: PairInfo[];
  onEnd?: (s: PairInfo) => void;
  /** Code just ran on this page: the eval icon pulses for a moment. */
  evalRan?: boolean;
  /** A friend's page: pairings are previews (no chat scope to grant). */
  friend?: boolean;
  /**
   * The hub verified this as the owner's session (DebugEval `owner`): with no
   * stored `lk:agent-local-stt`, the mic defaults to his local STT
   * (localSttRoute, docs/local-stt.md). Never set for friends or other users.
   * Also requires a `dev` grant (DebugEval): only then does the menu list
   * pairings (eval sessions) and full page paths with their devices.
   */
  owner?: boolean;
  /** Shown instead of the input when this account cannot chat (blocked). */
  notice?: string;
  /** With `notice`: a link under it (the read-only partner on another site: type on lianki.com). */
  noticeHref?: { href: string; label: string };
  /** A one-line note above the input (a message dropped by the rate limit). */
  warning?: string;
  /** With `warning`: a link after it (out of credits: where credits are bought). */
  warningHref?: { href: string; label: string };
  /**
   * The agent's heartbeat says it is working on a message (DebugEval decides,
   * from real beats only): a spinner at the right end of the input.
   */
  busy?: { label: string } | null;
  /**
   * The connection chip (LinkChip.tsx), left of the progress bar: given only on
   * a developer's page (DebugEval: `dev`, or the hub's verdict). `link`: remote
   * code on this page; `sessions`: the eval grants in time; `beatAt`: the
   * agent's latest heartbeat (it saw what came before); `onEnd` revokes one.
   */
  link?: {
    state: EvalLink;
    sessions: (EvalSession & { here: boolean })[];
    now: number;
    beatAt?: number;
    onEnd: (pair: string) => void;
  };
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
   * returning markdown or nodes, or a feed. Shown from the + menu's View group (and
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
  /**
   * On another site (the userscript, embed/; docs/dev-debug-widget.md "On
   * every site"): no mic, no voice-clip recording, and Escape is taken only
   * while focus is inside the chat, so the page's own keys are never touched.
   */
  embedded?: boolean;
  /** Where the full-screen sheet and badges are portalled (default document.body; the shadow root's container when embedded). */
  portalRoot?: Element;
  /**
   * The input's + menu (AttachMenu.tsx). Off in the cross-site iframe
   * (app/embed/partner): it cannot see the page's selection, and its box is tiny.
   */
  attach?: boolean;
  /**
   * The host's file handling (files.ts): paste, drop and the + menu's File /
   * Photo upload through it, sent lines show their files from its URLs, and
   * the menu's Inbox lists (and deletes) what it stored. Absent: no files.
   */
  files?: ChatFiles;
  /**
   * The host keeps the account's chat history (Lianki: /chat/history,
   * docs/chat-history.md): the + menu's View group gets History, which calls this.
   */
  onHistory?: () => void;
  /**
   * The ETA bar (eta.ts, flag chat.eta-bar; the owner's pages only): a summary
   * of the tree's timed tasks above the input, a tap opens the tree, which
   * lists each. Needs `treeSource`.
   */
  etaBar?: boolean;
  /** This page's timer saw a task's estimate run out, unsent: tell the hub (once per estimate). */
  onEtaDue?: (id: string) => void;
  /**
   * Set by DebugChatHost when the hot tree (the dev server's outline) took
   * `treeSource`'s place: the host's live source, which the ETA bar reads.
   */
  etaSource?: TreeSource;
  /**
   * Full screen for this viewer (full-screen.ts): the host's server-side read
   * of the flag `partner.fullscreen`. Off, only the owner's pages (`owner`)
   * get it. Never on another site (`embedded`).
   */
  fullScreen?: boolean;
  /**
   * The host's "Back closes an overlay" (Lianki: lib/back-to-close.ts
   * openBackToClose, docs/ui-state.md): opening full screen by a tap pushes
   * one history entry, Back runs `onBack`, and the returned close consumes the
   * entry when full screen ends any other way. Absent: Escape and the button only.
   */
  backToClose?: (onBack: () => void) => () => void;
};

/** The voice session before the page has one (server render, first paint). */
const QUIET: VoiceState = {
  mic: false,
  speaking: false,
  hold: false,
  ducked: false,
  queued: 0,
  paused: false,
  blocked: false,
};

/**
 * In a tap, after the browser refused to play a reply: unlock the outputs
 * (the AudioContext, the cloud's element, speechSynthesis) and read on.
 */
function unblockVoice() {
  // Once: the chip's own tap is also the page's tap (both listen).
  if (!voice().state().blocked) return;
  // Not an activation yet (a touch's pointerdown): its pointerup or click is.
  if (activationNow() === false) return;
  void existingCtx()?.resume().catch(() => {});
  // Whatever the mode: a sentence in a language with no voice here goes to the cloud too.
  cloudOut()?.unlock();
  try {
    synth()?.speak(new SpeechSynthesisUtterance(""));
  } catch {}
  voice().unblock?.();
}

/** A log line's avatar, square: fixed, so a picture loading late shifts nothing. */
const AVATAR_PX = 18;

/** The input grows to about five lines, then scrolls inside itself. */
const INPUT_MAX_PX = 128;

const NONE_ABOVE: ReadonlySet<string> = new Set();

/** The one panel over the log. */
type Panel = "none" | "menu" | "tree" | "voiceprint";

export function DebugChat({
  live,
  listeners,
  messages: rawMessages,
  onSend,
  onAnswer,
  onPassageEnd,
  sessions = [],
  onEnd,
  evalRan = false,
  friend = false,
  owner = false,
  notice,
  noticeHref,
  warning,
  warningHref,
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
  embedded = false,
  portalRoot,
  attach = true,
  files,
  onHistory,
  etaBar = false,
  onEtaDue,
  etaSource,
  link,
  fullScreen: fullScreenFlag = false,
  backToClose,
}: DebugChatProps) {
  const t = chatStrings(strings);
  /**
   * Agent lines with their lane (voices.ts): a `【lane】` prefix becomes the name tag and mark.
   * A line inside a summary (`collapsedInto`) is not shown: the summary's tap shows it as heard.
   */
  const messages = useMemo(
    () => rawMessages.filter((m) => !m.collapsedInto).map(withLane),
    [rawMessages],
  );
  /** Which lines arrived live: they shimmer while read (shimmer.ts). Seen at render, idempotent. */
  const newLines = useRef<ReturnType<typeof createNewLines> | null>(null);
  newLines.current ??= createNewLines();
  newLines.current.see(messages, Date.now());
  const shimmerOf = (m: ChatMessage) => newLines.current!.shimmer(m, Date.now());
  const laneOpts = { laneAvatar };
  /** This window's recording session, as the hub holds it (clips.ts); null before it spoke. */
  const clipsHub = useUi(clipsLive(), (s) => s.hub);
  const clipsAuto = useUi(clipsDevice(), (s) => s.autoStop);
  /** Turning it on needs somewhere to keep the clips: the hub's sink or this origin's key. */
  const clipsCanStart = !!clipsHub?.canStart;
  const [open, setOpen] = useState(() => {
    const v = read(OPEN_KEY);
    return v === null ? !location.pathname.startsWith("/words") : v === "1";
  });
  /**
   * Full screen (full-screen.ts): the open chat fills the app. Chosen per
   * device (ui-store.ts chatPrefs `full`); `flag || owner`, never on another site.
   */
  const fullAllowed = fullScreenAllowed({ flag: fullScreenFlag, owner, embedded });
  const fullPref = useUi(chatPrefs(), (s) => s.full);
  const full = fullScreenOn({ allowed: fullAllowed, pref: fullPref, open });
  const fullOn = useRef(full);
  fullOn.current = full;
  /** Wider than SIDEBAR_QUERY (35em): full screen is a sidebar docked right; the media query's change event, no polling. */
  const [sidebar, setSidebar] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(SIDEBAR_QUERY).matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(SIDEBAR_QUERY);
    const on = () => setSidebar(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const asSidebar = full && sidebar;
  // The sidebar leaves the page usable beside it: the page reflows clear of it.
  useEffect(() => {
    if (!asSidebar || typeof document === "undefined") return;
    return sidebarReserve(document.documentElement);
  }, [asSidebar]);
  const [speak, setSpeak] = useState(speechEnabled);
  /** Echo cancellation on the mic (lk:voice-aec): the menu's A/B switch. */
  const [aec, setAecState] = useState(aecOn);
  // A selection started on a chat line stays in the chat (select-fence.ts).
  useEffect(() => installSelectFence(), []);
  // The same switch in /words' Settings sheet: follow it.
  useEffect(() => {
    const f = () => setAecState(aecOn());
    window.addEventListener(AEC_EVENT, f);
    return () => window.removeEventListener(AEC_EVENT, f);
  }, []);
  /** The voice cues' two switches (cues.ts), synced with the account. */
  const [cueSend, setCueSend] = useState(() => cueOn(CUE_SEND_KEY));
  const [cueSpeech, setCueSpeech] = useState(() => cueOn(CUE_SPEECH_KEY));
  // Another tab's change, or another device's arriving (docs/prefs-sync.md).
  useEffect(() => {
    const f = () => {
      setCueSend(cueOn(CUE_SEND_KEY));
      setCueSpeech(cueOn(CUE_SPEECH_KEY));
    };
    window.addEventListener("storage", f);
    window.addEventListener("lk:pref-applied", f);
    return () => {
      window.removeEventListener("storage", f);
      window.removeEventListener("lk:pref-applied", f);
    };
  }, []);
  /** How fast replies are read (speech-rate.ts; per device, default 1.5×). */
  const [rate, setRate] = useState(speechRate);
  /** A drag of the box ended (useDrag): its edge, or a tuck (fold.ts). */
  const onDrop = useRef((_at: DropSpan) => {});
  /** A drag up out of full screen (set once setFull exists below). */
  const leaveFull = useRef(() => {});
  /** A drag of the box moved (useDrag): the full-screen hint (set below, where its rule is). */
  const onDragMove = useRef((_at: DropSpan | null) => {});
  const { offset, handle, begin, moveTo, end, shift, moved, wasDrag, holding, fit } = useDrag(
    (bar) => onDrop.current(bar),
    { now: () => fullOn.current, leave: () => leaveFull.current() },
    (bar) => onDragMove.current(bar),
  );
  /**
   * The drag would enter full screen if let go now (owner, 2026-11-10): the
   * bottom edge grows toward full screen as a preview, with a light haptic.
   */
  const [fullHint, setFullHint] = useState(false);
  const fullHintRef = useRef(false);
  /**
   * How far the chat is folded (fold.ts): open, a pill, or tucked into the
   * screen edge, and the edge it keeps to (on the left, everything mirrors).
   * Tucked and the edge are kept per device (ui-store.ts chatFold).
   */
  const foldStore = chatFold();
  const tuckedPref = useUi(foldStore, (s) => s.tucked);
  const edge = useUi(foldStore, (s) => s.edge);
  /**
   * The third level, tucked into the screen edge, is removed for now (owner,
   * 2026-11-07 20:32 JST: useless, to be rethought; fold.ts never steps into
   * it). A device that saved it shows the plain pill, and the saved value is
   * cleared. The handle's code stays dormant until it is rethought.
   */
  const fold: Fold = open ? "open" : "pill";
  const tucked = (fold as Fold) === "tucked";
  useEffect(() => {
    if (tuckedPref) foldStore.setState({ tucked: false });
  }, [tuckedPref]);
  const mirrorRow = mirrored(edge);
  const foldNow = useRef<FoldState>({ fold, edge });
  foldNow.current = { fold, edge };
  /** The box sliding into or out of the edge: its transform animates, then this clears. */
  const [sliding, setSliding] = useState(false);
  const slideEnd = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(slideEnd.current), []);
  const endSlide = () => {
    clearTimeout(slideEnd.current);
    setSliding(false);
    moved();
  };
  /** Session UI state (draft, panel, tree): survives a refresh and a hot swap. */
  const uiStore = chatUi();
  /** The box: its bar is kept on screen, expanded or minimized. */
  const root = useRef<HTMLElement | null>(null);
  // Only expanding or minimizing refits (fit itself is fresh each render).
  /**
   * One panel at a time over the log: the menu (status, read-aloud, pages,
   * sessions; a double tap on the mark) or the state tree (the + menu's View group).
   * Opening one closes the other.
   */
  const [panel, setPanelState] = useState<Panel>(() => uiStore.getState().panel);
  const panelNow = useRef(panel);
  panelNow.current = panel;
  /**
   * Switch panels. Leaving the voiceprint panel while an enrolment is under
   * way drops it: the page's leave guard confirms first (@lianki/ui-state/dirty).
   */
  const setPanel = (v: Panel | ((p: Panel) => Panel)) => {
    const cur = panelNow.current;
    const next = typeof v === "function" ? v(cur) : v;
    if (next === cur) return;
    if (cur === "voiceprint" && !confirmLeave()) return;
    panelNow.current = next;
    setPanelState(next);
  };
  // Kept for a refresh or a hot swap (ui-store.ts): the tree, never the menu.
  useEffect(() => uiStore.setState({ panel: panel === "tree" ? "tree" : "none" }), [panel]);
  const menu = panel === "menu";
  const tree = panel === "tree";
  const setMenu = (v: boolean) => setPanel((p) => (v ? "menu" : p === "menu" ? "none" : p));
  // Expanding, minimizing or opening the tree refits (fit itself is fresh each render).
  // Tucked, the box is past the edge on purpose: never pulled back on screen.
  // Full screen places itself; the panel's own place is kept for the way back.
  useLayoutEffect(() => {
    if (!tucked && !full) fit(root.current, open);
  }, [open, tree, full]);
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
      side: floatSide(foldNow.current.edge),
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
  /**
   * The tucked handle's top (fold.ts handleTop): level with the pill it
   * stands in for (the slide is sideways only), measured on tucking and on
   * any resize while tucked.
   */
  const [handleAt, setHandleAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!tucked) return;
    const measure = () => {
      const bar = barEl.current?.getBoundingClientRect();
      if (!bar) return;
      const top = handleTop({
        centerY: (bar.top + bar.bottom) / 2,
        height: HANDLE_SIZE[HANDLE_SHAPE].h,
        vh: innerHeight,
        // Clear of the notch and the home indicator, with the floating box's gutter.
        safeTop: safeTop() + ANCHOR_GUTTER_PX,
        safeBottom: safeInset("bottom") + ANCHOR_GUTTER_PX,
      });
      setHandleAt((cur) => (cur === top ? cur : top));
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [tucked]);
  /** The press on the handle became a drag (its click is not a tap). */
  const handleDragged = useRef(false);
  /**
   * A press on the handle: moved past the slop, the pill comes back at once
   * and follows the finger as a drag of the box (useDrag), so it can be
   * carried anywhere, or to the other edge. A tap is the button's click.
   */
  const pressHandle = (e: React.PointerEvent<HTMLButtonElement>) => {
    unlockSpeech();
    handleDragged.current = false;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        started = true;
        handleDragged.current = true;
        // Back where it was before the drag measures it: no slide.
        flushSync(() => foldBy({ type: "handle" }, true));
        begin(sx, sy);
      }
      moveTo(root.current, ev.clientX, ev.clientY);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      if (started) end();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };
  /** The notch, px: measured on mount and on rotation, not per viewport event. */
  const notch = useRef(0);
  /**
   * Under the on-screen keyboard: lift the bar by the covered amount
   * (keyboard-lift.ts), back to 0 once the keyboard closes. One read (the
   * bar's rect) then one write (a CSS variable on the box), no render.
   */
  const liftRef = useRef(() => {});
  liftRef.current = () => {
    const box = root.current;
    const bar = box?.querySelector("[data-debug-chat-row]")?.getBoundingClientRect();
    const vv = typeof visualViewport === "undefined" ? null : visualViewport;
    if (!box || !bar) return;
    // Full screen: the box is the visible area (full-screen.ts), so the bar
    // already sits above the keyboard; no lift.
    if (fullOn.current) {
      const b = fullScreenBox({ innerHeight, vv });
      box.style.setProperty(FULL_TOP_VAR, `${b.top}px`);
      box.style.setProperty(FULL_H_VAR, `${b.height}px`);
      box.style.setProperty(FULL_PB_VAR, fullBottomPad(b.keyboard));
      if (b.keyboard) box.dataset.kb = "";
      else delete box.dataset.kb;
      box.style.setProperty(KB_LIFT_VAR, "0px");
      delete box.dataset.kbLift;
      return;
    }
    delete box.dataset.kb;
    const cur = liftOf(box);
    let next = vv
      ? keyboardLift({
          barTop: bar.top + cur,
          barBottom: bar.bottom + cur,
          vvTop: vv.offsetTop,
          vvHeight: vv.height,
          vvScale: vv.scale,
          safeTop: notch.current,
        })
      : 0;
    // Not the overlay yet (a hot-loaded widget's CSS on its way): its rect means nothing.
    if (next && getComputedStyle(box).position !== "fixed") next = 0;
    if (next === cur) return;
    box.style.setProperty(KB_LIFT_VAR, `${next}px`);
    if (next) box.dataset.kbLift = String(next);
    else delete box.dataset.kbLift;
  };
  useLayoutEffect(() => liftRef.current());
  useEffect(() => {
    notch.current = safeTop();
    /** The tree's fit once more on the next frame, after the lift and the box have settled. */
    const again = () => {
      placeRef.current();
      fitRef.current();
      liftRef.current();
    };
    const rotate = () => {
      notch.current = safeTop();
      again();
    };
    // The visual viewport scrolls too (iOS pans it to the focused input):
    // only the lift follows that.
    const lift = () => {
      liftRef.current();
    };
    addEventListener("resize", again);
    addEventListener("orientationchange", rotate);
    visualViewport?.addEventListener("resize", again);
    visualViewport?.addEventListener("scroll", lift);
    return () => {
      removeEventListener("resize", again);
      removeEventListener("orientationchange", rotate);
      visualViewport?.removeEventListener("resize", again);
      visualViewport?.removeEventListener("scroll", lift);
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
  fitRef.current = () => {
    if (foldNow.current.fold !== "tucked") fit(root.current, open);
  };
  /** The tree's scroll, kept across the sheet ⇄ column switch. */
  const treeScroll = useRef(uiStore.getState().tree?.scroll ?? 0);
  /** Bumped each time the tree opens: the source loads again (never polled). */
  const [treeRev, setTreeRev] = useState(0);
  useEffect(() => {
    if (tree) setTreeRev((n) => n + 1);
  }, [tree]);
  /** The host's tree (StateTree.tsx), loaded while it is open or the bar shows its frontier. */
  const treeData = useTreeSource(treeSource, treeRev, treeRepo);
  /** The tree's timed tasks (eta.ts), and the clock that moves their bars. */
  const etaData = useTreeSource(etaBar ? etaSource : undefined, 0, treeRepo);
  const etaRoot = etaSource ? etaData.root : treeData.root;
  const etaList = useMemo<EtaTask[]>(
    () => (etaBar && (etaSource ?? treeSource) ? etaTasks(etaRoot) : []),
    [etaBar, etaSource, treeSource, etaRoot],
  );
  const [etaNow, setEtaNow] = useState(() => Date.now());
  /** The full-screen Gantt (GanttFull.tsx), opened from the ETA bar. */
  const [ganttOpen, setGanttOpen] = useState(false);
  const onEtaDueRef = useRef(onEtaDue);
  onEtaDueRef.current = onEtaDue;
  const etaClockRef = useRef<ReturnType<typeof etaClock> | null>(null);
  useEffect(() => {
    if (!etaBar) return;
    const c = etaClock({ onDue: (id) => onEtaDueRef.current?.(id), onTick: setEtaNow });
    etaClockRef.current = c;
    return () => {
      c.stop();
      etaClockRef.current = null;
    };
  }, [etaBar]);
  useEffect(() => {
    setEtaNow(Date.now());
    etaClockRef.current?.update(etaList);
  }, [etaList]);
  /** Without a host tree: the dev fragment at lk:tree-src (TreeFragment.tsx). */
  const fetchedTree = useFragmentSource(tree && !renderTree && !treeSource);
  /** The widget's strings for the page's language (ui-strings.ts), under the host's. */
  const ui = uiStrings();
  // The strings that were inline here, in the page's language (chat-ui-locales.ts).
  const ux = chatExtra();
  const details = useMessageDetails(ux.messageDetails);
  const withNew = (label: string, n: number) =>
    n ? `${label}, ${ux.newCount.replace("{n}", String(n))}` : label;
  /** Agent lines not read aloud because the page was in the background (voice.ts gateVoice). */
  const [unheardIds, setUnheardIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const u = unheard();
    setUnheardIds(u.ids);
    return u.subscribe(() => setUnheardIds(u.ids));
  }, []);
  /** The latest voice → reply breakdown (latency.ts), for the menu. */
  const [lastLatency, setLastLatency] = useState(() => voiceLatency().latest());
  useEffect(() => {
    const s = voiceLatency();
    setLastLatency(s.latest());
    return s.subscribe(() => setLastLatency(s.latest()));
  }, []);
  /** The mic's adaptive state (adaptive.ts), for the menu's readout. */
  const [adapt, setAdapt] = useState<AdaptState>(() => voiceAdapt().state());
  useEffect(() => {
    const a = voiceAdapt();
    setAdapt(a.state());
    return a.subscribe(setAdapt);
  }, []);
  const treeText = { ...treeDefaults(), ...hostTreeText };
  /** The tree as treeNav sees it (index-path ids), and where its focus and depths are. */
  const navIx = useMemo(() => navIndexOf(treeData.root), [treeData.root]);
  const [nav, setNav] = useState<TreeNavState>(() => initialNav(navIx.ix));
  // A reloaded tree keeps the focus if that node is still there; a fresh
  // page takes the kept one (ui-store.ts) once its nodes have loaded.
  /** The kept tree place has been applied to a loaded tree (the scroll waits for it). */
  const navRestored = useRef(false);
  useEffect(() => {
    if (navIx.ix.roots.length) navRestored.current = true;
    const kept = restoreTree(navIx.ix, navIx.byId, uiStore.getState().tree);
    setNav((s) =>
      s.focusId !== null && navIx.ix.parent.has(s.focusId) ? s : (kept ?? initialNav(navIx.ix)),
    );
  }, [navIx]);
  // Committed steps only (a drag in progress is a preview), on the loaded tree.
  useEffect(() => {
    if (nav.base || nav.focusId === null || !navIx.ix.parent.has(nav.focusId)) return;
    uiStore.setState({ tree: keepTree(navIx.byId, nav, treeScroll.current) });
  }, [nav, navIx]);
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
  /** The tree's scroller: the chat's column expanded, its own body minimized. */
  const treeScroller = () => treeBodyEl.current;
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
  /**
   * The minimized bar's lines: the host's, else the tree's frontier. With a
   * timed task (the ETA bar on), its in-progress line is the two ends instead
   * of the ≈ summary: "<nearest task> 5 min · <last task> 40 min" (eta.ts).
   */
  const treeLines = treeFrontier(treeData.root, {
    locale: globalThis.document?.documentElement.lang,
    inProgress: ui.nowDoing,
  });
  const etaLine = etaBar ? etaParts(etaList, etaNow) : null;
  const shownFrontier =
    frontier ??
    (etaLine
      ? {
          ...treeLines,
          doing: {
            text: etaPartsText(etaLine),
            parts: etaLine,
            items: etaList
              .filter((x) => !x.done)
              .map((x) => ({ title: x.title, path: x.id.startsWith("/") ? x.id : undefined })),
          },
        }
      : treeLines);
  /** The tree overflows (or is scrolled): its top edge fades, as the log's. */
  const [treeFade, setTreeFade] = useState(false);
  const onTreeScroll = () => {
    const el = treeBodyEl.current;
    if (!el) return;
    treeScroll.current = el.scrollTop;
    setTreeFade(el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0);
    // Kept with the tree (ui-store.ts) once the restored scroll has landed.
    const kept = uiStore.getState().tree;
    const top = Math.round(el.scrollTop);
    if (kept && treeScrollPending.current === null && kept.scroll !== top)
      uiStore.setState({ tree: { ...kept, scroll: top } });
  };
  /** A kept tree scroll waiting for the tree's rows to load (then applied once). */
  const treeScrollPending = useRef<number | null>(uiStore.getState().tree?.scroll || null);
  useLayoutEffect(() => {
    const want = treeScrollPending.current;
    const el = treeBodyEl.current;
    // After the kept focus and depths are back (navRestored), so the rows are there.
    if (want === null || !el || !navRestored.current) return;
    treeScrollPending.current = null;
    el.scrollTop = want;
    treeScroll.current = el.scrollTop;
  }, [nav, navIx, tree, open]);
  // Escape closes the tree. It is caught before the mic's own Escape (which
  // turns it off): closing the tree never does. (The tree is click-through, as
  // the log: taps outside it are the page's, and leave it open.)
  useEffect(() => {
    if (!tree) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // On another site, the page's Escape stays the page's unless the chat has focus.
      if (embedded) {
        const box = root.current;
        const scope = box?.getRootNode() as Document | ShadowRoot | undefined;
        if (!box || !scope?.activeElement || !box.contains(scope.activeElement)) return;
      }
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
  /**
   * The draft lives in the session UI store (ui-store.ts), so a refresh or a
   * hot swap keeps it, with whether it is still pure dictation (a restored
   * voice line still sends as `stt`). Cleared on send like any other draft.
   */
  const draft = useUi(uiStore, (s) => s.draft);
  const setDraft = (v: string) =>
    uiStore.setState({
      draft: v,
      pureDictation: v && pureDictation.current === v ? v : null,
      ...(v ? {} : { caret: null }),
    });
  /** The + menu (AttachMenu.tsx): the page selection kept outside the chat, and what goes with the next line. */
  const pageSel = usePageSelection(embedded);
  const appAddItems = useAddItems();
  const attached = useUi(uiStore, (s) => s.attached);
  const [attachMenu, setAttachMenu] = useState(false);
  const closeAttachMenu = useCallback(() => setAttachMenu(false), []);
  /** Files for the next line (files.ts): uploading or stored, removable until sent. */
  const filesRef = useRef(files);
  filesRef.current = attach ? files : undefined;
  const [pending] = useState(() =>
    createPendingFiles({
      files: () => filesRef.current,
      objectUrl:
        typeof URL !== "undefined" && URL.createObjectURL
          ? { create: (f) => URL.createObjectURL(f), revoke: (u) => URL.revokeObjectURL(u) }
          : undefined,
    }),
  );
  /** A send waited for uploads (submit): it goes when they are done. */
  const waitFiles = useRef(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // Files dragged into the window: the whole chat box takes the drop (its log
  // is click-through otherwise), so a dropped file uploads instead of its
  // name landing in the input as text. Ends on drop, or on leaving the window.
  useEffect(() => {
    if (!files || !attach) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer ?? undefined)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const done = () => {
      depth = 0;
      setDragging(false);
    };
    window.addEventListener("dragenter", enter, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", done, true);
    window.addEventListener("dragend", done, true);
    return () => {
      window.removeEventListener("dragenter", enter, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("drop", done, true);
      window.removeEventListener("dragend", done, true);
    };
  }, [files, attach]);
  /** The file picker the + menu opened is up: the input counts as in use (typing-glass.ts inputInUse). */
  const [picking, setPicking] = useState(false);
  const pickFiles = (accept?: string) => {
    const el = picker.current;
    if (!el) return;
    el.accept = accept ?? "";
    setPicking(true);
    el.click();
  };
  // The picker answered (change, below) or was dismissed: its "cancel", or the
  // page getting the focus back where a browser has no "cancel".
  useEffect(() => {
    if (!picking) return;
    const el = picker.current;
    const done = () => setPicking(false);
    el?.addEventListener("cancel", done);
    window.addEventListener("focus", done);
    return () => {
      el?.removeEventListener("cancel", done);
      window.removeEventListener("focus", done);
    };
  }, [picking]);
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
  const draftRef = useRef(uiStore.getState().draft);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The chat's one scroller: the tree (when open) and the log. */
  const log = useRef<HTMLDivElement | null>(null);
  /** The log is scrolled to its end (new messages follow it there). */
  const atEnd = useRef(true);
  /** The scrollTop the resize re-pin set, until its scroll event comes. */
  const pinnedAt = useRef<number | null>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  /**
   * The ETA bar's height (margin included), 0 without it. The floating buttons
   * above the input (scroll-down, ask jump) sit this much higher, so they never
   * cover the bar (owner, 2026-11-08 19:58 JST, Android: all in one spot).
   */
  const [etaH, setEtaH] = useState(0);
  const etaRo = useRef<ResizeObserver | null>(null);
  const etaEl = useRef<HTMLDivElement | null>(null);
  const setEtaBox = (el: HTMLDivElement | null) => {
    if (etaEl.current === el) return;
    etaRo.current?.disconnect();
    etaEl.current = el;
    if (!el) return setEtaH(0);
    const read = () => setEtaH(Math.ceil(el.getBoundingClientRect().height));
    read();
    if (typeof ResizeObserver !== "undefined") {
      etaRo.current = new ResizeObserver(read);
      etaRo.current.observe(el);
    }
  };
  /** Messages that arrived while scrolled up: a dot on the scroll-down button. */
  const [below, setBelow] = useState(0);
  const shown = useRef(messages.length);
  /** The log overflows (or is scrolled): its top edge fades. */
  const [fade, setFade] = useState(false);
  /** The lines whose ask card is above the log's view (ask-above-dom.ts). */
  const [askCardsAbove, setAskCardsAbove] = useState<ReadonlySet<string>>(NONE_ABOVE);
  /** Sets `held` through log-hold-dom.ts, which drops it on a press outside the chat. */
  const holdLog = useRef<((held: Held) => void) | null>(null);
  /**
   * The input has focus: the log opens to 30vh. Otherwise it shows only the
   * last 3 lines, scrolled to the end.
   */
  const [typing, setTyping] = useState(false);
  /**
   * The history is held engaged (log-engage.ts): by a press-and-hold on it, a
   * press on it while typing, or a selection open in the chat; a press
   * outside the chat drops it.
   */
  const [held, setHeld] = useState<Held>(false);
  /** Typing, for the log's height, the glass and the opacity (held open counts). */
  const typingNow = typingLook(typing, held);
  /** The log's last scroll while shown (kept across the tree taking its place). */
  const lastLogScroll = useRef(0);
  const onLogScroll = () => {
    const el = log.current;
    if (!el || el.hidden) return;
    lastLogScroll.current = el.scrollTop;
    setFade(el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0);
    // Our own re-pin's scroll (below) can land a frame late, after the log
    // shrank further (the keyboard): it is not him leaving the end.
    const own = pinnedAt.current !== null && Math.abs(el.scrollTop - pinnedAt.current) <= 1;
    pinnedAt.current = null;
    const end = stillAtEnd({ gap: el.scrollHeight - el.scrollTop - el.clientHeight, ownPin: own });
    atEnd.current = end;
    setScrolledUp(!end);
    if (end) setBelow(0);
  };
  /**
   * A vertical drag on the bar (the mic, or the empty input) scrolls the log,
   * and for as long as it lasts the log goes full screen: it grows upward to
   * the top of the visible area over the panel's own glass (never a sheet
   * over the page), while the bar stays put
   * and floats over it. The lines at its bottom edge do not move; the older
   * ones are revealed above them (a clip-path wipe and the glass's fade,
   * ~200 ms ease-out; at once under reduced motion). On release it folds
   * back the same way: the bar's resting log is the compact one, and a sheet
   * left up over the page would need its own way out.
   */
  const [fullLog, setFullLog] = useState<"off" | "on" | "leaving">("off");
  /** The full-screen log's state, for handlers and observers. */
  const fullNow = useRef(fullLog);
  fullNow.current = fullLog;
  const fullRef = useRef<{
    maxH: number;
    fromH: number;
    gap: number;
    lastDy: number;
    /** From the empty input: the log's own box (fullLogBox, section-relative px). */
    box: { left: number; width: number; bottom: number; height: number; hideBar: boolean } | null;
    /** The line the reader is on, kept in place across the height change (pickAnchor). */
    anchor: { id: string; top: number; height: number } | null;
    /**
     * The resting log's centre (viewport y) at the press: folding back, the
     * line there is the one kept, so the lines he sees where the resting log
     * is stay the same (the tall view's own centre was far back).
     */
    focusY: number;
    /** Folding back: to the end (the newest line was still in view at release), else the anchor. */
    toEnd: boolean;
  }>({ maxH: 0, fromH: 0, gap: 0, lastDy: 0, box: null, anchor: null, focusY: 0, toEnd: false });
  /**
   * Compact mode (compact-view.ts; this device's setting, off by default):
   * while the input has no focus, the open chat shows only its last message.
   * `expanded` is the whole chat brought back by an action (the input's
   * focus, a tap on the compact line, a drag on the log); it folds again
   * after the latest hold (the blur, a scroll, a reply arriving), never while
   * typing, scrolled up, or with a panel or the full-screen log up. One timer,
   * re-armed when it fires: no polling, and no render per scroll.
   */
  const compactPref = useUi(chatPrefs(), (s) => s.compact);
  const [expanded, setExpanded] = useState(false);
  const holdUntil = useRef(0);
  const hold = (ms: number) => {
    holdUntil.current = holdAtLeast(holdUntil.current, Date.now(), ms);
  };
  const [foldTick, setFoldTick] = useState(0);
  const compact = isCompact({
    pref: compactPref,
    open,
    expanded,
    typing,
    tree,
    // Full screen is for reading the whole chat: compact waits until it ends.
    fullLog: fullLog !== "off" || full,
  });
  useEffect(() => {
    const d = foldIn({
      pref: compactPref,
      open,
      expanded,
      typing: typingNow,
      scrolledUp,
      busy: panel !== "none" || fullLog !== "off" || full,
      holdUntil: holdUntil.current,
      now: Date.now(),
    });
    if (d === null) return;
    if (d === "now") return setExpanded(false);
    const t = setTimeout(() => setFoldTick((n) => n + 1), d);
    return () => clearTimeout(t);
  }, [compactPref, open, expanded, typingNow, scrolledUp, panel, fullLog, full, foldTick]);
  // A reply arriving while the whole chat is up: he is reading it, so the
  // fold waits for its reading time (float-lines.ts dwellMs).
  const lastMsg = messages.at(-1);
  useEffect(() => {
    if (!lastMsg || !expanded) return;
    hold(dwellMs(lastMsg.text));
  }, [lastMsg?.id]);
  /**
   * The line nearest the log's centre (its focus line), with where it is now;
   * `"end"`: the newest line instead (the one at the bottom edge); a number:
   * the line at that viewport y.
   */
  const anchorNow = (at?: "end" | number) => {
    const el = log.current;
    if (!el) return null;
    const v = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll<HTMLElement>("[data-testid=debug-chat-line]")].map((r) => {
      const b = r.getBoundingClientRect();
      return { id: r.dataset.msg ?? "", top: b.top, bottom: b.bottom };
    });
    const a = pickAnchor(
      rows,
      at === "end" ? v.bottom : typeof at === "number" ? at : (v.top + v.bottom) / 2,
    );
    return a && a.id ? { id: a.id, top: a.top, height: a.bottom - a.top } : null;
  };
  /** After the height changed: the anchored line back where it was, in the same frame. */
  const holdAnchor = () => {
    const el = log.current;
    const a = fullRef.current.anchor;
    if (!el || !a) return false;
    const row = el.querySelector<HTMLElement>(`[data-testid=debug-chat-line][data-msg="${a.id}"]`);
    if (!row) return false;
    const v = el.getBoundingClientRect();
    el.scrollTop = anchorScrollTop({
      before: a.top,
      after: row.getBoundingClientRect().top,
      height: a.height,
      view: { top: v.top, bottom: v.bottom },
      scrollTop: el.scrollTop,
      maxScroll: el.scrollHeight - el.clientHeight,
    });
    return true;
  };
  const wasFull = useRef(false);
  /**
   * No motion: the system's reduced motion, or the page's own "Turn off
   * animations" (lib/motion-pref.ts, `<html data-motion="off">`, whose CSS
   * zeroes every transition, so no transitionend ever comes).
   */
  const reducedMotion = () =>
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "off") ||
    (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const logDrag = {
    /**
     * `from: "input"` (the empty input): the log keeps its width and only
     * its height snaps, to the visible area top to bottom (log-surface.ts
     * fullLogBox), while the bar steps aside. From the mic, the bar stays
     * (the finger is on it) and the log only grows upward, as before.
     */
    start: (from: "mic" | "input" = "mic") => {
      const el = log.current;
      // The tree in the log's place: the drag scrolls it; no full-screen log.
      // Full screen: the log already spans it, so the drag only scrolls.
      if (tree || full) fullRef.current.lastDy = 0;
      if (!el || !open || tree || full) return;
      // Compact: the log comes back first, so it can be measured.
      if (compact) flushSync(() => setExpanded(true));
      const r = el.getBoundingClientRect();
      const sec = root.current?.getBoundingClientRect();
      let box: (typeof fullRef.current)["box"] = null;
      if (from === "input" && sec) {
        const vv = typeof visualViewport === "undefined" ? null : visualViewport;
        const b = fullLogBox({
          vh: innerHeight,
          visibleTop: vv?.offsetTop ?? 0,
          visibleBottom: vv ? vv.offsetTop + vv.height : innerHeight,
          safe: { top: notch.current, bottom: safeBottom() },
          log: { left: r.left, width: r.width, bottom: r.bottom, height: r.height },
        });
        // Section-relative: the box's bottom and left edges do not move when
        // the log leaves the flow (the box hangs from its bottom).
        box = {
          left: b.left - sec.left,
          width: b.width,
          bottom: sec.bottom - b.bottom,
          height: b.bottom - b.top,
          hideBar: b.hideBar,
        };
      }
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      fullRef.current = {
        // At the end, the newest line holds its place (not the centre one).
        anchor: box ? anchorNow(nearEnd(gap) ? "end" : undefined) : null,
        focusY: (r.top + r.bottom) / 2,
        toEnd: false,
        box,
        maxH: fullLogHeight({
          bottom: r.bottom,
          height: r.height,
          safeTop: notch.current,
          vvTop: typeof visualViewport === "undefined" ? 0 : (visualViewport?.offsetTop ?? 0),
        }),
        fromH: el.clientHeight,
        gap,
        lastDy: 0,
      };
      // At once, before the first move scrolls it: the switch's layout effect
      // holds the anchored line where it was at the press, so a scroll it ran
      // after that first move would undo the move (the log lagged the finger
      // by the touch slop from then on).
      flushSync(() => setFullLog("on"));
    },
    /** The joystick drives it: the finger's travel is taken without scrolling, so coming back inside does not jump. */
    hold: (dy: number) => {
      fullRef.current.lastDy = dy;
    },
    /** Finger travel since the press: the log scrolls by the change (no render). */
    move: (dy: number) => {
      // The tree in the log's place: the drag scrolls the tree.
      const el = tree ? treeBodyEl.current : log.current;
      if (!el) return;
      el.scrollTop -= dy - fullRef.current.lastDy;
      fullRef.current.lastDy = dy;
    },
    end: () => {
      hold(COMPACT_SCROLL_MS);
      setFullLog((s) => (s === "on" ? "leaving" : s));
    },
  };
  /** The log's surface props, full screen: lifted to the visible top, or its own snapped box. */
  const fullSurface = (p: ReturnType<typeof logSurface>, fullScreenNow = false) => {
    // Full screen: the log takes the height the bar leaves (full-screen.ts).
    if (fullScreenNow) return { ...p, style: { ...p.style, ...FULL_LOG_STYLE } };
    if (fullLog === "off") return p;
    const box = fullRef.current.box;
    const transition = reducedMotion() || box ? "none" : WIPE;
    return {
      ...p,
      style: {
        ...p.style,
        // The size switches at once; only the wipe (or the fade) animates.
        transition,
        // Nothing blurs behind it: the lines carry the strong halo.
        ...(sheetLook().solid ? { textShadow: LINE_HALO } : {}),
        ...(box
          ? {
              position: "absolute" as const,
              left: box.left,
              width: box.width,
              bottom: box.bottom,
              height: box.height,
              maxHeight: box.height,
              // Overscroll slack: any line can come to the middle.
              paddingTop: fullLogPad(box.height),
              paddingBottom: fullLogPad(box.height),
            }
          : { maxHeight: fullRef.current.maxH }),
      },
    };
  };
  /** The bar steps aside while the log spans the screen (fullLogBox hideBar). */
  const barAside = fullLog === "on" && !!fullRef.current.box?.hideBar;
  /**
   * The empty input takes the same vertical drag (with a draft, a drag is the
   * draft's own: it scrolls or selects its text). A tap still focuses it.
   */
  const inputAxis = useRef(createAxisLock());
  /**
   * Joystick mode (joystick.ts): a dead zone, a circle of `radius` (Tune),
   * centred on the press. Inside it the drag scrolls the full-screen log as
   * usual; outside it the log keeps scrolling that way, faster the further
   * out, and stops back inside. One rAF loop, stopped on release, disposed
   * on unmount.
   */
  const joystick = useRef<ReturnType<typeof createJoystick> | null>(null);
  /** The tree has the log's place (the joystick scrolls it then). */
  const treeShown = useRef(false);
  treeShown.current = open && tree;
  const tune = useRef(joystickTune());
  useEffect(() => {
    joystick.current = createJoystick((px) => {
      const el = treeShown.current ? treeBodyEl.current : log.current;
      if (el) el.scrollTop += px;
    });
    return () => {
      joystick.current?.dispose();
      joystick.current = null;
    };
  }, []);
  /** The finger at (dx, dy) from the press: a plain drag inside the zone, the joystick outside. */
  const steer = (dx: number, dy: number) => {
    const r = deadZoneSpeed(dx, dy, tune.current, reducedMotion());
    if (r.inside) logDrag.move(dy);
    else logDrag.hold(dy);
    joystick.current?.set(r.speed);
  };
  const inputDrag = {
    onPointerDown: (e: React.PointerEvent<HTMLTextAreaElement>) => {
      tune.current = joystickTune();
      if (!open || draftRef.current) return;
      inputAxis.current.down(e.clientX, e.clientY);
      // Captured from the press: a quick flick leaves the input before the
      // axis locks, and its moves must still come here (touch pointers are
      // captured implicitly; a mouse or pen is not).
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLTextAreaElement>) => {
      const was = inputAxis.current.axis();
      const m = inputAxis.current.move(e.clientX, e.clientY);
      if (!m || m.axis !== "y") return;
      if (!was) {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        logDrag.start("input");
      }
      steer(m.dx, m.dy);
    },
    onPointerUp: () => {
      joystick.current?.set(0);
      if (inputAxis.current.up() === "y") logDrag.end();
    },
    onPointerCancel: () => {
      joystick.current?.set(0);
      if (inputAxis.current.up() === "y") logDrag.end();
    },
  };
  /** The wipe's start (the height the log gained), for the way in and out. */
  const revealed = () => {
    const el = log.current;
    return el ? Math.max(0, el.clientHeight - fullRef.current.fromH) : 0;
  };
  useLayoutEffect(() => {
    const el = log.current;
    const was = wasFull.current;
    wasFull.current = fullLog !== "off";
    if (!el) return;
    if (fullLog === "on") {
      // Taller now: keep the line being read where it was (its own box), or
      // the bottom lines (growing upward from the mic).
      if (!(fullRef.current.box && holdAnchor()))
        el.scrollTop = keepEndGap({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          gap: fullRef.current.gap,
        });
      // Its own box: the same node, the same width, only taller, the line
      // being read held in place: nothing to animate (the glass fades), and
      // never an opacity-0 start, which left the list blank.
      if (reducedMotion() || fullRef.current.box) return;
      const h = revealed();
      if (!h) return;
      el.style.transition = "none";
      el.style.clipPath = `inset(${h}px 0 0 0)`;
      void el.offsetHeight; // the start of the wipe, once per switch
      el.style.transition = WIPE;
      el.style.clipPath = "inset(0px 0 0 0)";
    } else if (fullLog === "leaving") {
      fullRef.current.gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      // The newest line still in view: back to the end. Else the line being
      // read now, to keep in view as the log folds back.
      if (fullRef.current.box) {
        const rows = el.querySelectorAll<HTMLElement>("[data-testid=debug-chat-line]");
        const last = rows[rows.length - 1]?.getBoundingClientRect() ?? null;
        const v = el.getBoundingClientRect();
        fullRef.current.toEnd =
          foldBackTo({ newest: last, view: { top: v.top, bottom: v.bottom } }) === "end";
        fullRef.current.anchor = fullRef.current.toEnd ? null : anchorNow(fullRef.current.focusY);
      }
      const h = revealed();
      // Its own box folds back at once (no fade out, nothing to wait for).
      if (reducedMotion() || !h || fullRef.current.box) return setFullLog("off");
      el.style.clipPath = `inset(${h}px 0 0 0)`;
      // transitionend ends it (below); a one-shot fallback if it never fires.
      const t = setTimeout(() => setFullLog((s) => (s === "leaving" ? "off" : s)), 320);
      return () => clearTimeout(t);
    } else if (was) {
      // Back to its resting height at once (the wipe already hid the rest):
      // the newest lines when idle, as the compact log always shows; typing,
      // the lines that were at its bottom edge.
      const fromBox = !!fullRef.current.box;
      const toEnd = fromBox && fullRef.current.toEnd;
      fullRef.current.box = null;
      fullRef.current.toEnd = false;
      el.style.transition = "none";
      el.style.clipPath = "";
      // From its own box: the line being read stays in view (as near its
      // place as the compact log allows). Else as before: the newest lines
      // when idle, the lines at the bottom edge while typing.
      if (toEnd) el.scrollTop = el.scrollHeight;
      else if (!(fromBox && holdAnchor()))
        el.scrollTop =
          typing || micActive
            ? keepEndGap({
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                gap: fullRef.current.gap,
              })
            : el.scrollHeight;
      fullRef.current.anchor = null;
      void el.offsetHeight;
      el.style.transition = "";
      // Where it landed decides (not the slack-shifted scrolls before it).
      atEnd.current = toEnd;
      onLogScroll();
    }
  }, [fullLog]);
  const input = useRef<HTMLTextAreaElement | null>(null);
  // A restored draft gets its caret back (without focus: no keyboard pops up).
  useLayoutEffect(() => {
    const el = input.current;
    const { draft: d, caret } = uiStore.getState();
    if (!el || !d) return;
    const at = Math.min(caret ?? d.length, el.value.length);
    try {
      el.setSelectionRange(at, at);
    } catch {}
  }, []);
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
  // empty input scrolls it instead (inputDrag, by pointer events). Here the
  // swipe only keeps the page from scrolling; it once scrolled the log as
  // well, so the log moved twice the finger's travel. Only the pill moves the box.
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
      // With text in it, the swipe scrolls the text.
      if (el.value.length > 0) return;
      if (!swiping && Math.abs(e.touches[0].clientY - y) < 6) return;
      swiping = true;
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
    };
  }, [open]);
  // A wheel or trackpad scroll over the bar (the input, its buttons) scrolls
  // the log, as a drag on the empty input does (wheel-forward.ts). A long
  // draft (or a menu) that can still scroll that way keeps it. Not passive:
  // the forwarded wheel must not also scroll the page; one left alone is
  // never cancelled. Touch never fires wheel: the drag paths are untouched.
  const holdRef = useRef(hold);
  holdRef.current = hold;
  useEffect(() => {
    const bar = barEl.current;
    if (!bar) return;
    const wheel = (e: WheelEvent) => {
      const own: ScrollBox[] = [];
      for (let n = e.target as HTMLElement | null; n && n !== bar; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === "auto" || oy === "scroll") own.push(n);
      }
      const el = treeShown.current ? treeBodyEl.current : log.current;
      const dy = forwardWheel({
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        own,
        log: el && !el.hidden ? el : null,
      });
      if (!dy || !el) return;
      if (e.cancelable) e.preventDefault();
      el.scrollTop += dy;
      userScrollAt.current = Date.now();
      holdRef.current(COMPACT_SCROLL_MS);
    };
    bar.addEventListener("wheel", wheel, { passive: false });
    return () => bar.removeEventListener("wheel", wheel);
  }, [open]);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  useEffect(() => {
    synth()?.getVoices(); // starts loading them, so the first reply finds one
    return () => clearTimeout(timer.current);
  }, []);
  /**
   * The mic's local STT route (localSttRoute): a stored value wins; with none,
   * the owner's page defaults to his Mac. Never on a friend's page.
   */
  const storedStt = read(LOCAL_STT_KEY);
  const sttRoute = friend ? { source: "none" as const } : localSttRoute(storedStt, owner, true); // rtc:lianki may be mixed in (MicButton isMixedRoutes)
  useEffect(() => {
    // The devLog says where speech goes: `via` on the ready line, and here the route's source.
    if (sttRoute.source !== "none")
      voice().log({ ev: "local-stt", state: "route", source: sttRoute.source, urls: sttRoute.urls ?? "" });
  }, [sttRoute.source, sttRoute.urls]);
  /** The voice session (voice.ts): mic on, reading, sentences queued. */
  const [vs, setVs] = useState<VoiceState>(QUIET);
  useEffect(() => {
    const v = voice();
    setVs(v.state());
    return v.subscribe(setVs);
  }, []);
  // Any tap or key on the page unlocks Li's voice (speech-unlock.ts): a reply
  // on /reader is read with no tap on the chat, after a reload too.
  useEffect(() => unlockOnGesture(window, unlockSpeech), []);
  // Playback refused (autoplay, or iOS dropping speech before a tap): the next
  // tap anywhere on the page lets it go on too. Kept until one is an activation.
  useEffect(() => {
    if (!vs.blocked) return;
    const on = () => unblockVoice();
    for (const t of UNLOCK_EVENTS) window.addEventListener(t, on, { capture: true, passive: true });
    return () => {
      for (const t of UNLOCK_EVENTS) window.removeEventListener(t, on, { capture: true });
    };
  }, [vs.blocked]);
  // The tab hiding stops the reading — unless the mic is on (hands-free), or on
  // a computer, where it reads on in the background (voice-bg.ts).
  useEffect(() => {
    const hide = () =>
      document.visibilityState !== "visible" &&
      hideStops(isDesktop()) &&
      !voice().state().mic &&
      voice().stop();
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  // Compact again (the input lost focus): back to the newest lines. Not while
  // held open: a press on a line took the focus, and the lines must stay put
  // under the drag that selects them.
  useLayoutEffect(() => {
    if (typingNow) return;
    const el = log.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
    atEnd.current = true;
    setScrolledUp(false);
    setBelow(0);
  }, [typingNow]);
  useLayoutEffect(() => {
    if (!open) return;
    const added = messages.length - shown.current;
    shown.current = messages.length;
    // Follow new messages only from the end (or the owner's own, just sent);
    // scrolled up, they wait under the scroll-down button's dot.
    const mine = added > 0 && messages.at(-1)?.from !== "agent";
    if (atEnd.current || mine) {
      log.current?.scrollTo({ top: log.current.scrollHeight });
      // Its scroll event can land after the newest run grew (the arrow's
      // room, a card): this pin's own, not him leaving the end.
      if (log.current) pinnedAt.current = log.current.scrollTop;
      atEnd.current = true;
      setScrolledUp(false);
      setBelow(0);
    } else if (added > 0) setBelow((n) => n + added);
    const el = log.current;
    if (el) setFade(el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0);
  }, [messages, open]);
  // At the end, the log stays there when it or its lines change size (the
  // keyboard, the text size, the box moved, a card opening): a shrinking
  // scroller keeps its scrollTop, which showed older lines. Scrolled up, it
  // is left alone; the full-screen log places itself.
  useEffect(() => {
    const el = log.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.hidden || fullNow.current !== "off") return;
      const top = repinEnd({
        atEnd: atEnd.current,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      if (top === null) return;
      el.scrollTop = top;
      pinnedAt.current = el.scrollTop;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [open]);

  const messagesNow = useRef(messages);
  messagesNow.current = messages;
  /** How many commands the mic's taps had kept at the last spoken line. */
  const tapsAtVoice = useRef(0);
  /** Send the draft; true when it went out. */
  const submit = (): boolean => {
    clearTimeout(timer.current);
    // Sent another way (Enter, the send button): nothing is held any more.
    joiner.current?.cancel();
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
    // Files still uploading: the line waits for them, and goes once they are stored.
    if (pending.busy()) {
      waitFiles.current = true;
      return false;
    }
    const hasFiles = pending.get().some((p) => p.state === "done");
    // Files alone: the line's text is their names (a line always has text).
    if (!text && hasFiles)
      text = pending
        .get()
        .flatMap((p) => (p.state === "done" ? [p.name] : []))
        .join(", ")
        .slice(0, MAX_CHAT);
    if (!text) return false;
    const source = draftSource(draftRef.current, pureDictation.current);
    // A voice line carries its timestamps (latency.ts): the latest utterance in it.
    // And which recognizer made it (SttTag): an older store (hot swap) has no takeLine.
    const lat = voiceLatency();
    const taken: { timing?: VoiceTiming; stt?: SttTag } = source
      ? (lat.takeLine?.() ?? { timing: lat.take() }) : {};
    const timing = taken.timing;
    const stt = taken.stt;
    // And the Mac's speaker check (voiceprint.ts): the weakest of its utterances.
    // The Mac's signed proofs ride along; the hub verifies them and stores the tag.
    const heardFrom = source ? takeSpeaker() : (clearSpeaker(), undefined);
    const speakerProof = heardFrom?.proofs;
    // What was attached with the + menu rides along, this line only.
    const context = uiStore.getState().attached ?? undefined;
    const attachments = hasFiles ? pending.get().flatMap((p) => (p.ref ? [p.ref] : [])) : [];
    // Continuous speech (voice-merge.ts): asks to amend the line before, if it is
    // stamped mergeable (the flag is on) and no command ran since. The hub decides.
    const tapsNow = micTaps().kept?.() ?? 0;
    const lastLine = messagesNow.current.at(-1);
    const continues =
      source &&
      lastLine &&
      tapsAtVoice.current === tapsNow &&
      mergeVerdict(lastLine, {
        text,
        ...(timing ? { timing } : {}),
        ...(to === ROOT_NODE ? {} : { to }),
        ...(context ? { context } : {}),
        ...(heardFrom?.tag ? { speaker: heardFrom.tag } : {}),
        attachments,
      }).ok
        ? lastLine.id
        : undefined;
    const opts = {
      ...(attachments.length ? { attachments } : {}),
      ...(continues ? { continues } : {}),
      ...(source ? { source } : {}),
      ...(source && timing ? { timing } : {}),
      ...(source && stt ? { stt } : {}),
      ...(source && speakerProof?.length ? { speakerProof } : {}),
      ...(context ? { context } : {}),
    };
    if (
      !sendRef.current(
        text,
        to === ROOT_NODE ? undefined : to,
        Object.keys(opts).length ? opts : undefined,
      )
    ) {
      setOffline(true);
      return false;
    }
    setOffline(false);
    if (context) {
      uiStore.setState({ attached: null });
      pageSel.clear();
    }
    if (pending.get().length) pending.take();
    // A typed line says which language the owner speaks: the mic's STT hint.
    if (!source) learnSttHint(text);
    // A spoken line went out, by whichever path (the join, Enter, the debounce):
    // one cue for it (cues.ts), here and nowhere else. Typed lines are silent.
    else {
      // Amending the last line is not a new message: its own softer cue. The page asks by
      // the rule the hub applies, so they agree but for a reply already on its way.
      window.dispatchEvent(
        new CustomEvent(VOICE_SENT_EVENT, {
          detail: { sound: continues ? pageCues().amend() : pageCues().send() },
        }),
      );
      tapsAtVoice.current = tapsNow;
      passage.current?.final();
    }
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
  const pureDictation = useRef<string | null>(uiStore.getState().pureDictation);
  /** The draft's length when it last changed outside an IME composition. */
  // A restored draft is settled text, not a burst.
  const settledLen = useRef(draftRef.current.length);
  /** The key going down is Shift+Enter: its line break stays a line break. */
  const shiftEnter = useRef(false);
  /** The mic is listening, or has transcripts out: the debounce waits for it. */
  const micOn = useRef(false);
  /** The mic is on (drives the open log too: iOS drops input focus on a button tap). */
  const [micActive, setMicActive] = useState(false);
  /**
   * Lianki's speech servers for an account other than the owner (public-stt.ts):
   * asked once per page when the mic first turns on (GET /api/stt/session: 404
   * while the flag stt.worker is off or the account is not on the list), never in
   * an utterance's path. "ask" shows the consent card; only "on" changes the route.
   * The owner's own route (sttRoute) is never touched.
   */
  const [publicStt, setPublicStt] = useState<"unknown" | "no" | "ask" | "on">("unknown");
  useEffect(() => {
    if (owner || !micActive || publicStt !== "unknown" || sttRoute.source !== "none") return;
    let live = true;
    void publicSttAvailable().then((ok) => {
      if (!live) return;
      const c = readConsent();
      setPublicStt(!ok || c === "off" ? "no" : c === "on" ? "on" : "ask");
    });
    return () => {
      live = false;
    };
  }, [owner, micActive, publicStt, sttRoute.source]);
  const micRoute = sttRoute.source === "none" && !owner && publicStt === "on" ? PUBLIC_ROUTE_LIST : sttRoute.urls;
  /** The history takes the pointer: wheel and drag scroll it, its lines select (log-engage.ts). */
  const engaged = logEngaged({ typing, plusMenu: attachMenu || picking, micActive, held });
  const busyRef = useRef(false);
  busyRef.current = engaged && !held;
  // Open asks above the view (ask-above.ts). Only the shown log has a view: the
  // compact line shows its open asks itself, and a drag's full-screen log is
  // under the finger. An answer (from any device) arrives in `messages`, an
  // expiry is read on the next render or tap, so neither needs a timer.
  const openAsks = openAskIds(messages, Date.now());
  const openAsksKey = openAsks.join("\n");
  const askWatch = open && !tree && !compact && fullLog === "off";
  useEffect(() => {
    const el = log.current;
    if (!el || !askWatch || !openAsksKey) {
      setAskCardsAbove(NONE_ABOVE);
      return;
    }
    return watchAsksAbove(el, openAsksKey.split("\n"), setAskCardsAbove);
  }, [askWatch, openAsksKey]);
  const asksUp = askWatch ? asksAbove(openAsks, askCardsAbove) : [];
  /** Nothing over the bar has the place the button would take. */
  const askJumpShown = asksUp.length > 0 && !attachMenu && !inboxOpen && panel === "none";
  const askJumpText = jumpLabel(
    strings?.askJump ? t.askJump : ui.askJump,
    asksUp.length,
  );
  /** One tap: the nearest question above, at the log's top, with the log open to read and answer it. */
  const jumpToAsk = () => {
    const el = log.current;
    const id = nearestAbove(asksAbove(openAskIds(messages, Date.now()), askCardsAbove));
    const line = id && el && lineIn(el, id);
    if (!id || !el || !line) return;
    atEnd.current = false;
    el.scrollTop = jumpTop({
      scrollTop: el.scrollTop,
      lineTop: line.getBoundingClientRect().top,
      rootTop: el.getBoundingClientRect().top,
    });
    hold(COMPACT_SCROLL_MS);
    if (!typing && !micActive) holdLog.current?.("open");
    jumpedTo.current = { id, at: Date.now() };
    // The observer says so a frame later; a quick second tap goes on from here.
    setAskCardsAbove((s) => new Set([...s].filter((x) => x !== id)));
  };
  /**
   * The card a tap just brought in. When the arrow then hides (or its count
   * changes), the newest run's side room goes or shrinks and the run reflows:
   * a card inside a long run of one sender's lines moved up past the view's
   * top (#664). Put it back at the top once, in the same frame.
   */
  const jumpedTo = useRef<{ id: string; at: number } | null>(null);
  useLayoutEffect(() => {
    const j = jumpedTo.current;
    const el = log.current;
    if (!j || !el) return;
    if (Date.now() - j.at > REALIGN_MS) {
      jumpedTo.current = null;
      return;
    }
    const line = lineIn(el, j.id);
    if (!line) return;
    el.scrollTop = jumpTop({
      scrollTop: el.scrollTop,
      lineTop: line.getBoundingClientRect().top,
      rootTop: el.getBoundingClientRect().top,
    });
    if (!askJumpShown) jumpedTo.current = null;
  }, [askJumpShown, asksUp.length]);
  /**
   * Into full screen and back (full-screen.ts). Only the view changes: the
   * line being read keeps its place on screen across the switch (at the end,
   * the resize re-pin keeps the newest line); the draft, its focus and the
   * mic are the same elements, untouched.
   */
  const fullAnchor = useRef<ReturnType<typeof anchorNow>>(null);
  /** Entered by a tap in this page: it owns one history entry (Back leaves full screen). */
  const fullByTap = useRef(false);
  const setFull = (on: boolean, byTap = false) => {
    if (on === fullOn.current) return;
    fullAnchor.current = atEnd.current ? null : anchorNow();
    fullByTap.current = on && byTap;
    chatPrefs().setState({ full: on });
  };
  leaveFull.current = () => setFull(false);
  useLayoutEffect(() => {
    const el = log.current;
    const a = fullAnchor.current;
    fullAnchor.current = null;
    if (!el || !a) return;
    const row = el.querySelector<HTMLElement>(`[data-testid=debug-chat-line][data-msg="${a.id}"]`);
    if (!row) return;
    const v = el.getBoundingClientRect();
    el.scrollTop = anchorScrollTop({
      before: a.top,
      after: row.getBoundingClientRect().top,
      height: a.height,
      view: { top: v.top, bottom: v.bottom },
      scrollTop: el.scrollTop,
      maxScroll: el.scrollHeight - el.clientHeight,
    });
  }, [full]);
  // Back leaves full screen (docs/ui-state.md, "Back closes an overlay";
  // full-screen.ts fullScreenBack): its entry is taken at once after a tap,
  // else at the first gesture. Left any other way, the entry is consumed.
  useEffect(() => {
    if (!full || !backToClose) return;
    const close = fullScreenBack(
      window,
      backToClose,
      () => {
        fullByTap.current = false;
        chatPrefs().setState({ full: false });
      },
      fullByTap.current,
    );
    return () => {
      fullByTap.current = false;
      close();
    };
  }, [full]);
  /** The + menu or the inbox is up: their own Escape closes them first. */
  const attachMenuNow = useRef(false);
  attachMenuNow.current = attachMenu || inboxOpen;
  // Escape leaves full screen, after the tree's and the + menu's own Escape.
  // Caught before the mic's Escape (which turns it off): leaving full screen
  // never does.
  useEffect(() => {
    if (!full) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Native message popovers dismiss before the surrounding full-screen chat.
      if (document.querySelector(":popover-open")) return;
      if (!escapeLeaves({ full: fullOn.current, panelOpen: panelNow.current !== "none", plusMenu: attachMenuNow.current }))
        return;
      e.stopPropagation();
      setFull(false);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [full]);
  // At rest the history is click-through; a press-and-hold on it engages it
  // and selects the line under the finger (log-hold-dom.ts). Events only.
  useEffect(
    () =>
      wireLogHold({
        log: () => {
          const el = treeShown.current ? treeBodyEl.current : log.current;
          return el && !el.hidden ? el : null;
        },
        chat: () => root.current,
        busy: () => busyRef.current,
        onHeld: setHeld,
        onReady: (hold) => {
          holdLog.current = hold;
        },
      }),
    [],
  );
  // The tree's fade follows its size: on opening, switching mode, expanding.
  useLayoutEffect(() => {
    if (tree) onTreeScroll();
  }, [tree, open, typing, micActive]);
  const micPending = useRef(0);
  /** This browser can capture (the mic button shows inside the input). */
  const [hasMic, setHasMic] = useState(false);
  // No mic on another site: its speech-to-text and voice are lianki.com's.
  useEffect(() => setHasMic(!embedded && canCapture()), [embedded]);
  /** Dimmed after the draft: partial transcripts, or "…" for those still out. */
  const [interim, setInterim] = useState("");
  const mirror = useRef<HTMLDivElement | null>(null);
  /** A transcript lands in the draft, as typed text would, but is never sent by itself. */
  /**
   * The join (voice-tune.ts): a spoken line's send is held up to joinMs;
   * speech starting again cancels it and the next final joins the same line.
   * Holding beats sending at once and appending later: the agent never sees
   * (or answers) half a sentence, and the page cannot edit a sent line (the
   * hub's edit is the agent's). The cost is up to joinMs on a line that is
   * really done; it is tunable, and 0 sends at once.
   */
  const sendVoice = () => void submit();
  const joiner = useRef<ReturnType<typeof createJoiner> | null>(null);
  joiner.current ??= createJoiner({
    send: () => sendVoiceRef.current(),
    joinMs: () => voiceTune().joinMs,
    setTimer: (f, ms) => setTimeout(f, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  /**
   * The end of a passage: a second join, on what was already sent. No speech for
   * PASSAGE_END_MS after a spoken line, with nothing being heard or transcribed, and
   * if that line is a merged one the hub is told (one polish for all of it).
   */
  const passage = useRef<ReturnType<typeof createJoiner> | null>(null);
  const passageEnd = () => {
    const mic = (globalThis as { __lkMic?: { view?: () => { state: string } } }).__lkMic?.view?.();
    if (micPending.current || mic?.state === "capturing") return passage.current?.final();
    if (messagesNow.current.findLast((m) => m.from === "owner")?.parts) onPassageEndRef.current?.();
  };
  const passageEndRef = useRef(passageEnd);
  passageEndRef.current = passageEnd;
  const onPassageEndRef = useRef(onPassageEnd);
  onPassageEndRef.current = onPassageEnd;
  passage.current ??= createJoiner({
    send: () => passageEndRef.current(),
    joinMs: () => PASSAGE_END_MS,
    setTimer: (f, ms) => setTimeout(f, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  const sendVoiceRef = useRef(sendVoice);
  sendVoiceRef.current = sendVoice;
  /** Uploads finished: a held send goes now; files alone send after the usual pause. */
  const afterUpload = useRef(() => {});
  afterUpload.current = () => {
    if (pending.busy()) return;
    if (waitFiles.current) {
      waitFiles.current = false;
      submit();
    } else if (pending.get().some((p) => p.state === "done")) arm();
  };
  useEffect(() => pending.subscribe(() => afterUpload.current()), [pending]);
  useEffect(() => {
    const on = () => {
      joiner.current?.speechStart();
      passage.current?.speechStart();
    };
    window.addEventListener(VOICE_CAPTURE_EVENT, on);
    return () => {
      window.removeEventListener(VOICE_CAPTURE_EVENT, on);
      joiner.current?.cancel();
      passage.current?.cancel();
    };
  }, []);
  const dictated = (t: string) => {
    // A blip (one short Latin word, or only 嗯/呃) is not a line; short answers pass.
    if (isBlip(t)) {
      voice().log({ ev: "stt-blip", chars: t.length });
      joiner.current?.idle();
      passage.current?.idle();
      return;
    }
    voiceLatency().shown();
    const { draft: next, send } = appendDictation(draftRef.current, t);
    pureDictation.current = dictatedDraft(draftRef.current, pureDictation.current, next);
    caretToEnd.current = true;
    draftRef.current = next;
    settledLen.current = next.length; // not a typed "burst"
    setDraft(next);
    setOffline(false);
    // A spoken sentence goes out after the join window (a soft tick; typed
    // sends are silent), unless more speech joins it; anything else waits
    // for the usual rules.
    if (send) {
      joiner.current?.final();
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
      (!draftRef.current.trim() && !pending.get().some((p) => p.state === "done")) ||
      parseAddress(draftRef.current)?.complete === false
    )
      return setArmed(0);
    setArmed((n) => n + 1);
    timer.current = setTimeout(submit, DEBOUNCE_MS);
  };
  const toggle = (v: boolean) => {
    if (v) atEnd.current = true;
    // Opened from anywhere (the island, a voice command, the menu): no longer tucked.
    if (v && chatFold().getState().tucked) chatFold().setState({ tucked: false });
    setOpen(v);
    write(OPEN_KEY, v ? "1" : "0");
  };
  /**
   * The nav island's partner button (`chat.open`, island-bus.ts): the chat
   * opens and its input takes the focus; a `node` aims the next line there.
   */
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const aimRef = useRef(aim);
  aimRef.current = aim;
  useEffect(
    () =>
      onChatOpen(({ node }) => {
        if (node) aimRef.current(node);
        focusOnOpen.current = true;
        toggleRef.current(true);
        if (openRef.current) input.current?.focus();
      }),
    [],
  );
  /** chat.open asked for the input: focused once the expand has rendered (it is inert minimized). */
  const focusOnOpen = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    input.current?.focus();
  }, [open]);
  /**
   * One step of the fold (fold.ts): open or minimize, tuck or untuck (a
   * slide unless `instant`), and the edge, keeping a minimized pill where it
   * is when the box mirrors.
   */
  const foldBy = (ev: FoldEvent, instant = false) => {
    const cur = foldNow.current;
    const next = foldNext(cur, ev);
    if (next.fold === cur.fold && next.edge === cur.edge) return;
    shift(
      mirrorShift({
        from: cur.edge,
        to: next.edge,
        fold: cur.fold,
        boxWidth: root.current?.getBoundingClientRect().width ?? 0,
        pillWidth: barEl.current?.getBoundingClientRect().width ?? 0,
      }),
    );
    const tuckNow = next.fold === "tucked";
    if (tuckNow !== (cur.fold === "tucked")) {
      if (tuckNow) {
        // What was floating stays behind; only what arrives from now on peeks.
        setFloats([]);
        setPanel("none");
      }
      const slide = !instant && !reducedMotion() && next.fold !== "open";
      setSliding(slide);
      clearTimeout(slideEnd.current);
      // The slide's transitionend ends it; this only in case none comes.
      slideEnd.current = setTimeout(endSlide, slide ? 400 : 0);
    }
    foldNow.current = next;
    foldStore.setState({ tucked: tuckNow, edge: next.edge });
    if ((next.fold === "open") !== open) toggle(next.fold === "open");
  };
  // While dragging: the moment letting go would enter full screen, preview it.
  onDragMove.current = (bar) => {
    const on =
      !!bar &&
      dropEntersFull({
        allowed: fullAllowed && !tucked,
        open,
        full: fullOn.current,
        barBottom: bar.bottom,
        vh: innerHeight,
      });
    const step = fullHintStep(fullHintRef.current, on);
    if (!step) return;
    fullHintRef.current = on;
    setFullHint(on);
    // A light tick on the way in (Android; navigator.vibrate is absent on iOS).
    if (step === "enter") navigator.vibrate?.(FULL_HINT_HAPTIC_MS);
  };
  // A drag of the box ended: it follows its nearest edge (no tuck: that level is removed).
  onDrop.current = (bar) => {
    const vw = innerWidth;
    // Dropped flush against the bottom: full screen (full-screen.ts dropEntersFull).
    if (
      dropEntersFull({
        allowed: fullAllowed && !tucked,
        open,
        full: fullOn.current,
        barBottom: bar.bottom,
        vh: innerHeight,
      })
    )
      setFull(true, true);
    foldBy({
      type: "dropped",
      nearest: nearestEdge(bar.boxLeft, bar.boxRight, vw),
      against: pushedAgainst(bar.left, bar.right, vw),
    });
  };
  gripAct.current = {
    // Open: minimize into the pill. The pill: open it again.
    single: () => {
      setPanel("none");
      foldBy({ type: "mark" });
    },
    double: () => setPanel((p) => (p === "menu" ? "none" : "menu")),
  };
  /**
   * Minimized, the log is hidden and messages float above the bar instead
   * (float-lines.ts): those that arrive while minimized, or the lines a scrub
   * on the mic brings back. Each fades on its own after its dwell.
   */
  const [floats, setFloats] = useState<ChatMessage[]>([]);
  /** Each floating line's life, by id: a line never fades before the one above it (fifoDwellMs). */
  const floatLives = useRef(new Map<string, { remaining: () => number }>());
  /** Polished voice lines shown as first heard (their mark tapped). */
  const [rawIds, setRawIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRaw = (id: string) =>
    setRawIds((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  /**
   * A polished line's text as shown, and its mark (nothing for any other line).
   * A summary's mark is a visible tag (ui.summary), and its raw is every line as heard.
   * Other polished or merged voice lines keep their text in place: the same
   * sparkle opens their raw transcript in a popover.
   */
  const polish = (m: ChatMessage) => {
    if ((!m.edited && !m.summary && !m.passage) || m.raw === undefined)
      return { text: m.text, mark: null };
    const raw = Boolean(m.summary) && rawIds.has(m.id);
    return {
      text: raw ? (
        <span data-testid="debug-chat-raw" className="text-gray-500">
          <RichBody rich={richOf(m.raw, "markdown")} onOpenPage={onOpenPage} />
        </span>
      ) : (
        m.text
      ),
      mark: (
        <>
          <PolishedMark
            icon={
              m.summary ? (
                <span data-testid="debug-chat-summary" className="rounded border border-current px-1 text-[0.8em]">
                  {ui.summary}
                </span>
              ) : (
                polishedIcon
              )
            }
            label={
              m.summary
                ? ui.summaryTip
                : strings?.polished
                  ? t.polished
                  : ui.polished
            }
            showRaw={raw}
            onToggle={() => toggleRaw(m.id)}
            rawText={m.summary ? undefined : m.raw}
          />
        </>
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
  /** The scrub moved within SCRUB_PULSE_MS: the lines pulse (shimmer.ts); stops when it rests. */
  const [scrubMoving, setScrubMoving] = useState(false);
  const scrubRest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrubMoved = () => {
    setScrubMoving(true);
    clearTimeout(scrubRest.current);
    scrubRest.current = setTimeout(() => setScrubMoving(false), SCRUB_PULSE_MS);
  };
  useEffect(() => () => clearTimeout(scrubRest.current), []);
  /** Show the SCRUB_LINES lines that end `n` back from the newest. */
  const scrubTo = (n: number) => {
    back.current = n;
    const end = messages.length - n;
    setFloats(messages.slice(Math.max(0, end - SCRUB_LINES), end));
    setFloatEpoch((e) => e + 1);
  };
  /**
   * A press on the mic (owner, 2026-11-10, push to talk: ptt.ts): a tap
   * toggles always-on listening (MicButton's click); a long press is one
   * voice line, recorded from the pointerdown and sent on release; held, a
   * slide PTT_CANCEL_PX away arms a cancel. Locked horizontally before the
   * hold, it moves the box. It no longer scrubs the history (drag the
   * history itself; ↑/↓ still step through it).
   */
  const micAxis = useRef(createAxisLock());
  const micDragged = useRef(createDragFlag());
  const micPress = useRef({ x: 0, y: 0 });
  /** The push-to-talk state for the button (held: the red ring and the elapsed time). */
  const [pttView, setPttView] = useState<{ state: PttState; since: number }>({
    state: "idle",
    since: 0,
  });
  const pttRec = useRef<ReturnType<typeof pttRecorder> | null>(null);
  const pttAt = useRef(0);
  /** The last press was push to talk: its click is no tap. */
  const pttWasHold = useRef(false);
  const ptt = useRef<ReturnType<typeof createPttGesture> | null>(null);
  ptt.current ??= createPttGesture({
    press: (at) => {
      pttAt.current = at;
      pttRec.current = pttRecorder();
      pttRec.current.start();
    },
    hold: () => {
      pttWasHold.current = true;
      // A light tick (Android; iOS has no navigator.vibrate, and that is fine).
      navigator.vibrate?.(PTT_HAPTIC_MS);
    },
    release: (at) => {
      const rec = pttRec.current;
      pttRec.current = null;
      const start = pttAt.current;
      if (!rec) return;
      void rec
        .finish()
        .then(({ text, audioMs, stt }) => {
          if (!text) return;
          const done = Date.now();
          const timing: VoiceTiming = {
            t_speechStart: start,
            t_speechEnd: at,
            t_uploadStart: at,
            t_sttDone: done,
            t_sent: done,
            audioMs,
          };
          const to = targetRef.current;
          // Sent at once: push to talk has no draft step.
          sendRef.current(text, to === ROOT_NODE ? undefined : to, {
            source: "stt",
            timing,
            ...(stt ? { stt } : {}),
          });
          window.dispatchEvent(
            new CustomEvent(VOICE_SENT_EVENT, { detail: { sound: pageCues().send() } }),
          );
        })
        // A failed transcription: logged for the dev view, the line is not sent.
        .catch((e: unknown) => {
          voice().log({ ev: "ptt-error", error: String((e as Error)?.message ?? e) });
        });
    },
    drop: () => {
      pttRec.current?.abort();
      pttRec.current = null;
    },
    state: (st) =>
      setPttView((v) => ({ state: st, since: st === "held" && v.state !== "away" ? Date.now() : v.since })),
  });
  const micGesture = {
    description: MIC_PTT_HINT,
    ptt: pttView,
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      micAxis.current.down(e.clientX, e.clientY);
      micDragged.current.down();
      micPress.current = { x: e.clientX, y: e.clientY };
      pttWasHold.current = false;
      ptt.current!.down(e.clientX, e.clientY);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const g = ptt.current!;
      // Held: the finger only arms or disarms the cancel; nothing else moves.
      if (g.state() === "held" || g.state() === "away") return g.move(e.clientX, e.clientY);
      const was = micAxis.current.axis();
      const m = micAxis.current.move(e.clientX, e.clientY);
      if (!m || m.axis !== "x") return;
      // Sideways before the hold: a drag that moves the box, no clip.
      g.drag();
      if (!was) begin(micPress.current.x, micPress.current.y);
      handle.onPointerMove(e);
    },
    onPointerUp: () => {
      const axis = micAxis.current.up();
      if (axis) micDragged.current.dragEnded();
      if (axis === "x") handle.onPointerUp();
      ptt.current!.up();
    },
    onPointerCancel: () => {
      const axis = micAxis.current.up();
      if (axis === "x") handle.onPointerCancel();
      ptt.current!.cancel();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (open ||(e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const from = floats.length ? back.current : -1;
      const n = Math.max(0, Math.min(Math.max(0, messages.length - 1), from + (e.key === "ArrowUp" ? 1 : -1)));
      scrubTo(n);
      scrubMoved();
    },
    wasDrag: () => micDragged.current.wasDrag() || pttWasHold.current,
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
    notePrefWrite(); // synced with the account by the app (docs/prefs-sync.md)
    // His mute wins: it also ends "the mic was used here" (sticky read-aloud, voice.ts).
    if (!v) voice().unvoice?.();
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
  /** The last of his lines still waiting (waiting-mark.ts): only it carries the label. */
  const lastPending = lastPendingIndex(messages);
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
   * (after 280 ms), a double tap opens the menu. It is its own drag handle,
   * so its click still lands on it. The state tree is in the + menu (its
   * "View" group; AttachMenu.tsx). The mic follows them (micEl).
   */
  const controls = (
    <>
      <button
        type="button"
        data-drag-handle
        data-testid="debug-chat-pill-min"
        // The grip (owner, 2026-11-07 20:34 JST: it did not look draggable):
        // six dots, grab / grabbing. A tap folds or opens, a double tap the menu.
        aria-label={withNew(t.dragGrip, !open ? unread : 0)}
        title={t.dragGrip}
        aria-expanded={open}
        {...handle}
        onPointerDown={(e) => {
          unlockSpeech();
          // In full screen a drag up leaves it (useDrag); the panel keeps its place.
          handle.onPointerDown(e);
        }}
        onClick={() => !wasDrag() && gripTaps.current?.tap()}
        style={{
          ...handle.style,
          ...BAR_CONTROL,
          // Grab, grabbing while held (in full screen a drag up leaves it).
          cursor: holding ? "grabbing" : "grab",
        }}
        data-lk-tap
        className="tap-40 relative flex shrink-0 items-center justify-center rounded-full"
      >
        <GripDots />
        <span
          aria-hidden
          className="absolute end-1.5 top-1 size-1.5 rounded-full"
          style={{ background: dot }}
        />
      </button>
      {!open && (
        // The pill's Li: a tap opens the chat again (the mark beside it now
        // tucks). Part of the pill, not a button of its own: it drags as the
        // pill does. Screen readers restore from the menu. It takes the +'s
        // slot, as wide, so the mic after it keeps its place.
        <span
          aria-hidden
          data-testid="debug-chat-restore"
          data-chat-restore
          title={ui.restoreChat}
          {...handle}
          onClick={() => !wasDrag() && foldBy({ type: "restore" })}
          style={{ ...handle.style, ...BAR_CONTROL, cursor: "pointer" }}
          data-lk-tap
          className="tap-40 flex shrink-0 items-center justify-center"
        >
          <LiagentMark size={18} />
        </span>
      )}
    </>
  );
  /**
   * The mic, in the cluster with the mark and the + (owner, 2026-11-07:
   * "我们把麦克风跟另外几个按钮排到一起吧……这样折叠的时候，它位置就不会变"):
   * [mark | + | mic | input] open, [mark | Li | mic] folded, the Li in the +'s
   * slot, so the mic keeps its place on the screen as the chat folds, and in
   * full screen (the bar keeps the panel's span there). It is always this one
   * node, so its live state and gestures survive the switch.
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
            // The speech after a held line came to nothing: hold it again.
            if (!n && !text) {
              joiner.current?.idle();
              passage.current?.idle();
            }
            arm(); // stops a debounce under way, or restarts it once all is in
          }}
          onActive={(on) => {
            micOn.current = on;
            // The mic off: a held line goes now.
            if (!on) joiner.current?.flush();
            setMicActive(on);
            arm();
          }}
          // Only while the hub says this window records (clips.ts); the key is the sink URL only.
          clipSink={friend ? undefined : activeSink(clipsHub)}
          localStt={micRoute}
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
        // A tree already shown stays up through a later failed load: the
        // error shows only while there is nothing to show.
        status={
          treeData.root
            ? undefined
            : treeData.error
              ? `${treeStrings(treeText).failed} (${treeData.error})`
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
   * Expanded, the tree REPLACES the log: the same slot, the same box, one
   * or the other (the + menu's state tree row switches). The log is hidden, not
   * covered; its scroll is kept here and put back when it shows again.
   */
  const logScrollKept = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = log.current;
    if (open && tree) {
      logScrollKept.current ??= lastLogScroll.current;
      return;
    }
    if (!el || !open || logScrollKept.current === null) return;
    el.scrollTop = logScrollKept.current;
    logScrollKept.current = null;
    onLogScroll();
  }, [tree, open]);
  /**
   * The state tree, shown as the log is (log-surface.ts): no box, translucent
   * text with the halo. Minimized it heads the floating box, click-through.
   * Expanded it takes the log's place: the same slot, width, height and
   * surface (at its open height), with its own scroller, taking taps and
   * scrolls, so it is wherever the log would be (no separate layer to place:
   * that kept ending up off screen, under the page or over the header). ✕
   * (or the + menu's row, or Escape) brings the log back, never taking the
   * input's focus. Fades in (opacity; at once under reduced motion).
   */
  const treePanel = (floating: boolean) => (
    <div
      id="debug-chat-tree"
      role="region"
      aria-label={ui.stateTree}
      data-testid="debug-chat-tree"
      data-mode={floating ? "floating" : "log"}
      // ←/→/↑/↓ on a focused row move the tree's focus (tree-nav.ts), as they
      // did on the old tree button.
      onKeyDown={(e) => {
        if (!e.key.startsWith("Arrow")) return;
        e.preventDefault();
        navTo({ type: "key", key: e.key });
      }}
      // Click-through, expanded or not (docs/design-principles.md): only its
      // rows and the ✕ take taps, so a blank strip beside or under the rows
      // never swallows a tap meant for the page (the log does the same). A
      // drag on a row still scrolls the tree.
      className={`pointer-events-none relative flex w-full min-w-0 max-w-full flex-row-reverse items-start transition-opacity duration-[180ms] starting:opacity-0 motion-reduce:transition-none ${floating ? "" : "shrink-0"}`}
    >
      <button
        type="button"
        data-testid="debug-chat-tree-close"
        aria-label={ui.closeTree}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPanel("none")}
        // Beside the tree, never over it (first in the DOM, last on screen).
        className="tap-40 pointer-events-auto shrink-0 px-1.5 fs-10 text-gray-500"
      >
        ✕
      </button>
      <div
        ref={(el) => {
          if (el && el !== treeBodyEl.current) el.scrollTop = treeScroll.current;
          treeBodyEl.current = el;
        }}
        data-testid="debug-chat-tree-body"
        onScroll={onTreeScroll}
        {...withClass(
          // Expanded: the log's surface at its open height (the log's box).
          logSurface({
            expanded: !floating || typingNow || micActive,
            fade: treeFade,
            touch: !floating && engaged,
          }),
          // Expanded: the log's box at its open height (30vh), whatever it holds.
          `min-w-0 flex-1 ${!floating ? "h-[30vh]" : ""}`,
        )}
      >
        {etaBar && (
          <EtaList tasks={etaList} now={etaNow} strings={t} onExpand={() => setGanttOpen(true)} />
        )}
        {treeContent}
      </div>
    </div>
  );
  /** One floating line; `above` is the line before it (its dwell waits for that one's). */
  const floatLine = (f: ChatMessage, above: string | undefined, oneLine = false) => {
    // The latest copy of the line: an edit changes it in place.
    const m = messages.find((x) => x.id === f.id) ?? f;
    const p = polish(m);
    return (
            <FloatLine
              details={details.forMessage}
              oneLine={oneLine}
              key={m.id}
              m={m}
              arrivedAt={newLines.current!.arrivedAt(m.id)}
              // The same identity as in the log: the avatar, never the name in its place.
              who={lineAvatar(m, {
                friend,
                viewer,
                agentAvatar,
                avatarFor,
                agentName: t.name,
                you: t.you,
                otherName: t.vpOtherShort,
                ...laneOpts,
              })}
              text={lineText(m, p.text)}
              mark={
                m.speaker?.decision === "me" ? (
                  <>
                    {p.mark}
                    <VoiceMark label={t.vpVerified} />
                  </>
                ) : m.speaker?.decision === "other" ? (
                  <>
                    {p.mark}
                    <span
                      data-testid="debug-chat-speaker-other"
                      className="ms-1 inline-flex items-center gap-0.5 rounded px-1 fs-10 font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                      title={
                        typeof m.speaker.score === "number"
                          ? `${t.vpOther} (${m.speaker.score})`
                          : t.vpOther
                      }
                    >
                      <span>👥</span>
                      <span>{t.vpOtherShort}</span>
                    </span>
                  </>
                ) : (
                  p.mark
                )
              }
              epoch={floatEpoch}
              aboveLeft={() => (above ? (floatLives.current.get(above)?.remaining() ?? 0) : 0)}
              onLife={(l) => (l ? floatLives.current.set(m.id, l) : floatLives.current.delete(m.id))}
              paused={floatHover || scrubbing}
              onHover={setFloatHover}
              onGone={() => dropFloat(m.id)}
            />
    );
  };
  const floatsEl = floats.length > 0 && (
    // Minimized: the lines that arrived (or a scrub brought back), newest
    // at the bottom, each fading on its own. Hover or touch holds them.
    <ol
      data-testid="debug-chat-floats"
      // The mic scrub moving: the lines pulse (shimmer.ts).
      {...(scrubMoving ? { [SCRUB_ATTR]: true } : {})}
      aria-live="polite"
      className={`flex flex-col gap-0.5 ${ALIGN_ITEMS[place.side]}`}
    >
      {floats.map((f, i) => floatLine(f, floats[i - 1]?.id))}
    </ol>
  );
  /**
   * Minimized: the floating lines, the frontier and the tree hang over the
   * pill in one box, from the pill's side (fold.ts floatSide, anchor.ts),
   * clamped inside the viewport. Tucked, only the newest line peeks (tuckEl).
   */
  const floatBoxEl = fold === "pill" && (floats.length > 0 || !!shownFrontier || tree) && (
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
  /** The voiceprint panel's page side: the Mac over the local STT socket, and the mic session. */
  const voiceprintDeps = () =>
    panelDeps({
      url: sttRoute.urls ?? "",
      device: voiceDevice(),
      capture: (on, onFinal, id) => pageMic().enrolCapture(on, onFinal, id),
      // The voiceprint test: scored finals to the panel only (no draft, cloud or clip sink).
      testCapture: (on, onFinal) => pageMic().enrolCapture(on, onFinal, "", true),
      log: (ev) => voice().log(ev),
    });
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
            ? ux.speakMicTitle
            : speak && vs.touch
              ? ux.speakTouchTitle
              : speak && vs.voiced
                ? ux.speakVoicedTitle
                : ux.speakTypingTitle
        }
        onClick={() => !vs.mic && toggleSpeak()}
        className={`flex items-center gap-2 px-3 py-1.5 text-start ${vs.mic ? "opacity-70" : ""}`}
      >
        <Icon name="speakerHigh" weight={speak || vs.mic ? "fill" : "regular"} />
        {vs.mic
          ? ux.speakMicOn
          : speak && vs.touch
            ? strings?.readAloud
              ? t.readAloud
              : ui.readAloud
            : speak && vs.voiced
              ? ux.speakMicUsed
              : speak
                ? strings?.readAloudTyping
                  ? t.readAloudTyping
                  : ui.readAloudTyping
                : ux.speakSilent}
      </button>
      {/* The voice cues (cues.ts): each its own switch, synced with the account. */}
      <button
        type="button"
        role="menuitemcheckbox"
        data-testid="debug-menu-cue-send"
        aria-checked={cueSend}
        onClick={() => {
          setCueSend(!cueSend);
          setCue(CUE_SEND_KEY, !cueSend);
          notePrefWrite();
        }}
        className="flex items-center gap-2 px-3 py-1.5 text-start"
      >
        <span aria-hidden className="w-[1em] text-center">
          {cueSend ? "◉" : "○"}
        </span>
        {strings?.cueSend ? t.cueSend : ui.cueSend}
      </button>
      <button
        type="button"
        role="menuitemcheckbox"
        data-testid="debug-menu-cue-speech"
        aria-checked={cueSpeech}
        onClick={() => {
          setCueSpeech(!cueSpeech);
          setCue(CUE_SPEECH_KEY, !cueSpeech);
          notePrefWrite();
        }}
        className="flex items-center gap-2 px-3 py-1.5 text-start"
      >
        <span aria-hidden className="w-[1em] text-center">
          {cueSpeech ? "◉" : "○"}
        </span>
        {strings?.cueSpeech ? t.cueSpeech : ui.cueSpeech}
      </button>
      {/* Compact mode (compact-view.ts): this device only (lk:pref:chat-view). */}
      <button
        type="button"
        role="menuitemcheckbox"
        data-testid="debug-menu-compact"
        aria-checked={compactPref}
        onClick={() => chatPrefs().setState({ compact: !compactPref })}
        className="flex items-center gap-2 px-3 py-1.5 text-start"
      >
        <span aria-hidden className="w-[1em] text-center">
          {compactPref ? "◉" : "○"}
        </span>
        {strings?.compactIdle ? t.compactIdle : ui.compactIdle}
      </button>
      {/* Full screen without a drag (the keyboard's and a screen reader's way
          in; a drop on the bottom edge is the other, full-screen.ts). */}
      {fullAllowed && !tucked && (
        <button
          type="button"
          role="menuitemcheckbox"
          data-testid="debug-menu-fullscreen"
          aria-checked={full}
          onClick={() => {
            setMenu(false);
            setFull(!full, true);
          }}
          className="flex items-center gap-2 px-3 py-1.5 text-start"
        >
          <span aria-hidden className="w-[1em] text-center">
            {full ? "◉" : "○"}
          </span>
          {t.fullScreen}
        </button>
      )}
      {/* Reading speed, per device: from the next sentence on. */}
      <div
        role="radiogroup"
        aria-label={ux.readingSpeed}
        data-testid="debug-menu-rate"
        className="flex items-center gap-1 px-3 py-1"
      >
        <span className="me-1 text-gray-500">{ux.speed}</span>
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
      {/* Dev (DevMenuGroup.tsx): internal diagnostics, on the owner's pages only, collapsed. */}
      <DevMenuGroup owner={owner} label={t.devGroup}>
      {/* Echo cancellation, an A/B (aec.ts lk:voice-aec): an open mic reopens with it at once. */}
      <button
        type="button"
        role="menuitemcheckbox"
        data-testid="debug-menu-aec"
        aria-checked={aec}
        title={ui.aecHint}
        onClick={() => {
          setAecState(!aec);
          void applyAec(!aec);
        }}
        className="flex items-center gap-2 px-3 py-1.5 text-start"
      >
        <span aria-hidden className="w-[1em] text-center">
          {aec ? "◉" : "○"}
        </span>
        {ui.aec}
      </button>
      {/* The last voice line's path to its reply (latency.ts), when there is one or the mic is on. */}
      {(lastLatency || vs.mic) && (
        <div data-testid="debug-menu-latency" className="px-3 py-1 text-gray-500">
          {lastLatency ? (
            (() => {
              const lines = latencyLines(lastLatency, ui, viaAt(lastLatency.timing.t_sttDone));
              const line = (title: string, g?: { total: string; parts: [string, string][] }) =>
                g && (
                  <div className="tabular-nums">
                    {title}: <span className="font-semibold">{g.total} s</span>
                    {g.parts.length > 0 && ` (${g.parts.map(([k, v]) => `${k} ${v}`).join(" · ")})`}
                  </div>
                );
              return (
                <>
                  <div>{ui.latency}</div>
                  {line(ui.latSpeechLine, lines.speech)}
                  {line(ui.latReplyLine, lines.reply)}
                  {lines.total && (
                    <div className="tabular-nums">
                      {ui.latTotal}: <span className="font-semibold">{lines.total} s</span>
                    </div>
                  )}
                </>
              );
            })()
          ) : (
            ui.latencyNone
          )}
        </div>
      )}
      {/* The mic's adaptation (adaptive.ts): read-only, no toggle. */}
      {vs.mic && (
        <div data-testid="debug-menu-adapt" className="px-3 py-1 text-gray-500">
          <div>
            {ui.micAdapt}
            <span className="ms-1">({adapt.mode})</span>
            {adapt.whisper && <span className="ms-1 font-semibold">· {ui.micAdaptWhisper}</span>}
          </div>
          <div className="tabular-nums">
            {[
              `${ui.micAdaptFloor} ${adapt.floorDb} dB`,
              `${ui.micAdaptVoice} ${adapt.levelDb} dB`,
              `${ui.micAdaptGain} +${adapt.gainDb} dB`,
            ].join(" · ")}
          </div>
          <div className="tabular-nums">
            {`VAD ${adapt.positiveSpeechThreshold}/${adapt.negativeSpeechThreshold} · ${adapt.minSpeechMs} ms · end ${adapt.endpointMs} ms`}
          </div>
        </div>
      )}
      </DevMenuGroup>
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
          {ux.stopReading}
          {vs.queued > 1 ? ` (${ux.sentencesLeft.replace("{n}", String(vs.queued))})` : ""}
        </button>
      )}
      {treeSource && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={tree}
          data-testid="debug-menu-tree"
          // The tree panel, as the + menu's row (one panel at a time: the menu closes).
          onClick={() => setPanel("tree")}
          className="flex items-center gap-2 px-3 py-1.5 text-start"
        >
          <span aria-hidden className="w-[1em] text-center">
            ☰
          </span>
          {treeStrings(treeText).tree}
        </button>
      )}
      {/* The voiceprint (voiceprint.ts): owner pages with a local STT; enrolling and deleting are taps in its panel. */}
      {sttRoute.urls && (
        <button
          type="button"
          role="menuitem"
          data-testid="debug-menu-voiceprint"
          onClick={() => setPanel("voiceprint")}
          className="flex items-center gap-2 px-3 py-1.5 text-start"
        >
          <span aria-hidden className="w-[1em] text-center">
            ◎
          </span>
          {t.vpMenu}
        </button>
      )}
      {/* Voice clips (clips.ts): a tap turns this window's recording on; the badge stops it. */}
      {!friend && !embedded && !clipsHub?.on && clipsCanStart && (
        <>
          <button
            type="button"
            role="menuitem"
            data-testid="debug-menu-clips"
            onClick={() => {
              clipsAction({
                type: "clips-on",
                ...(clipsAuto ? { minutes: CLIPS_AUTOSTOP_MIN } : {}),
              });
              setMenu(false);
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-start"
          >
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full"
              style={{ background: "oklch(0.62 0.22 27)" }}
            />
            {t.clipsStart}
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={clipsAuto}
            data-testid="debug-menu-clips-autostop"
            onClick={() => clipsDevice().setState({ autoStop: !clipsAuto })}
            className="flex items-center gap-2 px-3 py-1.5 text-start"
          >
            <span aria-hidden className="w-[1em] text-center">
              {clipsAuto ? "◉" : "○"}
            </span>
            {t.clipsAutoStop.replaceAll("{n}", String(CLIPS_AUTOSTOP_MIN))}
          </button>
        </>
      )}
      <button
        type="button"
        role="menuitem"
        data-testid="debug-menu-minimize"
        onClick={() => {
          setMenu(false);
          foldBy({ type: open ? "minimize" : "restore" });
        }}
        className="flex items-center gap-2 px-3 py-1.5 text-start"
      >
        <span className="w-[1em] text-center">{open ? "–" : "+"}</span>
        {open ? ux.minimize : ui.restoreChat}
      </button>
      {/* Every open page of this chat; ending this one asks twice. */}
      {pages.map((pg) => {
        const self = pg.id === selfPage;
        const key = `page:${pg.id}`;
        const parts = pageParts(pg.label);
        const path = parts.path;
        // A developer sees the full path and the device; anyone else the page's
        // first segment only (owner, 2026-11-11 01:31 JST).
        const device = owner ? parts.device : "";
        const shown = owner ? path : shortPage(path);
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
              title={owner ? pg.label : undefined}
              onClick={() => {
                setMenu(false);
                if (!self) onOpenPage?.(path);
              }}
              className="flex min-w-0 flex-1 items-baseline gap-1.5 text-start"
            >
              <span className="truncate text-gray-700 dark:text-gray-200">{shown}</span>
              <span className="shrink-0 fs-10">
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
                className="fs-10 underline opacity-70"
                style={endArmed === key ? { color: "oklch(0.58 0.19 25)" } : undefined}
              >
                {endArmed === key ? "tap again" : "disconnect"}
              </button>
            )}
          </div>
        );
      })}
      {/* Pairings (eval sessions): a developer's menu only. */}
      {sessions
        .filter((x) => owner && x.scope !== "chat")
        .map((x) => (
          <div
            key={x.pair}
            data-testid="debug-menu-session"
            data-pair={x.pair}
            className="flex items-center gap-2 px-3 py-1 text-gray-500"
          >
            <span className="min-w-0 flex-1 truncate">
              {friend ? "preview" : "eval"}: {x.label} · {x.persistent ? evalTrustStrings().remember : x.code}
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
        .filter((x) => owner && x.scope === "chat" && addable(x))
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

  /**
   * Read-aloud progress (read-progress.ts): each agent sentence spoken
   * (grey), speaking (highlighted) or not yet (normal). Followed through the
   * shared voice session's queue count and sentence starts, matched to the
   * live agent lines, kept in the session store across a refresh. Lines from
   * history that were never read live stay normal.
   */
  const [readP, readDispatch] = useReducer(readStep, undefined, () =>
    initialRead(uiStore.getState().spoken),
  );
  useEffect(() => {
    const v = voice() as ReturnType<typeof voice> & {
      onStart?: (f: (curr?: { id?: string; idx?: number }) => void) => () => void;
    };
    const s0 = v.state();
    readDispatch({ type: "queued", n: s0.queued, current: s0.current });
    const off1 = v.subscribe((s) =>
      readDispatch({ type: "queued", n: s.queued, current: s.current }),
    );
    const off2 = v.onStart?.((curr) => readDispatch({ type: "start", current: curr }));
    return () => {
      off1();
      off2?.();
    };
  }, []);
  /** Agent lines there before this widget came up: history, never claimed. */
  const historyIds = useRef<Set<string> | null>(null);
  const currentVoiceId = voice().state().current?.id;
  historyIds.current ??= new Set(
    messages.filter((m) => m.id !== currentVoiceId).map((m) => m.id),
  );
  const claimed = useRef(new Set<string>());
  useEffect(() => {
    let left = readP.unmatched;
    if (!left) return;
    for (const m of messages) {
      if (m.from !== "agent" || historyIds.current!.has(m.id) || claimed.current.has(m.id)) continue;
      const n = sentenceCount(spokenOf(m, { embedded }));
      if (!n) continue;
      claimed.current.add(m.id);
      readDispatch({ type: "enqueue", id: m.id, n });
      left -= Math.min(left, n);
      if (!left) break;
    }
  }, [messages, readP.unmatched]);
  useEffect(() => uiStore.setState({ spoken: { ...readP.done } }), [readP.done]);
  /**
   * Resuming after a reload or a page switch (read-progress.ts): what was
   * left to read is kept per message (its first unread sentence, the one
   * cut off restarting); on the next page, once those lines are in the
   * history again, the reading goes on from there. Only replies queued in
   * the last 10 minutes. The browser may need a tap before it speaks
   * (autoplay): then a chip, "Tap to continue reading", does it.
   */
  const queuedAt = useRef(new Map<string, number>());
  /** The mirror queue has had something on this page (from then on, its state is what is kept). */
  const queueSeen = useRef(false);
  useEffect(() => {
    for (const e of readP.queue) if (!queuedAt.current.has(e.id)) queuedAt.current.set(e.id, Date.now());
    // The page going away stops the voice (the queue empties): keep what was
    // left from before, so the next page can read on.
    // (A computer reads on in the background: its queue is kept as it goes.)
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible" &&
      hideStops(isDesktop())
    )
      return;
    // Nothing read on this page yet: what an earlier page kept stays (for the
    // chip, or for a copy of this widget mounted next, e.g. after a hot swap).
    if (!readP.queue.length && !queueSeen.current) return;
    queueSeen.current = true;
    uiStore.setState({ reading: readingLeft(readP, queuedAt.current) });
  }, [readP.queue]);
  const [resumeLeft, setResumeLeft] = useState<ReadingLeft[]>(() =>
    toResume(uiStore.getState().reading, Date.now()),
  );
  const resumeItems = resumeLeft
    .map((r) => ({ r, m: messages.find((x) => x.id === r.id && x.from === "agent") }))
    // A withdrawn ask card is never read on (speak-rules.ts).
    .filter((x): x is { r: ReadingLeft; m: ChatMessage } => !!x.m && !isWithdrawn(x.m));
  // An ask withdrawn while it is being read (or waits in the queue): its
  // sentences are dropped, the other lines read on (an older session without
  // `drop` stops the reading instead).
  useEffect(() => {
    for (const m of messages) {
      if (!isWithdrawn(m) || !readP.queue.some((e) => e.id === m.id)) continue;
      const v = voice() as ReturnType<typeof voice> & { drop?: (id: string) => boolean };
      if (!v.drop) return v.stop();
      readDispatch({ type: "drop", id: m.id });
      // Not in the session's queue after all (untagged): stop rather than read it.
      if (!v.drop(m.id)) return v.stop();
    }
  }, [messages, readP.queue]);
  /** Hand the unread rest of those replies back to the voice, as one queued reply each. */
  const resumeNow = () => {
    const v = voice();
    const el = input.current;
    // The page's own voice session reads a reply only with the mic on or the
    // input focused (its focus rule): focus it for that one call, read-only
    // so no keyboard opens, and without its blur stopping the reading.
    const focusHack = !v.state().mic && !!el;
    if (focusHack && el) {
      keepReading.current = true;
      el.readOnly = true;
      el.focus({ preventScroll: true });
    }
    for (const { r, m } of resumeItems) {
      const said = spokenOf(m, { embedded });
      const ranges = sentenceRanges(said);
      const start = ranges[r.from]?.start;
      if (start === undefined) continue;
      claimed.current.add(m.id);
      // The line as meta: its sentences carry its id (a withdrawn ask is dropped by it).
      if (v.reply(said.slice(start), m))
        readDispatch({ type: "enqueue", id: m.id, n: ranges.length - r.from, from: r.from });
    }
    if (focusHack && el) {
      el.blur();
      el.readOnly = false;
      keepReading.current = false;
    }
    setResumeLeft([]);
  };
  /** The input's blur would stop the reading (mic off): not for resumeNow's own focus. */
  const keepReading = useRef(false);
  // Once the lines are back: on at once if the page may already speak, else the chip.
  const resumeTried = useRef(false);
  useEffect(() => {
    if (resumeTried.current || !resumeItems.length) return;
    resumeTried.current = true;
    const activated =
      (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation
        ?.hasBeenActive === true;
    if (voice().state().mic || activated) resumeNow();
  }, [resumeItems.length]);
  /**
   * A line's text in full: markdown by its tier (rich-text.ts), and an agent
   * line in its sentences, each coloured by how far the reading got.
   */
  const readText = (m: ChatMessage, text: ReactNode) => {
    if (typeof text !== "string") return text;
    const rich = richOf(text, lineTier(m, { embedded }));
    if (m.from !== "agent") return <RichBody rich={rich} onOpenPage={onOpenPage} />;
    return (
      <RichBody
        rich={rich}
        onOpenPage={onOpenPage}
        read={{
          ranges: sentenceRanges(rich.spoken),
          wrap: (idx, key, children) => {
            const st = sentenceState(readP, m.id, idx);
            return (
              <span
                key={key}
                data-read={st}
                style={
                  st === "spoken" ? SPOKEN_STYLE : st === "speaking" ? SPEAKING_STYLE : undefined
                }
              >
                {children}
              </span>
            );
          },
        }}
      />
    );
  };
  /**
   * A line in the one-line views: its words with their links, no blocks. A
   * function declaration, hoisted: the folded pill's floating lines (floatLine,
   * above) render with it before this point, and as a `const` that threw
   * "Cannot access 'lineText' before initialization" and took the chat down
   * as soon as a line floated (debug-chat-fold-qa, debug-chat-bar-qa).
   */
  function lineText(m: ChatMessage, text: ReactNode) {
    return typeof text === "string" ? (
      <RichLine rich={richOf(text, lineTier(m, { embedded }))} onOpenPage={onOpenPage} />
    ) : (
      text
    );
  }
  /** Who said each line, and where a run of one sender's lines starts (avatar-rules.ts). */
  const whos = messages.map((m) =>
    lineAvatar(m, {
      friend,
      viewer,
      agentAvatar,
      avatarFor,
      agentName: t.name,
      you: t.you,
      otherName: t.vpOtherShort,
      ...laneOpts,
    }),
  );
  const starts = runStarts(
    messages.map((m, i) => ({
      seed: `${whos[i]!.seed}|${whos[i]!.mine ? "me" : ""}`,
      node: lineNode(m)?.node,
      at: m.at,
    })),
  );
  /**
   * Compact mode's view (compact-view.ts): the open ask cards in full (they
   * need a tap), then the last message as one short line with its avatar,
   * as the minimized chat's floating lines show it. A tap on the line brings
   * the whole chat back.
   */
  const compactRow = (m: ChatMessage, line: boolean) => {
    const who = lineAvatar(m, {
      friend,
      viewer,
      agentAvatar,
      avatarFor,
      agentName: t.name,
      you: t.you,
      otherName: t.vpOtherShort,
      ...laneOpts,
    });
    const p = polish(m);
    const asLine = line && !m.ask;
    return (
      <div
        key={m.id}
        data-testid={asLine ? "debug-chat-compact-line" : "debug-chat-compact-ask"}
        data-msg={m.id}
        data-from={m.from}
        {...details.forMessage(m, who.name)}
        // A 40px tap target over the page; the text keeps the box's halo.
        className={`pointer-events-auto flex min-h-10 items-start gap-1.5 py-1 leading-snug ${asLine ? "cursor-pointer" : ""}`}
      >
        <Avatar
          src={who.src}
          name={who.name}
          initialFrom={who.initialFrom}
          seed={who.seed}
          size={AVATAR_PX}
          hidden
        />
        <div
          className={`m-0 min-w-0 flex-1 break-words pt-px ${LINE_SELECTABLE} ${asLine ? "line-clamp-2" : "whitespace-pre-wrap"}`}
          {...shimmerOf(m)}
        >
          <span className="sr-only">{who.name}: </span>
          {m.lane && <LaneTag lane={m.lane} inline />}
          {m.ask
            ? m.ask.questions.length === 1
              ? lineText(m, m.ask.questions[0]!.question)
              : ""
            : asLine
              ? lineText(m, p.text)
              : readText(m, p.text)}
          {m.ask && (
            <AskCard
              ask={m.ask}
              answer={m.answer}
              onAnswer={onAnswer}
              sendText={(text) => sendRef.current(text)}
            />
          )}
          {p.mark}
        </div>
      </div>
    );
  };
  const compactEl = (() => {
    const { asks, last } = compactLines(messages, Date.now());
    return (
      <div
        data-testid="debug-chat-compact"
        // Click-through but for its rows, as the log is.
        className="pointer-events-none flex flex-col px-0 pt-1"
      >
        {asks.map((m) => compactRow(m, false))}
        {last ? compactRow(last, true) : <p className="m-0 py-1 text-gray-500">{t.hint}</p>}
      </div>
    );
  })();
  /**
   * Tucked (fold.ts): one big handle on the edge, and the newest line that
   * arrived since peeking beside it for its dwell, a dot while any is
   * unread. Its touch area starts TOUCH_INSET in from the edge, clear of
   * Android's Back swipe: a tap, or a press-and-drag starting on it, brings
   * the pill back (the drag carrying it along). Out of the box's transform.
   */
  const tuckEl = tucked && handleAt !== null && (() => {
    const size = HANDLE_SIZE[HANDLE_SHAPE];
    const touch = handleTouch(HANDLE_SHAPE);
    const fromEdge = (px: number) => `calc(env(safe-area-inset-${edge}) + ${px}px)`;
    const r = size.r;
    const radius =
      HANDLE_SHAPE === "square" ? r : edge === "right" ? `${r} 0 0 ${r}` : `0 ${r} ${r} 0`;
    const peek = floats.at(-1);
    return (
      <>
        <button
          type="button"
          data-testid="debug-chat-handle"
          data-chat-restore
          data-shape={HANDLE_SHAPE}
          data-edge={edge}
          aria-label={withNew(ui.untuckChat, unread)}
          title={ui.untuckChat}
          onPointerDown={pressHandle}
          onClick={() => {
            if (handleDragged.current) return void (handleDragged.current = false);
            foldBy({ type: "handle" });
          }}
          style={{
            top: handleAt,
            [edge]: fromEdge(touch.inset),
            width: touch.width,
            height: size.h,
            touchAction: "none",
          }}
          className="pointer-events-auto fixed z-[var(--lk-z-chat,80)] cursor-pointer text-gray-600 dark:text-gray-300"
        >
          {/* The shape, out to the edge; only the touch area above takes the press. */}
          <span
            aria-hidden
            data-testid="debug-chat-handle-shape"
            style={{
              [edge]: size.gap - touch.inset,
              width: size.w,
              height: size.h,
              borderRadius: radius,
              background: INPUT_BG,
              ...(HANDLE_SHAPE === "half" ? { [edge === "right" ? "borderRight" : "borderLeft"]: "none" } : {}),
            }}
            className="pointer-events-none absolute top-0 flex items-center justify-center border border-current/25 backdrop-blur-md backdrop-saturate-150"
          >
            <LiagentMark size={26} />
            {unread > 0 && (
              <span
                data-testid="debug-chat-handle-dot"
                className="absolute top-2.5 size-3.5 rounded-full"
                style={{ background: "oklch(0.6 0.2 22)", [edge === "right" ? "left" : "right"]: 6 }}
              />
            )}
          </span>
        </button>
        {peek && (
          // Text on the page with its halo, as the floating lines are: no box.
          <ol
            data-testid="debug-chat-peek"
            aria-live="polite"
            onClick={() => foldBy({ type: "handle" })}
            style={{
              top: handleAt + size.h / 2,
              [edge]: fromEdge(size.gap + size.w + 8),
              textAlign: edge,
            }}
            className="pointer-events-none fixed z-[var(--lk-z-chat,80)] flex w-max max-w-[min(20rem,calc(100vw-6rem))] -translate-y-1/2 cursor-pointer flex-col lk-halo lk-fs-chat text-xs text-gray-800 dark:text-gray-100"
          >
            {floatLine(peek, undefined, true)}
          </ol>
        )}
      </>
    );
  })();
  /** The + menu or its file picker is up: in use, as the focused input is. */
  const plusMenu = attachMenu || picking;
  const typingGlassShown = showTypingGlass({
    typing: typingNow,
    plusMenu,
    open,
    // Full screen: the glass is the whole chat area, which is the screen.
    fullLog: fullLog !== "off" || full,
  });
  /** The progress bar (EtaBar) shows over the input. */
  const etaShown = open && !tree && etaBar && etaList.length > 0;
  /** The connection chip: a developer's page, the chat open, not over the tree. */
  const linkShown = open && !tree && !notice && owner && !!link;
  const selState = selectionState({
    attached: !!attached,
    lines: messages,
    beatAt: link?.beatAt,
    listeners: listeners ?? 0,
  });
  /**
   * The bar and the progress bar as one glass strip (owner, 2026-11-10); not
   * while the typing glass is the frame, nor full screen (the screen is the glass).
   */
  const strip = etaShown && !full && !typingGlassShown;
  const typingGlassLookNow = (() => {
    const has = (prop: string, v: string) => typeof CSS !== "undefined" && CSS.supports(prop, v);
    const look = typingGlassLook({
      blur:
        has("backdrop-filter", "blur(1px)") || has("-webkit-backdrop-filter", "blur(1px)"),
      reduce:
        typeof matchMedia !== "undefined" &&
        matchMedia("(prefers-reduced-transparency: reduce)").matches,
      lightDark: has("color", "light-dark(#000, #fff)"),
    });
    if (fullLog === "off" && !full) return look;
    // The full-screen log (and full screen): the same glass, with the sheet's stronger tint and
    // blur (log-surface.ts SHEET_SCRIM, contrast-checked for a tall list).
    const sheet = sheetLook();
    // Full screen: the chat is all there is to read, so the scrim is near-opaque
    // (legible even where the blur is not drawn), still frosted over the page.
    if (full && !sheet.solid)
      return {
        ...look,
        background: has("color", "light-dark(#000, #fff)")
          ? sheetScrim(true)
          : "color-mix(in oklch, var(--background) 92%, transparent)",
        filter: SHEET_FILTER,
      };
    return { ...look, background: sheet.background, filter: sheet.solid ? "none" : SHEET_FILTER };
  })();
  return (
    <>
    {details.popup}
    <section
      ref={root}
      data-debug-chat
      // Minimized keeps its old test id: the bar alone, plus floating lines.
      data-testid={open ? "debug-chat" : "debug-chat-minimized"}
      data-minimized={!open || undefined}
      data-fold={fold}
      data-edge={edge}
      // Tucked: slid past its edge, out of reach (the handle stands in for it).
      inert={tucked}
      aria-hidden={tucked || undefined}
      aria-label={t.chatWith}
      // Full screen (full-screen.ts): the open chat fills the app.
      data-fullscreen={full || undefined}
      onPointerDown={unlockSpeech}
      onKeyDown={unlockSpeech}
      // Files dropped anywhere on the chat are attached (files.ts).
      onDragOver={(e) => {
        if (!filesRef.current || !open || notice || !dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        setDragging(false);
        if (!filesRef.current || !open || notice) return;
        const got = filesFrom(e.dataTransfer);
        if (!got.length) return;
        e.preventDefault();
        pending.add(got);
      }}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === "transform") endSlide();
      }}
      // A live mic counts as focus: the box goes opaque as it does while typing.
      style={{
        transform: tucked
          ? `${offset.transform} translateX(${mirrorRow ? "-" : ""}100vw)`
          : offset.transform,
        // Only the slide into or out of the edge animates: a drag follows the finger.
        transition: sliding && !holding ? "opacity 150ms, transform 220ms ease-out" : undefined,
        // Full screen: the visible area, edge to edge (the panel's place is kept).
        ...(full ? (sidebar ? FULL_SIDEBAR_STYLE : FULL_SCREEN_STYLE) : {}),
      }}
      className={`fixed right-[calc(0.5rem+env(safe-area-inset-right))] bottom-[calc(0.5rem+env(safe-area-inset-bottom)+var(--lk-bottom-reserve,0px))] z-[var(--lk-z-chat,80)] flex w-[min(20rem,calc(100vw-1rem))] flex-col rounded-xl transition-opacity ${panelOpaque({ typing: typingNow, plusMenu, micActive, fullLog: fullLog !== "off" || full }) ? "opacity-100" : "opacity-60 focus-within:opacity-100 active:opacity-100"} ${full ? "pointer-events-auto" : "pointer-events-none"} lk-halo lk-fs-chat text-xs text-gray-800 dark:text-gray-100`}
    >
      {/* The recording badge, top of the screen, out of the box's transform. */}
      {!friend &&
        !embedded &&
        typeof document !== "undefined" &&
        createPortal(<ClipsBadge strings={t} />, portalRoot ?? document.body)}
      {/* The full-screen Gantt, out of the box's transform. */}
      {etaBar &&
        ganttOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <GanttFull
            tasks={etaList}
            now={etaNow}
            strings={t}
            onClose={() => setGanttOpen(false)}
          />,
          portalRoot ?? document.body,
        )}
      {/* The typing glass (typing-glass.ts): while the input has the focus,
          the box's own area frosts; the page around it stays sharp. Behind
          the box's content (-z-10 in its stacking context), a little past its
          edge so the text has room. Always mounted, so it fades both ways;
          hidden, it is not painted. It never takes a pointer. */}
      <div
        aria-hidden
        data-testid="debug-chat-typing-glass"
        data-shown={typingGlassShown || undefined}
        data-full={fullLog === "off" ? undefined : fullLog}
        style={{
          background: typingGlassLookNow.background,
          backdropFilter: typingGlassLookNow.filter,
          WebkitBackdropFilter: typingGlassLookNow.filter,
          boxShadow: typingGlassLookNow.edge,
          // The full-screen log in its own box (out of the flow): the glass
          // follows it, the log's box and its few px of edge, never the screen.
          ...(fullLog !== "off" && fullRef.current.box ? glassAroundLog(fullRef.current.box) : {}),
          // Full screen: the chat area is the screen, so the glass is too.
          ...(full ? { inset: 0, borderRadius: 0, boxShadow: "none" } : {}),
          ...typingGlassMotion(typingGlassShown, reducedMotion()),
        }}
        className="pointer-events-none absolute -inset-1.5 -z-10 rounded-[1.5rem]"
      />
      {/* The way out of full screen (owner, 2026-11-09 18:25 JST: no button to
          enter it, a drag to the bottom edge does; "an exit button is still
          needed"): ✕ alone (2026-11-11: "字不用打出来"), its words as the
          label and tooltip, at the top corner under the notch, in the flow so
          the log starts under it. Escape, Back, the menu and a drag up
          leave too. Entering without a drag: the menu's Full screen row. */}
      {open && full && (
        <div className="pointer-events-none flex shrink-0 justify-end">
          <button
            type="button"
            data-testid="debug-chat-fullscreen-exit"
            title={t.fullScreenExit}
            aria-label={t.fullScreenExit}
            // Keeps the input's focus, so the keyboard and the draft's caret stay
            // (WebKit moves the focus on the tap's mousedown, not its pointerdown).
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFull(false)}
            style={{ background: INPUT_BG, minHeight: 40, minWidth: 40 }}
            className="tap-40 pointer-events-auto inline-flex items-center justify-center rounded-full border border-current/25 text-gray-700 backdrop-blur-md dark:text-gray-200"
          >
            <span aria-hidden className="text-base leading-none">
              ✕
            </span>
          </button>
        </div>
      )}
      {/* Expanded, one or the other in the log's slot: the state tree, or the log. */}
      {open && tree && treePanel(false)}
      {/* The log: the messages, the newest at the bottom. Hidden minimized, and while the tree has its place. */}
      <div
        ref={log}
        id="debug-chat-column"
        data-testid="debug-chat-column"
        onScroll={onLogScroll}
        onWheel={() => {
          userScrollAt.current = Date.now();
          hold(COMPACT_SCROLL_MS);
        }}
        onTouchMove={() => {
          userScrollAt.current = Date.now();
          hold(COMPACT_SCROLL_MS);
        }}
        // A tap on a line (its polish mark, an ask card) is use too.
        onPointerDown={() => hold(COMPACT_SCROLL_MS)}
        data-fade={fade || undefined}
        data-expanded={typing || undefined}
        hidden={!open || tree || compact}
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          // The full-screen log's wipe out ended: back to its resting height.
          if (e.propertyName === "clip-path") {
            if (fullLog === "leaving") setFullLog("off");
            return;
          }
          // Shrunk: land on the newest lines again, now that the height settled.
          // Not when held open: it grew (a jump to an ask), and he is reading there.
          if (!typingNow && !micActive) log.current?.scrollTo({ top: log.current.scrollHeight });
          onLogScroll();
        }}
        data-full={fullLog === "off" ? undefined : fullLog}
        {...fullSurface(
          logSurface({
            expanded: typingNow || micActive || (compactPref && expanded),
            fade,
            touch: engaged || full,
          }),
          full,
        )}
      >
      <ol
        data-testid="debug-chat-log"
        className="m-0 list-none space-y-0.5 p-0"
      >
        {messages.length === 0 && (
          <li className="text-gray-500">{t.hint}</li>
        )}
        {/*
          A game-style log, avatar then text, no bubbles. A run of one
          sender's messages (same sender and node, no long pause: runStarts)
          is ONE paragraph: the avatar once, the messages flowing inline one
          after another, a faint dot between them. Merged at render time
          only: every message stays its own span, with its own id, title
          (time), polish mark, waiting tag, so the hub's history, the polish
          edit (one line id), read-aloud and the anchoring are unchanged.
        */}
        {runsOf(starts).map((run, r, runs) => {
          const i0 = run[0]!;
          const m0 = messages[i0]!;
          const who = whos[i0]!;
          // The state-tree node the run belongs to: a muted subtitle and a left border by its hue.
          const node = lineNode(m0);
          // The up-arrow floats at the log's end: the newest run keeps room
          // beside it (ask-above.ts jumpRoom), never an empty row under it.
          const room = askJumpShown && r === runs.length - 1 ? jumpRoom(asksUp.length) : null;
          return (
            <li
              key={m0.id}
              data-testid="debug-chat-run"
              data-from={m0.from}
              data-node={node?.node}
              data-jump-room={room ? room.end : undefined}
              className="flex items-start gap-1.5 leading-snug"
              style={{
                ...(node ? { borderInlineStart: `2px solid ${node.border}`, paddingInlineStart: 4 } : {}),
                // A short run sits at the bottom of its room: nothing blank under it.
                // The ROW goes down (align-content on a one-line wrapping flex), not
                // each item: align-items would drop the avatar to a long run's last
                // line, away from its first (owner, 2026-11-09 13:42 JST).
                ...(room
                  ? {
                      paddingInlineEnd: room.end,
                      minHeight: room.minHeight,
                      flexWrap: "wrap",
                      alignContent: "flex-end",
                    }
                  : {}),
              }}
            >
              <Avatar
                src={who.src}
                name={who.name}
                initialFrom={who.initialFrom}
                seed={who.seed}
                size={AVATAR_PX}
                hidden
              />
              <div className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words pt-px">
                {/* A lane's name tag (voices.ts), once per run; lines with no lane have none. */}
                {m0.lane && <LaneTag lane={m0.lane} agentName={t.name} />}
                {node && (
                  <span
                    aria-hidden
                    data-testid="debug-chat-node"
                    className="block truncate fs-10 leading-tight text-gray-500"
                  >
                    {node.subtitle}
                  </span>
                )}
                {/* Screen readers hear the name once per run, from the sr-only span. */}
                <span className="sr-only">
                  {who.name}
                  {node ? ` (${node.subtitle})` : ""}:{" "}
                </span>
                {run.map((i, k) => {
                  const m = messages[i]!;
                  return (
                    <span key={m.id}>
                      {k > 0 && (
                        <span aria-hidden className="mx-1 opacity-40">
                          ·
                        </span>
                      )}
                      {/* The time only on hover (long press on a phone). */}
                      <span
                        {...details.forMessage(m, who.name)}
                        data-testid="debug-chat-line"
                        data-msg={m.id}
                        data-from={m.from}
                        data-node={node?.node}
                        data-run-start={k === 0 || undefined}
                        // say --quiet: shown alike; only reading it aloud differs (speak-rules.ts).
                        data-volume={m.quiet ? "quiet" : undefined}
                        title={
                          node ? `${when(m.at)} · ${who.name} · ${node.subtitle}` : when(m.at)
                        }
                        // Selectable; it takes the pointer while the log is engaged (log-engage.ts).
                        className={`${LINE_SELECTABLE} ${m.speaker?.decision === "other" ? "text-amber-800/90 dark:text-amber-200/90" : ""}`}
                        // Just arrived: a soft sweep over its reading time (shimmer.ts).
                        {...shimmerOf(m)}
                      >
                        {m.context && m.from !== "agent" && <QuoteBlock t={t} ctx={m.context} />}
                        {m.attachments?.length && m.from !== "agent" ? (
                          <SentFiles refs={m.attachments} files={files} />
                        ) : null}
                        {m.ask
                          ? m.ask.questions.length === 1
                            ? lineText(m, m.ask.questions[0]!.question)
                            : ""
                          : readText(m, polish(m).text)}
                        {m.ask && (
                          <AskCard
                            ask={m.ask}
                            answer={m.answer}
                            onAnswer={onAnswer}
                            sendText={(text) => sendRef.current(text)}
                          />
                        )}
                        {polish(m).mark}
                        {m.speaker?.decision === "me" && <VoiceMark label={t.vpVerified} />}
                        {m.speaker?.decision === "other" && (
                          <span
                            data-testid="debug-chat-speaker-other"
                            className="ms-1 inline-flex items-center gap-0.5 rounded px-1 fs-10 font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                            title={
                              typeof m.speaker.score === "number"
                                ? `${t.vpOther} (${m.speaker.score})`
                                : t.vpOther
                            }
                          >
                            <span>👥</span>
                            <span>{t.vpOtherShort}</span>
                          </span>
                        )}
                        {(() => {
                          // Which recognizer made a voice line: dev holders only (`owner` needs dev).
                          const tag = m.from === "owner" ? sttTagText(m.stt, owner, ui) : undefined;
                          return tag ? (
                            <span
                              data-testid="debug-chat-stt"
                              className="ms-1 fs-10 text-gray-500"
                              title={ui.sttTagTip}
                            >
                              {tag}
                            </span>
                          ) : null;
                        })()}
                        {m.from === "agent" && unheardIds.has(m.id) && (
                          <span
                            data-testid="debug-chat-unheard"
                            className="ms-1 fs-10 text-gray-500"
                          >
                            {t.notReadHidden}
                          </span>
                        )}
                        {(() => {
                          // Waiting for the partner: the label on the last pending line only;
                          // the earlier ones a mark in the same ink, named for screen readers.
                          const w = waitingMark({ i, from: m.from, agentOnline, lastAgent, lastPending });
                          if (!w) return null;
                          return w === "label" ? (
                            <span
                              data-testid="debug-chat-queued"
                              className="ms-1 fs-10"
                              style={{ color: WAITING_INK }}
                              title={t.waitingTitle}
                            >
                              {t.waiting}
                            </span>
                          ) : (
                            <span
                              data-testid="debug-chat-queued-mark"
                              role="img"
                              aria-label={t.waiting.replace(/^[·\s]+/, "")}
                              title={`${t.waiting.replace(/^[·\s]+/, "")} — ${t.waitingTitle}`}
                              className="ms-1 inline-block size-1.5 rounded-full align-middle"
                              style={{ background: WAITING_INK }}
                            />
                          );
                        })()}
                      </span>
                    </span>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
      </div>
      {compact && compactEl}
      {open && warning && (
        <div
          role="alert"
          data-testid="debug-chat-warning"
          className="px-2 pt-1 fs-10"
          style={{ color: "oklch(0.6 0.17 45)" }}
        >
          {warning}
          {warningHref && (
            <>
              {" "}
              <a
                href={warningHref.href}
                data-testid="debug-chat-warning-link"
                className="underline"
                style={{ color: "inherit" }}
              >
                {warningHref.label}
              </a>
            </>
          )}
        </div>
      )}
      {vs.blocked && (
        // The browser refused to read a reply aloud (no tap since the page loaded): one tap reads on.
        <button
          type="button"
          data-testid="debug-chat-voice-blocked"
          onMouseDown={(e) => e.preventDefault()}
          onClick={unblockVoice}
          style={{ background: INPUT_BG }}
          className="pointer-events-auto self-start mb-1 rounded-full border border-current/25 px-2.5 py-1 fs-11 backdrop-blur"
        >
          🔊 {ui.resumeBlocked}
        </button>
      )}
      {resumeLeft.length > 0 && resumeItems.length > 0 && (
        // After a reload cut a reply off and the browser wants a tap before it speaks.
        <div className="pointer-events-auto flex items-center gap-1 self-start pb-1">
          <button
            type="button"
            data-testid="debug-chat-resume-read"
            onMouseDown={(e) => e.preventDefault()}
            onClick={resumeNow}
            style={{ background: INPUT_BG }}
            className="rounded-full border border-current/25 px-2.5 py-1 fs-11 backdrop-blur"
          >
            ▶ {ui.resumeRead}
          </button>
          <button
            type="button"
            aria-label="✕"
            data-testid="debug-chat-resume-read-dismiss"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setResumeLeft([]);
              uiStore.setState({ reading: [] });
            }}
            className="tap-40 px-1 fs-10 text-gray-500"
          >
            ✕
          </button>
        </div>
      )}
      {open && dragging && !notice && (
        // Over the whole box, taking pointer events: the drop lands here (onDrop above).
        <div
          data-testid="debug-chat-drop"
          className="pointer-events-auto absolute inset-0 z-30 flex min-h-24 items-center justify-center rounded-xl border-2 border-dashed px-2 text-center fs-13 backdrop-blur-sm"
          style={{ borderColor: "oklch(0.6 0.132 22.3)", background: "oklch(0.6 0.132 22.3 / 0.16)" }}
        >
          {t.attachDrop}
        </div>
      )}
      {open && !notice && publicStt === "ask" && (
        <SttServersCard
          onAgree={() => {
            writeConsent("on");
            setPublicStt("on");
          }}
          onLater={() => setPublicStt("no")}
        />
      )}
      {open && !notice && filesRef.current && <PendingChips t={t} pending={pending} />}
      {open && attached && !notice && (
        <AttachChip
          t={t}
          flat={typingGlassShown}
          ctx={attached}
          onRemove={() => {
            uiStore.setState({ attached: null });
            pageSel.clear();
          }}
        />
      )}
      {(etaShown || linkShown) && (
        // Right over the bar. flow-root: the bar's own margin counts in the
        // height the buttons above step over. In the strip it has no margin
        // and no track: the strip's glass is behind it. The connection chip
        // (a developer's page) sits at its left.
        <div
          ref={setEtaBox}
          data-testid="debug-chat-eta-slot"
          data-strip={strip || undefined}
          // The inset is STRIP_INSET_PX on the top and the sides (stripTopRadius).
          className="flow-root"
          style={strip ? { padding: `${STRIP_INSET_PX}px ${STRIP_INSET_PX}px 0` } : undefined}
        >
          {linkShown && link ? (
            <div className="flex items-stretch gap-1">
              <LinkChip
                glass={strip}
                t={ui}
                link={link.state}
                selection={selState}
                sessions={link.sessions}
                now={link.now}
                onEnd={link.onEnd}
              />
              {etaShown && (
                <div className="min-w-0 flex-1">
                  <EtaBar
                    tasks={etaList}
                    now={etaNow}
                    strings={t}
                    glass={strip}
                    onOpen={() => setGanttOpen(true)}
                  />
                </div>
              )}
            </div>
          ) : (
            <EtaBar
              tasks={etaList}
              now={etaNow}
              strings={t}
              glass={strip}
              onOpen={() => setGanttOpen(true)}
            />
          )}
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
        // On the left edge the row runs right to left (fold.ts): the mark on
        // the inner side, folding right. The text inside stays left to right.
        // Full screen: the bar spans the screen (or the sidebar), the cluster
        // at its left and the input taking the rest (full-screen.ts fullBarSpan).
        style={{
          gridTemplateColumns: open ? "1fr 0fr" : "0fr 1fr",
          direction: mirrorRow && !full ? "rtl" : undefined,
          ...(full ? fullBarSpan(sidebar) : {}),
        }}
      >
        {strip && (
          // The strip's one glass (owner, 2026-11-10): behind the progress
          // bar and the bar alike, so the two read as one surface. Its own
          // layer, not a wrapper: a backdrop-filter on an ancestor would
          // become the box of the fixed menus and the floating lines in here.
          <div
            aria-hidden
            data-testid="debug-chat-strip"
            data-top-radius={stripTopRadius(etaH)}
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 border border-current/25"
            style={{
              ...barGeometry(),
              ...STRIP_GLASS,
              top: -etaH,
              // The top corners concentric with the progress pill's end caps
              // (bar-geometry.ts stripTopRadius); the bottom ones the bar's own.
              borderTopLeftRadius: stripTopRadius(etaH),
              borderTopRightRadius: stripTopRadius(etaH),
              transition: reducedMotion() ? undefined : "border-radius 180ms ease-out, top 180ms ease-out",
            }}
          />
        )}
        <div style={LTR}>
        {open && (shownTarget !== ROOT_NODE || completions.length > 0) && (
          // The target node (a chip: × back to the main thread) and "@/…" completions.
          // Over the input, which starts after the cluster [mark | + | mic].
          <div
            style={{ insetInlineStart: INPUT_START, maxWidth: `calc(100% - ${INPUT_START} - 1rem)` }}
            className="pointer-events-none absolute bottom-full mb-1 flex flex-col items-start gap-1"
          >
            {completions.length > 0 && (
              <ul
                role="listbox"
                aria-label="Nodes to address"
                data-testid="debug-chat-nodes"
                // Inside the typing glass, plain rows on the glass (no box of
                // its own: one frame); a box only where no glass is behind it, and in
                // full screen, where the list would sit straight on the log's lines.
                style={typingGlassShown && !full ? undefined : { background: INPUT_BG }}
                className={`pointer-events-auto max-w-full list-none overflow-hidden py-0.5 fs-11 ${typingGlassShown && !full ? "" : "rounded-lg border border-current/25 backdrop-blur"}`}
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
                className={`pointer-events-auto inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 fs-10 leading-4 text-gray-600 dark:text-gray-300 ${preview ? "opacity-70" : ""}`}
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
        {open && attachMenu && (
          <AttachMenu
            t={t}
            attach={attach && !notice}
            sel={pageSel.sel}
            items={appAddItems}
            tree={tree}
            sessions={evalSessions.length}
            sessionsLabel={conns}
            onTree={() => setPanel((p) => (p === "tree" ? "none" : "tree"))}
            onAttachSelection={() => {
              const s = pageSel.sel;
              if (!s) return;
              const { at: _at, ...ctx } = s;
              uiStore.setState({ attached: ctx });
            }}
            upload={!!filesRef.current}
            onPickFiles={pickFiles}
            onInbox={filesRef.current?.list && !notice ? () => setInboxOpen(true) : undefined}
            onHistory={notice ? undefined : onHistory}
            onClose={closeAttachMenu}
          />
        )}
        {open && inboxOpen && filesRef.current?.list && (
          <InboxPanel t={t} files={filesRef.current} onClose={() => setInboxOpen(false)} />
        )}
        {filesRef.current && (
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            data-testid="debug-chat-file-input"
            onChange={(e) => {
              setPicking(false);
              pending.add(Array.from(e.currentTarget.files ?? []));
              e.currentTarget.value = "";
            }}
          />
        )}
        {askJumpShown && (
          // Left of the scroll-down button's place, whether or not it shows: a
          // jump brings that button up, and a second tap here must not land on it.
          <div
            className="pointer-events-none absolute inset-x-0 bottom-full flex justify-end"
            style={{ paddingInlineEnd: JUMP_END_PX, marginBottom: JUMP_GAP_PX + etaH }}
          >
            <button
              type="button"
              data-testid="debug-chat-ask-jump"
              data-count={asksUp.length}
              // Keeps the input's focus, so the keyboard and the log stay.
              onPointerDown={(e) => e.preventDefault()}
              aria-label={askJumpText}
              title={askJumpText}
              onClick={jumpToAsk}
              style={{
                background: "oklch(0.5 0.187 22.3)",
                color: "oklch(0.98 0 0)",
                height: JUMP_H_PX,
                width: jumpWidth(asksUp.length),
                padding: "0 10px",
                gap: 4,
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1,
                boxShadow: "0 1px 4px oklch(0 0 0 / 0.3)",
              }}
              className="tap-40 pointer-events-auto inline-flex items-center justify-center rounded-full"
            >
              {asksUp.length > 1 && <span aria-hidden>{asksUp.length}</span>}
              <span aria-hidden style={{ display: "inline-flex", fontSize: 16 }}>
                <Icon name="arrowUp" />
              </span>
            </button>
          </div>
        )}
        {open && scrolledUp && (
          // The row stays click-through; only the button takes taps.
          <div
            className="pointer-events-none absolute inset-x-0 bottom-full flex justify-end"
            style={{ marginBottom: 4 + etaH }}
          >
            <button
              type="button"
              data-testid="debug-chat-bottom"
              // Keeps the input's focus, so the log stays open.
              onPointerDown={(e) => e.preventDefault()}
              aria-label={
                withNew(ux.scrollNewest, below)
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
        </div>
        {/* One container: [mark | + | mic | input]; minimized, the input's slot
        closes to 0 and leaves [mark | Li | mic], the mic where it was. No title bar:
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
            if ((e.target as HTMLElement).closest("button, textarea, p, [data-chat-restore]"))
              return;
            handle.onPointerDown(e);
          }}
          onPointerMove={(e) => e.target === e.currentTarget && handle.onPointerMove(e)}
          onPointerUp={(e) => e.target === e.currentTarget && handle.onPointerUp()}
          onPointerCancel={(e) => e.target === e.currentTarget && handle.onPointerCancel()}
          style={{
            // Radius, padding and the line box as variables: the mic is concentric
            // with the corner by construction (bar-geometry.ts).
            ...barGeometry(),
            // A press target, not text: a long press here never selects (the input does).
            ...NO_SELECT,
            background: INPUT_BG,
            // Aside while the log spans the screen; it keeps the pointer (captured).
            opacity: barAside ? 0 : undefined,
            // Its own blur off too: invisible, it would only cost a
            // second backdrop pass over the sheet.
            ...(barAside ? { backdropFilter: "none", WebkitBackdropFilter: "none" } : {}),
            // While the typing glass is up it is the frame: the bar's own box
            // goes inside it (border transparent, width kept; no tint, no blur).
            // Full screen keeps the bar's own box: the glass there is the whole screen.
            // In the strip the strip's glass is its surface (the same glass).
            ...barInGlass((typingGlassShown && !full) || strip),
            transition: reducedMotion() ? undefined : `${FADE}, ${BAR_IN_GLASS_TRANSITION}`,
          }}
          data-in-glass={(typingGlassShown && !full) || undefined}
          className={`pointer-events-auto relative flex items-end border border-current/25 text-gray-600 backdrop-blur-md backdrop-saturate-150 dark:text-gray-300`}
        >
          {armed > 0 && (
            <div
              key={armed}
              aria-hidden
              className="lk-drain absolute inset-x-3 top-0 h-0.5 bg-blue-600/60"
            />
          )}
          {/* The controls' 44 px touch areas (bar-geometry.ts TAP_44_CSS). */}
          <style>{TAP_44_CSS}</style>
          {/* New lines and the mic scrub's cue (shimmer.ts). */}
          <style>{SHIMMER_CSS}</style>
          {controls}
          {/* + : add to Lianki, attach to the line, view the state tree
          (AttachMenu.tsx). Open only; without `attach` (or with a notice) it
          holds only the View group. */}
          {open && (
            <AttachButton
              t={t}
              open={attachMenu}
              announce={attach && !notice}
              sessions={evalSessions.length}
              ran={evalRan}
              onToggle={() => setAttachMenu((v) => !v)}
            />
          )}
          {/* The mic, after the + (open) or the pill's Li (folded): one place on screen. */}
          {micEl}
          {/* The input: gone while minimized (inert, so it can't take focus or
          be read), fading out as its slot closes. */}
          <div
            data-testid="debug-chat-input-slot"
            style={{ ...LTR_TEXT, ...TEXT_SELECT }}
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
                {noticeHref && (
                  <a
                    href={noticeHref.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="debug-chat-notice-link"
                    className="pointer-events-auto ms-1 underline"
                  >
                    {noticeHref.label}
                  </a>
                )}
              </p>
            ) : (
              <>
                {(interim || micActive) && (
                  // A mirror of the draft, invisible, then the interim text dimmed and the
                  // caret that follows the voice (MicCaret): where the transcript will land.
                  <div
                    ref={mirror}
                    aria-hidden
                    className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border border-transparent px-2 py-1 text-base ${inputPad}`}
                  >
                    <span className="invisible">{draft}</span>
                    <span data-testid="debug-chat-mic-pending" className="text-gray-400">
                      {joinText(draft, interim).slice(draft.length)}
                      {micActive && <MicCaret />}
                    </span>
                  </div>
                )}
                <textarea
                  ref={input}
                  data-testid="debug-chat-input"
                  // The draft is kept in sessionStorage across pages and reloads
                  // (ui-store.ts): never unsaved, for the leave guard or the deploy reload.
                  data-dirty="persisted"
                  data-drag-hint={holding || undefined}
                  rows={1}
                  // 16px: iOS zooms the whole page into any input under 16px.
                  value={draft}
                  maxLength={MAX_CHAT}
                  placeholder={
                    holding
                      ? DRAG_HINT
                      : interim || micActive
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
                  // A pasted image or file goes up as an attachment (files.ts); text pastes as usual.
                  onPaste={(e) => {
                    if (!filesRef.current) return;
                    const got = filesFrom(e.clipboardData);
                    if (!got.length) return;
                    e.preventDefault();
                    pending.add(got);
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
                  onFocus={() => {
                    setExpanded(true);
                    setTyping(true);
                  }}
                  // The caret is kept with the draft (ui-store.ts).
                  onSelect={(e) => {
                    const c = e.currentTarget.selectionEnd;
                    if (uiStore.getState().caret !== c) uiStore.setState({ caret: c });
                  }}
                  onBlur={() => {
                    hold(COMPACT_BLUR_MS);
                    setTyping(false);
                    // resumeNow's own focus and blur: the reading it queued goes on.
                    if (keepReading.current) return;
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
                  {...inputDrag}
                  // Empty, a vertical drag scrolls the log (full screen), not the page.
                  className={`block h-[2.125rem] max-h-32 min-h-[2.125rem] min-w-0 flex-1 resize-none self-end overflow-y-auto overscroll-contain ${draft ? "touch-pan-y" : "touch-none"} border border-transparent bg-transparent px-2 py-1 text-base outline-none placeholder:text-gray-400 ${inputPad}`}
                />
                {holding && draft && (
                  // The draft hides the placeholder: the hint sits over it instead.
                  <span
                    data-testid="debug-chat-drag-hint"
                    className="pointer-events-none absolute inset-x-1 top-0.5 truncate rounded px-1 fs-10 text-gray-500"
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
                    aria-label={ux.working.replace("{name}", busy.label || t.name)}
                    title={ux.working.replace("{name}", busy.label || t.name)}
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
          {!open && unread > 0 && (
            <span
              data-testid="debug-chat-pill-unread"
              className="pointer-events-none absolute -end-1.5 -top-1.5 rounded-full px-1 fs-10 leading-4 text-white"
              style={{ background: "oklch(0.55 0.21 22.3)" }}
            >
              {unread}
            </span>
          )}
        </div>
        <span aria-hidden />
        <div style={LTR}>
        {floatBoxEl}
        {menuEl}
        {panel === "voiceprint" && (
          <div className="pointer-events-auto absolute inset-x-0 bottom-full mb-1">
            <VoiceprintPanel t={t} deps={voiceprintDeps} onClose={() => setPanel("none")} />
          </div>
        )}
        </div>
      </div>
    </section>
    {tuckEl}
    {fullAllowed && (
      // The full-screen preview (full-screen.ts FULL_HINT_STYLE): outside the
      // section, whose transform would make it the box of a fixed child.
      <div
        aria-hidden
        data-testid="debug-chat-full-hint"
        data-on={fullHint || undefined}
        style={FULL_HINT_STYLE(fullHint, reducedMotion())}
      />
    )}
    </>
  );
}

/** The bar's drag grip: a vertical six-dot grip (two columns of three), its own SVG. */
function GripDots() {
  return (
    <svg
      data-testid="debug-chat-grip"
      viewBox="0 0 18 18"
      width={18}
      height={18}
      aria-hidden
      fill="currentColor"
    >
      {[3.5, 9, 14.5].flatMap((y) =>
        [6.5, 11.5].map((x) => <circle key={`${x},${y}`} cx={x} cy={y} r={1.6} />),
      )}
    </svg>
  );
}

/**
 * One floating line of the minimized chat: "name: text", up for its dwell
 * (float-lines.ts), then a slow opacity fade (none under reduced motion).
 * `epoch` restarts it; `paused` holds it, back at full opacity if fading.
 */
function FloatLine({
  details,
  oneLine,
  m,
  who,
  text,
  mark,
  epoch,
  aboveLeft,
  onLife,
  paused,
  onHover,
  onGone,
  arrivedAt,
}: {
  details: ReturnType<typeof useMessageDetails>["forMessage"];
  /** Its first line only (the tucked handle's peek), else up to three. */
  oneLine?: boolean;
  m: ChatMessage;
  /** When it arrived live (shimmer.ts createNewLines): it shimmers while read. */
  arrivedAt?: number;
  /** Who said it (avatar-rules.ts lineAvatar), drawn as in the log. */
  who: ReturnType<typeof lineAvatar>;
  /** What the line shows (a polished line's text, or its raw STT text), and its mark. */
  text: ReactNode;
  mark: ReactNode;
  epoch: number;
  /** The dwell left of the line above (ms): this one waits at least that long. */
  aboveLeft: () => number;
  /** Its life, for the line below (null when it ends). */
  onLife: (l: { remaining: () => number } | null) => void;
  paused: boolean;
  onHover: (on: boolean) => void;
  onGone: () => void;
}) {
  const [phase, setPhase] = useState<FloatPhase>("dwell");
  // Fixed at mount: the sweep picks up where it is, and no re-render shifts it.
  const [shim] = useState(() =>
    arrivedAt === undefined ? null : newShimmer(m.text, arrivedAt, Date.now()),
  );
  const life = useRef<ReturnType<typeof createFloatLife> | null>(null);
  const live = useRef({ paused, onGone, aboveLeft, onLife });
  live.current = { paused, onGone, aboveLeft, onLife };
  // A new epoch (a scrub step or its release) starts the line over: full dwell, then the fade.
  useEffect(() => {
    setPhase("dwell");
    const l = createFloatLife({
      // Its reading time, but never gone before the line above (float-lines.ts).
      ms: fifoDwellMs(m.text, live.current.aboveLeft()),
      // The app's "Turn off animations" (lib/motion-pref.ts) sets data-motion="off".
      reducedMotion:
        document.documentElement.dataset.motion === "off" ||
        matchMedia("(prefers-reduced-motion: reduce)").matches,
      paused: live.current.paused,
      onPhase: (p) => (p === "gone" ? live.current.onGone() : setPhase(p)),
    });
    life.current = l;
    live.current.onLife(l);
    return () => {
      l.cancel();
      live.current.onLife(null);
    };
  }, [epoch, m.id, m.text]);
  useEffect(() => {
    if (paused) life.current?.pause();
    else life.current?.resume();
  }, [paused]);
  const fading = phase === "fade";
  return (
    <li
      {...details(m, who.name)}
      data-msg={m.id}
      data-testid="debug-chat-float"
      data-from={m.from}
      data-fading={fading || undefined}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onPointerCancel={() => onHover(false)}
      // Text only, with a strong halo: no background, no box (they float over the page).
      style={{ textShadow: LINE_HALO, transitionDuration: `${FADE_MS}ms`, ...shim?.style }}
      {...(shim ? { [NEW_ATTR]: true } : {})}
      // The fade runs FADE_MS (ease-out, opacity only); held (touched), the line
      // snaps back to full at once. Reduced motion: no fade, it just goes.
      className={`${fading ? "opacity-0 transition-opacity ease-out" : "opacity-100 transition-none"} pointer-events-auto ${oneLine ? "line-clamp-1" : "line-clamp-3"} max-w-full whitespace-pre-wrap break-words py-0.5 leading-snug motion-reduce:transition-none`}
    >
      <span className="me-1 inline-block align-[-0.25em]">
        <Avatar
          src={who.src}
          name={who.name}
          initialFrom={who.initialFrom}
          seed={who.seed}
          size={AVATAR_PX}
          hidden
        />
      </span>
      <span className="sr-only">{who.name}: </span>
      {m.lane && <LaneTag lane={m.lane} inline />}
      {text}
      {mark}
    </li>
  );
}
