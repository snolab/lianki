"use client";

import { isEntrySource } from "@/lib/words/entry-list";
import { motionOff, setMotionOff, useMotionOff } from "@/lib/motion-pref";
import { useTextScale } from "@/lib/use-text-size";
import { useBackToClose } from "@/lib/use-back-to-close";
import { SettingsSheet } from "./SettingsSheet";
import { ListPreview, PreviewButton } from "./ListPreview";
import { TextSizeControls } from "@/app/components/TextSizeControls";
import { advanceTop, shouldAdvance } from "@/lib/words/advance";
import {
  afterGrade,
  emptyRequeue,
  isRetired,
  takeDue,
  undoPick,
  withdraw,
  type Requeue,
} from "@/lib/words/requeue";
import { progressPercent } from "@/lib/words/progress";
import { ProgressRingSvg } from "@/app/components/progress-ring";
import { voiceQuality } from "@lianki/debug-chat/wire";
import { pageAudio } from "@lianki/debug-chat/page-audio";
import { AEC_EVENT, aecOn, applyAec } from "@lianki/debug-chat/aec";
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon, type IconName } from "@/app/components/icons";
import { useIntlayer, useLocale } from "next-intlayer";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  applyDrop,
  descendants,
  flatten,
  projectDrop,
  visible,
  withoutNode,
} from "@/lib/words/tree";
import { shownName } from "@/lib/words/lang-groups";
import { planArrange } from "@/lib/words/arrange";
import {
  buildAddTree,
  loadAddOpen,
  saveAddOpen,
  toggleOpenKey,
  coverageBands,
  defaultOpen,
  freqListsOf,
  leavesOf,
  tickState,
  tickedInOrder,
  toggleTick,
  type AddNode,
} from "@/lib/words/add-tree";
import { EXTERNAL_SEARCHES, searchLinks, type ExternalSearch } from "@/lib/words/external-search";
import {
  SCENARIOS,
  isPhraseMeta,
  moveUnder,
  phraseHome,
  phraseRowName,
  type Register,
  type Scenario,
} from "@/lib/words/phrases";
import { createDeferredDelete, UNDO_MS, type FlushReason } from "@/lib/words/deferred-delete";
import type { WordCard, WordList } from "@/lib/repos/wordsD1";
import { spokenText } from "@/lib/words/spoken";
import type { VoiceAccess } from "@/lib/words/voice-access";
import { type VoiceActions, type VoiceOutcome, handleUtterance } from "@/lib/words/voice-dispatch";
import { VoiceBadge, useVoiceMode, voiceOutcomeLabel } from "./VoiceMode";
import { MEANING_VOICE, prefetchOrder, sayParts, type SayPart } from "@/lib/words/say-parts";
import { backParts, rowMetrics } from "@/lib/words/row-layout";
import { withPickedExample, type Example } from "@/lib/words/example-pick";
import {
  exampleSegments,
  famLang,
  famMark,
  missingWords,
  recordHits,
  type FamHit,
  type FamMap,
} from "@/lib/words/example-marks";
import { createSequencer } from "@/lib/words/sequence";
import { AudioCache } from "@/lib/words/audio-cache";
import { AUDIO_CACHE_NAME, AudioDisk } from "@/lib/words/audio-disk";
import { rowPriority } from "@/lib/words/audio-priority";
import {
  createClipPool,
  type Clip as PoolClip,
  type ClipPool,
  type CtxLike as PoolCtx,
} from "@/lib/words/clip-pool";
import { debugOn, devLog } from "@/lib/debug-client";
import { useInputModality } from "@/lib/use-input-modality";
import { EmptyTray } from "./EmptyTray";
import { useDebugToggle } from "@/app/components/useDebugToggle";
import {
  COLUMN_QUANTILE,
  centreWeight,
  frameDt,
  glideStep,
  nextGoal,
  splitTarget,
  termTarget,
  weightedQuantile,
} from "@/lib/words/columns";
import { MIN_JERK_EASING, moveSeconds } from "@/lib/words/motion";
import { CORD_BOW, cordPath } from "@/lib/words/cords";
import {
  sideGrade,
  sideRating,
  SWIPE_COAST_MS,
  SWIPE_MIRROR_KEY,
  SWIPE_HYSTERESIS,
  SWIPE_LEVEL,
  SWIPE_SNAP,
  SWIPE_SPRING,
} from "@/lib/words/swipe";
import { setSwipeVariant, swipeAbTag, swipeVariant, type SwipeVariant } from "@/lib/words/swipe-ab";
import { NATIVE_PARAMS, showReveal, useNativeSlip } from "@/lib/words/native-slip-gesture";
import {
  SWIPE_CORE_IFACE,
  SwipeFeelProvider,
  type SwipeRowValue,
  SwipeRowProvider,
  feelTagNow,
  setFeelPrefs,
  useFeelPrefs,
  useSwipeFeel,
  useSwipeGesture,
} from "@/lib/words/swipe-core";
import { notePrefWrite, PREF_APPLIED_EVENT, useUi } from "@lianki/ui-state";
import {
  anchorTop,
  migrateCollapsed,
  setAnchor,
  toggleCollapsed,
  topIndex,
  wordsUiStore,
} from "./ui-store";
import { island } from "@/lib/islands/Island";
import { SwipeCard } from "@/lib/words/islands/SwipeCard";
import { SwipeCue } from "@/lib/words/islands/SwipeCue";
import { SwipeGrades } from "@/lib/words/islands/SwipeGrades";
import { SwipeFeelSource } from "@/lib/words/islands/SwipeFeelSource";
import { SwipeTuner } from "@/lib/words/islands/SwipeTuner";

// The swipe's UI, as hot-swappable islands over the headless core (docs/swipe-core.md).
const SwipeCardIsland = island("words.swipeCard", SwipeCard);
const SwipeCueIsland = island("words.swipeCue", SwipeCue);
const SwipeGradesIsland = island("words.swipeGrades", SwipeGrades);
const SwipeFeelIsland = island("words.swipeFeel", SwipeFeelSource);
const SwipeTunerIsland = island("words.swipeTuner", SwipeTuner);
import { downloadCatalog, loadCatalog } from "@/lib/words/catalog-cache";
import { newScan, takeNewIndices, type NewScan } from "@/lib/words/take-new";
import { dueFetchLimit, MAX_DUE_FETCH, nextBatch, orderDue } from "@/lib/words/review-first";
import { countGradedNew, unseenLeft } from "@/lib/words/unseen";
import { idbAdd, idbAll, idbDelete, idbGet, idbPut, type PendingOp } from "@/lib/words/idb";
import {
  afterSend,
  backoff,
  pendingReviewed,
  reviewedKey,
  sendOrder,
  undoTarget,
  withPendingRenames,
} from "@/lib/words/pending";
import { playGradeTone, sharedAudioContext, unlockGradeTones, type GradeTone } from "./gradeSound";
import { formatInterval, parseCard, previewInterval, reviewWord } from "@/lib/words/schedule";

/**
 * Sub-second word-list review.
 *
 * A screen shows PAGE words at once — due words first, then new words in a
 * different colour, so finishing the due words flows straight into learning
 * new ones. Grading is by exception: mark only the words you missed, press
 * Enter, and every unmarked word counts as Good. The screen is submitted in one
 * request in the background; the next screen never waits for the network.
 */

/** Spacing for spreadPairs: the two directions of a pair stay this far apart. */
const PAGE = 20;
/** Ungraded words kept ready below the cursor; also the first batch of new words. */
const AHEAD = 40;
/** Due words per /session fetch; more are fetched as the queue drains. */
const DUE_PAGE = 200;
/** Hidden at least this long: on return, ask the server for words that fell due. */
const RECHECK_DUE_MS = 5 * 60_000;
/** A touch held this long without moving starts listen mode (looped audio). */
const HOLD_MS = 300;
/** The last swipes (distance, speed, result), kept locally to tune the physics. */
/**
 * Swipe telemetry, uploaded to /api/words/telemetry (the owner asked for it
 * to be collected, no button): finger travel, release speed, where the row
 * would rest, the grade, and the tuning in force. Queued in localStorage and
 * sent in batches — every 20 swipes, when study opens, and by beacon when
 * the page is hidden. The older local-only log (lk:swipe-log) goes up once.
 * Each row's params end with the A/B tag (lib/words/swipe-ab.ts), and two
 * kinds of rows are events, not swipes: `ev=undo` (an undo within
 * UNDO_AFTER_SWIPE_MS of a swipe's grade). A swipe with rating null slid but
 * graded nothing.
 */
const SWIPE_PARAMS = `snap=${SWIPE_SNAP};spring=${SWIPE_SPRING};level=${SWIPE_LEVEL};hyst=${SWIPE_HYSTERESIS};coast=${SWIPE_COAST_MS}`;
type SwipeRow = {
  at: string;
  finger: number;
  v: number;
  projected: number;
  rating: Rating | null;
  a: number;
  params: string;
};
const UNSENT = "lk:swipe-unsent";
function readJson<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
/** An undo this soon after a swipe graded counts against that swipe. */
const UNDO_AFTER_SWIPE_MS = 5000;
let lastSwipeGrade = { at: 0, a: 44 };
function logSwipe(e: {
  finger: number;
  v: number;
  projected: number;
  rating: Rating | null;
  a: number;
  /** The tuning in force; default: variant A's detents. */
  params?: string;
  ev?: "undo";
}) {
  if (e.rating) lastSwipeGrade = { at: Date.now(), a: e.a };
  const mirror = swipeMirrored();
  const unsent = readJson<SwipeRow>(UNSENT);
  unsent.push({
    at: new Date().toISOString(),
    finger: Math.round(e.finger * 10) / 10,
    v: Math.round(e.v * 1000) / 1000,
    projected: Math.round(e.projected * 10) / 10,
    // The grade given: with the sides mirrored, the finger's sign is the other one's.
    rating: sideRating(e.rating, mirror),
    a: e.a,
    // The feel tag (lib/words/swipe-feel.ts) only off the plain light feel, so old rows
    // compare; `mirror=1` only with the sides mirrored (Settings → Mirror swipe sides).
    params: `${e.params ?? SWIPE_PARAMS};${swipeAbTag()}${feelTagNow() ? `;${feelTagNow()}` : ""}${mirror ? ";mirror=1" : ""}${e.ev ? `;ev=${e.ev}` : ""}`,
  });
  try {
    localStorage.setItem(UNSENT, JSON.stringify(unsent.slice(-400)));
  } catch {}
  if (unsent.length >= 20) flushSwipes();
}
/** The sides are mirrored on this device (lib/words/swipe.ts, synced as words.swipeMirror). */
function swipeMirrored() {
  try {
    return localStorage.getItem(SWIPE_MIRROR_KEY) === "1";
  } catch {
    return false;
  }
}
/**
 * The sides mirrored (Settings → Mirror swipe sides): what a sliding slip
 * uncovers reads it (GradeZones, and data-mirror for showReveal). The grade
 * itself is mirrored once, where a row's swipe is graded (swipeGrade).
 */
const SwipeMirror = createContext(false);

/** The list's swipe contexts: the feel (swipe-core) and the mirror. */
function SwipeProviders({ mirror, children }: { mirror: boolean; children: React.ReactNode }) {
  return (
    <SwipeFeelProvider>
      <SwipeMirror.Provider value={mirror}>{children}</SwipeMirror.Provider>
    </SwipeFeelProvider>
  );
}

/** An undo: logged when it comes within UNDO_AFTER_SWIPE_MS of a swipe's grade. */
function logUndoAfterSwipe() {
  if (Date.now() - lastSwipeGrade.at > UNDO_AFTER_SWIPE_MS) return;
  const variantParams = swipeVariant() === "native" ? NATIVE_PARAMS : SWIPE_PARAMS;
  lastSwipeGrade.at = 0;
  logSwipe({
    finger: 0,
    v: 0,
    projected: 0,
    rating: null,
    a: lastSwipeGrade.a,
    params: variantParams,
    ev: "undo",
  });
}
function flushSwipes(beacon = false) {
  let legacy: SwipeRow[] = [];
  try {
    if (!localStorage.getItem("lk:swipe-log-sent"))
      legacy = readJson<{
        at: number;
        dx: number;
        v: number;
        projected: number;
        rating: Rating | null;
      }>("lk:swipe-log").map((l) => ({
        at: new Date(l.at).toISOString(),
        finger: l.dx,
        v: l.v,
        projected: l.projected,
        rating: l.rating,
        a: 44,
        params: "legacy:decay=0.99;no-resist",
      }));
  } catch {}
  const unsent = readJson<SwipeRow>(UNSENT);
  const batch = [...legacy, ...unsent].slice(0, 200);
  if (!batch.length) return;
  const sentUnsent = Math.max(0, batch.length - legacy.length);
  const done = () => {
    try {
      if (legacy.length) localStorage.setItem("lk:swipe-log-sent", "1");
      localStorage.setItem(UNSENT, JSON.stringify(readJson<SwipeRow>(UNSENT).slice(sentUnsent)));
    } catch {}
  };
  const body = JSON.stringify({ swipes: batch });
  if (
    beacon &&
    navigator.sendBeacon?.("/api/words/telemetry", new Blob([body], { type: "application/json" }))
  )
    return done();
  void fetch("/api/words/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  })
    .then((r) => r.ok && done())
    .catch(() => {});
}
/** A word whose next due falls inside this window comes back in this session. */
const SESSION_WINDOW_MS = 20 * 60_000;

type Rating = 1 | 2 | 3 | 4;
type CatalogMeta = {
  id: string;
  lang: string;
  name: string;
  level: string;
  count: number;
  file: string;
  source: string;
  license: string;
  /**
   * Where the entries are, when not `${base}/${file}`: an imported list's
   * words come from /api/words/lists/<id>/entries.
   */
  path?: string;
  /**
   * "phrase" for a scenario phrase deck (lib/words/phrases.ts), "exam" for an
   * exam deck (scripts/words/build-exam-decks.ts); word lists have none.
   */
  kind?: "phrase" | "exam";
  /** The exam a list prepares for (JLPT, HSK 3.0, CET 四六级, TOEFL…); the add picker groups by it. */
  exam?: string;
  /** A phrase deck's scenario. */
  scenario?: Scenario;
  /**
   * A frequency list's text coverage: the share of running text its top rank
   * covers, estimated by lemma (scripts/words/build-word-lists.ts). The add tree's bands.
   */
  coverage?: number;
};
/** The URL of a catalog's entries. */
const catalogPath = (base: string, c: CatalogMeta) => c.path ?? `${base}/${c.file}`;
/** An Anki deck imported at /words/import: its words live in D1, not a catalog file. */
const isImported = (l: { source: string | null }) => isEntrySource(l.source);
/** Imported lists, described as catalogs so the rest of the page needs no special case. */
const importedCatalog = (lists: WordList[]): CatalogMeta[] =>
  lists.filter(isImported).map((l) => ({
    id: l.source!,
    lang: l.lang,
    name: l.name,
    level: "",
    count: l.size,
    file: "",
    // A book's own list (the reader's in-place review): the book is its source.
    source: l.source!.startsWith("book:") ? l.name : "Anki",
    license: "",
    path: `/api/words/lists/${l.id}/entries`,
  }));
type Entry = {
  term: string;
  reading?: string;
  back: string;
  /** An example sentence in the target language, and its English. */
  ex?: string;
  exTr?: string;
  /** More example sentences, if the deck has them: one is shown per showing (lib/words/example-pick.ts). */
  exs?: Example[];
  /** Phrase decks: a usage note (English), casual / polite, and the moment it is said in. */
  note?: string;
  register?: Register;
  scene?: string;
};
type Item = Entry & {
  kind: "due" | "new" | "again";
  newIndex?: number;
  /** The list it belongs to — a "study all" screen mixes lists. */
  listId: string;
  lang: string;
  /** Stored ts-fsrs card JSON; absent for a word never reviewed. */
  card?: string;
};
/** Identity of a card across lists: the same term may be in two of them. */
const keyOf = (it: { listId: string; term: string }) => `${it.listId}\u0000${it.term}`;

/**
 * 1–4 for the left hand; the right hand mirrors it, so the outer fingers
 * agree: L K J H = Again Hard Good Easy (1 and L are both the outer edge's
 * Again). W/S move, like the arrows.
 */
const KEY_RATING: Record<string, Rating> = {
  KeyL: 1,
  KeyK: 2,
  KeyJ: 3,
  KeyH: 4,
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
};
/**
 * A graded row's ink (--grade, app/globals.css): the slip itself keeps its
 * colour; only a small seal at its right end and the due time take the grade.
 */
const RATING_STYLE: Record<Rating, string> = {
  1: "grade-again",
  2: "grade-hard",
  3: "grade-good",
  4: "grade-easy",
};
/** The grades' names, in the app's language. */
function useRatingLabel(): Record<Rating, string> {
  const text = useIntlayer("words-page");
  return { 1: text.again.value, 2: text.hard.value, 3: text.good.value, 4: text.easy.value };
}

/** Fills the `{name}` placeholders of a words-page string. */
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** True on a touch-first device (no hover, coarse pointer). */
function useTouch() {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
    const on = () => setTouch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return touch;
}

/**
 * An example sentence with its words marked by the user's familiarity
 * (lib/words/example-marks.ts): a word with a card gets a solid (weak) or
 * dashed (learning) line; mastered words and words without a card stay plain.
 */
function MarkedExample({ text, lang, fam }: { text: string; lang: string; fam: FamMap }) {
  const known = fam.get(famLang(lang));
  if (!known) return <>{text}</>;
  return (
    <>
      {exampleSegments(text, lang).map((s, k) => {
        const mark = s.word ? famMark(known.get(s.word)) : null;
        return mark ? (
          <span key={k} className={`lk-fam-${mark}`} data-fam={mark}>
            {s.text}
          </span>
        ) : (
          s.text
        );
      })}
    </>
  );
}

/**
 * Run `read` after mount, and again whenever a setting may have changed
 * underneath: a value from the account (docs/prefs-sync.md, `lk:pref-applied`)
 * or from another tab (`storage`).
 */
function usePrefReader(read: () => void) {
  useEffect(() => {
    read();
    window.addEventListener(PREF_APPLIED_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [read]);
}

/**
 * A remembered on/off setting (localStorage), the same across refreshes and,
 * for the keys in lib/prefs/bindings.ts, across the account's devices.
 * Reads after mount, so server and first client render agree.
 */
function usePref(key: string, initial: boolean) {
  const [on, setOn] = useState(initial);
  const read = useCallback(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === "1" || v === "0") setOn(v === "1");
    } catch {}
  }, [key]);
  usePrefReader(read);
  const set = useCallback(
    (next: boolean | ((v: boolean) => boolean)) =>
      setOn((v) => {
        const n = typeof next === "function" ? next(v) : next;
        try {
          localStorage.setItem(key, n ? "1" : "0");
        } catch {}
        notePrefWrite();
        return n;
      }),
    [key],
  );
  return [on, set] as const;
}

/** A pill-shaped switch for the settings panel. */
/**
 * "Whisper mode: Auto / On / Off" for the debug chat's microphone
 * (packages/debug-chat/src/adaptive.ts): localStorage lk:voice-whisper
 * ("force" / "off" / unset = auto), on this device only (never synced). The
 * mic reads it at every frame, so a change applies at once.
 */
const WHISPER_CHOICES = [
  ["auto", "whisperAuto"],
  ["force", "whisperOn"],
  ["off", "whisperOff"],
] as const;
function WhisperModeSetting({
  text,
}: {
  text: Record<
    "whisperMode" | "whisperModeHint" | "whisperAuto" | "whisperOn" | "whisperOff",
    { value: string }
  >;
}) {
  const [mode, setMode] = useState<string>("auto");
  useEffect(() => {
    try {
      setMode(localStorage.getItem("lk:voice-whisper") ?? "auto");
    } catch {}
  }, []);
  const pick = (m: string) => {
    setMode(m);
    try {
      if (m === "auto") localStorage.removeItem("lk:voice-whisper");
      else localStorage.setItem("lk:voice-whisper", m);
    } catch {}
  };
  return (
    <div
      role="radiogroup"
      aria-label={text.whisperMode.value}
      title={text.whisperModeHint.value}
      data-whisper-mode={mode}
      className="inline-flex items-center gap-1 rounded-full bg-black/5 py-1 pr-1 pl-3 text-xs dark:bg-white/10"
    >
      <span className="me-1 opacity-80">{text.whisperMode.value}</span>
      {WHISPER_CHOICES.map(([m, k]) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => pick(m)}
          className={`rounded-full px-2 py-0.5 ${mode === m ? "bg-emerald-500/20 font-semibold text-emerald-900 dark:text-emerald-100" : "opacity-70"}`}
        >
          {text[k].value}
        </button>
      ))}
    </div>
  );
}

function TogglePill({
  on,
  onChange,
  label,
  hint,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      title={hint}
      onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-2 rounded-full pl-1 pr-3 py-1 text-xs transition-colors ${
        on
          ? "bg-emerald-500/20 text-emerald-900 dark:text-emerald-100"
          : "bg-black/5 dark:bg-white/10 opacity-80"
      }`}
    >
      <span
        className={`relative h-4 w-7 rounded-full transition-colors ${
          on ? "bg-emerald-500" : "bg-black/25 dark:bg-white/30"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
            on ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

type FsDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

/**
 * Full screen for phone study: the address bar eats a lot of a phone screen.
 * The Fullscreen API works on Android; iPhone Safari has none for pages, so
 * there `supported` is false and the way is Add to Home Screen (standalone).
 */
function useFullscreen() {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const d = document as FsDoc;
    setSupported(!!(d.fullscreenEnabled || d.webkitFullscreenEnabled));
    setStandalone(
      window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
    );
    const on = () => setActive(!!(d.fullscreenElement || d.webkitFullscreenElement));
    on();
    document.addEventListener("fullscreenchange", on);
    document.addEventListener("webkitfullscreenchange", on);
    return () => {
      document.removeEventListener("fullscreenchange", on);
      document.removeEventListener("webkitfullscreenchange", on);
    };
  }, []);
  const enter = useCallback(() => {
    const el = document.documentElement as FsEl;
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    return req?.({ navigationUI: "hide" } as FullscreenOptions)?.catch(() => {});
  }, []);
  const exit = useCallback(() => {
    const d = document as FsDoc;
    if (!(d.fullscreenElement || d.webkitFullscreenElement)) return;
    (d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d))?.()?.catch(() => {});
  }, []);
  return { supported, active, standalone, enter, exit };
}

/** Does one card's answer show the other's front? (あ → a next to a → あ) */
const answers = (a: Item, b: Item) =>
  a.back.split(/\s*\/\s*/).includes(b.term) || b.back.split(/\s*\/\s*/).includes(a.term);

/**
 * Reorder `items` so no screen holds both directions of a pair — a reverse
 * card under its forward card gives the answer away. `offset` is how far into
 * the current screen the first item lands.
 */
function spreadPairs(items: Item[], size: number, offset: number, seed: Item[] = []): Item[] {
  const out: Item[] = [];
  let pending = items;
  let room = size - (offset % size);
  // `seed`: what already sits on the partly filled screen these items join.
  let onScreen = room < size ? seed.slice(-(size - room)) : [];
  while (pending.length) {
    const screen: Item[] = [];
    const later: Item[] = [];
    for (const it of pending) {
      if (screen.length < room && ![...onScreen, ...screen].some((s) => answers(s, it)))
        screen.push(it);
      else later.push(it);
    }
    if (!screen.length) screen.push(later.shift()!);
    out.push(...screen);
    pending = later;
    room = size;
    onScreen = [];
  }
  return out;
}

/** True while the tab is visible and its window has focus. */
function usePageActive() {
  const [active, setActive] = useState(true);
  useEffect(() => {
    const update = () => setActive(document.visibilityState === "visible" && document.hasFocus());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return active;
}

/**
 * Browser speech (Web Speech API): instant, offline, no rate limit, and every
 * language the OS has a voice for. Where it cannot speak — no API, no voice
 * for the language, or it never starts (Firefox on Android) — the word comes
 * from the server instead (/api/words/tts, generated once and cached).
 */
/**
 * Full language tags for speech. A bare "ja" with no voice chosen lets
 * Android pick any engine voice — Japanese then came out in a Chinese accent.
 */
const SPEECH_TAG: Record<string, string> = {
  ja: "ja-JP",
  zh: "zh-CN",
  ko: "ko-KR",
  fr: "fr-FR",
  es: "es-ES",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  ru: "ru-RU",
  fi: "fi-FI",
  en: "en-US",
};

/**
 * Debug-only swipe profiler: frame times while a finger is on a slip, plus
 * how often the slip rendered.
 * Reported to devLog when the finger lifts.
 */
const swipePerf = {
  on: false,
  frames: [] as number[],
  renders: 0,
  raf: 0,
  last: 0,
  start() {
    if (!debugOn()) return;
    this.on = true;
    this.frames = [];
    this.renders = 0;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.on) return;
      this.frames.push(now - this.last);
      this.last = now;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  stop(kind: string) {
    if (!this.on) return;
    this.on = false;
    cancelAnimationFrame(this.raf);
    const f = [...this.frames].sort((a, b) => a - b);
    const q = (p: number) =>
      f.length ? Math.round(f[Math.min(f.length - 1, Math.floor(p * f.length))]) : 0;
    devLog({
      ev: "swipe-perf",
      kind,
      frames: f.length,
      p50: q(0.5),
      p95: q(0.95),
      max: q(1),
      over20: f.filter((x) => x > 20).length,
      over34: f.filter((x) => x > 34).length,
      renders: this.renders,
      dpr: devicePixelRatio,
    });
  },
};

/**
 * How far past the first or last row the list scrolls, as a fraction of its
 * height: the first row can be pulled down to 80% of the way down the list,
 * the last up to 20% from the top.
 */
const OVERSCROLL_FRACTION = 0.8;

/** Rows past the rendered window whose audio is fetched ahead too. */
const PREFETCH_NEXT = 5;

/** How long a word clip takes to fade out when the card changes. */
const FADE_S = 0.15;

/**
 * The <audio> elements word clips play in, each routed once through a gain
 * node so it can fade out (iOS ignores `volume` on media elements), and
 * reused from clip to clip (lib/words/clip-pool.ts). One element per clip
 * kept every element and its nodes alive in the AudioContext: the page slowed
 * down over a long study.
 */
type Clip = PoolClip<HTMLAudioElement>;
let sharedClips: ClipPool<HTMLAudioElement> | null = null;
function clipPool() {
  sharedClips ??= createClipPool({
    element: () => new Audio(),
    ctx: () => sharedAudioContext() as unknown as PoolCtx | null,
  });
  return sharedClips;
}

/**
 * Word audio for this tab, shared by every mount of the page: each clip is
 * fetched once per session (lib/words/audio-cache.ts).
 */
let sharedAudio: AudioCache | null = null;
function wordAudio(): AudioCache {
  if (!sharedAudio) requestPersistentStorage();
  sharedAudio ??= new AudioCache({
    fetch: (url, init) => fetch(url, init),
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    connection: () =>
      (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
        .connection,
    // On the device too (lib/words/audio-disk.ts): next time, and offline,
    // a clip plays with no network at all.
    disk:
      typeof caches === "undefined"
        ? undefined
        : new AudioDisk({ open: () => caches.open(AUDIO_CACHE_NAME) }),
    log: devLog,
  });
  return sharedAudio;
}

/**
 * Ask once per device that stored clips and words outlive storage pressure
 * (iOS evicts a home-screen app's storage otherwise). The answer is the
 * browser's; nothing depends on it.
 */
function requestPersistentStorage() {
  try {
    if (localStorage.getItem("lk:storage-persist")) return;
    localStorage.setItem("lk:storage-persist", "asked");
    void navigator.storage
      ?.persist?.()
      .then((granted) => devLog({ ev: "storage-persist", granted }))
      .catch(() => {});
  } catch {}
}

/**
 * The mic's echo cancellation switch (lk:voice-aec; packages/debug-chat
 * aec.ts), device-local (docs/prefs-sync.md): the same one as the chat's ⋯
 * menu, which it follows. An open mic reopens with the new mode at once.
 */
function useAecSwitch(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const read = () => setOn(aecOn());
    read();
    window.addEventListener(AEC_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(AEC_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    setOn(next);
    void applyAec(next).then((how) => devLog({ ev: "aec-switch", on: next, how }));
  }, []);
  return [on, set];
}

/** `serverVoice`: always use the server's recordings, never the browser's. */
function useSpeech(serverVoice = false) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem("lk:words-sound") !== "off";
    } catch {
      return true;
    }
  });
  // Read aloud follows the account (docs/prefs-sync.md).
  usePrefReader(
    useCallback(() => {
      try {
        setOn(localStorage.getItem("lk:words-sound") !== "off");
      } catch {}
    }, []),
  );
  /**
   * Bumped by cancel(). cancel() can fire the old utterance's onend, which
   * would otherwise go on with the old word beside the new one.
   */
  const generation = useRef(0);

  const [available, setAvailable] = useState(false);
  /** Languages the browser failed to speak; the server speaks them instead. */
  const browserDead = useRef(new Set<string>());
  const audio = useRef<Clip | null>(null);
  /**
   * The part playing, told to the page (page-audio.ts): with echo
   * cancellation off the mic holds its capture meanwhile, so a word read
   * aloud is not transcribed.
   */
  const audible = useRef<(() => void) | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setAvailable(true);
    if (typeof speechSynthesis === "undefined") return;
    // Mobile browsers speak only once a gesture has spoken: say nothing on
    // the first touch or key so later, timer-driven speech is allowed.
    const prime = () => {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      speechSynthesis.speak(u);
    };
    const opts = { once: true, capture: true } as const;
    window.addEventListener("pointerup", prime, opts);
    window.addEventListener("keydown", prime, opts);
    const pick = () => setVoices(speechSynthesis.getVoices());
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
    return () => {
      speechSynthesis.removeEventListener("voiceschanged", pick);
      window.removeEventListener("pointerup", prime, opts);
      window.removeEventListener("keydown", prime, opts);
    };
  }, []);

  const voiceFor = useCallback(
    (lang: string) => {
      // Android has reported tags as "fr_FR".
      const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace("_", "-");
      const vs = voices.filter((v) => norm(v).startsWith(lang));
      const tag = SPEECH_TAG[lang]?.toLowerCase();
      // The language's own region first (ja-JP, not a ja voice of elsewhere).
      const exact = vs.filter((v) => norm(v) === tag);
      // Natural voices first: iOS lists robotic Eloquence and novelty voices first.
      const best = (pool: SpeechSynthesisVoice[]) => {
        const q = Math.max(-1, ...pool.map(voiceQuality));
        const top = pool.filter((v) => voiceQuality(v) === q);
        return top.find((v) => v.localService) ?? top[0];
      };
      return best(exact) ?? best(vs) ?? null;
    },
    [voices],
  );

  /** Silence the part playing now; callbacks of what was playing are ignored. */
  const cancel = useCallback(() => {
    generation.current++;
    clearTimeout(watchdog.current);
    audible.current?.();
    audible.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    // A clip cut mid-word is jarring when the card changes: fade it out.
    clipPool().fadeOut(audio.current, FADE_S);
    audio.current = null;
  }, []);

  type Done = (played: boolean) => void;

  /** Play the server's recording of `text`. False when it could not (no voice, limit, offline). */
  const serverSpeak = useCallback(async (text: string, lang: string, done: Done) => {
    const gen = generation.current;
    const t0 = performance.now();
    // Prefetched, most of the time: then it plays at once, still inside the
    // tap's gesture (no await before play()).
    const ready = wordAudio().peek(lang, text);
    const r = ready ?? (await wordAudio().load(lang, text));
    if (r.kind !== "ok") return false;
    if (gen !== generation.current) return true;
    const tFetched = performance.now();
    const from = r.from;
    // An idle element from the pool: the previous one may still be fading out.
    const c = clipPool().take(r.url);
    audio.current = c;
    // Debug mode only: how long from "say it" to sound, and where it went —
    // waiting for the clip, or the element starting to play.
    c.el.onplaying = () =>
      devLog({
        ev: "play",
        lang,
        text,
        prefetched: !!ready,
        // memory (this session), disk (the device), or network.
        from,
        fetchMs: Math.round(tFetched - t0),
        startMs: Math.round(performance.now() - tFetched),
      });
    c.el.onended = () => done(true);
    c.el.onerror = () => done(false);
    void c.el.play().catch(() => {});
    return true;
  }, []);

  /** The browser can say this language itself. */
  const browserCan = useCallback(
    (lang: string) =>
      typeof speechSynthesis !== "undefined" &&
      !browserDead.current.has(lang) &&
      voiceFor(lang) !== null,
    [voiceFor],
  );

  /** `serverTried`: the server already failed this text — don't ask again. */
  const browserSpeak = useCallback(
    (text: string, lang: string, done: Done, serverTried = false) => {
      const gen = generation.current;
      const viaServer = () => {
        if (serverTried) {
          // Neither engine can say it: log that, rather than going on in silence.
          devLog({ ev: "silent", lang, text, reason: "no server clip, no browser voice" });
          return done(false);
        }
        void serverSpeak(text, lang, done).then(
          (ok) => !ok && gen === generation.current && done(false),
        );
      };
      // Only a voice of this very language. With none listed (Chrome on
      // Android often lists nothing) the OS picks its default voice — a
      // Japanese voice reading French. The server speaks instead, or nothing.
      const voice = voiceFor(lang);
      if (!browserCan(lang) || !voice) return viaServer();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      devLog({ ev: "browser", lang, text, voice: voice.name, voiceLang: voice.lang });
      u.rate = 0.9;
      // Never started (no engine behind the API) or failed outright: the
      // server speaks this language from now on.
      let started = false;
      const fallBack = () => {
        if (started || gen !== generation.current) return;
        clearTimeout(watchdog.current);
        browserDead.current.add(lang);
        speechSynthesis.cancel();
        viaServer();
      };
      u.onstart = () => {
        started = true;
        clearTimeout(watchdog.current);
      };
      u.onerror = (e) => {
        if (e.error !== "interrupted" && e.error !== "canceled") fallBack();
      };
      u.onend = () => {
        if (started) done(true);
      };
      clearTimeout(watchdog.current);
      watchdog.current = setTimeout(fallBack, 2000);
      speechSynthesis.speak(u);
    },
    [voiceFor, browserCan, serverSpeak],
  );

  /** The server voices this part (rather than the browser). */
  const viaServer = useCallback(
    (p: SayPart) =>
      !wordAudio().isDead(p.lang) &&
      (p.kind === "meaning" ? MEANING_VOICE === "server" : serverVoice || !browserCan(p.lang)),
    [serverVoice, browserCan],
  );

  /** One part; a missing voice falls back to the other engine for this part only. */
  const say = useCallback(
    (p: SayPart, finish: Done) => {
      devLog({ ev: "speak", kind: p.kind, lang: p.lang, text: p.text, serverVoice });
      audible.current?.();
      const end = pageAudio().start();
      audible.current = end;
      const done: Done = (played) => {
        end();
        if (audible.current === end) audible.current = null;
        finish(played);
      };
      // The server voice by default: browser voices can mislead (Japanese read
      // in a Chinese accent). The browser speaks only where the server can't —
      // a language or text it has no voice for, the rate limit, offline.
      if (!viaServer(p)) return browserSpeak(p.text, p.lang, done);
      const gen = generation.current;
      void serverSpeak(p.text, p.lang, done).then(
        (ok) => !ok && gen === generation.current && browserSpeak(p.text, p.lang, done, true),
      );
    },
    [serverVoice, viaServer, serverSpeak, browserSpeak],
  );

  /**
   * A tap reads the word, the meaning and the example back to back: fetch the
   * ones not prefetched yet all at once, so the meaning and the example arrive
   * while the word plays instead of each waiting for the one before.
   */
  const warm = useCallback(
    (parts: SayPart[]) => wordAudio().warm(parts.filter(viaServer)),
    [viaServer],
  );

  const sayRef = useRef(say);
  sayRef.current = say;
  const sequencer = useMemo(
    () =>
      createSequencer<SayPart>({
        say: (p, done) => sayRef.current(p, done),
        cancel,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      }),
    [cancel],
  );
  const stop = sequencer.stop;

  /**
   * A long-press reading: `parts` on a loop while the finger is down. It
   * outranks what a swipe or a focus change says (`once(…, { yieldToHold })`):
   * those are skipped while it plays. Only a tap or another long press cuts it.
   */
  const hold = useCallback(
    (parts: SayPart[]) => {
      warm(parts);
      sequencer.play(
        parts.filter((p) => p.text),
        { loop: true, tag: "hold" },
      );
    },
    [sequencer, warm],
  );

  /** The finger lifted: the long-press reading plays its current pass to the end, then stops. */
  const release = sequencer.finish;

  /**
   * Say `parts` in turn (word, meaning, example), pause, repeat — until the
   * next call; an empty list just stops.
   */
  const loop = useCallback(
    (parts: SayPart[], force = false) => {
      if (!on && !force) return stop();
      // A tap: everything now. Not when the focus moves (desktop): flicking
      // through rows would fetch every row's clips, and prefetch has them.
      if (force) warm(parts);
      // A short delay so flicking through rows does not start a word per row.
      sequencer.play(
        parts.filter((p) => p.text),
        { loop: true, delayMs: 250 },
      );
      return stop;
    },
    [on, sequencer, stop, warm],
  );

  /**
   * Say `parts` once, back to back, now — interrupting whatever was playing,
   * unless `yieldToHold` and a long-press reading is playing: then nothing.
   */
  const once = useCallback(
    (parts: SayPart[], force = false, opts: { yieldToHold?: boolean } = {}) => {
      if (opts.yieldToHold && sequencer.playing() === "hold") return;
      if (!on && !force) return stop();
      warm(parts);
      sequencer.play(parts.filter((p) => p.text));
    },
    [on, sequencer, stop, warm],
  );

  /**
   * Fetch the clips of rows about to be tapped (only those the server would
   * voice): `visible` first, never evicted, then `rest`.
   */
  const prefetch = useCallback(
    (visible: SayPart[], rest: SayPart[]) => {
      const seen = visible.filter(viaServer);
      wordAudio().prefetch([...seen, ...rest.filter(viaServer)], { pinned: seen.length });
    },
    [viaServer],
  );

  /** Put these on the device, last of all (today's due words, for offline study). */
  const stock = useCallback(
    (parts: SayPart[]) => wordAudio().stock(parts.filter(viaServer)),
    [viaServer],
  );

  const toggle = useCallback(() => {
    setOn((v) => {
      try {
        localStorage.setItem("lk:words-sound", v ? "off" : "on");
      } catch {}
      notePrefWrite();
      if (v) stop();
      return !v;
    });
  }, [stop]);

  return useMemo(
    () => ({ available, on, loop, once, hold, release, toggle, prefetch, stock }),
    [available, on, loop, once, hold, release, toggle, prefetch, stock],
  );
}

/**
 * Glance motion (lib/words/motion.ts): peak acceleration in px/s², and the
 * pauses (s) to read the start and the end. A 200px slide takes ~1.6s.
 */
const GLANCE_ACCEL = 450;
const GLANCE_HOLD_START = 1.0;
const GLANCE_HOLD_END = 1.2;
/** Line height of a /words cell that wraps (Glance `lines`), in em. */
const ROW_LINE_LH = 1.25;

/**
 * A cell that would be cut off: on the active row it slides to its end,
 * pauses, and slides back — a minimum-jerk move, run by the compositor
 * through the Web Animations API — so a long word or
 * meaning can be read in full without leaving the list. Elsewhere it ends in
 * an ellipsis, and hovering shows the whole text.
 *
 * With `lines` > 1 the text wraps onto that many lines first (the taller
 * rows, owner 2026-11-03 23:01 JST), ends in an ellipsis there, and on the
 * active row slides up instead, to its last line and back.
 */
function Glance({
  active,
  className,
  title,
  lines = 1,
  children,
}: {
  active: boolean;
  className: string;
  title?: string;
  lines?: number;
  children: React.ReactNode;
}) {
  const wrap = lines > 1;
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(0);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!active || !o || !i) return setOver(0);
    // Measured as laid out on one line, ellipsis aside — and again whenever
    // the cell's width changes (window resize, the term column gliding).
    // The outer box clips, so its scrollWidth is the full text's width (an
    // inline span's own scrollWidth is always 0).
    const measure = () => {
      // Wrapped: clamped, the inner box's own overflow; sliding (unclamped),
      // how far it reaches past the outer box's lines.
      const extra = wrap
        ? Math.max(i.scrollHeight - i.clientHeight, i.offsetHeight - o.clientHeight)
        : o.scrollWidth - o.clientWidth;
      setOver(extra > 2 ? Math.ceil(extra) : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    return () => ro.disconnect();
  }, [active, children, title, wrap]);
  useEffect(() => {
    const i = inner.current;
    if (!over || !i || motionOff()) return;
    const move = moveSeconds(over, GLANCE_ACCEL);
    const total = GLANCE_HOLD_START + move + GLANCE_HOLD_END + move;
    const at = (s: number) => s / total;
    const end = wrap ? `translateY(-${over}px)` : `translateX(-${over}px)`;
    const anim = i.animate(
      [
        { transform: "none", offset: 0 },
        { transform: "none", offset: at(GLANCE_HOLD_START), easing: MIN_JERK_EASING },
        { transform: end, offset: at(GLANCE_HOLD_START + move) },
        {
          transform: end,
          offset: at(GLANCE_HOLD_START + move + GLANCE_HOLD_END),
          easing: MIN_JERK_EASING,
        },
        { transform: "none", offset: 1 },
      ],
      { duration: total * 1000, iterations: Infinity },
    );
    return () => anim.cancel();
  }, [over, wrap]);
  if (wrap)
    return (
      <span
        ref={outer}
        title={title}
        className={`${className} overflow-hidden whitespace-normal [overflow-wrap:anywhere]`}
        style={{ maxHeight: `${lines * ROW_LINE_LH}em`, lineHeight: ROW_LINE_LH }}
      >
        <span
          ref={inner}
          className={over ? "block will-change-transform" : "block overflow-hidden text-ellipsis"}
          style={
            over
              ? undefined
              : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines }
          }
        >
          {children}
        </span>
      </span>
    );
  return (
    <span
      ref={outer}
      title={title}
      className={`${className} overflow-hidden whitespace-nowrap ${over ? "" : "text-ellipsis"}`}
    >
      <span ref={inner} className={over ? "inline-block will-change-transform" : ""}>
        {children}
      </span>
    </span>
  );
}

/**
 * When a graded word comes back, counting down live: each second under a
 * minute (59s, 58s…), each minute under an hour, static beyond. Each row
 * ticks itself — only rows on screen exist, so nothing else re-renders.
 * Once due, a word that was put back in the queue reads "↓ back" and its
 * slip fades (.lk-back in globals.css): the copy further down is the one
 * to answer now.
 */
function Countdown({ due, back }: { due: number; back: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const left = due - now;
    if (left <= 0 || left > 3_600_000) return;
    // Wake when the label next changes: the next second, or the next minute.
    const wait = left < 60_500 ? left % 1000 || 1000 : left % 60_000 || 60_000;
    const t = setTimeout(() => setNow(Date.now()), Math.min(wait + 20, left + 20));
    return () => clearTimeout(t);
  }, [due, now]);
  const text = useIntlayer("words-page");
  const left = due - now;
  if (left > 0) return <>{formatInterval(left)}</>;
  return back ? <span className="lk-back">{text.back}</span> : <>{text.now}</>;
}

/** Due time (ms) of a stored card JSON. */
const dueOf = (card: string) => {
  try {
    return new Date(JSON.parse(card).due).getTime();
  } catch {
    return Date.now();
  }
};

const localDay = () => new Date().toLocaleDateString("en-CA");

/** The request never reached the server: no network. */
class OfflineError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch {
    throw new OfflineError("offline");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return res.json() as Promise<T>;
}

// ── Sync: grades and undos wait in IndexedDB `pending` and go out in order ──

type SyncStatus = { pending: number; online: boolean };
const syncListeners = new Set<(s: SyncStatus) => void>();
let flushing = false;
/** An op was queued while a pass was sending: send again when it ends. */
let flushAgain = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Tell every header how many ops are waiting. */
async function notifySync() {
  const n = (await idbAll<PendingOp>("pending").catch(() => [])).length;
  const s = { pending: n, online: navigator.onLine };
  for (const l of syncListeners) l(s);
}

/** Send waiting ops in the order they were made; stop at the first network failure. */
async function flushPending() {
  // Already sending: ops queued meanwhile go out in another pass right after
  // (nothing else would send them — there is no polling).
  if (flushing) return void (flushAgain = true);
  flushing = true;
  flushAgain = false;
  clearTimeout(retryTimer);
  let retrying = false;
  try {
    const ops = sendOrder(await idbAll<PendingOp>("pending"));
    for (const o of ops) {
      let status: number | "network";
      try {
        const res = await fetch(`/api/words/lists/${o.listId}/${o.op}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(o.body),
          keepalive: true,
        });
        status = res.status;
      } catch {
        status = "network";
      }
      const next = afterSend(status);
      if (next === "retry") {
        retryTimer = setTimeout(flushPending, backoff(attempt++));
        retrying = true;
        break;
      }
      attempt = 0;
      await idbDelete("pending", o.id!);
      await notifySync();
    }
  } catch {
    // IndexedDB unavailable: nothing to send from here.
  } finally {
    flushing = false;
    await notifySync();
  }
  if (flushAgain && !retrying) void flushPending();
}

/** Queue an op and try to send it now. */
async function enqueue(op: PendingOp) {
  try {
    await idbAdd("pending", op);
  } catch {
    // No IndexedDB (private mode): send directly, best effort.
    void fetch(`/api/words/lists/${op.listId}/${op.op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(op.body),
      keepalive: true,
    }).catch(() => {});
    return;
  }
  await notifySync();
  void flushPending();
}

/** Pending ops and connectivity, for the study header. Also drives retries. */
function useSyncStatus(): SyncStatus {
  const [s, setS] = useState<SyncStatus>({ pending: 0, online: true });
  useEffect(() => {
    syncListeners.add(setS);
    const online = () => void flushPending();
    const offline = () => void notifySync();
    // "online" is unreliable on some phones: coming back to the page sends
    // too. Event-driven only — no polling (an owner rule).
    const visible = () => document.visibilityState === "visible" && void flushPending();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    // Ops left from an earlier visit.
    void flushPending();
    return () => {
      syncListeners.delete(setS);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
    };
  }, []);
  return s;
}

/**
 * Make this page open offline: the site-wide service worker (public/sw.js,
 * registered in the root layout) caches pages as they load, but not the ones
 * loaded before it took control — so tell it what this page already fetched.
 */
function useOfflineShell() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => {
        // Files this page already loaded came before the worker was in charge:
        // hand it their URLs so it caches them for the next offline visit.
        const urls = performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin) && u.includes("/_next/static/"));
        reg.active?.postMessage({ type: "cache", urls: [location.pathname, ...urls] });
      })
      .catch(() => {});
  }, []);
}

/** Which catalog a page drills: /words (vocabulary) or /alphabet (scripts). */
export type DrillConfig = {
  /** Public folder holding index.json and the list files. */
  base: string;
  title: string;
  intro: string;
  /** The "study all" title; defaults to `All <title>`. */
  allTitle?: string;
  /**
   * Where `reading` goes. Words put it on the hidden back (kana or pinyin is
   * part of the answer); alphabets keep it on the front as a hint.
   */
  readingOnBack?: boolean;
  /** Offer importing Anki decks (/words/import) and show the imported lists. */
  imports?: boolean;
};

export const WORDS: DrillConfig = {
  base: "/words",
  title: "Word lists",
  intro: "An endless list: grade each word with 1 / 2 / 3 / 4 — it is saved at once. Z undoes.",
  readingOnBack: true,
  imports: true,
};

/** `source` of a group row on this page: "group:words" / "group:alphabets". */
const groupSourceOf = (config: DrillConfig) => `group:${config.base.replace(/^\//, "")}`;

/** listId for "study all": every list of this page in one queue. */
const ALL = "all";

/**
 * The open list lives in the URL (?list=<id>, or ?list=all), so each list and
 * "study all" has its own address: bookmarkable, and a refresh stays put.
 * Other params (the app's ?lang=) are kept.
 *
 * The URL is the source of truth. This tab also remembers the list
 * (ui-store.ts, sessionStorage): opened with no ?list= — the nav menu, the
 * home screen icon — it reopens the list this tab had open, by replacing the
 * address (no extra history entry). Going back to the lists clears it.
 */
function useListParam(base: string): [string | null, (id: string | null) => void] {
  const ui = wordsUiStore(base);
  const read = () =>
    typeof location === "undefined" ? null : new URLSearchParams(location.search).get("list");
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let first = read();
    const kept = ui.getState().listId;
    if (first === null && kept) {
      const url = new URL(location.href);
      url.searchParams.set("list", kept);
      history.replaceState(history.state, "", url);
      first = kept;
    }
    ui.setState({ listId: first });
    setId(first);
    const onPop = () => {
      const now = read();
      ui.setState({ listId: now });
      setId(now);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [ui]);
  const go = useCallback(
    (next: string | null) => {
      const url = new URL(location.href);
      if (next) url.searchParams.set("list", next);
      else url.searchParams.delete("list");
      history.pushState(null, "", url);
      ui.setState({ listId: next });
      setId(next);
    },
    [ui],
  );
  return [id, go];
}

export default function WordsClient({
  config: given,
  voice = "off",
}: {
  config?: DrillConfig;
  /** Voice mode (docs/voice-mode.md): the flag's verdict for this user, from the server. */
  voice?: VoiceAccess;
}) {
  // /words's own title and intro follow the app's language; other drills
  // (/alphabet) bring theirs.
  const text = useIntlayer("words-page");
  const [wordsTitle, wordsIntro, wordsAll] = [
    text.title.value,
    text.intro.value,
    text.allTitle.value,
  ];
  const config = useMemo(
    () => given ?? { ...WORDS, title: wordsTitle, intro: wordsIntro, allTitle: wordsAll },
    [given, wordsTitle, wordsIntro, wordsAll],
  );
  const [allLists, setLists] = useState<WordList[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogMeta[] | null>(null);
  const [listId, setListId] = useListParam(config.base);
  const [error, setError] = useState<string | null>(null);
  /** The lists shown came from the offline copy. */
  const [offline, setOffline] = useState(false);
  useOfflineShell();

  const refreshLists = useCallback(async () => {
    // A rename still in the queue wins over the name the server sends back.
    const queued = () => idbAll<PendingOp>("pending").catch(() => [] as PendingOp[]);
    try {
      const { lists: fresh } = await api<{ lists: WordList[] }>("/api/words/lists");
      const lists = withPendingRenames(fresh, await queued());
      setLists(lists);
      setOffline(false);
      idbPut("lists", lists, "all").catch(() => {});
    } catch (e) {
      const cached =
        e instanceof OfflineError
          ? await idbGet<WordList[]>("lists", "all").catch(() => undefined)
          : undefined;
      if (cached) {
        setLists(withPendingRenames(cached, await queued()));
        setOffline(true);
      } else setError((e as Error).message);
    }
  }, []);

  /**
   * Rename: shown at once, kept in the offline copy, and sent through the
   * same `pending` queue as grades (POST /api/words/lists/:id/rename), so it
   * also goes out later when made offline.
   */
  const renameList = useCallback(async (id: string, name: string) => {
    const named = (all: WordList[]) => all.map((l) => (l.id === id ? { ...l, name } : l));
    setLists((all) => all && named(all));
    idbGet<WordList[]>("lists", "all")
      .then((cached) => cached && idbPut("lists", named(cached), "all"))
      .catch(() => {});
    await enqueue({
      listId: id,
      op: "rename",
      body: { name },
      term: "",
      at: new Date().toISOString(),
    });
  }, []);

  // Delete with Undo (lib/words/deferred-delete.ts): the row hides at once and
  // the DELETE goes out when the toast runs out, or when the page goes away.
  const [doomed, setDoomed] = useState<DoomedList | null>(null);
  const deleter = useMemo(
    () =>
      createDeferredDelete<DoomedList>({
        onChange: setDoomed,
        commit: async ({ list }, reason: FlushReason) => {
          if (reason === "leave") {
            void fetch(`/api/words/lists/${list.id}`, { method: "DELETE", keepalive: true });
            return;
          }
          // A failure (offline) leaves the list on the server: the refresh
          // shows it again rather than pretending it is gone.
          await api(`/api/words/lists/${list.id}`, { method: "DELETE" }).catch(() => {});
          await refreshLists();
        },
      }),
    [refreshLists],
  );
  useEffect(() => {
    const leave = () => deleter.flush("leave");
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      deleter.flush("leave");
    };
  }, [deleter]);

  useEffect(() => {
    refreshLists();
    loadCatalog<{ lists: CatalogMeta[] }>(`${config.base}/index.json`)
      .then((d) => setCatalog(d.lists ?? []))
      .catch(() => setCatalog([]));
  }, [refreshLists, config.base]);

  // Both pages share the word_lists table; each shows only lists from its own
  // catalog, so alphabets never appear among the vocabulary lists.
  const lists = useMemo(() => {
    if (!catalog) return null;
    const ids = new Set(catalog.map((c) => c.id));
    const group = groupSourceOf(config);
    // A list waiting to be deleted is already gone here; a group's lists move
    // up a level, as the server will do.
    const shown = allLists && withoutNode(allLists, doomed?.list.id ?? null);
    return (
      shown?.filter(
        (l) =>
          l.source &&
          (ids.has(l.source) || l.source === group || (config.imports && isImported(l))),
      ) ?? null
    );
  }, [allLists, catalog, config, doomed]);
  // The built-in catalogs plus this user's imported decks.
  const fullCatalog = useMemo(
    () => (catalog && lists ? [...catalog, ...importedCatalog(lists)] : null),
    [catalog, lists],
  );

  if (error)
    return (
      <div className="p-8 text-red-400">
        {error === "Login required" ? text.signInToUse : error}
      </div>
    );
  if (!lists || !catalog || !fullCatalog)
    return <div className="p-8 opacity-60">{text.loading}</div>;

  // A row studies itself and everything below it, in tree order; groups hold
  // no words of their own.
  const flat = flatten(lists);
  const scope =
    listId === ALL
      ? flat
      : flat.filter((x) => x.id === listId || descendants(flat, listId ?? "").includes(x.id));
  const studying = scope.filter((l) => l.source !== groupSourceOf(config));
  // "Study all" with only one list is just that list.
  // The Undo toast stays up when a list is opened meanwhile.
  const undoToast = doomed && (
    <UndoDeleteToast
      key={doomed.list.id}
      doomed={doomed}
      onUndo={() => {
        const back = deleter.undo();
        // Back to the restored row's ⋯ button, for keyboard users.
        if (back)
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>(`[data-list-menu="${back.list.id}"]`)?.focus(),
          );
      }}
    />
  );
  if (studying.length)
    return (
      <>
        {undoToast}
        <Study
          key={listId}
          config={config}
          lists={studying}
          catalog={fullCatalog}
          voice={voice}
          title={
            listId === ALL
              ? (config.allTitle ?? `All ${config.title.toLowerCase()}`)
              : (lists.find((l) => l.id === listId)?.name ?? studying[0].name)
          }
          onExit={() => {
            setListId(null);
            refreshLists();
          }}
        />
      </>
    );

  return (
    <>
      {undoToast}
      <ListPicker
        config={config}
        lists={lists}
        catalog={fullCatalog}
        offline={offline}
        onOpen={setListId}
        onRefresh={refreshLists}
        onDelete={(list, isGroup) => deleter.remove({ list, isGroup })}
        onRename={renameList}
        onReorder={async (order) => {
          // Show the new tree at once; the server confirms with its own.
          setLists((all) => {
            if (!all) return all;
            const pos = new Map(order.map((x, i) => [x.id, i]));
            const parent = new Map(order.map((x) => [x.id, x.parentId]));
            return [...all]
              .map((l) => (parent.has(l.id) ? { ...l, parentId: parent.get(l.id)! } : l))
              .sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
          });
          const { lists } = await api<{ lists: WordList[] }>("/api/words/lists", {
            method: "PATCH",
            body: JSON.stringify({ order }),
          });
          setLists(lists);
        }}
      />
    </>
  );
}

/** A list (or group) hidden from the picker while its delete can be undone. */
type DoomedList = { list: WordList; isGroup: boolean };

/**
 * "Deleted “…” · Undo", floating over the bottom of the page as glass. It is a
 * live region, so a screen reader hears it, and its Undo takes the focus: the
 * menu item that deleted the row is gone with it.
 */
function UndoDeleteToast({ doomed, onUndo }: { doomed: DoomedList; onUndo: () => void }) {
  const text = useIntlayer("words-page");
  const undo = useRef<HTMLButtonElement>(null);
  useEffect(() => undo.current?.focus({ preventScroll: true }), []);
  const said = fill(doomed.isGroup ? text.deletedGroup.value : text.deletedList.value, {
    name: doomed.list.name,
  });
  return (
    <div
      role="status"
      aria-live="polite"
      data-undo-delete={doomed.list.id}
      className="lk-glass fixed inset-x-4 z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-[var(--glass-line)] py-1 ps-4 pe-1 shadow-lg"
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
    >
      <span className="min-w-0 flex-1 text-sm">{said}</span>
      <button
        ref={undo}
        onClick={onUndo}
        className="min-h-11 min-w-11 shrink-0 rounded-lg px-3 font-medium text-[oklch(0.5_0.15_250)] hover:bg-[oklch(0.5_0_0/0.1)] dark:text-[oklch(0.78_0.12_250)]"
      >
        {text.undoDelete}
      </button>
      {/* Runs out with the delete: a visual cue only. */}
      <span
        aria-hidden
        className="lk-undo-timer pointer-events-none absolute inset-x-3 bottom-0 h-0.5 origin-left rounded-full bg-[oklch(0.5_0_0/0.35)] rtl:origin-right"
        style={{ animationDuration: `${UNDO_MS}ms` }}
      />
    </div>
  );
}

/** Cached due words for one list (IndexedDB `sessions`). */
type CachedSession = { listId: string; due: WordCard[]; fetchedAt: string };

async function cacheSessions(lists: Record<string, { due: WordCard[] }>) {
  const fetchedAt = new Date().toISOString();
  await Promise.all(
    Object.entries(lists).map(([listId, s]) =>
      idbPut("sessions", { listId, due: s.due, fetchedAt } satisfies CachedSession),
    ),
  );
}

/**
 * "Download for offline": every list's catalog, the lists themselves and each
 * list's due words go into IndexedDB, so the page works with no network.
 */
async function downloadForOffline(
  config: DrillConfig,
  lists: WordList[],
  catalog: CatalogMeta[],
  progress: (done: number, total: number) => void,
) {
  const studyable = lists.filter((l) => l.source !== groupSourceOf(config));
  const files = studyable
    .map((l) => catalog.find((c) => c.id === l.source))
    .filter((c): c is CatalogMeta => !!c)
    .map((c) => catalogPath(config.base, c));
  const total = files.length + 2;
  let done = 0;
  const step = () => progress(++done, total);
  await downloadCatalog(`${config.base}/index.json`);
  step();
  for (const f of files) {
    await downloadCatalog(f);
    step();
  }
  // D1 binds at most ~100 parameters: ask for the lists' due words in chunks.
  for (let i = 0; i < studyable.length; i += 80) {
    const ids = studyable.slice(i, i + 80).map((l) => l.id);
    const s = await api<{ lists: Record<string, { due: WordCard[] }> }>(
      `/api/words/session?lists=${encodeURIComponent(ids.join(","))}&day=${localDay()}&limit=1000`,
    );
    await cacheSessions(s.lists);
  }
  await idbPut("lists", lists, "all");
  step();
}

/** Indent per tree level, px. Dragging this far sideways nests or un-nests. */
const INDENT = 24;

/** Sums over a row and everything below it. */
type Totals = {
  due: number;
  learning: number;
  mastered: number;
  cards: number;
  total: number;
  /** Progress scores summed (lib/words/progress.ts). */
  progress: number;
};

/**
 * How far a list (a group: its whole subtree) has come, as a thin ring and a
 * percentage: the mean of its words' scores, each by how near its stability
 * is to a year (lib/words/progress.ts). Nothing while the list's size is unknown.
 */
function ProgressRing({ progress, total }: { progress: number; total: number }) {
  const text = useIntlayer("words-page");
  const { locale } = useLocale();
  const pct = progressPercent(progress, total);
  if (pct === null) return null;
  const label = fill(text.progressTitle.value, { pct, total });
  const shown = new Intl.NumberFormat(String(locale), { style: "percent" }).format(pct / 100);
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums"
      title={label}
      aria-label={label}
      role="img"
      data-progress={pct}
    >
      <ProgressRingSvg pct={pct} />
      <span className="min-w-[2.6em] text-end opacity-80">{shown}</span>
    </span>
  );
}

/** One row of the picker tree: a list or a group, draggable by its ⠿ handle. */
function SortableListRow({
  list: l,
  depth,
  index,
  totals,
  isGroup,
  hasChildren,
  collapsed,
  onToggle,
  onOpen,
  onDelete,
  onRename,
  keys,
  displayName,
  fresh,
}: {
  list: WordList;
  /** Just added from the "Add a list" tree: outlined while its toast is up. */
  fresh?: boolean;
  /** The name as shown: inside a language group, without the language prefix. */
  displayName: string;
  /** A hardware keyboard is in use: show the row's number key. */
  keys: boolean;
  depth: number;
  index: number;
  totals: Totals;
  isGroup: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  /** Set once an edit is saved or cancelled, so the blur after Enter/Escape is ignored. */
  const finished = useRef(false);
  const endEdit = (name: string | null) => {
    if (finished.current) return;
    finished.current = true;
    const next = name?.trim().slice(0, LIST_NAME_MAX);
    if (next && next !== l.name) onRename(next);
    setEditing(false);
    requestAnimationFrame(() => menuButton.current?.focus({ preventScroll: true }));
  };
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: l.id });
  const text = useIntlayer("words-page");
  return (
    <div
      ref={setNodeRef}
      // Rows move vertically; the sideways drag shows up as the indent instead.
      style={{
        transform: CSS.Translate.toString(transform && { ...transform, x: 0 }),
        transition,
        marginInlineStart: depth * INDENT,
      }}
      data-list-row={l.id}
      data-group={isGroup || undefined}
      data-fresh={fresh || undefined}
      className={`relative flex min-h-14 items-center rounded-lg ps-0.5 pe-1 ${
        fresh ? "ring-2 ring-[oklch(0.65_0.15_155)] " : ""
      }${
        isDragging
          ? "z-10 bg-[oklch(0.5_0_0/0.14)] ring-1 ring-[oklch(0.5_0_0/0.35)] shadow-lg"
          : isGroup
            ? "bg-[oklch(0.5_0_0/0.11)] dark:bg-[oklch(0.8_0_0/0.1)]"
            : "bg-[oklch(0.5_0_0/0.06)] dark:bg-[oklch(0.8_0_0/0.055)]"
      }`}
    >
      <span
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={text.dragToReorder.value}
        title={text.dragTitle.value}
        className="grid h-11 w-8 shrink-0 cursor-grab place-items-center select-none text-lg leading-none opacity-40 hover:opacity-100 active:cursor-grabbing touch-none"
      >
        ⠿
      </span>
      {hasChildren ? (
        <button
          type="button"
          className="grid h-11 w-9 shrink-0 place-items-center text-sm opacity-60 hover:opacity-100"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={fill(collapsed ? text.expandGroup.value : text.collapseGroup.value, {
            name: l.name,
          })}
        >
          <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
        </button>
      ) : (
        <span className="w-2 shrink-0" aria-hidden />
      )}
      {editing ? (
        <form
          className="flex-1 min-w-0 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            endEdit(new FormData(e.currentTarget).get("name") as string);
          }}
        >
          <input
            name="name"
            autoFocus
            defaultValue={l.name}
            maxLength={LIST_NAME_MAX}
            enterKeyHint="done"
            autoComplete="off"
            aria-label={fill(text.renameField.value, { name: l.name })}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              endEdit(null);
            }}
            onBlur={(e) => endEdit(e.currentTarget.value)}
            // 16px text: phones do not zoom into the field.
            className="w-full min-h-11 rounded-md px-2 text-base font-medium bg-[oklch(1_0_0/0.7)] dark:bg-[oklch(0.2_0_0/0.7)] ring-1 ring-[oklch(0.5_0_0/0.35)] focus:outline-none focus:ring-2 focus:ring-[oklch(0.6_0.15_250)]"
          />
        </form>
      ) : (
        // The whole row studies the list (a group: everything in it); only
        // the ⠿ handle, the fold arrow and the ⋯ menu do something else.
        <button
          type="button"
          data-open-list={l.id}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-2 self-stretch rounded-md py-2 ps-1 text-start focus-visible:outline-2 focus-visible:outline-[oklch(0.6_0.15_250)]"
          onClick={() => onOpen(l.id)}
          title={
            (isGroup ? `${text.groupRowHint.value}\n` : "") +
            fill(text.rowStats.value, {
              due: totals.due,
              learning: totals.learning,
              mastered: totals.mastered,
              seen: totals.cards,
              total: totals.total || "?",
            })
          }
        >
          {keys && index < 9 && (
            <kbd className="shrink-0 text-xs opacity-40 tabular-nums">{index + 1}</kbd>
          )}
          <span className="min-w-0 flex-1">
            {/* The full name, wrapped, never cut: "JLPT N3" and "JLPT N2" must read apart. */}
            <span
              className={`block leading-snug [overflow-wrap:anywhere] ${isGroup ? "font-semibold" : "font-medium"}`}
            >
              {isGroup && <Icon name="folder" className="me-1 opacity-70" />}
              {displayName}
            </span>
            <span className="mt-0.5 block truncate text-xs opacity-60 tabular-nums">
              {fill(text.rowStatsShort.value, { due: totals.due, learning: totals.learning })}
            </span>
          </span>
          {/* A fixed column, so the rings line up down the list. */}
          <span className="flex w-[4.25rem] shrink-0 justify-end">
            <ProgressRing progress={totals.progress} total={totals.total} />
          </span>
        </button>
      )}
      <ListRowMenu
        listId={l.id}
        name={l.name}
        buttonRef={menuButton}
        onRename={() => {
          finished.current = false;
          setEditing(true);
        }}
        onDelete={onDelete}
      />
    </div>
  );
}

/** A list's name, as long as the server takes it (POST /api/words/lists, /rename). */
const LIST_NAME_MAX = 120;

/**
 * The "⋯" button at the end of a list row and its menu: Rename, Delete. A
 * menu button in the ARIA pattern: ↓/Enter/Space open it on the first item,
 * ↑↓ Home End move, Escape closes back to the button, Tab closes. Every
 * target is 44px. It sits apart from the ⠿ drag handle, which alone starts a
 * drag, so a tap here never moves the row.
 */
function ListRowMenu({
  listId,
  name,
  buttonRef,
  onRename,
  onDelete,
}: {
  listId: string;
  name: string;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onRename: () => void;
  onDelete: () => void;
}) {
  const text = useIntlayer("words-page");
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus({ preventScroll: true });
    // A tap anywhere else closes it (and does what it tapped).
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open, buttonRef]);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  };
  const pick = (act: () => void) => () => {
    setOpen(false);
    act();
  };
  const label = fill(text.listMenu.value, { name });
  return (
    <div className={`relative shrink-0 ${open ? "z-30" : ""}`}>
      <button
        ref={buttonRef}
        type="button"
        data-list-menu={listId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="grid h-11 w-11 place-items-center rounded-full text-xl leading-none opacity-60 hover:opacity-100 hover:bg-[oklch(0.5_0_0/0.12)] aria-expanded:opacity-100 aria-expanded:bg-[oklch(0.5_0_0/0.15)]"
      >
        <span aria-hidden>⋯</span>
      </button>
      {open && (
        <div
          id={menuId}
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const all = items();
            const i = all.indexOf(document.activeElement as HTMLElement);
            const go = (n: number) => {
              e.preventDefault();
              all[(n + all.length) % all.length]?.focus();
            };
            if (e.key === "ArrowDown") go(i + 1);
            else if (e.key === "ArrowUp") go(i - 1);
            else if (e.key === "Home") go(0);
            else if (e.key === "End") go(all.length - 1);
            else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "Tab") setOpen(false);
          }}
          className="lk-glass absolute end-0 top-full z-30 mt-1 min-w-44 rounded-xl border border-[var(--glass-line)] p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={pick(onRename)}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-start text-sm hover:bg-[oklch(0.5_0_0/0.12)] focus:bg-[oklch(0.5_0_0/0.12)] focus:outline-none"
          >
            <Icon name="pencilSimple" className="opacity-70" />
            {text.renameList}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={pick(onDelete)}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-start text-sm text-[oklch(0.52_0.19_25)] dark:text-[oklch(0.75_0.15_25)] hover:bg-[oklch(0.6_0.19_25/0.12)] focus:bg-[oklch(0.6_0.19_25/0.12)] focus:outline-none"
          >
            <Icon name="trash" />
            {text.deleteList}
          </button>
        </div>
      )}
    </div>
  );
}

function ListPicker({
  config,
  lists,
  catalog,
  offline,
  onOpen,
  onRefresh,
  onDelete,
  onRename,
  onReorder,
}: {
  config: DrillConfig;
  lists: WordList[];
  catalog: CatalogMeta[];
  /** Showing the offline copy of the lists. */
  offline: boolean;
  onOpen: (id: string) => void;
  /** Reload the lists from the server. */
  onRefresh: () => Promise<void>;
  /** Delete a row, with Undo (the toast is the parent's). */
  onDelete: (list: WordList, isGroup: boolean) => void;
  onRename: (id: string, name: string) => void;
  /** The whole tree in display order; also the order new words are learned in. */
  onReorder: (order: { id: string; parentId: string | null }[]) => void;
}) {
  const groupSource = groupSourceOf(config);
  const isGroup = (l: WordList) => l.source === groupSource;
  const text = useIntlayer("words-page");
  const phraseText = useIntlayer("words-phrases");
  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const isPhrase = (l: WordList) => isPhraseMeta(catalogById.get(l.source ?? ""));
  const scenarioName = (s: Scenario) => phraseText[scenarioKey(s)].value;
  // Number keys open lists: show them only with a hardware keyboard.
  const keys = useInputModality() === "keyboard";
  const flat = useMemo(() => flatten(lists), [lists]);
  const byId = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const [download, setDownload] = useState<{
    done: number;
    total: number;
    error?: string;
  } | null>(null);

  // Folded groups, per tab (docs/ui-state.md: session `lk:ui:words`).
  const ui = wordsUiStore(config.base);
  useEffect(() => migrateCollapsed(ui, config.base), [ui, config.base]);
  const folded = useUi(ui, (s) => s.collapsed);
  const collapsed = useMemo(() => new Set(folded), [folded]);
  const toggle = (id: string) => toggleCollapsed(ui, id);

  // Drag: up/down reorders, the sideways offset picks the depth (nest under
  // the row above, or come out a level). The dragged row's subtree moves with
  // it, so it is hidden during the drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const items = useMemo(() => {
    const hide = new Set(collapsed);
    if (activeId) hide.add(activeId);
    return visible(flat, hide);
  }, [flat, collapsed, activeId]);
  const projected =
    activeId && overId ? projectDrop(items, activeId, overId, offsetX, INDENT) : null;
  const resetDrag = () => {
    setActiveId(null);
    setOverId(null);
    setOffsetX(0);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && projected) {
      const order = applyDrop(flat, items, String(active.id), String(over.id), projected.parentId);
      const before = flat.map((x) => `${x.id}>${x.parentId}`).join();
      if (order.map((x) => `${x.id}>${x.parentId}`).join() !== before) onReorder(order);
    }
    resetDrag();
  };

  const totals = useMemo(() => {
    const own = (l: WordList): Totals => ({
      due: l.due,
      learning: l.learning,
      mastered: l.mastered,
      progress: l.progress ?? 0,
      cards: l.cards,
      total: catalog.find((c) => c.id === l.source)?.count ?? 0,
    });
    const m = new Map<string, Totals>();
    for (const row of flat) {
      const sum = own(row);
      for (const id of descendants(flat, row.id)) {
        const d = own(flat.find((x) => x.id === id)!);
        sum.due += d.due;
        sum.learning += d.learning;
        sum.mastered += d.mastered;
        sum.progress += d.progress;
        sum.cards += d.cards;
        sum.total += d.total;
      }
      m.set(row.id, sum);
    }
    return m;
  }, [flat, catalog]);

  const [busy, setBusy] = useState(false);
  // Imported decks are already lists; only the built-in catalogs can be added.
  const builtIn = useMemo(() => catalog.filter((c) => !c.path), [catalog]);
  const added = new Set(lists.flatMap((l) => (l.source ? [l.source] : [])));
  const studyable = lists.filter((l) => !isGroup(l));

  // 1–9 open the matching row, 0 studies everything — no mouse needed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      // Keys inside a row's ⋯ menu or the Undo toast are theirs.
      if (t.closest?.('[role="menu"], [role="dialog"], [data-undo-delete], [data-added-toast]'))
        return;
      const n = Number(e.key);
      if (e.key === "0" && studyable.length > 1) onOpen(ALL);
      else if (n >= 1 && n <= 9 && items[n - 1]) onOpen(items[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, studyable.length, onOpen]);

  // "Add a list" as a tree with checkboxes (lib/words/add-tree.ts): tick
  // lists, languages or whole branches, then add them all in one go. Adding
  // never starts studying: the learner stays here and opens a list himself.
  const addTree = useMemo(() => buildAddTree(builtIn, SCENARIOS, EXTERNAL_SEARCHES), [builtIn]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [openKeys, setOpenKeys] = useState<Set<string>>(
    () =>
      loadAddOpen(config.base) ??
      defaultOpen(
        addTree,
        studyable.map((l) => l.lang),
        typeof navigator === "undefined" ? [] : [...(navigator.languages ?? [])],
      ),
  );
  // Folding a node hides its whole branch; unfolding it shows its branches as
  // they were (the first time, all of them open). Kept per device.
  const toggleOpen = (node: AddNode) =>
    setOpenKeys((s) => {
      const n = toggleOpenKey(node, s);
      saveAddOpen(config.base, n);
      return n;
    });
  const [addedNow, setAddedNow] = useState<AddedNow | null>(null);
  const fresh = useMemo(() => new Set(addedNow?.ids ?? []), [addedNow]);
  /** A built-in list's name in the toast: a phrase deck by its scenario. */
  const addName = (c: CatalogMeta) =>
    isPhraseMeta(c) && c.scenario ? scenarioName(c.scenario) : c.name;

  // A list's (or a band's) preview before adding it (ListPreview.tsx): its
  // entries load only once it opens. Focus goes back to its eye on close.
  const [preview, setPreview] = useState<{ title: string; lists: CatalogMeta[] } | null>(null);
  const previewFrom = useRef<HTMLElement | null>(null);
  const openPreview = (lists: CatalogMeta[], title: string, from: HTMLElement) => {
    previewFrom.current = from;
    setPreview({ title, lists });
  };
  const previewSources = useMemo(
    () =>
      (preview?.lists ?? []).map((c) => ({
        id: c.id,
        count: c.count,
        path: catalogPath(config.base, c),
      })),
    [preview, config.base],
  );
  const fetchPreview = useCallback(
    (path: string) => loadCatalog<{ entries: Entry[] }>(path).then((d) => d.entries),
    [],
  );

  // "Arrange by language" (lib/words/arrange.ts): every list he has into
  // language → kind → lists in learning order, with Undo while it shows.
  const { locale } = useLocale();
  const [arrangedNow, setArrangedNow] = useState<{
    before: { id: string; parentId: string | null }[];
    made: string[];
    at: number;
  } | null>(null);
  const arrange = async () => {
    const index = new Map(catalog.map((c, i) => [c.id, i]));
    const labels = {
      freq: text.freqLists.value,
      phrase: phraseText.phrases.value,
      exam: text.examLists.value,
    };
    const plan = planArrange(lists, {
      isGroup,
      metaOf: (l) => catalogById.get(l.source ?? ""),
      catalogIndex: (l) => index.get(l.source ?? "") ?? catalog.length,
      kindLabels: labels,
    });
    const before = flat.map((r) => ({ id: r.id, parentId: r.parentId }));
    const ids = new Map<string, string>();
    setBusy(true);
    try {
      for (const g of plan.make) {
        const { list } = await api<{ list: WordList }>("/api/words/lists", {
          method: "POST",
          body: JSON.stringify({
            name: g.kind ? labels[g.kind] : langName(g.lang, locale),
            lang: g.lang,
            source: groupSource,
          }),
        });
        ids.set(g.key, list.id);
      }
      const order = plan.order(ids);
      await api("/api/words/lists", { method: "PATCH", body: JSON.stringify({ order }) });
      setArrangedNow({ before, made: [...ids.values()], at: Date.now() });
    } finally {
      await onRefresh().catch(() => {});
      setBusy(false);
    }
  };
  const undoArrange = async (a: NonNullable<typeof arrangedNow>) => {
    setArrangedNow(null);
    setBusy(true);
    try {
      await api("/api/words/lists", { method: "PATCH", body: JSON.stringify({ order: a.before }) });
      // The groups it made are empty again now.
      for (const id of a.made) await api(`/api/words/lists/${id}`, { method: "DELETE" });
    } finally {
      await onRefresh().catch(() => {});
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!arrangedNow) return;
    const t = setTimeout(() => setArrangedNow(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [arrangedNow]);

  /** Add these built-in lists in one go (Add selected, or a language's Add all). */
  const addLists = async (all: CatalogMeta[]) => {
    const picks = all.filter((c) => !added.has(c.id));
    if (!picks.length) return;
    setBusy(true);
    let nodes = lists;
    const done: AddedNow = { ids: [], names: [], made: [], at: Date.now() };
    try {
      for (const c of picks) {
        const { list } = await api<{ list: WordList }>("/api/words/lists", {
          method: "POST",
          body: JSON.stringify({ name: c.name, lang: c.lang, source: c.id }),
        });
        done.ids.push(list.id);
        done.names.push(addName(c));
        nodes = [...nodes, list];
        // A phrase deck is still added if placing it fails; it shows at the top level.
        if (isPhraseMeta(c)) {
          const placed = await placePhrase(list, nodes).catch(() => null);
          if (placed) {
            nodes = placed.nodes;
            if (placed.group) done.made.push(placed.group);
          }
        }
      }
    } catch (e) {
      done.error = (e as Error).message;
    }
    setTicked((t) => new Set([...t].filter((id) => !picks.some((c) => c.id === id))));
    await onRefresh().catch(() => {});
    setBusy(false);
    setAddedNow(done);
  };

  const undoAdd = async (a: AddedNow) => {
    setAddedNow(null);
    setBusy(true);
    try {
      // The lists first, then any Phrases group made for them (empty by then).
      for (const id of [...a.ids, ...a.made])
        await api(`/api/words/lists/${id}`, { method: "DELETE" }).catch(() => {});
      await onRefresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  // The toast runs out on its own; the new rows lose their outline with it.
  useEffect(() => {
    if (!addedNow) return;
    const t = setTimeout(() => setAddedNow(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [addedNow]);
  // Bring the first new row into view (it may sit inside a folded group).
  useEffect(() => {
    const id = addedNow?.ids[0];
    if (!id) return;
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-list-row="${id}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: motionOff() ? "auto" : "smooth" }),
    );
  }, [addedNow]);

  /**
   * Put a newly added phrase deck where it belongs: language → Phrases →
   * scenario. The language's Phrases group is made when it has none, inside
   * the language's own group when there is one (lib/words/phrases.ts).
   * `nodes` is the tree so far, the new list included; the tree after is returned.
   */
  const placePhrase = async (list: WordList, before: WordList[]) => {
    let nodes = before;
    const label = phraseText.phrases.value;
    const home = phraseHome(flatten(nodes), list.lang, isGroup, isPhrase, label);
    let phrasesGroup = home.phrasesGroup;
    let group: string | undefined;
    if (!phrasesGroup) {
      const { list: g } = await api<{ list: WordList }>("/api/words/lists", {
        method: "POST",
        body: JSON.stringify({ name: label, lang: list.lang, source: groupSource }),
      });
      phrasesGroup = group = g.id;
      nodes = applyOrder([...nodes, g], moveUnder(flatten([...nodes, g]), g.id, home.langGroup));
    }
    const order = moveUnder(flatten(nodes), list.id, phrasesGroup);
    await api("/api/words/lists", { method: "PATCH", body: JSON.stringify({ order }) });
    return { nodes: applyOrder(nodes, order), group };
  };

  /** A row's name: phrase decks name their scenario in the UI's language. */
  const rowName = (row: WordList) => {
    const parent = row.parentId ? byId.get(row.parentId) : null;
    const meta = catalogById.get(row.source ?? "");
    if (isPhraseMeta(meta) && meta?.scenario) {
      const holds =
        !!parent &&
        isGroup(parent) &&
        lists.filter((x) => x.parentId === parent.id).every((x) => isPhrase(x));
      const named = phraseRowName(row, meta.name, parent, holds, {
        phrases: phraseText.phrases.value,
        scenario: scenarioName(meta.scenario),
      });
      if (named) return named;
    }
    return shownName(row, parent);
  };

  const addGroup = async () => {
    const name = prompt(text.groupName.value)?.trim();
    if (!name) return;
    await api("/api/words/lists", {
      method: "POST",
      body: JSON.stringify({ name, lang: "mul", source: groupSource }),
    });
    onRefresh();
  };

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{config.title}</h1>
        <p className="opacity-70 text-sm mt-1">{config.intro}</p>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
          {offline ? (
            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">
              {text.offlineBanner}
            </span>
          ) : (
            <button
              disabled={!!download && download.done < download.total}
              onClick={async () => {
                setDownload({ done: 0, total: 1 });
                try {
                  await downloadForOffline(config, lists, catalog, (done, total) =>
                    setDownload({ done, total }),
                  );
                } catch (e) {
                  setDownload({ done: 0, total: 0, error: (e as Error).message });
                }
              }}
              className="px-3 py-1.5 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20 disabled:opacity-50"
              title={text.downloadTitle.value}
            >
              <Icon name="downloadSimple" className="me-1" />
              {text.downloadForOffline}
            </button>
          )}
          {download && !offline && (
            <span className="opacity-70 tabular-nums">
              {download.error
                ? fill(text.downloadFailed.value, { error: download.error })
                : download.done < download.total
                  ? fill(text.downloading.value, { done: download.done, total: download.total })
                  : text.savedOnDevice}
            </span>
          )}
        </div>
      </div>

      {studyable.length > 1 && (
        <button
          onClick={() => onOpen(ALL)}
          className="w-full flex items-center gap-3 rounded-lg bg-emerald-500/20 dark:bg-emerald-700/40 hover:bg-emerald-500/30 dark:hover:bg-emerald-700/60 px-4 py-3 text-left"
        >
          {keys && <kbd className="text-xs opacity-50">0</kbd>}
          <span className="flex-1">
            <span className="font-medium">{text.studyAll}</span>
            <span className="block text-xs opacity-60">{text.studyAllHint}</span>
          </span>
          <span className="text-xs opacity-70 tabular-nums">
            {fill(text.dueCount.value, { n: studyable.reduce((n, l) => n + l.due, 0) })}
          </span>
        </button>
      )}
      {lists.length > 0 && (
        <div className="space-y-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={({ active }) => {
              setActiveId(String(active.id));
              setOverId(String(active.id));
            }}
            onDragMove={({ delta }) => setOffsetX(delta.x)}
            onDragOver={({ over }) => setOverId(over ? String(over.id) : null)}
            onDragEnd={onDragEnd}
            onDragCancel={resetDrag}
          >
            <SortableContext items={items.map((x) => x.id)} strategy={verticalListSortingStrategy}>
              {items.map((row, i) => (
                <SortableListRow
                  key={row.id}
                  list={row}
                  depth={row.id === activeId && projected ? projected.depth : row.depth}
                  index={i}
                  totals={totals.get(row.id)!}
                  isGroup={isGroup(row)}
                  hasChildren={descendants(flat, row.id).length > 0}
                  collapsed={collapsed.has(row.id)}
                  onToggle={() => toggle(row.id)}
                  onOpen={onOpen}
                  onDelete={() => onDelete(row, isGroup(row))}
                  onRename={(name) => onRename(row.id, name)}
                  keys={keys}
                  displayName={rowName(row)}
                  fresh={fresh.has(row.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
          <p className="fs-11 opacity-40">{text.reorderHelp}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={addGroup}
          className="text-sm px-3 py-1.5 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
        >
          {text.newGroup}
        </button>
        {studyable.length > 1 &&
          (arrangedNow ? (
            <span className="flex items-center gap-2 text-sm" data-arranged>
              <span className="opacity-70">{text.arranged}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => undoArrange(arrangedNow)}
                data-undo-arrange
                className="min-h-11 rounded-lg px-3 font-medium text-[oklch(0.5_0.14_155)] hover:bg-[oklch(0.5_0_0/0.1)] disabled:opacity-40 dark:text-[oklch(0.78_0.13_155)]"
              >
                {text.undoArrange}
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={arrange}
              data-arrange-lists
              className="text-sm px-3 py-1.5 rounded bg-[oklch(0.5_0_0/0.12)] hover:bg-[oklch(0.5_0_0/0.2)] disabled:opacity-40"
            >
              {text.arrangeLists}
            </button>
          ))}
        {config.imports && <ImportLink />}
      </div>

      <div className="space-y-2" data-add-tree>
        <h2 className="text-sm font-medium opacity-80">{text.addList}</h2>
        <div role="tree" aria-multiselectable className="-mx-2">
          {addTree.map((n) => (
            <AddTreeNode
              key={n.key}
              node={n}
              depth={0}
              ticked={ticked}
              added={added}
              openKeys={openKeys}
              busy={busy}
              onTick={(node) => setTicked((t) => toggleTick(node, t, added))}
              onToggleOpen={toggleOpen}
              onAdd={addLists}
              onPreview={openPreview}
              scenarioName={scenarioName}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            disabled={busy || ![...ticked].some((id) => !added.has(id))}
            onClick={() => addLists(tickedInOrder(addTree, ticked))}
            data-add-selected
            className="min-h-11 rounded-lg bg-[oklch(0.55_0.14_155)] px-4 text-sm font-medium text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.14_155)] disabled:opacity-40"
          >
            {text.addSelected}
          </button>
        </div>
        {[
          ...new Set(
            builtIn
              .filter((c) => ticked.has(c.id) || openKeys.has(`lang:${c.lang}`))
              .map((c) => `${c.source} — ${c.license}`),
          ),
        ].map((credit) => (
          <p key={credit} className="fs-11 opacity-40">
            {credit}
          </p>
        ))}
      </div>
      {preview && (
        <ListPreview
          title={preview.title}
          lang={preview.lists[0]?.lang ?? ""}
          sources={previewSources}
          fetchEntries={fetchPreview}
          allAdded={preview.lists.every((c) => added.has(c.id))}
          busy={busy}
          onAdd={() => {
            const lists = preview.lists;
            setPreview(null);
            void addLists(lists);
          }}
          onClose={() => setPreview(null)}
          returnTo={previewFrom}
        />
      )}
      {addedNow && (
        <AddedToast
          key={addedNow.at}
          added={addedNow}
          onStart={
            addedNow.ids.length === 1 && !addedNow.error
              ? () => {
                  setAddedNow(null);
                  onOpen(addedNow.ids[0]);
                }
              : undefined
          }
          onUndo={addedNow.ids.length ? () => undoAdd(addedNow) : undefined}
        />
      )}
    </div>
  );
}

/** What one "Add selected" did: the new lists, any group made for them, a failure. */
type AddedNow = { ids: string[]; names: string[]; made: string[]; error?: string; at: number };

/**
 * One node of the "Add a list" tree: the whole row ticks it (a language or a
 * branch ticks everything under it), the arrow folds it. Flat: depth is shown
 * by indentation and type weight, with no box per level.
 */
function AddTreeNode({
  node,
  depth,
  ticked,
  added,
  openKeys,
  busy,
  onTick,
  onToggleOpen,
  onAdd,
  onPreview,
  scenarioName,
}: {
  node: AddNode<CatalogMeta>;
  depth: number;
  ticked: ReadonlySet<string>;
  added: ReadonlySet<string>;
  openKeys: ReadonlySet<string>;
  busy: boolean;
  onTick: (node: AddNode<CatalogMeta>) => void;
  onToggleOpen: (node: AddNode<CatalogMeta>) => void;
  /** One tap adds these lists: a language's "Add all", a coverage band. */
  onAdd: (lists: CatalogMeta[]) => void;
  /** The eye on a list's row or a band: preview its entries before adding. */
  onPreview: (lists: CatalogMeta[], title: string, from: HTMLElement) => void;
  scenarioName: (s: Scenario) => string;
}) {
  const text = useIntlayer("words-page");
  const phraseText = useIntlayer("words-phrases");
  const { locale } = useLocale();
  const box = useRef<HTMLInputElement>(null);
  const state = tickState(node, ticked, added);
  useEffect(() => {
    if (box.current) box.current.indeterminate = state.mixed;
  }, [state.mixed]);
  if (node.kind === "external")
    return (
      <ExternalNode
        node={node}
        depth={depth}
        open={openKeys.has(node.key)}
        onToggleOpen={() => onToggleOpen(node)}
      />
    );
  // A branch with nothing to add (only exams we cannot ship) has no checkbox.
  const tickable = leavesOf(node).length > 0;
  const label =
    node.kind === "lang"
      ? langName(node.lang, locale)
      : node.kind === "family"
        ? node.family === "freq"
          ? text.freqLists.value
          : node.family === "exam"
            ? text.examLists.value
            : phraseText.phrases.value
        : node.kind === "exam"
          ? node.exam
          : node.meta.scenario
            ? scenarioName(node.meta.scenario as Scenario)
            : // the language is the row above: "Japanese · JLPT N5" → "JLPT N5"
              node.meta.name.replace(/^[^·]*·\s*/, "");
  const open = node.kind !== "list" && openKeys.has(node.key);
  const weight =
    node.kind === "lang" ? "font-semibold" : node.kind === "list" ? "" : "font-medium opacity-80";
  return (
    <div
      role="treeitem"
      aria-expanded={node.kind === "list" ? undefined : open}
      aria-selected={state.checked}
    >
      <div
        className="flex min-h-11 items-center rounded-lg pe-2 hover:bg-[oklch(0.5_0_0/0.07)]"
        style={{ paddingInlineStart: `calc(${depth} * 1.25rem)` }}
        data-add-node={node.key}
      >
        {node.kind === "list" ? (
          <span className="w-9 shrink-0" aria-hidden />
        ) : (
          <button
            type="button"
            onClick={() => onToggleOpen(node)}
            aria-label={fill((open ? text.collapseGroup : text.expandGroup).value, { name: label })}
            className="grid h-11 w-9 shrink-0 place-items-center text-sm opacity-60 hover:opacity-100"
          >
            <span
              className={`inline-block transition-transform ${open ? "rotate-90" : "rtl:rotate-180"}`}
            >
              ▸
            </span>
          </button>
        )}
        {/* The whole row is the checkbox's label: tapping anywhere on it ticks it. */}
        <label
          className={`flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm ${weight} ${state.disabled ? "cursor-default" : ""}`}
        >
          {tickable ? (
            <input
              ref={box}
              type="checkbox"
              checked={state.checked}
              disabled={state.disabled || busy}
              onChange={() => onTick(node)}
              className="size-4 shrink-0 accent-[oklch(0.55_0.14_155)]"
            />
          ) : (
            <span className="size-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {node.kind === "list" &&
            (added.has(node.meta.id) ? (
              <span className="fs-11 opacity-50">{text.added}</span>
            ) : (
              <span className="fs-11 tabular-nums opacity-40">{node.meta.count}</span>
            ))}
        </label>
        {/* The eye sits outside the label: it previews, the rest of the row ticks. */}
        {node.kind === "list" && (
          <PreviewButton
            name={label}
            onOpen={(from) =>
              onPreview([node.meta], `${langName(node.meta.lang, locale)} · ${label}`, from)
            }
          />
        )}
        {/* Folded, a language is only its row: no Add all, no bands, no children. */}
        {node.kind === "lang" && open && !state.disabled && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAdd(leavesOf(node))}
            data-add-all={node.lang}
            className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-[oklch(0.5_0.14_155)] hover:bg-[oklch(0.5_0_0/0.1)] disabled:opacity-40 dark:text-[oklch(0.78_0.13_155)]"
          >
            {text.addAll}
          </button>
        )}
      </div>
      {/* A language's one-tap coverage bands are part of its branch: they fold with it. */}
      {node.kind === "lang" && open && (
        <CoverageBands
          lists={freqListsOf(node)}
          added={added}
          busy={busy}
          depth={depth + 1}
          onAdd={onAdd}
          onPreview={onPreview}
        />
      )}
      {open && (
        <div role="group">
          {node.children.map((c) => (
            <AddTreeNode
              key={c.key}
              node={c}
              depth={depth + 1}
              ticked={ticked}
              added={added}
              openKeys={openKeys}
              busy={busy}
              onTick={onTick}
              onToggleOpen={onToggleOpen}
              onAdd={onAdd}
              onPreview={onPreview}
              scenarioName={scenarioName}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An exam we cannot ship (docs/word-deck-sources.md, "Not shipped"): its name
 * and a muted "not included"; unfolded, search links only (never a link to a
 * specific deck or file) and a pointer to the Anki import, so the flow is
 * search → download → import. No checkbox: there is nothing to add.
 */
function ExternalNode({
  node,
  depth,
  open,
  onToggleOpen,
}: {
  node: { key: string; search: ExternalSearch };
  depth: number;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const text = useIntlayer("words-page");
  const label = node.search.level ?? node.search.exam;
  const links = searchLinks(node.search);
  const link = "underline decoration-[oklch(0.5_0_0/0.4)] underline-offset-2 hover:opacity-100";
  return (
    <div role="treeitem" aria-expanded={open} data-add-external={node.search.id}>
      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={fill((open ? text.collapseGroup : text.expandGroup).value, { name: label })}
        className="flex min-h-11 w-full items-center gap-3 rounded-lg pe-2 text-start text-sm hover:bg-[oklch(0.5_0_0/0.07)]"
        style={{ paddingInlineStart: `calc(${depth} * 1.25rem)` }}
      >
        <span className="grid h-11 w-9 shrink-0 place-items-center opacity-60" aria-hidden>
          <span
            className={`inline-block transition-transform ${open ? "rotate-90" : "rtl:rotate-180"}`}
          >
            ▸
          </span>
        </span>
        <span className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate opacity-70">{label}</span>
        <span className="fs-11 ms-auto shrink-0 opacity-50">{text.notIncluded}</span>
      </button>
      {open && (
        <div
          role="group"
          className="space-y-1 pb-2 text-sm"
          style={{ paddingInlineStart: `calc(${depth} * 1.25rem + 4.75rem)` }}
        >
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="opacity-60">{text.searchOn}</span>
            {links.map((l) => (
              <a
                key={l.engine}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                data-search-engine={l.engine}
                className={`${link} opacity-80`}
              >
                {l.name}
              </a>
            ))}
          </p>
          <p>
            <a href="/words/import" className={`${link} opacity-80`}>
              {text.importFound}
            </a>
          </p>
          <p className="fs-11 opacity-50">{text.externalNote}</p>
        </div>
      )}
    </div>
  );
}

/**
 * One-tap bands over a language's most common words, by how much of running
 * text they cover (lib/words/add-tree.ts coverageBands): "Covers 75% of text ·
 * top 1–500". A band adds its frequency lists that are not added yet.
 */
function CoverageBands({
  lists,
  added,
  busy,
  depth,
  onAdd,
  onPreview,
}: {
  lists: CatalogMeta[];
  added: ReadonlySet<string>;
  busy: boolean;
  depth: number;
  onAdd: (lists: CatalogMeta[]) => void;
  /** A band's preview: the union of its lists. */
  onPreview: (lists: CatalogMeta[], title: string, from: HTMLElement) => void;
}) {
  const text = useIntlayer("words-page");
  const previewText = useIntlayer("words-list-preview");
  const { locale } = useLocale();
  const bands = coverageBands(lists);
  if (!bands.length) return null;
  return (
    <div
      className="flex flex-wrap gap-x-1"
      style={{ paddingInlineStart: `calc(${depth} * 1.25rem + 2.25rem)` }}
      data-coverage-bands
    >
      {bands.map((b) => {
        const done = b.ids.every((id) => added.has(id));
        const pct = Math.floor(b.coverage * 100);
        const of = lists.filter((c) => b.ids.includes(c.id));
        return (
          <span key={b.top} className="inline-flex items-center">
            <button
              type="button"
              disabled={busy || done}
              onClick={() => onAdd(of)}
              data-band={b.top}
              className="min-h-11 rounded-lg px-2 text-start text-sm text-[oklch(0.5_0.14_155)] hover:bg-[oklch(0.5_0_0/0.1)] disabled:opacity-40 dark:text-[oklch(0.78_0.13_155)]"
            >
              {fill(text.coverageBand.value, { pct })}
              <span className="ms-1.5 fs-11 tabular-nums opacity-60">
                {done ? text.added : fill(text.coverageRanks.value, { top: b.top })}
              </span>
            </button>
            <PreviewButton
              name={fill(text.coverageBand.value, { pct }).replace(/^\+\s*/, "")}
              onOpen={(from) =>
                onPreview(
                  of,
                  fill(previewText.bandTitle.value, {
                    lang: langName(of[0]?.lang ?? "", locale),
                    pct,
                  }),
                  from,
                )
              }
            />
          </span>
        );
      })}
    </div>
  );
}

/** A language's name in the UI's language ("ja" → "Japanese" / "日语"). */
function langName(code: string, locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * "Added: JLPT N5 and JLPT N4", as glass over the bottom of the page: one
 * layer, with Start studying (one list added) and Undo. It runs out with the
 * new rows' outline (UNDO_MS).
 */
function AddedToast({
  added,
  onStart,
  onUndo,
}: {
  added: AddedNow;
  onStart?: () => void;
  onUndo?: () => void;
}) {
  const text = useIntlayer("words-page");
  const { locale } = useLocale();
  let names = added.names.join(", ");
  try {
    names = new Intl.ListFormat([locale], { type: "conjunction" }).format(added.names);
  } catch {}
  const said = added.error
    ? fill(text.addFailed.value, { error: added.error })
    : fill(text.addedToast.value, { names });
  const action =
    "min-h-11 min-w-11 shrink-0 rounded-lg px-3 font-medium text-[oklch(0.5_0.15_250)] hover:bg-[oklch(0.5_0_0/0.1)] dark:text-[oklch(0.78_0.12_250)]";
  return (
    <div
      role="status"
      aria-live="polite"
      data-added-toast
      className="lk-glass fixed inset-x-4 z-50 mx-auto flex max-w-md items-center gap-1 rounded-xl border border-[var(--glass-line)] py-1 ps-4 pe-1 shadow-lg"
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
    >
      <span className="line-clamp-2 min-w-0 flex-1 text-sm">{said}</span>
      {onStart && (
        <button onClick={onStart} className={action} data-added-start>
          {text.startStudying}
        </button>
      )}
      {onUndo && (
        <button onClick={onUndo} className={action} data-added-undo>
          {text.undoAdd}
        </button>
      )}
      <span
        aria-hidden
        className="lk-undo-timer pointer-events-none absolute inset-x-3 bottom-0 h-0.5 origin-left rounded-full bg-[oklch(0.5_0_0/0.35)] rtl:origin-right"
        style={{ animationDuration: `${UNDO_MS}ms` }}
      />
    </div>
  );
}

/** A phrase card's casual / polite badge, then its usage note (phrase decks only). */
function PhraseNote({ note, register }: { note?: string; register?: Register }) {
  const text = useIntlayer("words-phrases");
  return (
    <>
      {register && (
        <span
          className="me-1.5 inline-block rounded-full border border-current px-1.5 fs-10 leading-4 opacity-80"
          data-register={register}
        >
          {register === "polite" ? text.polite : text.casual}
        </span>
      )}
      {note && <span data-row-note>{note}</span>}
    </>
  );
}

/** A scenario's key in the words-phrases dictionary. */
const scenarioKey = (s: Scenario) => (s === "small-talk" ? "smallTalk" : s);

/** Nodes with the parents an order (PATCH /api/words/lists) gives them, in that order. */
function applyOrder<T extends { id: string; parentId: string | null }>(
  nodes: T[],
  order: { id: string; parentId: string | null }[],
): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return order.flatMap((o) => {
    const n = byId.get(o.id);
    return n ? [{ ...n, parentId: o.parentId }] : [];
  });
}

/** "Import Anki deck (.apkg)" → /words/import. */
function ImportLink() {
  const { pickerLink } = useIntlayer("words-import");
  return (
    <a
      href="/words/import"
      className="text-sm px-3 py-1.5 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
    >
      <Icon name="uploadSimple" className="me-1" />
      {pickerLink}
    </a>
  );
}

/**
 * The study list: one endless column of words, each graded on its own and
 * saved the moment it is graded. Every due word comes first, then new words
 * (green) — lib/words/review-first.ts;
 * misses come back further down within minutes. Grading a word again re-grades
 * it (the server replaces the review while the word is not due yet); Z undoes.
 */
/**
 * A review of given words instead of a list's session: the reader's "review
 * this range's words" (app/(app)/read/[id]/reader-word-review.tsx). The same
 * study — rows, swipe, mirror, undo, marks, FSRS cards — with only these
 * words: no new-word intake, no further due words, the page not locked.
 */
export type StudyScope = {
  items: {
    listId: string;
    term: string;
    reading?: string | null;
    back: string;
    ex?: string | null;
    /** Stored ts-fsrs card JSON; null: a new word (its first grade makes the card). */
    card?: string | null;
  }[];
  /** A row was graded (its review is queued to sync as usual). */
  onGrade?: (listId: string, term: string, isNew: boolean) => void;
  /** The exit button's text (instead of "back to lists"). */
  exitLabel?: string;
  /** Shown in the toolbar after the title (the reader's 制卡). */
  toolbar?: React.ReactNode;
};

export function Study({
  config,
  lists,
  catalog,
  title,
  onExit,
  voice,
  scope,
}: {
  scope?: StudyScope;
  config: DrillConfig;
  /** Whether the voice mode switch is offered (lib/words/voice-access.ts). */
  voice: VoiceAccess;
  /** One list, or every list of a group / "study all". */
  lists: WordList[];
  catalog: CatalogMeta[];
  title: string;
  onExit: () => void;
}) {
  const [queue, setQueue] = useState<Item[]>([]);
  /** Grade per queue index; `card` is the server's card once saved. */
  const [grades, setGrades] = useState<Map<number, { rating: Rating; card?: string }>>(new Map());
  /**
   * The grades as of now, not as of the last render: a grade runs in a
   * transition, so until that render commits the `grades` a swipe handler
   * closed over still lacks it. The auto-advance check (shouldAdvance) reads
   * this, so a second grade of the same row in that gap is a re-grade.
   */
  const gradesNow = useRef(grades);
  gradesNow.current = grades;
  const [row, setRow] = useState(0);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The row whose other actions are open (double tap / right click). */
  const [sheet, setSheet] = useState<number | null>(null);
  const lastTap = useRef({ i: -1, t: 0 });
  // A modal is open (the slip's sheet, Settings): the study keys rest.
  const sheetOpen = useRef(false);
  // Back (the browser's, the phone's) folds the sheet instead of leaving /words.
  useBackToClose(sheet !== null, () => setSheet(null));
  const sync = useSyncStatus();
  /** The queue was built from the offline copy. */
  const [offlineCopy, setOfflineCopy] = useState(false);
  /** This tab's UI state (ui-store.ts): panels open, where the reader was. */
  const ui = wordsUiStore(config.base);
  const help = useUi(ui, (s) => s.helpOpen);
  const setHelp = useCallback(
    (v: boolean | ((h: boolean) => boolean)) =>
      ui.setState((s) => ({ helpOpen: typeof v === "function" ? v(s.helpOpen) : v })),
    [ui],
  );
  /** Every meaning shown, not just the focused / pinned rows. */
  const [showAll, setShowAll] = usePref("lk:words-show-all", false);
  const settings = useUi(ui, (s) => s.settingsOpen);
  sheetOpen.current = sheet !== null || settings;
  const settingsBtn = useRef<HTMLButtonElement>(null);
  const setSettings = useCallback(
    (v: boolean | ((o: boolean) => boolean)) =>
      ui.setState((s) => ({ settingsOpen: typeof v === "function" ? v(s.settingsOpen) : v })),
    [ui],
  );
  /** Touch: say the word as a swipe starts. Remembered; on by default. */
  const [swipeSpeak, setSwipeSpeak] = usePref("lk:words-swipe-speak", true);
  /**
   * Touch: the swipe's sides swapped (lib/words/swipe.ts sideRating): ← Good /
   * Easy, → Hard / Again. Remembered, synced (words.swipeMirror); off by default.
   */
  const [mirror, setMirror] = usePref(SWIPE_MIRROR_KEY, false);
  /** Touch: the row being held (listen mode) — revealed and looped while held. */
  const [holding, setHolding] = useState<number | null>(null);
  /** After a swipe grades a row, scroll the list down one row. Remembered. */
  /** Grade tones for eyes-free study. Remembered; on unless turned off. */
  const [tones, setTones] = usePref("lk:words-grade-tones", true);
  useEffect(() => unlockGradeTones(), []);
  const tone = (t: GradeTone) => {
    if (tones) playGradeTone(t);
  };
  const started = useRef(Date.now());
  const touch = useTouch();
  /** Hints follow the input used last: keys for a keyboard, gestures for touch. */
  const modality = useInputModality();
  /**
   * Which touch swipe this device uses (lib/words/swipe-ab.ts): WordRow's JS
   * detents, or — the experimental "New swipe" — NativeSlipRow's native
   * scroll snapping. Read after mount.
   */
  const [swipeAb, setSwipeAb] = useState<SwipeVariant>("js");
  /** The swipe's feel on this device: light (everyone) or heavy (lib/words/swipe-feel.ts). */
  const feelPrefs = useFeelPrefs();
  usePrefReader(useCallback(() => setSwipeAb(swipeVariant()), []));
  const native = touch && swipeAb === "native";
  /** Phone full screen. Remembered: once on, the first touch of a later study re-enters it. */
  const fs = useFullscreen();
  const [fsHint, setFsHint] = useState(false);
  const fsWanted = useRef(false);
  useEffect(() => {
    try {
      fsWanted.current = localStorage.getItem("lk:words-fullscreen") === "1";
    } catch {}
    // Leaving study leaves full screen too.
    return () => fs.exit();
  }, [fs.exit]);
  const rememberFs = (on: boolean) => {
    fsWanted.current = on;
    try {
      localStorage.setItem("lk:words-fullscreen", on ? "1" : "0");
    } catch {}
  };
  const toggleFullscreen = () => {
    if (!fs.supported) return setFsHint((v) => !v);
    if (fs.active) {
      rememberFs(false);
      fs.exit();
    } else {
      rememberFs(true);
      fs.enter();
    }
  };
  /** Browsers allow full screen only from a gesture: re-enter on this study's first touch. */
  const fsResumed = useRef(false);
  const resumeFullscreen = () => {
    if (fsResumed.current) return;
    fsResumed.current = true;
    if (fsWanted.current && fs.supported && !fs.active) fs.enter();
  };
  // Swipe telemetry: send what is queued now, and whatever is left on leaving.
  useEffect(() => {
    if (!touch) return;
    flushSwipes();
    const hide = () => document.visibilityState === "hidden" && flushSwipes(true);
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [touch]);
  /** "Turn off animations": this device's, app-wide; the system's until set (lib/motion-pref.ts). */
  const animationsOff = useMotionOff();
  /** Read with the server's voice instead of the browser's. Remembered. */
  const [serverVoice, setServerVoice] = usePref("lk:words-server-voice", true);
  const speech = useSpeech(serverVoice);
  const { locale } = useLocale();
  /** What a tap, a hold or the focus reads: word → example → meaning (the row's order). */
  const partsOf = useCallback(
    (it: Item) => sayParts(it, it.lang, !!config.readingOnBack, String(locale)),
    [config.readingOnBack, locale],
  );
  /** A word's tags, for the double-tap sheet: its list and the list's level (JLPT, CEFR…). */
  const tagsOf = (it: Item): string[] => {
    const list = lists.find((l) => l.id === it.listId);
    const meta = list && catalog.find((c) => c.id === list.source);
    return [list?.name, meta?.level].filter((t): t is string => !!t);
  };
  const base = config.base;
  const listIds = lists.map((l) => l.id).join(",");
  const paramsOf = useMemo(() => new Map(lists.map((l) => [l.id, l.params])), [lists]);
  /** Each list's size and cards as this session found them, for the toolbar's unseen count. */
  const scopeAtStart = useMemo(
    () =>
      lists.map((l) => ({
        total: catalog.find((c) => c.id === l.source)?.count ?? 0,
        cards: l.cards,
      })),
    // Snapshot per session: a refetched list already counts this session's cards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listIds, catalog],
  );

  const catalogs = useRef<Map<string, Entry[]>>(new Map());
  const byTerm = useRef<Map<string, Map<string, Entry>>>(new Map());
  /**
   * A word's example sentence, or a phrase's note, register and scene, from
   * its list's catalog (cards store none).
   */
  const exampleOf = (listId: string, term: string): Partial<Entry> => {
    let m = byTerm.current.get(listId);
    if (!m) {
      m = new Map((catalogs.current.get(listId) ?? []).map((e) => [e.term, e]));
      byTerm.current.set(listId, m);
    }
    const found = m.get(term);
    if (!found) return {};
    // Several examples: one at random for this showing, frozen into the item.
    const e = withPickedExample(found, keyOf({ listId, term }));
    return {
      ...(e.ex ? { ex: e.ex, exTr: e.exTr } : {}),
      ...(e.note ? { note: e.note } : {}),
      ...(e.register ? { register: e.register } : {}),
      ...(e.scene ? { scene: e.scene } : {}),
    };
  };
  /** Per list: where the search for new words has got (lib/words/take-new.ts). */
  const scans = useRef<Map<string, NewScan>>(new Map());
  /** Queue indices in the order they were graded (and not undone): Z walks this back. */
  const gradeLog = useRef<number[]>([]);
  /**
   * Misses queued again further down (lib/words/requeue.ts). Words in a
   * learning step (due again within minutes) wait in `later` until due — met
   * early, grading them would re-grade the review just made instead of
   * recording a new one — then join the list just below the screen. From
   * then on the slip they came from reads "↓ back" and is frozen.
   */
  const requeue = useRef<Requeue<Item>>(emptyRequeue());
  /** Slip i reads "↓ back": its copy below is the one to answer; it no longer grades. */
  const retired = (i: number) => {
    const card = gradesNow.current.get(i)?.card;
    return isRetired(requeue.current, i, card ? dueOf(card) : undefined, Date.now());
  };
  const dwellSince = useRef(Date.now());

  /**
   * A list's catalog, loaded once and only when needed (its due words'
   * examples, or new words), from the IndexedDB cache when it has a copy.
   */
  const catalogLoads = useRef<Map<string, Promise<Entry[]>>>(new Map());
  const ensureCatalog = useCallback(
    (list: WordList): Promise<Entry[]> => {
      let p = catalogLoads.current.get(list.id);
      if (!p) {
        const meta = catalog.find((c) => c.id === list.source);
        // No catalog for this list is a load failure, never "no new words":
        // treating it as empty would show "every word learned".
        p = meta
          ? loadCatalog<{ entries: Entry[] }>(catalogPath(base, meta)).then((d) => d.entries)
          : Promise.reject(new Error(`No word catalog for "${list.name}" (${list.source})`));
        p = p.then((entries) => {
          catalogs.current.set(list.id, entries);
          byTerm.current.delete(list.id);
          return entries;
        });
        catalogLoads.current.set(list.id, p);
        // A failed load is tried again next time, not remembered.
        p.catch(() => catalogLoads.current.delete(list.id));
      }
      return p;
    },
    [catalog, base],
  );

  /** Pull up to `n` catalog words of one list that have no card yet (lib/words/take-new.ts). */
  const takeNewFrom = useCallback(
    async (list: WordList, n: number): Promise<Item[]> => {
      const entries = await ensureCatalog(list);
      let scan = scans.current.get(list.id);
      if (!scan) scans.current.set(list.id, (scan = newScan(list.cursor)));
      const picked = await takeNewIndices(
        entries.map((e) => e.term),
        scan,
        n,
        async (terms) => {
          try {
            const { known } = await api<{ known: string[] }>(`/api/words/lists/${list.id}/known`, {
              method: "POST",
              body: JSON.stringify({ terms }),
            });
            return new Set(known);
          } catch (e) {
            // Offline: no check; the stored cursor already skips introduced words.
            if (e instanceof OfflineError) return null;
            throw e;
          }
        },
      );
      return picked.map((i) => ({
        // Several examples: one at random for this showing, frozen into the item.
        ...withPickedExample(entries[i], keyOf({ listId: list.id, term: entries[i].term })),
        kind: "new",
        newIndex: i,
        listId: list.id,
        lang: list.lang,
      }));
    },
    [ensureCatalog],
  );

  /** Up to `n` new words in the user's list order: the first list until it runs out. */
  const takeNew = useCallback(
    async (n: number) => {
      const out: Item[] = [];
      // A scoped review has only its own words.
      if (scope) return out;
      for (const l of lists) {
        if (out.length >= n) break;
        out.push(...(await takeNewFrom(l, n - out.length)));
      }
      return out;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listIds, takeNewFrom],
  );

  const dueItems = (list: WordList, cards: WordCard[]): Item[] =>
    cards.map((c) => ({
      ...exampleOf(list.id, c.term),
      term: c.term,
      reading: c.reading ?? undefined,
      back: c.back,
      kind: "due",
      listId: list.id,
      lang: list.lang,
      card: c.card,
    }));

  /** Due words of a session response, minus `skip` keys, in study order (lib/words/review-first.ts). */
  const orderedDue = (per: Record<string, { due: WordCard[] }>, skip?: Set<string>): Item[] =>
    orderDue(
      lists.flatMap((l) =>
        (per[l.id]?.due ?? [])
          .filter((c) => !skip?.has(keyOf({ listId: l.id, term: c.term })))
          .map((c) => ({ ...c, l })),
      ),
      new Date(),
    ).flatMap(({ l, ...c }) => dueItems(l, [c]));

  /** Due words not in `queued` yet, from the server; [] offline. */
  const fetchDue = async (queued: Item[]): Promise<Item[]> => {
    if (!navigator.onLine || scope) return [];
    const limit = dueFetchLimit(queued.filter((it) => it.kind !== "new").length, DUE_PAGE);
    try {
      const s = await api<{ lists: Record<string, { due: WordCard[] }> }>(
        `/api/words/session?lists=${encodeURIComponent(listIds)}&day=${localDay()}&limit=${limit}`,
      );
      await Promise.all(lists.filter((l) => s.lists[l.id]?.due.length).map(ensureCatalog));
      return orderedDue(s.lists, new Set(queued.map(keyOf)));
    } catch (e) {
      if (e instanceof OfflineError) return [];
      throw e;
    }
  };

  useEffect(() => {
    let alive = true;
    // Start from the stored cursors every run (Strict Mode mounts twice in dev).
    scans.current = new Map(lists.map((l) => [l.id, newScan(l.cursor)]));
    if (scope) {
      // The given words, in their order: a card as due, a new word as new.
      const lang = new Map(lists.map((l) => [l.id, l.lang]));
      setQueue(
        scope.items.map((x) => ({
          term: x.term,
          reading: x.reading ?? undefined,
          back: x.back,
          ex: x.ex ?? undefined,
          kind: x.card ? "due" : "new",
          listId: x.listId,
          lang: lang.get(x.listId) ?? "und",
          card: x.card ?? undefined,
        })),
      );
      setLoading(false);
      return;
    }
    (async () => {
      // All lists' due words in one request (one D1 query) — or, with no
      // network, the copy saved on the last visit / "download for offline",
      // minus words graded since that are still waiting to sync.
      const ids = lists.map((l) => l.id).join(",");
      let session: { lists: Record<string, { due: WordCard[] }>; more: boolean };
      try {
        session = await api(
          `/api/words/session?lists=${encodeURIComponent(ids)}&day=${localDay()}&limit=${MAX_DUE_FETCH}`,
        );
        cacheSessions(session.lists).catch(() => {});
      } catch (e) {
        if (!(e instanceof OfflineError)) throw e;
        const [cached, queued] = await Promise.all([
          idbAll<CachedSession>("sessions"),
          idbAll<PendingOp>("pending"),
        ]);
        const graded = pendingReviewed(queued);
        const now = Date.now();
        session = { lists: {}, more: false };
        for (const c of cached)
          if (lists.some((l) => l.id === c.listId))
            session.lists[c.listId] = {
              due: c.due.filter(
                (d) =>
                  !graded.has(reviewedKey(c.listId, d.term)) && new Date(d.due).getTime() <= now,
              ),
            };
        setOfflineCopy(true);
      }
      // Catalogs only for lists with due words (for their examples); the rest
      // load when their new words are needed.
      const withDue = lists.filter((l) => session.lists[l.id]?.due.length);
      await Promise.all(withDue.map(ensureCatalog));
      // New words: two batches to start — enough headroom that a fast grader
      // never reaches the end before the next batch lands; more as you go.
      // None while more due words wait on the server: those come first.
      const fresh = session.more ? [] : await takeNew(AHEAD * 2);
      if (!alive) return;
      const due = orderedDue(session.lists);
      setQueue([...due, ...spreadPairs(fresh, PAGE, due.length, due)]);
      setLoading(false);
    })().catch((e) => alive && setLoadError((e as Error).message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listIds, catalog, takeNew, ensureCatalog, base]);

  /** Per list, the first catalog word not yet introduced: the lowest ungraded new word in the queue. */
  const cursorOf = (listId: string, except: number) =>
    Math.min(
      scans.current.get(listId)?.next ?? 0,
      ...queue
        .map((it, i) => ({ it, i }))
        .filter(
          ({ it, i }) =>
            it.listId === listId && it.kind === "new" && i !== except && !grades.has(i),
        )
        .map(({ it }) => it.newIndex ?? Infinity),
    );

  // The cursor also lives in a ref: keys pressed faster than React re-renders
  // must each act on the row the previous key moved to.
  const rowRef = useRef(0);
  const queueLen = useRef(0);
  queueLen.current = queue.length;
  const moveRow = useCallback((to: number) => {
    dwellSince.current = Date.now();
    rowRef.current = Math.max(0, Math.min(queueLen.current - 1, to));
    setRow(rowRef.current);
  }, []);

  /**
   * Grade one word. Works the same online and offline: the new card is
   * computed here (same FSRS params as the server), and the review joins the
   * `pending` queue, which the sync loop sends at once when online — or later,
   * dated when it was made. Grading it again re-grades it.
   */
  const grade = (i: number, rating: Rating) => {
    const it = queue[i];
    if (!it || retired(i)) return;
    const now = new Date();
    const elapsedMs = i === rowRef.current ? now.getTime() - dwellSince.current : null;
    // From the card as it was before this row's grade, so a re-grade replaces.
    const { card } = reviewWord(parseCard(it.card), rating, now, paramsOf.get(it.listId)!);
    const cardJson = JSON.stringify(card);
    gradesNow.current = new Map(gradesNow.current).set(i, { rating, card: cardJson });
    setGrades((g) => new Map(g).set(i, { rating, card: cardJson }));
    gradeLog.current = [...gradeLog.current.filter((x) => x !== i), i];
    navigator.vibrate?.(10);
    tone(rating);
    // A miss comes back further down, within minutes (learning steps). A
    // re-grade first takes back the copy its earlier grade queued.
    requeue.current = afterGrade(
      requeue.current,
      i,
      { ...it, kind: "again", newIndex: undefined, card: cardJson },
      card.due.getTime(),
      now.getTime(),
      SESSION_WINDOW_MS,
    );
    const op: PendingOp = {
      listId: it.listId,
      op: "review",
      term: it.term,
      at: now.toISOString(),
      body: {
        day: localDay(),
        cursor: cursorOf(it.listId, i),
        reviews: [
          {
            term: it.term,
            reading: it.reading ?? null,
            back: it.back,
            rating,
            elapsedMs,
            newIndex: it.kind === "new" ? it.newIndex : null,
            reviewedAt: now.toISOString(),
          },
        ],
      },
    };
    void (async () => {
      // A re-grade whose earlier grade was never sent replaces it in the queue.
      const queued = await idbAll<PendingOp>("pending").catch(() => []);
      const stale = undoTarget(queued, it.listId, it.term);
      if (stale != null && grades.has(i)) await idbDelete("pending", stale).catch(() => {});
      await enqueue(op);
    })();
    scope?.onGrade?.(it.listId, it.term, !it.card);
  };

  /**
   * Z: undo the focused word's grade if it has one, else the most recent
   * grade not yet undone (and move there). Repeated Z walks back in time.
   * One level per word: the server keeps only the card before its last review.
   */
  const undo = (focusedOnly = false, at = rowRef.current) => {
    // A slip reading "↓ back" stays answered: its copy below is the live one.
    const target = undoPick(gradeLog.current, at, focusedOnly, (i) => grades.has(i), retired);
    if (target < 0) return;
    const it = queue[target];
    // Its copy, still waiting, must not come back for an ungraded word.
    requeue.current = withdraw(requeue.current, target);
    if (touch) logUndoAfterSwipe();
    tone("undo");
    gradeLog.current = gradeLog.current.filter((x) => x !== target);
    setGrades((g) => {
      const n = new Map(g);
      n.delete(target);
      return n;
    });
    moveRow(target);
    void (async () => {
      // Not sent yet: just drop it. Already sent: queue an undo for the server.
      const queued = await idbAll<PendingOp>("pending").catch(() => []);
      const drop = undoTarget(queued, it.listId, it.term);
      if (drop != null) {
        await idbDelete("pending", drop).catch(() => {});
        notifySync();
      } else
        await enqueue({
          listId: it.listId,
          op: "undo",
          term: it.term,
          at: new Date().toISOString(),
          body: { term: it.term, day: localDay() },
        });
    })();
  };
  const text = useIntlayer("words-page");
  const ratingLabel = useRatingLabel();
  const grades4 = {
    again: ratingLabel[1],
    hard: ratingLabel[2],
    good: ratingLabel[3],
    easy: ratingLabel[4],
  };
  /** The help strip's touch grades by side: `{hard}` / `{again}` fill ←, `{good}` / `{easy}` fill →. */
  const swipeSides = {
    again: ratingLabel[sideRating(1, mirror)],
    hard: ratingLabel[sideRating(2, mirror)],
    good: ratingLabel[sideRating(3, mirror)],
    easy: ratingLabel[sideRating(4, mirror)],
  };
  // The debug mode's user-facing name: "Learning Partner" (learning-partner.content.ts).
  const partner = useIntlayer("learning-partner");
  const partnerName = partner.name.value;
  const partnerOn = partner.on.value.replace("{name}", partnerName);
  const partnerOff = partner.off.value.replace("{name}", partnerName);
  const [debug, debugTap] = useDebugToggle(
    useCallback((on: boolean) => setNotice(on ? partnerOn : partnerOff), [partnerOn, partnerOff]),
  );
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  /** A grade from the keys (or the voice on desktop): the cursor moves on past a first grade. */
  const keyGrade = (at: number, r: Rating) => {
    const advance = shouldAdvance(grades, at);
    grade(at, r);
    if (advance) moveRow(at + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const row = rowRef.current;
      // The action sheet is open: its keys are its own (Escape closes it).
      if (sheetOpen.current) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      // Holding a key repeats movement only, never grading or undo.
      const moves = ["ArrowDown", "ArrowUp", "KeyS", "KeyW", "KeyU", "KeyI"];
      if (e.repeat && !moves.includes(e.code)) return e.preventDefault();
      // W/S (left hand) and I/U (right hand) move like the arrows.
      if (["ArrowDown", "KeyS", "KeyU"].includes(e.code)) moveRow(row + 1);
      else if (["ArrowUp", "KeyW", "KeyI"].includes(e.code)) moveRow(row - 1);
      else if (e.code === "Space")
        setRevealed((s) => {
          const n = new Set(s);
          if (n.has(row)) n.delete(row);
          else n.add(row);
          return n;
        });
      else if (e.code === "Enter") {
        // Jump to the next word not graded yet.
        const next = queue.findIndex((_, i) => i > row && !grades.has(i));
        if (next >= 0) moveRow(next);
      } else if (e.code === "KeyZ" || e.code === "KeyM" || e.code === "Backspace") undo();
      else if (e.code === "Escape") undo(true);
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.code === "KeyV") speech.toggle();
      else if (e.code === "KeyE") setShowAll((v) => !v);
      else if (KEY_RATING[e.code] && !e.shiftKey) keyGrade(row, KEY_RATING[e.code]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The list is a box the height of the screen that scrolls inside itself;
  // only the rows in view (plus a margin) are rendered.
  // Text size (lib/text-size.ts): rows grow with the cards' text, never shrink.
  // Rows are 1.5× their swipe unit (owner, 2026-11-03): SWIPE_A, the old row
  // height, stays the finger distance of one detent (lib/words/row-layout.ts).
  const cardScale = useTextScale("cards");
  const { rowH: ROW_H, a: SWIPE_A } = rowMetrics(touch, cardScale);
  const listRef = useRef<HTMLDivElement>(null);
  /** The list element as state, for effects that must start when it mounts. */
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const setListRef = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    setListEl(el);
  }, []);
  const hintRef = useRef<HTMLDivElement>(null);
  /** The glass toolbar over the top of the list (header included in `bar.top`). */
  const topRef = useRef<HTMLDivElement>(null);
  /**
   * What the glass overlays cover of the full-window list: `top` = the
   * toolbar's bottom edge, `bottom` = the help strip's height; `toolbar` = the
   * toolbar's own height, which the in-flow content (loading, errors) clears.
   */
  const [bar, setBar] = useState({ top: 0, bottom: 0, toolbar: 0 });
  const barRef = useRef(bar);
  barRef.current = bar;
  /** Room for the help strip: a tall enough window, the on-screen keyboard closed. */
  const [room, setRoom] = useState(true);
  useEffect(() => {
    const vv = window.visualViewport;
    const check = () => {
      const keyboard = !!vv && vv.scale <= 1.01 && vv.height < window.innerHeight - 120;
      setRoom(window.innerHeight >= 560 && !keyboard);
    };
    check();
    window.addEventListener("resize", check);
    vv?.addEventListener("resize", check);
    return () => {
      window.removeEventListener("resize", check);
      vv?.removeEventListener("resize", check);
    };
  }, []);
  /** What a sliding slip uncovers: the grade of each level (SwipeUnderlay). */
  const underlay = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  /** When the list last scrolled: a touch within 120 ms of it catches a fling. */
  const lastScrollAt = useRef(0);
  const scrollingNow = useCallback(() => performance.now() - lastScrollAt.current < 120, []);
  /**
   * Where the last auto-advance is taking the list, while it is on its way
   * (lib/words/advance.ts, `advanceTop`). Cleared when the list gets there or
   * the finger takes the list.
   */
  const advancing = useRef<{ row: number; top: number } | null>(null);
  /**
   * After grading row `i` for the first time: scroll the list by exactly one
   * row, so the next word slides up under the thumb. An absolute target, not
   * scrollBy: a relative step lands one row past wherever the list is at
   * that instant, so a step taken while the list still moves (the last
   * advance's smooth scroll, a coast) adds to it. One advance per row.
   */
  const advanceList = (i: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = advanceTop({
      row: i,
      scrollTop: el.scrollTop,
      rowH: ROW_H,
      max: el.scrollHeight - el.clientHeight,
      pending: advancing.current,
    });
    if (top === null) return;
    advancing.current = { row: i, top };
    el.scrollTo({ top, behavior: motionOff() ? "auto" : "smooth" });
  };
  const [viewH, setViewH] = useState(600);
  /** viewH holds the real measured height (the opening scroll depends on it). */
  const [measured, setMeasured] = useState(false);
  const listReady = !loading && !loadError && queue.length > 0;
  // Empty space above the first row and below the last (OVERSCROLL_FRACTION
  // of the list's height), so any row — the first and last included — can be
  // scrolled well past the middle (or to the touch focus line). Row positions
  // and the windowing below are all offset by it.
  const pad = Math.round(viewH * OVERSCROLL_FRACTION);
  // `scrollTop` (state) moves only when the rows in view change: the window,
  // the audio wish, the reach and the glide's goal are all per row, and a
  // render of the whole list on every scroll event (60 a second) was the
  // biggest scroll cost on an iPhone. The key is every row edge they read.
  const scrollKey = useRef("");
  const syncScroll = (top: number) => {
    const key = `${Math.floor((top - pad) / ROW_H)}|${Math.floor((top - pad + viewH) / ROW_H)}|${Math.ceil((top - pad + viewH) / ROW_H)}`;
    if (key === scrollKey.current) return;
    scrollKey.current = key;
    setScrollTop(top);
  };
  // The rows' edges move with the height, the over-scroll and the row height.
  useEffect(() => {
    if (listEl) syncScroll(listEl.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listEl, pad, viewH, ROW_H]);
  // Open with the first row just under the glass toolbar, not half a screen
  // down. Re-applied until the person moves the list themselves: whenever the
  // list element is (re)mounted (the queue can reload, e.g. from the offline
  // copy and then the server), the measured heights or the over-scroll
  // change (fonts, safe areas and the toolbar settle late on iOS), and on
  // pageshow (a restored page). Events only — nothing polls.
  const opened = useRef<{ el: HTMLElement | null; moved: boolean }>({ el: null, moved: false });
  const [shownAt, setShownAt] = useState(0);
  useEffect(() => {
    const again = () => setShownAt((n) => n + 1);
    window.addEventListener("pageshow", again);
    return () => window.removeEventListener("pageshow", again);
  }, []);
  useEffect(() => {
    if (!listEl) return;
    const moved = () => {
      if (opened.current.el === listEl) opened.current.moved = true;
    };
    const opts = { passive: true, capture: true } as const;
    listEl.addEventListener("pointerdown", moved, opts);
    listEl.addEventListener("touchstart", moved, opts);
    listEl.addEventListener("wheel", moved, opts);
    window.addEventListener("keydown", moved, opts);
    return () => {
      listEl.removeEventListener("pointerdown", moved, opts);
      listEl.removeEventListener("touchstart", moved, opts);
      listEl.removeEventListener("wheel", moved, opts);
      window.removeEventListener("keydown", moved, opts);
    };
  }, [listEl]);
  // Where the reader was in this tab (ui-store.ts): the same opening, aimed
  // at that word instead of the first, while it is still in the queue.
  const studyKey = lists.map((l) => l.id).join(",");
  const anchor = useUi(ui, (s) => s.anchors[studyKey] ?? null);
  const anchorAt = useMemo(
    () => (anchor === null ? -1 : queue.findIndex((it) => keyOf(it) === anchor)),
    [anchor, queue],
  );
  useLayoutEffect(() => {
    if (!listEl || !listReady || !measured) return;
    if (opened.current.el !== listEl) opened.current = { el: listEl, moved: false };
    if (opened.current.moved) return;
    listEl.scrollTop = anchorTop(anchorAt, { pad, rowH: ROW_H, barTop: bar.top }) ?? pad - bar.top;
  }, [listEl, listReady, measured, pad, bar.top, shownAt, anchorAt]);
  /** Remember the word at the top once the reader has moved the list (not the opening's own scroll). */
  const anchorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepAnchor = useCallback(
    (top: number) => {
      if (!opened.current.moved) return;
      clearTimeout(anchorTimer.current);
      anchorTimer.current = setTimeout(() => {
        const it = queue[topIndex(top, { pad, rowH: ROW_H, barTop: barRef.current.top })];
        setAnchor(ui, studyKey, it ? keyOf(it) : null);
      }, 200);
    },
    [queue, pad, ui, studyKey, ROW_H],
  );
  useEffect(() => () => clearTimeout(anchorTimer.current), []);
  // A text size change resizes the rows (lib/text-size.ts): the word at the
  // top stays at the top.
  const rowHWas = useRef(ROW_H);
  useLayoutEffect(() => {
    const was = rowHWas.current;
    rowHWas.current = ROW_H;
    const el = listRef.current;
    if (was === ROW_H || !el) return;
    el.scrollTop = pad + ((el.scrollTop - pad) / was) * ROW_H;
  }, [ROW_H, pad]);
  // The list fills the window (.lk-words-list); the toolbar and the help strip
  // float over it. Measured whenever any of them changes size (settings open,
  // hints change, the window turns), never polled.
  useLayoutEffect(() => {
    const fit = () => {
      const top = topRef.current;
      const hint = hintRef.current;
      const next = {
        top: Math.round(top?.getBoundingClientRect().bottom ?? 0),
        toolbar: Math.round(top?.offsetHeight ?? 0),
        bottom: hint
          ? Math.max(0, Math.round(window.innerHeight - hint.getBoundingClientRect().top))
          : 0,
      };
      setBar((b) =>
        b.top === next.top && b.bottom === next.bottom && b.toolbar === next.toolbar ? b : next,
      );
      if (listEl) {
        setViewH(Math.max(160, listEl.clientHeight));
        setMeasured(true);
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    for (const el of [topRef.current, hintRef.current, listEl]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [listEl, room]);
  // The paper scrolls with the list (.lk-paper-layer): the body behind it is
  // plain, so the texture isn't drawn twice.
  useEffect(() => {
    if (!listEl) return;
    const root = document.documentElement;
    root.classList.add("lk-paper-scrolls");
    return () => root.classList.remove("lk-paper-scrolls");
  }, [listEl]);
  // Only the list scrolls: the page under it stays put.
  useEffect(() => {
    // A scoped review is an overlay: the page under it keeps its place.
    if (!listEl || scope) return;
    // The page is exactly the window while the list is up (.lk-page-lock):
    // no overflow, no rubber band, and no taller-than-the-window document
    // (min-h-screen plus the body's safe-area padding made it 48px taller on
    // an iPhone, and iOS left it scrolled by that much).
    const root = document.documentElement;
    root.classList.add("lk-page-lock");
    const top = () => {
      if (window.scrollY || root.scrollTop) window.scrollTo(0, 0);
    };
    top();
    // Again once the lock has laid out, and whenever iOS moves the page anyway
    // (the keyboard, a restored page): the list is the only scroller.
    queueMicrotask(top);
    const raf = requestAnimationFrame(top);
    window.addEventListener("scroll", top, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      root.classList.remove("lk-page-lock");
      window.removeEventListener("scroll", top);
    };
  }, [listEl]);
  // Keep the cursor in view as it moves, a couple of rows from the edges of
  // what the overlays leave uncovered. A row height change alone (text size)
  // is not a move: the effect below keeps the reader's place instead.
  const cursorRowH = useRef(ROW_H);
  useEffect(() => {
    const el = listRef.current;
    const resized = cursorRowH.current !== ROW_H;
    cursorRowH.current = ROW_H;
    if (!el || resized) return;
    const { top: over, bottom: under } = barRef.current;
    const top = pad + row * ROW_H;
    if (top < el.scrollTop + over + ROW_H) el.scrollTop = Math.max(0, top - ROW_H - over);
    else if (top + ROW_H > el.scrollTop + el.clientHeight - under - ROW_H * 2)
      el.scrollTop = top + ROW_H * 3 - el.clientHeight + under;
  }, [row, ROW_H]);

  // Touch has no cursor: the focused row is the one last tapped, and grading
  // it moves focus to the next row (as the desktop cursor advances). Scrolling
  // never moves focus — the finger decides, not the scroll position. A newly
  // focused row is read once.
  const [focusLine, setFocusLine] = useState(0);

  // Due words from `later` join the list just below the screen — nothing on
  // screen moves, and scrolling on meets them, as Anki interleaves learning
  // cards. Never mid-gesture or mid-scroll: they wait for the hand to rest.
  // Every index-keyed piece of state below the insertion point shifts by one.
  const touchingList = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      const el = listRef.current;
      const now = Date.now();
      if (!el || !requeue.current.later.some((x) => x.due <= now)) return;
      if (touchingList.current || performance.now() - lastScrollAt.current < 400) return;
      // The list's top spacer (`pad`), from the live height.
      const top = Math.round(el.clientHeight * OVERSCROLL_FRACTION);
      const below = Math.floor((el.scrollTop - top + el.clientHeight) / ROW_H) + 1;
      // Updaters stay pure (Strict Mode runs them twice): the insertion point
      // is fixed here, from the queue length as last rendered.
      const at = Math.max(0, Math.min(queueLen.current, below));
      const { ready, next, shift } = takeDue(requeue.current, now, at);
      const n = ready.length;
      requeue.current = next;
      setQueue((q) => [...q.slice(0, at), ...ready, ...q.slice(at)]);
      setGrades((g) => new Map([...g].map(([k, v]) => [shift(k), v])));
      setRevealed((r) => new Set([...r].map(shift)));
      gradeLog.current = gradeLog.current.map(shift);
      rowRef.current = shift(rowRef.current);
      queueLen.current += n;
      setRow((r) => shift(r));
      setFocusLine((f) => shift(f));
      setHolding((h) => (h === null ? h : shift(h)));
    }, 1000);
    return () => clearInterval(t);
  }, [ROW_H]);
  const focusItem = touch ? queue[focusLine] : undefined;
  const focusText = focusItem ? spokenText(focusItem, focusItem.lang, !!config.readingOnBack) : "";
  /** The focus moved by a tap or a swipe that already said the word: don't say it twice. */
  const quietFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!touch || !active || holding !== null || !focusItem) return;
    if (quietFocus.current === focusLine) return void (quietFocus.current = null);
    // With every meaning shown, the back is read too: word → example → meaning.
    speech.once(
      showAll ? partsOf(focusItem) : [{ kind: "word", text: focusText, lang: focusItem.lang }],
      false,
      { yieldToHold: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touch, focusLine, focusText]);

  /** The touch focus as of now (a voice command may come before the render that moved it). */
  const focusNow = useRef(focusLine);
  focusNow.current = focusLine;
  /**
   * A swipe's grade (or the voice's on touch): auto-advance is for a card met
   * for the first time; editing a grade already given stays on that card (the
   * owner, 2026-10-30). Read now, not from this render: see gradesNow.
   */
  const swipeGrade = (i: number, r: Rating) => {
    const advance = shouldAdvance(gradesNow.current, i);
    // The slip glides home meanwhile: the grade's re-render can wait.
    startTransition(() => {
      grade(i, r);
      if (touch && advance) setFocusLine(Math.min(queue.length - 1, i + 1));
    });
    if (touch && advance) focusNow.current = Math.min(queue.length - 1, i + 1);
    // The next word slides up under the thumb.
    if (advance) advanceList(i);
  };

  // Voice mode (docs/voice-mode.md): spoken commands run the same actions
  // as the keys and the swipe, never anything else.
  const [voicePref, setVoicePref] = usePref("lk:words-voice-mode", false);
  const voiceOn = voice !== "off" && voicePref;
  const vtext = useIntlayer("words-voice-mode");
  const [aec, setAecPill] = useAecSwitch();
  /** The card a command acts on: the touch focus, or the desktop cursor. */
  const currentRow = () => (touch ? focusNow.current : rowRef.current);
  /** Touch: bring a focused row into the part of the list the glass leaves uncovered. */
  const showRow = (i: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = pad + i * ROW_H;
    const { top: over, bottom: under } = barRef.current;
    if (top < el.scrollTop + over || top + ROW_H > el.scrollTop + el.clientHeight - under)
      el.scrollTo({
        top: Math.max(0, top - over - ROW_H * 2),
        behavior: motionOff() ? "auto" : "smooth",
      });
  };
  const voiceActions: VoiceActions = {
    move: (d) => {
      if (!touch) return moveRow(rowRef.current + d);
      const to = Math.max(0, Math.min(queue.length - 1, focusNow.current + d));
      focusNow.current = to;
      // The focus effect reads the newly focused word, as a tap's focus does.
      setFocusLine(to);
      showRow(to);
    },
    grade: (r) => (touch ? swipeGrade(currentRow(), r) : keyGrade(currentRow(), r)),
    show: () => {
      const i = currentRow();
      setRevealed((s) => (s.has(i) ? s : new Set(s).add(i)));
    },
    read: () => {
      const it = queue[currentRow()];
      if (it) speech.once(partsOf(it), true);
    },
    // From the card in focus (touch has no cursor): its grade, else the last one given.
    undo: () => undo(false, currentRow()),
    exit: () => setVoicePref(false),
  };
  const voiceHandle = (heard: string): VoiceOutcome => {
    const at = currentRow();
    // The cards around the focus: what is read aloud, or what he says to practise.
    const near = queue.slice(Math.max(0, at - 2), at + 4);
    return handleUtterance(heard, {
      actions: voiceActions,
      // 左/右 grade as the side that is on the left / right now (the mirror).
      mirror,
      hasCard: !!queue[at],
      cardTexts: near.flatMap((it) => [
        it.term,
        it.reading,
        it.back,
        it.ex,
        it.exTr,
        spokenText(it, it.lang, !!config.readingOnBack),
        ...partsOf(it).map((p) => p.text),
      ]),
      // The focused card and the one before (focus moves on after a grade):
      // exactly what sayParts reads aloud, plus the raw meaning and example.
      spoken: queue
        .slice(Math.max(0, at - 1), at + 1)
        .flatMap((it) => [it.term, it.back, it.ex, it.exTr, ...partsOf(it).map((p) => p.text)]),
    });
  };
  const voiceMode = useVoiceMode(voiceOn, voiceHandle);
  const voiceLabel = (o: VoiceOutcome) => voiceOutcomeLabel(o, vtext, ratingLabel, mirror);

  /** How far down the list the user has got: the cursor, or the last row in view. */
  const reach = Math.max(row, Math.floor((scrollTop - pad + viewH) / ROW_H));
  // Endless: when fewer than AHEAD ungraded words are left below the cursor
  // or below the bottom of the view (touch has no cursor; scrolling doesn't
  // move it), fetch more — every due word not queued yet first (the server is
  // asked each time, so words that fell due since the page opened come too),
  // then new ones. Stops only when every catalog runs out.
  const [exhausted, setExhausted] = useState(!!scope);
  const fetching = useRef(false);
  /** Bumped when a recheck lets go of `fetching`, so a skipped endless fetch runs. */
  const [released, setReleased] = useState(0);
  useEffect(() => {
    if (loading || exhausted || fetching.current || queue.length - reach > AHEAD) return;
    fetching.current = true;
    const append = (items: Item[]) =>
      setQueue((q) => [...q, ...spreadPairs(items, PAGE, q.length, q.slice(-PAGE))]);
    (async () => {
      const next = await nextBatch({
        due: await fetchDue([...queue, ...requeue.current.later.map((x) => x.item)]),
        fresh: () => takeNew(AHEAD),
      });
      if (!next.items.length) setExhausted(true);
      // Due words go ahead of new words still waiting below the screen.
      else if (next.kind === "due" && newWaiting(queue)) toLater(next.items);
      else append(next.items);
    })()
      // With nothing on screen, a failure is the page's error (with Retry),
      // not a quiet note under an empty list.
      .catch((e) => (queue.length ? setSyncError : setLoadError)((e as Error).message))
      .finally(() => {
        fetching.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, exhausted, queue.length, reach, takeNew, released]);

  /** An ungraded new word below the screen. */
  const newWaiting = (q: Item[]) =>
    q.some((it, i) => i > reach && it.kind === "new" && !grades.has(i));
  /** Into `requeue.later`, to join just below the screen; ones already queued or waiting are dropped. */
  const toLater = (items: Item[]) => {
    const q = requeue.current;
    const have = new Set([...queueNow.current, ...q.later.map((x) => x.item)].map(keyOf));
    // from -1: fetched, not a copy of a graded slip (lib/words/requeue.ts).
    const add = items
      .filter((it) => !have.has(keyOf(it)))
      .map((item) => ({ item, due: 0, from: -1 }));
    requeue.current = { ...q, later: [...q.later, ...add] };
  };
  // Back on the page after a while (a phone keeps the tab open overnight):
  // words that fell due meanwhile join just below the screen, through `requeue.later`,
  // ahead of the new words still waiting. Not while the endless fetch runs:
  // it asks for the same words.
  const queueNow = useRef(queue);
  queueNow.current = queue;
  const recheckDue = useRef(() => {});
  recheckDue.current = () => {
    if (fetching.current) return;
    fetching.current = true;
    fetchDue([...queue, ...requeue.current.later.map((x) => x.item)])
      .then(toLater)
      .catch(() => {})
      .finally(() => {
        fetching.current = false;
        setReleased((n) => n + 1);
      });
  };
  useEffect(() => {
    if (loading) return;
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") return void (hiddenAt = Date.now());
      if (!hiddenAt || Date.now() - hiddenAt < RECHECK_DUE_MS) return;
      hiddenAt = 0;
      recheckDue.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loading]);

  // Say the focused row aloud on a loop (word, example, meaning) while the page
  // is active; paused in a hidden tab or background window.
  const active = usePageActive();
  const focused = !touch && active ? queue[row] : undefined;
  // Keyed by content: re-rendering the same row must not restart its loop.
  const focusParts = JSON.stringify(focused ? partsOf(focused) : []);
  useEffect(() => speech.loop(JSON.parse(focusParts) as SayPart[]), [focusParts, speech]);

  // Windowed rendering: the list is endless, the DOM is not.
  const OVERSCAN = 20;
  const from = Math.max(0, Math.floor((scrollTop - pad) / ROW_H) - OVERSCAN);
  const to = Math.min(queue.length, Math.ceil((scrollTop - pad + viewH) / ROW_H) + OVERSCAN);

  // Audio, in the owner's order: the rows on screen, then their neighbours
  // outward across the rendered window, then a few past it. Each scroll
  // re-orders the wish, so what scrolled away is dropped (lib/words/audio-cache.ts).
  // Today's due words go to the device last, for offline study.
  const firstSeen = Math.max(0, Math.floor((scrollTop - pad) / ROW_H));
  const lastSeen = Math.min(queue.length, Math.ceil((scrollTop - pad + viewH) / ROW_H));
  // Desktop with sound off says nothing (a click grades); a tap always speaks.
  const audioOn = touch || speech.on;
  useEffect(() => {
    if (!audioOn) return;
    const { visible, rest } = rowPriority(
      queue.length,
      firstSeen,
      lastSeen,
      from,
      to,
      PREFETCH_NEXT,
    );
    const parts = (rows: number[]) => prefetchOrder(rows.map((i) => partsOf(queue[i])));
    speech.prefetch(parts(visible), parts(rest));
  }, [audioOn, firstSeen, lastSeen, from, to, queue, speech, partsOf]);
  useEffect(() => {
    if (!audioOn || loading) return;
    speech.stock(queue.filter((it) => it.kind === "due").flatMap(partsOf));
  }, [audioOn, loading, queue, speech, partsOf]);
  // Sticky over the whole loaded queue: a column appearing and disappearing
  // as example-less stretches scroll by would shift every other column.
  const hasExamples = useMemo(() => queue.some((it) => it.ex || it.note), [queue]);

  // Familiarity marks inside the examples (lib/words/example-marks.ts): the
  // words of the rendered window not asked yet, in one request per language
  // once the window has held still for a moment; answers kept for the session.
  const fam = useRef<FamMap>(new Map());
  const [, setFamRev] = useState(0);
  useEffect(() => {
    const want = missingWords(queue.slice(from, to), fam.current);
    if (!want.size) return;
    const t = setTimeout(() => {
      for (const [lang, all] of want)
        for (let k = 0; k < all.length; k += 500) {
          const words = all.slice(k, k + 500);
          // Asked: never again this session, even if the request fails.
          recordHits(fam.current, lang, words, {});
          void fetch("/api/words/familiarity", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lang, words }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j: { hits?: Record<string, FamHit> } | null) => {
              if (!j?.hits || !Object.keys(j.hits).length) return;
              recordHits(fam.current, lang, words, j.hits);
              setFamRev((n) => n + 1);
            })
            .catch(() => {});
        }
    }, 250);
    return () => clearTimeout(t);
  }, [from, to, queue]);

  // Term column width (lib/words/columns.ts): fitted to the terms near the
  // middle of the screen, eased into place through --term-w on the list.
  const measureTerm = useMemo(() => {
    if (typeof document === "undefined") return () => 0;
    const ctx = document.createElement("canvas").getContext("2d");
    const family = getComputedStyle(document.body).fontFamily;
    const cache = new Map<string, number>();
    return (it: Item) => {
      const k = keyOf(it);
      let w = cache.get(k);
      if (w === undefined && ctx) {
        ctx.font = `500 ${(touch ? 16 : 15) * cardScale}px ${family}`;
        w = ctx.measureText(it.term).width;
        if (!config.readingOnBack && it.reading && it.reading !== it.term) {
          ctx.font = `400 ${12 * cardScale}px ${family}`;
          w += 8 + ctx.measureText(it.reading).width;
        }
        cache.set(k, w);
      }
      return w ?? 0;
    };
  }, [touch, config.readingOnBack, cardScale]);
  /** Desktop: how wide a row's meaning and example want to be (text-sm, one line). */
  const measureCells = useMemo(() => {
    if (typeof document === "undefined") return () => ({ back: 0, ex: 0 });
    const ctx = document.createElement("canvas").getContext("2d");
    const family = getComputedStyle(document.body).fontFamily;
    const cache = new Map<string, { back: number; ex: number }>();
    return (it: Item) => {
      const k = keyOf(it);
      let w = cache.get(k);
      if (!w && ctx) {
        ctx.font = `400 ${14 * cardScale}px ${family}`;
        let back = ctx.measureText(it.back).width;
        let ex = it.ex ? ctx.measureText(it.ex).width : 0;
        if (config.readingOnBack && it.reading && it.reading !== it.term)
          back += 8 + ctx.measureText(it.reading).width;
        if (it.exTr) {
          ctx.font = `400 ${12 * cardScale}px ${family}`;
          ex += 8 + ctx.measureText(it.exTr).width;
        }
        // A phrase's note (and its register badge) sits where an example would.
        if (!it.ex && it.note) {
          ctx.font = `400 ${12 * cardScale}px ${family}`;
          ex = ctx.measureText(it.note).width + (it.register ? 56 : 0);
        }
        w = { back, ex };
        cache.set(k, w);
      }
      return w ?? { back: 0, ex: 0 };
    };
  }, [config.readingOnBack, cardScale]);
  const rem = useMemo(
    () =>
      typeof document === "undefined"
        ? 16
        : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    [],
  );
  const termGoal = useRef<number | null>(null);
  const termShown = useRef<number | null>(null);
  const termVelocity = useRef(0);
  // Desktop with examples: the example column's share (it comes first), the same way.
  const exGoal = useRef<number | null>(null);
  const exShown = useRef<number | null>(null);
  const exVelocity = useRef(0);
  /** The glide's one rAF loop, kept across renders (see below). */
  const glideRaf = useRef(0);
  const glideLast = useRef<number | null>(null);
  const glideSplit = useRef(false);
  useEffect(() => () => cancelAnimationFrame(glideRaf.current), []);
  useEffect(() => {
    if (!viewH || to <= from) return;
    const centre = scrollTop + viewH / 2;
    const rows: { width: number; distance: number }[] = [];
    for (let i = from; i < to; i++)
      rows.push({
        width: measureTerm(queue[i]),
        distance: Math.abs(pad + i * ROW_H + ROW_H / 2 - centre),
      });
    termGoal.current = nextGoal(termGoal.current, termTarget(rows, viewH, rem, touch), rem);
    const el = listRef.current;
    if (!el) return;
    const split = !touch && hasExamples;
    if (split) {
      const weighted = (f: (c: { back: number; ex: number }) => number) =>
        weightedQuantile(
          rows.map((r, k) => [f(measureCells(queue[from + k])), centreWeight(r.distance, viewH)]),
          COLUMN_QUANTILE,
        );
      // The list less padding, marker and status columns, gaps, and the term column.
      const avail = el.clientWidth - (1 + 1.25 + 3.5 + 2) * rem - termGoal.current;
      exGoal.current = nextGoal(
        exGoal.current,
        splitTarget(weighted((c) => c.ex) + rem, weighted((c) => c.back) + rem, avail, rem),
        rem,
      );
    }
    if (termShown.current === null || (split && exShown.current === null)) {
      termShown.current = termGoal.current;
      el.style.setProperty("--term-w", `${termShown.current}px`);
      if (split) {
        exShown.current = exGoal.current;
        el.style.setProperty("--ex-w", `${exShown.current}px`);
      }
      return;
    }
    // Glide every row together: one variable, moved by a critically damped
    // spring that keeps its velocity if the goal moves mid-glide. One loop
    // outlives this effect: a scroll re-runs it at each row it crosses, and restarting
    // the loop each time cancelled the pending step and timed the next from
    // a fresh performance.now(), so the spring advanced a fraction of each
    // frame, or not at all — the width stalled while the finger moved, then
    // caught up in jumps.
    glideSplit.current = split;
    if (glideRaf.current) return;
    const reduce = motionOff();
    /** One spring step of a column toward its goal; true once it has settled. */
    const glide = (
      goal: number,
      shown: { current: number | null },
      velocity: { current: number },
      prop: string,
      dt: number,
    ) => {
      const s = glideStep(shown.current!, velocity.current, goal, dt, reduce);
      // Every row's grid reads the variable, so each write lays out the whole
      // list: write only whole device pixels, and only when that changes (the
      // spring's long sub-pixel tail no longer relays the list every frame).
      const px = (v: number) => Math.round(v * devicePixelRatio) / devicePixelRatio;
      const was = px(shown.current!);
      shown.current = s.x;
      velocity.current = s.v;
      if (px(s.x) !== was || s.settled) el.style.setProperty(prop, `${px(s.x)}px`);
      return s.settled;
    };
    const step = (now: number) => {
      const dt = frameDt(now, glideLast.current);
      glideLast.current = now;
      const a = glide(termGoal.current!, termShown, termVelocity, "--term-w", dt);
      const b =
        !glideSplit.current ||
        exGoal.current === null ||
        exShown.current === null ||
        glide(exGoal.current, exShown, exVelocity, "--ex-w", dt);
      if (a && b) {
        glideRaf.current = 0;
        glideLast.current = null;
      } else glideRaf.current = requestAnimationFrame(step);
    };
    glideRaf.current = requestAnimationFrame(step);
  }, [from, to, scrollTop, viewH, pad, queue, measureTerm, measureCells, hasExamples, rem, touch]);

  const done = grades.size;
  const minutes = (Date.now() - started.current) / 60_000;
  const ahead = queue.filter((_, i) => i >= row && !grades.has(i));
  const dueLeft = ahead.filter((it) => it.kind !== "new").length;
  // Not the new words in the loaded batch (always ~80 at the start): the
  // words in scope never seen yet (lib/words/unseen.ts).
  const unseen = unseenLeft(scopeAtStart, countGradedNew(queue, grades.keys()));

  const status = (it: Item, i: number) => {
    const g = grades.get(i);
    if (g) {
      // Saved: when it actually comes back. Not yet saved: the preview.
      if (g.card) return <Countdown due={dueOf(g.card)} back={requeue.current.requeued.has(i)} />;
      return previewInterval(it.card, g.rating, paramsOf.get(it.listId)!);
    }
    if (it.kind === "new" || !it.card) return text.statusNew.value;
    return fill(text.ago.value, { t: formatInterval(Date.now() - dueOf(it.card)) });
  };

  // The help strip's text, by the input used last (keys or gestures).
  const hintText =
    exhausted && ahead.length === 0 ? (
      <>
        {text.everyWordLearned} <Icon name="confetti" className="ms-0.5" />
      </>
    ) : modality === null ? null : modality === "touch" ? (
      // The gestures exist only in the touch layout; a touchscreen
      // laptop's tap is a click (= Again), and has no swipe to explain.
      // Each side's grades as the mirror (if on) puts them: the text's ← is
      // filled with the left side's grades, whatever they are.
      touch && fill(text.helpTouch.value, swipeSides)
    ) : help ? (
      fill(text.helpKeys.value, grades4)
    ) : (
      fill(text.helpKeysShort.value, grades4)
    );

  return (
    // Full width: wide screens get room for longer explanations.
    // In-flow content (loading, errors) starts below the glass toolbar.
    <div className="w-full px-3 pb-4 sm:px-8 sm:pb-6" style={{ paddingTop: bar.toolbar + 16 }}>
      {/* The toolbar: a glass overlay under the header, over the list. */}
      <div
        ref={topRef}
        data-words-top
        className="lk-words-bar lk-glass border-b border-[var(--glass-line)] py-2 text-sm"
        style={{ top: "calc(3.5rem + env(safe-area-inset-top))" }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <button
            className="tap-40 opacity-60 hover:opacity-100 whitespace-nowrap"
            onClick={onExit}
          >
            {scope?.exitLabel ?? text.backToLists}
          </button>
          <span className="font-medium">{title}</span>
          {scope?.toolbar}
          <button
            ref={settingsBtn}
            // Tapped seven times fast for debug: iOS must not turn that into a
            // text selection or a double-tap zoom.
            className={`tap-40 select-none touch-manipulation [-webkit-touch-callout:none] px-2 py-0.5 rounded text-xs ${
              settings
                ? "bg-black/20 dark:bg-white/25"
                : "bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
            }`}
            onClick={() => {
              setSettings((v) => !v);
              // Seven quick toggles turn the debug log on or off (the installed
              // app has no address bar for ?debug).
              debugTap();
            }}
            aria-expanded={settings}
            aria-label={text.settings.value}
          >
            <Icon name="gearSix" className="me-1" />
            {text.settings}
          </button>
          <span className="w-full sm:w-auto sm:ml-auto tabular-nums opacity-70 text-xs sm:text-sm">
            {debug && (
              <>
                <span className="mr-1 rounded bg-red-700 px-1 text-white" data-debug-badge>
                  {partnerName}
                </span>
                {/* Design prototypes, to try on the device itself. */}
                {["slip"].map((p) => (
                  <a key={p} href={`/proto/${p}`} data-debug-proto={p} className="mr-1 underline">
                    proto/{p}
                  </a>
                ))}
              </>
            )}
            {fill(text.stats.value, {
              done,
              rate: minutes > 0.2 ? Math.round(done / minutes) : "–",
              due: dueLeft,
              new: unseen,
            })}
            {sync.pending > 0 ? (
              <span
                data-sync="pending"
                className={sync.online ? "" : "text-amber-700 dark:text-amber-300"}
              >
                {sync.online
                  ? ` · ${fill(text.saving.value, { n: sync.pending })}`
                  : ` · ${text.offline.value} · ${fill(text.toSync.value, { n: sync.pending })}`}
              </span>
            ) : (
              <span data-sync="synced">
                {!sync.online || offlineCopy ? ` · ${text.offline.value}` : ""}
                {sync.online && grades.size > 0 ? ` · ${text.synced.value}` : ""}
              </span>
            )}
          </span>
        </div>
        {syncError && (
          <div className="text-red-500 text-sm mt-1">
            {fill(text.couldntLoadMore.value, { error: syncError })}
          </div>
        )}
        {notice && <div className="text-amber-600 dark:text-amber-300 text-sm mt-1">{notice}</div>}
      </div>

      {settings && (
        <SettingsSheet
          title={
            <>
              <Icon name="gearSix" className="me-1" />
              {text.settings}
            </>
          }
          label={text.studySettings.value}
          closeLabel={text.closeSettings.value}
          onClose={() => setSettings(false)}
          // The scrim covers the Settings button: a tap there still counts
          // toward the seven quick taps that toggle debug.
          onScrimTap={(x, y) => {
            const r = settingsBtn.current?.getBoundingClientRect();
            if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) debugTap();
          }}
          returnTo={settingsBtn}
        >
          <div className="flex flex-wrap gap-2">
            <TogglePill
              on={showAll}
              onChange={setShowAll}
              label={text.showAll.value}
              hint={text.showAllHint.value}
            />
            {speech.available && (
              <TogglePill
                on={speech.on}
                onChange={() => speech.toggle()}
                label={text.readAloud.value}
                hint={text.readAloudHint.value}
              />
            )}
            {speech.on && (
              <TogglePill
                on={serverVoice}
                onChange={setServerVoice}
                label={text.serverVoice.value}
                hint={text.serverVoiceHint.value}
              />
            )}
            {debug && <WhisperModeSetting text={text} />}
            {speech.on && serverVoice && (
              <span className="w-full text-xs opacity-60" data-voice-credit>
                {/* Credits: the voice names stay as their makers write them. */}
                {text.voices} VOICEVOX:No.7 ({text.japanese}) · Kokoro · Piper (Thorsten-Voice,
                Dmitri) · MeloTTS
              </span>
            )}
            <TogglePill
              on={tones}
              onChange={setTones}
              label={text.gradeTones.value}
              hint={text.gradeTonesHint.value}
            />
            {touch && (
              <TogglePill
                on={swipeSpeak}
                onChange={setSwipeSpeak}
                label={text.speakOnSwipe.value}
                hint={text.speakOnSwipeHint.value}
              />
            )}
            {(touch || voice !== "off") && (
              <span className="inline-flex flex-wrap items-center gap-x-2" data-swipe-mirror>
                <TogglePill
                  on={mirror}
                  onChange={setMirror}
                  label={text.swipeMirror.value}
                  hint={text.swipeMirrorHint.value}
                />
                {/* The mapping in force, live: it changes as the switch flips. */}
                <span className="fs-11 opacity-60" data-swipe-mirror-map>
                  {fill(text.swipeMirrorMap.value, {
                    left: `${swipeSides.hard} / ${swipeSides.again}`,
                    right: `${swipeSides.good} / ${swipeSides.easy}`,
                  })}
                </span>
              </span>
            )}
            {touch && !fs.standalone && (
              <TogglePill
                on={fs.active}
                onChange={toggleFullscreen}
                label={text.fullScreen.value}
                hint={text.fullScreenHint.value}
              />
            )}
            <TogglePill
              on={animationsOff}
              onChange={setMotionOff}
              label={text.animationsOff.value}
              hint={text.animationsOffHint.value}
            />
            <TextSizeControls compact />
            {/* Nothing experimental on a desktop without voice mode: no empty heading. */}
            {(touch || voice !== "off") && (
              <div className="w-full pt-1" data-experimental>
                <div className="fs-11 font-medium uppercase tracking-wide opacity-50">
                  {text.experimental}
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {touch && (
                    <TogglePill
                      on={swipeAb === "native"}
                      onChange={(on) => {
                        const v = on ? "native" : "js";
                        setSwipeVariant(v);
                        setSwipeAb(v);
                      }}
                      label={text.newSwipe.value}
                      hint={text.newSwipeHint.value}
                    />
                  )}
                  {/* The swipe's feel (docs/swipe-core.md): debug mode only, this device only. */}
                  {touch && debug && (
                    <>
                      <TogglePill
                        on={feelPrefs.preset === "heavy"}
                        onChange={(on) =>
                          setFeelPrefs({ ...feelPrefs, preset: on ? "heavy" : "light", tweaks: {} })
                        }
                        label={text.heavySwipe.value}
                        hint={text.heavySwipeHint.value}
                      />
                      <TogglePill
                        on={feelPrefs.tune}
                        onChange={(on) => setFeelPrefs({ ...feelPrefs, tune: on })}
                        label={text.tuneSwipe.value}
                        hint={text.tuneSwipeHint.value}
                      />
                    </>
                  )}
                  {voice !== "off" && (
                    <span className="inline-flex items-center gap-1" data-voice-setting={voice}>
                      <TogglePill
                        on={voicePref}
                        onChange={setVoicePref}
                        label={vtext.voiceMode.value}
                        hint={vtext.voiceModeHint.value}
                      />
                      {voice === "preview" && (
                        <span className="fs-10 opacity-60">{vtext.preview}</span>
                      )}
                    </span>
                  )}
                  {/* The mic's echo cancellation (packages/debug-chat aec.ts), this device only. */}
                  {voice !== "off" && (
                    <span className="flex w-full flex-col items-start gap-1" data-aec-setting>
                      <TogglePill
                        on={aec}
                        onChange={setAecPill}
                        label={vtext.echoCancel.value}
                        hint={vtext.echoCancelHint.value}
                      />
                      <span className="fs-10 opacity-60">{vtext.echoCancelHint}</span>
                    </span>
                  )}
                  <span className="text-xs opacity-60">
                    {touch ? `${text.nativeSwipeNote.value} ` : ""}
                    {text.mayChange}
                  </span>
                </div>
              </div>
            )}
          </div>
          {fsHint && (
            <div className="text-sm mt-2 opacity-80" onClick={() => setFsHint(false)}>
              {text.fsHint}
            </div>
          )}
        </SettingsSheet>
      )}

      {loadError ? (
        <div className="space-y-3 py-8 text-center">
          <div className="text-red-500">{fill(text.couldntLoad.value, { error: loadError })}</div>
          <button
            className="px-4 py-2 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
            onClick={() => location.reload()}
          >
            {text.retry}
          </button>
        </div>
      ) : loading ? (
        <div className="opacity-60">{text.loading}</div>
      ) : queue.length === 0 ? (
        <div className="py-8 text-center text-lg">
          {exhausted ? (
            <>
              {text.everyWordLearned}{" "}
              <Icon name="confetti" className="ms-1 text-blue-600 dark:text-blue-400" />
            </>
          ) : (
            text.loadingMore
          )}
        </div>
      ) : (
        <SwipeProviders mirror={mirror}>
          {/* The feel's sources and its tuner: islands (docs/swipe-core.md). */}
          {touch && <SwipeFeelIsland />}
          {touch && <SwipeTunerIsland />}
          <div
            ref={setListRef}
            // The whole window, edge to edge, under the glass overlays
            // (.lk-words-list); scroll-padding keeps resting rows clear of them.
            className="lk-words-list lk-fs-cards overflow-y-auto overscroll-contain"
            data-touch={touch ? "true" : "false"}
            // overflow-anchor: none — the padding and spacers change as rows
            // load; the browser must not "help" by shifting the scroll.
            style={{
              overflowAnchor: "none",
              scrollPaddingTop: bar.top,
              scrollPaddingBottom: bar.bottom,
            }}
            onScroll={(e) => {
              syncScroll(e.currentTarget.scrollTop);
              lastScrollAt.current = performance.now();
              const to = advancing.current;
              if (to && Math.abs(e.currentTarget.scrollTop - to.top) < 1) advancing.current = null;
              keepAnchor(e.currentTarget.scrollTop);
            }}
            onPointerDownCapture={() => {
              touchingList.current = true;
              // A list at rest is the finger's now: the next advance starts from
              // where it is. One still on its way keeps its target.
              if (!scrollingNow()) advancing.current = null;
            }}
            onPointerUpCapture={() => (touchingList.current = false)}
            onPointerCancelCapture={() => (touchingList.current = false)}
            // pointerup, not pointerdown: for touch it is the event that grants
            // the user activation full screen needs.
            onPointerUp={touch ? resumeFullscreen : undefined}
            role="list"
          >
            {/* The paper, scrolling with the rows: one composited layer the
            height of the whole content (both over-scroll pads included),
            under everything in the list. `background-attachment: local`
            on the list cost ~50 of 90 frames over 20ms on an iPhone; this
            layer scrolls as fast as the fixed body texture. */}
            <div
              aria-hidden
              data-paper-layer
              className="lk-paper-layer"
              style={{ height: pad * 2 + queue.length * ROW_H }}
            />
            {touch && !native && <SwipeUnderlay ref={underlay} />}
            <div className="relative" style={{ height: pad + from * ROW_H }}>
              {pad - bar.top > 140 && <EmptyTray style={{ top: bar.top, height: pad - bar.top }} />}
            </div>
            {queue.slice(from, to).map((it, k) => {
              const i = from + k;
              const g = grades.get(i);
              const rating = g?.rating;
              // The keyboard cursor reveals its row, as hovering does.
              const show = showAll || revealed.has(i) || (!touch && i === row) || holding === i;
              // The row being read: long cells slide to show their end.
              const glancing = touch ? holding === i || i === focusLine : i === row;
              // The A/B test's variant B: same props, the browser does the gesture.
              const Row = native ? NativeSlipRow : WordRow;
              return (
                <Row
                  key={i}
                  index={i}
                  touch={touch}
                  loose={touch ? i === focusLine : i === row}
                  onMore={() => setSheet(i)}
                  scrolling={scrollingNow}
                  underlay={underlay}
                  // Desktop click = Again; on touch a tap reveals and reads it.
                  onTap={(now) => {
                    if (!touch) return grade(i, 1);
                    // A double tap: the slip's other actions, in a sheet. Timed
                    // by the events themselves: a slow render after the first
                    // tap must not stretch the gap.
                    const second = lastTap.current.i === i && now - lastTap.current.t < 300;
                    lastTap.current = second ? { i: -1, t: 0 } : { i, t: now };
                    // A tap focuses the row (loosens its cords), as the cursor
                    // does on desktop; it reveals the answer and says the word.
                    // Re-rendering the list for the new focus must not hold up the tap.
                    quietFocus.current = i;
                    startTransition(() => setFocusLine(i));
                    if (!second) speech.once(partsOf(it), true);
                    // The second tap undoes the first one's reveal.
                    setRevealed((s) => {
                      const n = new Set(s);
                      if (n.has(i)) n.delete(i);
                      else n.add(i);
                      return n;
                    });
                    if (second) setSheet(i);
                  }}
                  onSwipeStart={() => {
                    // Only a loose slip slides: a swipe on a tied one loosens it first.
                    // A low-priority update: the finger must keep moving the slip
                    // while the list re-renders (iOS showed 50–160 ms frames).
                    if (touch) {
                      quietFocus.current = i;
                      startTransition(() => setFocusLine(i));
                    }
                    // The word, or with every meaning shown the whole card. Never
                    // over a long-press reading: that one plays on through the swipe.
                    if (swipeSpeak)
                      speech.once(
                        showAll
                          ? partsOf(it)
                          : [
                              {
                                kind: "word",
                                text: spokenText(it, it.lang, !!config.readingOnBack),
                                lang: it.lang,
                              },
                            ],
                        false,
                        { yieldToHold: true },
                      );
                  }}
                  onHold={() => {
                    setHolding(i);
                    speech.hold(partsOf(it));
                  }}
                  onHoldEnd={() => {
                    setHolding(null);
                    // Not cut on lifting: the pass in progress reads to its end,
                    // through a swipe that follows.
                    speech.release();
                  }}
                  // The row reports the side's default grade; the mirror swaps it here, once.
                  onSwipe={(r) => swipeGrade(i, sideRating(r, mirror))}
                  locked={() => retired(i)}
                  className={`slip group grid items-center gap-2 px-2 leading-none cursor-pointer select-none ${
                    touch
                      ? "slip-touch grid-cols-[1rem_var(--term-w,8rem)_1fr_3rem] text-base pr-4"
                      : hasExamples
                        ? "grid-cols-[1.25rem_var(--term-w,12rem)_var(--ex-w,minmax(10rem,1fr))_minmax(8rem,1fr)_3.5rem] fs-15"
                        : "grid-cols-[1.25rem_var(--term-w,12rem)_1fr_3.5rem] fs-15"
                  } ${rating ? RATING_STYLE[rating] : ""}`}
                  style={{ height: ROW_H }}
                  a={SWIPE_A}
                >
                  {/* The grade, stamped like a small seal (盖章) at the slip's left end. */}
                  <span className="flex justify-center fs-10" data-stamp-cell>
                    {rating ? (
                      <i key={rating} className="lk-stamp" aria-label={ratingLabel[rating]} />
                    ) : !touch && i === row ? (
                      <span className="opacity-40">▸</span>
                    ) : null}
                  </span>
                  <Glance
                    active={glancing}
                    title={it.reading ? `${it.term} ${it.reading}` : it.term}
                    className={`font-medium ${
                      it.kind === "new"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : it.kind === "again"
                          ? "text-amber-600 dark:text-amber-300"
                          : ""
                    }`}
                  >
                    {/* bdi: a right-to-left word (Hebrew) keeps its own direction and punctuation */}
                    <bdi lang={it.lang}>{it.term}</bdi>
                    {!config.readingOnBack && it.reading && it.reading !== it.term && (
                      <bdi className="ml-2 text-xs font-normal opacity-60">{it.reading}</bdi>
                    )}
                  </Glance>
                  {(() => {
                    // The back in the row's order (lib/words/row-layout.ts): the
                    // example, then the meaning; with no example the meaning
                    // takes its place. Each part is styled by its place, not by
                    // what it is: the first is the stronger.
                    const parts = backParts(it);
                    const cell = (k: (typeof parts)[number], at: number) => {
                      const first = at === 0;
                      const tone = touch
                        ? first
                          ? "text-sm opacity-80"
                          : "text-xs opacity-60"
                        : first
                          ? "text-sm opacity-80"
                          : "text-sm opacity-70";
                      // Desktop: a card without an example spans both columns.
                      const span = !touch && hasExamples && parts.length === 1 ? "col-span-2" : "";
                      const look = `${tone} ${span} transition-[filter] duration-75 ${
                        touch ? "block min-w-0" : ""
                      } ${show ? "" : "slip-blank"}`;
                      // The taller rows' room (owner, 2026-11-03): on a phone the
                      // first line (the example) may wrap once, the second stays
                      // one line; on desktop each column may take two lines.
                      const lines = !touch || first ? 2 : 1;
                      if (k === "meaning")
                        return (
                          <Glance
                            key={k}
                            active={glancing && show}
                            title={show ? it.back : undefined}
                            className={look}
                            lines={lines}
                          >
                            {config.readingOnBack && it.reading && it.reading !== it.term && (
                              <bdi className="mr-2 font-medium">{it.reading}</bdi>
                            )}
                            {it.back}
                          </Glance>
                        );
                      return (
                        <Glance
                          key={k}
                          active={glancing && show}
                          title={
                            show ? (it.ex ? `${it.ex}\n${it.exTr ?? ""}` : it.note) : undefined
                          }
                          className={look}
                          lines={lines}
                        >
                          {it.ex ? (
                            <>
                              <bdi lang={it.lang} data-row-example>
                                <MarkedExample text={it.ex} lang={it.lang} fam={fam.current} />
                              </bdi>
                              {it.exTr && (
                                <span className="ml-2 text-xs opacity-60">{it.exTr}</span>
                              )}
                            </>
                          ) : (
                            <span className="text-xs">
                              <PhraseNote note={it.note} register={it.register} />
                            </span>
                          )}
                        </Glance>
                      );
                    };
                    const cells = parts.map(cell);
                    if (!touch) return cells;
                    // Phones: one row is the whole card — the front, then the
                    // back beside it (example, then meaning), as "Show all
                    // meanings" shows and reads it. Two parts in the row's fixed
                    // height (side by side on a wider screen), the example
                    // wrapping once, so the windowing stays exact. Tags (level, list) are only in the double-tap sheet.
                    return (
                      <span
                        className="flex min-w-0 flex-col justify-center gap-1 sm:flex-row sm:items-baseline sm:gap-3"
                        data-row-back
                      >
                        {cells}
                      </span>
                    );
                  })()}
                  {/* Graded: when it comes back. Ungraded: "new", or how long it has been due. */}
                  <span
                    className={`flex items-center justify-end gap-1.5 fs-11 tabular-nums ${rating ? "font-medium" : "opacity-40"}`}
                    style={rating ? { color: "var(--grade)" } : undefined}
                    title={rating ? ratingLabel[rating] : text.dueTitle.value}
                  >
                    {status(it, i)}
                  </span>
                </Row>
              );
            })}
            <div className="relative" style={{ height: (queue.length - to) * ROW_H + pad }}>
              {pad - bar.bottom > 140 && (
                <EmptyTray style={{ bottom: bar.bottom, height: pad - bar.bottom }} />
              )}
            </div>
            {/* Last, so the rows' :nth-child grain is unchanged. */}
            <SlipCords
              top={pad}
              h={ROW_H}
              count={queue.length}
              from={from}
              to={to}
              loose={touch ? focusLine : row}
            />
          </div>
          {sheet !== null && queue[sheet] && (
            <SlipSheet
              item={queue[sheet]}
              tags={tagsOf(queue[sheet])}
              status={status(queue[sheet], sheet)}
              onClose={() => setSheet(null)}
              onListen={() => {
                const it = queue[sheet];
                speech.loop(partsOf(it), true);
              }}
              onCopy={() => {
                void navigator.clipboard?.writeText(queue[sheet].term).catch(() => {});
                setNotice(fill(text.copied.value, { term: queue[sheet].term }));
              }}
            />
          )}
          {/* The help strip: glass over the bottom of the list, shown only
            when there is room (a tall window, no on-screen keyboard). */}
          {room && hintText && (
            <div
              ref={hintRef}
              data-words-help
              className="lk-words-bar lk-glass bottom-0 border-t border-[var(--glass-line)] pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] fs-11"
            >
              <span className="opacity-75">{hintText}</span>
            </div>
          )}
          <VoiceBadge
            state={voiceMode.state}
            flash={voiceMode.flash}
            label={voiceLabel}
            retry={voiceMode.retry}
            bottom={bar.bottom}
          />
        </SwipeProviders>
      )}
    </div>
  );
}
/**
 * One row. On touch, tap = onTap and a horizontal swipe grades by the level
 * it snaps to (lib/words/swipe.ts snapSwipe); the row follows the finger, tinted the colour of the
 * grade it will give (no label: colour and the grade tone say enough). Rows only claim horizontal drags (touch-action: pan-y), so vertical
 * scrolling stays native.
 */
/**
 * A slip's other actions, in a sheet from the bottom of the screen — a slip
 * is too small to hold them. Only what works today; editing, suspending and
 * deleting a card join when they exist.
 */
function SlipSheet({
  item,
  tags,
  status,
  onClose,
  onListen,
  onCopy,
}: {
  item: Item;
  /** The word's tags (its list, the list's level): shown here only, never in the row. */
  tags: string[];
  status: React.ReactNode;
  onClose: () => void;
  onListen: () => void;
  onCopy: () => void;
}) {
  // The tap that opened the sheet may be followed by one more (a quick third
  // tap): that one lands on the scrim and must not close it at once.
  const openedAt = useRef(performance.now());
  const dismiss = () => performance.now() - openedAt.current > 350 && onClose();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const text = useIntlayer("words-page");
  const actions: [IconName, string, () => void][] = [
    ["speakerHigh", text.listenAgain.value, onListen],
    ["copy", text.copyWord.value, onCopy],
  ];
  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-label={text.wordActions.value}
      data-slip-sheet
    >
      <div className="absolute inset-0 bg-black/30 lk-fade-in" onClick={dismiss} />
      <div className="absolute inset-x-0 bottom-0 mx-auto max-w-lg rounded-t-2xl bg-[var(--background)] px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_oklch(0_0_0/0.25)] lk-sheet-in">
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-current opacity-20" />
        <div className="flex items-baseline gap-3 border-b border-black/10 dark:border-white/10 px-1 pb-3">
          <b className="text-2xl font-normal">
            <bdi lang={item.lang}>{item.term}</bdi>
          </b>
          {/* Example first (lib/words/row-layout.ts): with an example, the
          meaning comes after it, below; without one it stays up here. */}
          {!item.ex && <span className="truncate opacity-70">{item.back}</span>}
          <small className="ml-auto shrink-0 text-xs opacity-60">{status}</small>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pt-2" data-sheet-tags>
            {tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-black/5 dark:bg-white/10 px-2 py-0.5 text-xs opacity-80"
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {/* A phrase: its register, the moment it is said in, and the note in full. */}
        {item.note && (
          <div
            className="border-b border-black/10 dark:border-white/10 px-1 py-3 text-sm"
            data-sheet-note
          >
            <PhraseNote note={item.note} register={item.register} />
            {item.scene && <div className="mt-1 text-xs opacity-60">{item.scene}</div>}
          </div>
        )}
        {/* The row shows the example too; here it is in full. */}
        {item.ex && (
          <div
            className="border-b border-black/10 dark:border-white/10 px-1 py-3"
            data-sheet-example
          >
            <div lang={item.lang} dir="auto">
              {item.ex}
            </div>
            {item.exTr && <div className="mt-1 text-sm opacity-60">{item.exTr}</div>}
          </div>
        )}
        {item.ex && (
          <div
            className="border-b border-black/10 dark:border-white/10 px-1 py-3 opacity-70"
            data-sheet-meaning
          >
            {item.back}
          </div>
        )}
        <ul className="mt-1">
          {actions.map(([icon, label, run]) => (
            <li key={label}>
              <button
                className="flex w-full items-center gap-4 rounded-lg px-2 py-3 text-left active:bg-black/10 dark:active:bg-white/10"
                onClick={() => {
                  run();
                  onClose();
                }}
              >
                <Icon name={icon} className="w-6 text-xl opacity-80" />
                {label}
              </button>
            </li>
          ))}
        </ul>
        <button
          className="mt-2 w-full rounded-xl bg-black/10 dark:bg-white/10 py-3 font-semibold"
          onClick={onClose}
        >
          {text.cancel}
        </button>
      </div>
    </div>
  );
}

/**
 * The binding cords (编绳) down both edges of the list: one layer over the
 * rows, not part of any slip, so a slip slides out from under its cords (both
 * swipes) and nothing follows the finger. It sits inside the list scroller,
 * so it scrolls with the rows, as the paper does. One cell per rendered row,
 * at the row's place: tied, the cord runs straight on; the focused row's
 * (`loose`) bows inward. A loose cord is the same path at full bow, squeezed
 * flat by scaleX when tied, so loosening and tightening are a CSS transition
 * (200 ms, minimum jerk) and no frame runs in JS.
 */
function SlipCords({
  top,
  h,
  count,
  from,
  to,
  loose,
}: {
  /** Where the first row starts in the list (the top over-scroll pad). */
  top: number;
  /** The row height. */
  h: number;
  count: number;
  /** The rendered rows. */
  from: number;
  to: number;
  /** The focused row: its cords are loose. */
  loose: number;
}) {
  const bow = CORD_BOW * h;
  const left = cordPath(4.5, h, bow);
  const right = cordPath(35.5, h, -bow);
  const cells = [];
  for (let i = from; i < to; i++)
    cells.push(
      <span key={i} data-cords={i === loose ? "loose" : "tied"} style={{ top: i * h, height: h }}>
        <svg className="slip-cord" style={{ left: 0 }}>
          <path d={left} />
        </svg>
        <svg className="slip-cord slip-cord-end" style={{ right: 0 }}>
          <path d={right} />
        </svg>
      </span>,
    );
  return (
    <div
      aria-hidden
      data-slip-cords
      className="slip-cords"
      style={{ top, height: count * h, ["--cord-ease" as string]: MIN_JERK_EASING }}
    >
      {cells}
    </div>
  );
}

/** The grade zones island, labelled with the grades' names in the app's language. */
function GradeZones() {
  const l = useRatingLabel();
  const mirror = useContext(SwipeMirror);
  return <SwipeGradesIsland again={l[1]} hard={l[2]} good={l[3]} easy={l[4]} mirror={mirror} />;
}

/**
 * What a sliding slip uncovers: one static strip per list, put under the slip
 * as it starts to slide. Slid right, the slip uncovers Good (its first row's
 * width a) then Easy; slid left, Hard then Again — the levels it snaps to
 * (lib/words/swipe.ts). Painted once: changing level repaints nothing, the
 * slip only moves over it.
 */
function SwipeUnderlay({ ref }: { ref: React.RefObject<HTMLDivElement | null> }) {
  const mirror = useContext(SwipeMirror);
  return (
    <div
      ref={ref}
      aria-hidden
      data-swipe-underlay
      data-mirror={mirror ? "" : undefined}
      className="pointer-events-none absolute inset-x-0 overflow-hidden"
      style={{ visibility: "hidden", background: "var(--slip-seam)" }}
    >
      <GradeZones />
    </div>
  );
}

type RowProps = {
  index: number;
  touch: boolean;
  /** Focused: it lifts, its cords (SlipCords) come loose, and only a loose slip slides. */
  loose?: boolean;
  /** `at`: when the finger lifted (the event's own time, not when it was handled). */
  onTap: (at: number) => void;
  /** The slip's other actions (desktop: right click). */
  onMore?: () => void;
  onSwipe: (r: Rating) => void;
  /** The slip reads "↓ back" (lib/words/requeue.ts): it taps and holds, never slides. */
  locked?: () => boolean;
  /** The finger has started moving sideways (a grade is being decided). */
  onSwipeStart?: () => void;
  /** The list's one SwipeUnderlay: moved under this slip as it starts sliding. */
  underlay?: React.RefObject<HTMLDivElement | null>;
  /** Held still for HOLD_MS: listen mode until the finger lifts. */
  onHold?: () => void;
  onHoldEnd?: () => void;
  /** The list is (or just was) scrolling: a touch now is catching a fling. */
  scrolling?: () => boolean;
  /** The swipe's travel unit, one detent (px): the old row height, not the row's own. */
  a: number;
  className: string;
  style: React.CSSProperties;
  children: React.ReactNode;
};

function WordRow(props: RowProps) {
  // Desktop rows never slide: no gesture core, no islands.
  return props.touch ? <TouchWordRow {...props} /> : <DeskWordRow {...props} />;
}

function DeskWordRow({
  index,
  loose = false,
  onTap,
  onMore,
  className,
  style,
  children,
}: RowProps) {
  return (
    <div
      role="listitem"
      data-i={index}
      // No hover handler: the mouse never moves the focused slip (owner,
      // 2026-11-04). It moves by keys, grading and voice; hovering only
      // reveals the blank (CSS .group:hover), which leaves the focus alone.
      onClick={(e) => onTap(e.timeStamp)}
      onContextMenu={(e) => {
        if (!onMore) return;
        e.preventDefault();
        onMore();
      }}
      className={`relative ${className} ${loose ? "slip-loose" : ""}`}
      style={style}
    >
      {children}
    </div>
  );
}

/**
 * The js swipe (variant A): the headless core (lib/words/swipe-core.tsx)
 * runs the gesture and moves the card; the card and its lift are islands
 * that read the core's context (docs/swipe-core.md).
 */
function TouchWordRow({
  index,
  loose = false,
  onTap,
  onSwipe,
  locked,
  onSwipeStart,
  onHold,
  onHoldEnd,
  scrolling,
  underlay,
  a,
  className,
  style,
  children,
}: RowProps) {
  const { feel, reducedMotion } = useSwipeFeel(SWIPE_CORE_IFACE);
  if (swipePerf.on) swipePerf.renders++;
  const core = useSwipeGesture({
    a,
    feel,
    reducedMotion,
    holdMs: HOLD_MS,
    scrolling,
    locked,
    onTap,
    onSwipe,
    onSwipeStart,
    onHold,
    onHoldEnd,
    perf: swipePerf,
    onSlide: (row) => {
      // Only one slip slides at a time: the list's underlay goes under it,
      // once — what the slip uncovers then shows the grade, with no repaint
      // as the level changes.
      const u = underlay?.current;
      if (!u) return;
      u.style.top = `${row.offsetTop}px`;
      u.style.height = `${row.offsetHeight}px`;
      // Under the row itself: on a tablet the list is padded by the glass
      // nav, and the zones must line up with the slip.
      u.style.left = `${row.offsetLeft}px`;
      u.style.right = "auto";
      u.style.width = `${row.offsetWidth}px`;
      u.style.setProperty("--a", `${a}px`);
      showReveal(u, 0);
      u.style.visibility = "visible";
    },
    onLevel: (k) => {
      // A light tick at each level, either way (Android; iOS has no API).
      navigator.vibrate?.(Math.abs(k) === 2 ? 12 : 6);
      showReveal(underlay?.current, k);
    },
    onRelease: (r) =>
      logSwipe({ finger: r.finger, v: r.v, projected: r.projected, rating: r.rating, a }),
  });
  const value: SwipeRowValue = {
    iface: 1,
    variant: "js",
    phase: core.phase,
    feel,
    reducedMotion,
    card: {
      bind: core.bind,
      index,
      className: `relative ${className} ${loose ? "slip-loose" : ""}`,
      style: {
        ...style,
        touchAction: "pan-y",
        // A hold is listen mode, not iOS's callout / text-selection menu.
        WebkitTouchCallout: "none",
        // transform and transition are the core's: it writes them.
      },
      children: (
        <>
          {children}
          <SwipeCueIsland />
        </>
      ),
    },
  };
  return (
    <SwipeRowProvider value={value}>
      <SwipeCardIsland />
    </SwipeRowProvider>
  );
}

/**
 * Variant B of the swipe A/B test (lib/words/swipe-ab.ts): WordRow's slip,
 * but each row is its own horizontal scroller (public/proto/slip.html). The
 * browser locks the axis, follows the finger, coasts, snaps to the levels at
 * 0, ±a, ±2a and stops hard at ±2a — all on the compositor; script runs only
 * as a gesture starts and ends. What the slip uncovers is the same grade
 * strip as SwipeUnderlay, held still behind the face (sticky); its cords are
 * the list's (SlipCords), not the slip's; it glides home by a smooth scroll.
 * Touch only: desktop rows are always WordRow.
 */
function NativeSlipRow({
  index,
  loose = false,
  onTap,
  onSwipe,
  locked,
  onSwipeStart,
  onHold,
  onHoldEnd,
  scrolling,
  a,
  className,
  style,
  children,
}: RowProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const mirror = useContext(SwipeMirror);
  // Rows mount as the list scrolls: each starts centred before it is painted.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = 2 * a;
  }, [a]);
  const { feel, reducedMotion } = useSwipeFeel(SWIPE_CORE_IFACE);
  if (swipePerf.on) swipePerf.renders++;
  /** The gesture's phase, for the lift cue: changes only as a gesture starts and ends. */
  const phase = useNativeSlip(scroller, a, {
    onTap,
    onSwipe,
    onSwipeStart,
    onHold,
    onHoldEnd,
    scrolling,
    locked,
    feel,
    reducedMotion,
    holdMs: HOLD_MS,
    log: logSwipe,
    perf: swipePerf,
  });
  const value: SwipeRowValue = {
    iface: 1,
    variant: "native",
    phase,
    feel,
    reducedMotion,
    card: null,
  };
  return (
    <SwipeRowProvider value={value}>
      <div
        role="listitem"
        data-i={index}
        data-swipe="native"
        // Raised over its neighbours while lifted, so the lift's shadow shows (globals.css).
        data-swipe-phase={feel.lift > 0 ? phase : undefined}
        // The wrapper lifts the focused slip (z-index, shadow): the scroller
        // would clip a shadow drawn by the face.
        className={`slip-native ${loose ? "slip-loose" : ""}`}
        style={{ height: style.height, ["--a" as string]: `${a}px` }}
      >
        <SwipeCueIsland />
        {/* Behind the scroller, not inside it: the face (opaque, above) uncovers
          it only by sliding away. A sticky strip inside the scroller painted
          over the face on iOS (WebKit composites sticky layers on their own). */}
        <div
          aria-hidden
          className="slip-strip"
          data-swipe-strip
          data-mirror={mirror ? "" : undefined}
        >
          <GradeZones />
        </div>
        <div ref={scroller} className="slip-scroller" style={{ WebkitTouchCallout: "none" }}>
          <div className="slip-track">
            {[0, 1, 2, 3, 4].map((k) => (
              <i key={k} className="slip-snap" style={{ left: k * a }} />
            ))}
            <div className={`slip-face ${className} ${loose ? "slip-loose" : ""}`}>{children}</div>
          </div>
        </div>
      </div>
    </SwipeRowProvider>
  );
}
