"use client";

import {
  startTransition,
  useCallback,
  useEffect,
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
import { applyDrop, descendants, flatten, projectDrop, visible } from "@/lib/words/tree";
import type { WordCard, WordList } from "@/lib/repos/wordsD1";
import { spokenText } from "@/lib/words/spoken";
import { MEANING_VOICE, prefetchOrder, sayParts, type SayPart } from "@/lib/words/say-parts";
import { createSequencer } from "@/lib/words/sequence";
import { AudioCache } from "@/lib/words/audio-cache";
import { debugOn, devLog } from "@/lib/debug-client";
import { useInputModality } from "@/lib/use-input-modality";
import { EmptyTray } from "./EmptyTray";
import { useDebugToggle } from "@/app/components/useDebugToggle";
import {
  COLUMN_QUANTILE,
  centreWeight,
  nextGoal,
  splitTarget,
  termTarget,
  weightedQuantile,
} from "@/lib/words/columns";
import { MIN_JERK_EASING, cssLinear, minJerk, moveSeconds, springStep } from "@/lib/words/motion";
import { CORD_BOW, cordPath, cordPull } from "@/lib/words/cords";
import {
  type Axis,
  type SwipeLevel,
  lockAxis,
  releaseLevel,
  releaseRating,
  releaseVelocity,
  restRating,
  snapSwipe,
  springProgress,
  swipeLevel,
  revealShown,
  SWIPE_COAST_MS,
  SWIPE_HYSTERESIS,
  SWIPE_LEVEL,
  SWIPE_RETURN_S,
  SWIPE_SNAP,
  SWIPE_SPRING,
  SWIPE_VELOCITY_MS,
} from "@/lib/words/swipe";
import { setSwipeVariant, swipeAbTag, swipeVariant, type SwipeVariant } from "@/lib/words/swipe-ab";
import { downloadCatalog, loadCatalog } from "@/lib/words/catalog-cache";
import { idbAdd, idbAll, idbDelete, idbGet, idbPut, type PendingOp } from "@/lib/words/idb";
import {
  afterSend,
  backoff,
  pendingReviewed,
  reviewedKey,
  sendOrder,
  undoTarget,
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
/** A released slip springs home: the critically damped spring, as a CSS easing. */
const SPRING_EASING = cssLinear(springProgress, 32);
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
/** Variant B's tuning, for its telemetry rows: the browser's scroll snapping. */
const NATIVE_PARAMS = "scroll-snap";
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
  const unsent = readJson<SwipeRow>(UNSENT);
  unsent.push({
    at: new Date().toISOString(),
    finger: Math.round(e.finger * 10) / 10,
    v: Math.round(e.v * 1000) / 1000,
    projected: Math.round(e.projected * 10) / 10,
    rating: e.rating,
    a: e.a,
    params: `${e.params ?? SWIPE_PARAMS};${swipeAbTag()}${e.ev ? `;ev=${e.ev}` : ""}`,
  });
  try {
    localStorage.setItem(UNSENT, JSON.stringify(unsent.slice(-400)));
  } catch {}
  if (unsent.length >= 20) flushSwipes();
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
/** The slip colour a swipe would grade to, shown while the finger is down. */
const SWIPE_BG: Record<Rating, string> = {
  1: "var(--slip-again)",
  2: "var(--slip-hard)",
  3: "var(--slip-good)",
  4: "var(--slip-easy)",
};
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
};
/** The URL of a catalog's entries. */
const catalogPath = (base: string, c: CatalogMeta) => c.path ?? `${base}/${c.file}`;
/** An Anki deck imported at /words/import: its words live in D1, not a catalog file. */
const isImported = (l: { source: string | null }) => !!l.source?.startsWith("anki:");
/** Imported lists, described as catalogs so the rest of the page needs no special case. */
const importedCatalog = (lists: WordList[]): CatalogMeta[] =>
  lists.filter(isImported).map((l) => ({
    id: l.source!,
    lang: l.lang,
    name: l.name,
    level: "",
    count: l.size,
    file: "",
    source: "Anki",
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
const RATING_LABEL: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

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
 * A remembered on/off setting (localStorage), the same across refreshes.
 * Reads after mount, so server and first client render agree.
 */
function usePref(key: string, initial: boolean) {
  const [on, setOn] = useState(initial);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === "1" || v === "0") setOn(v === "1");
    } catch {}
  }, [key]);
  const set = useCallback(
    (next: boolean | ((v: boolean) => boolean)) =>
      setOn((v) => {
        const n = typeof next === "function" ? next(v) : next;
        try {
          localStorage.setItem(key, n ? "1" : "0");
        } catch {}
        return n;
      }),
    [key],
  );
  return [on, set] as const;
}

/** A pill-shaped switch for the settings panel. */
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
  en: "en-US",
};

/**
 * Debug-only swipe profiler: frame times while a finger is on a slip, plus
 * how often the slip rendered and how long the loose-cord frames took.
 * Reported to devLog when the finger lifts.
 */
const swipePerf = {
  on: false,
  frames: [] as number[],
  renders: 0,
  cordFrames: 0,
  cordMs: 0,
  raf: 0,
  last: 0,
  start() {
    if (!debugOn()) return;
    this.on = true;
    this.frames = [];
    this.renders = 0;
    this.cordFrames = 0;
    this.cordMs = 0;
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
      cordFrames: this.cordFrames,
      cordMsPerFrame: this.cordFrames ? +(this.cordMs / this.cordFrames).toFixed(2) : 0,
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

/** Rows past the last one near the screen whose audio is fetched ahead too. */
const PREFETCH_NEXT = 5;

/** How long a word clip takes to fade out when the card changes. */
const FADE_S = 0.15;

/**
 * An <audio> element for a clip, routed through a gain node so it can fade
 * out — iOS ignores `volume` on media elements. Without Web Audio, a plain
 * element (it then stops at once).
 */
type Clip = HTMLAudioElement & { gain?: GainNode };
function playable(url: string): Clip {
  const a: Clip = new Audio(url);
  try {
    const ac = sharedAudioContext();
    if (ac && "createMediaElementSource" in ac) {
      const g = ac.createGain();
      ac.createMediaElementSource(a).connect(g).connect(ac.destination);
      a.gain = g;
    }
  } catch {
    // Web Audio refused the element: it plays unfaded.
  }
  return a;
}

/** Fade a playing clip out and stop it; no fade in, so the next word starts at once. */
function fadeOut(a: Clip | null) {
  if (!a || a.paused) return;
  a.onended = null;
  const ac = sharedAudioContext();
  if (!a.gain || !ac) return void a.pause();
  const now = ac.currentTime;
  a.gain.gain.cancelScheduledValues(now);
  a.gain.gain.setValueAtTime(a.gain.gain.value, now);
  a.gain.gain.linearRampToValueAtTime(0, now + FADE_S);
  setTimeout(
    () => {
      a.pause();
      a.gain?.disconnect();
    },
    FADE_S * 1000 + 30,
  );
}

/**
 * Word audio for this tab, shared by every mount of the page: each clip is
 * fetched once per session (lib/words/audio-cache.ts).
 */
let sharedAudio: AudioCache | null = null;
function wordAudio(): AudioCache {
  sharedAudio ??= new AudioCache({
    fetch: (url, init) => fetch(url, init),
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    connection: () =>
      (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
        .connection,
    log: devLog,
  });
  return sharedAudio;
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
  /**
   * Bumped by cancel(). cancel() can fire the old utterance's onend, which
   * would otherwise go on with the old word beside the new one.
   */
  const generation = useRef(0);

  const [available, setAvailable] = useState(false);
  /** Languages the browser failed to speak; the server speaks them instead. */
  const browserDead = useRef(new Set<string>());
  const audio = useRef<HTMLAudioElement | null>(null);
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
      return (
        exact.find((v) => v.localService) ??
        exact[0] ??
        vs.find((v) => v.localService) ??
        vs[0] ??
        null
      );
    },
    [voices],
  );

  /** Silence the part playing now; callbacks of what was playing are ignored. */
  const cancel = useCallback(() => {
    generation.current++;
    clearTimeout(watchdog.current);
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    // A clip cut mid-word is jarring when the card changes: fade it out.
    fadeOut(audio.current);
    audio.current = null;
  }, []);

  type Done = (played: boolean) => void;

  /** Play the server's recording of `text`. False when it could not (no voice, limit, offline). */
  const serverSpeak = useCallback(async (text: string, lang: string, done: Done) => {
    const gen = generation.current;
    // Prefetched, most of the time: then it plays at once, still inside the
    // tap's gesture (no await before play()).
    const r = wordAudio().peek(lang, text) ?? (await wordAudio().load(lang, text));
    if (r.kind !== "ok") return false;
    if (gen !== generation.current) return true;
    // A fresh element per clip: the previous one may still be fading out.
    const a = playable(r.url);
    audio.current = a;
    a.onended = () => done(true);
    a.onerror = () => done(false);
    void a.play().catch(() => {});
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
        if (serverTried) return done(false);
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
    (p: SayPart, done: Done) => {
      devLog({ ev: "speak", kind: p.kind, lang: p.lang, text: p.text, serverVoice });
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
   * Say `parts` in turn (word, meaning, example), pause, repeat — until the
   * next call; an empty list just stops.
   */
  const loop = useCallback(
    (parts: SayPart[], force = false) => {
      if (!on && !force) return stop();
      // A short delay so flicking through rows does not start a word per row.
      sequencer.play(
        parts.filter((p) => p.text),
        { loop: true, delayMs: 250 },
      );
      return stop;
    },
    [on, sequencer, stop],
  );

  /** Say `parts` once, back to back, now — interrupting whatever was playing. */
  const once = useCallback(
    (parts: SayPart[], force = false) => {
      if (!on && !force) return stop();
      sequencer.play(parts.filter((p) => p.text));
    },
    [on, sequencer, stop],
  );

  /** Fetch the clips of rows about to be tapped (only those the server would voice). */
  const prefetch = useCallback(
    (parts: SayPart[]) => wordAudio().prefetch(parts.filter(viaServer)),
    [viaServer],
  );

  const toggle = useCallback(() => {
    setOn((v) => {
      try {
        localStorage.setItem("lk:words-sound", v ? "off" : "on");
      } catch {}
      if (v) stop();
      return !v;
    });
  }, [stop]);

  return useMemo(
    () => ({ available, on, loop, once, toggle, prefetch }),
    [available, on, loop, once, toggle, prefetch],
  );
}

/**
 * Glance motion (lib/words/motion.ts): peak acceleration in px/s², and the
 * pauses (s) to read the start and the end. A 200px slide takes ~1.6s.
 */
const GLANCE_ACCEL = 450;
const GLANCE_HOLD_START = 1.0;
const GLANCE_HOLD_END = 1.2;

/**
 * A cell that would be cut off: on the active row it slides to its end,
 * pauses, and slides back — a minimum-jerk move, run by the compositor
 * through the Web Animations API — so a long word or
 * meaning can be read in full without leaving the list. Elsewhere it ends in
 * an ellipsis, and hovering shows the whole text.
 */
function Glance({
  active,
  className,
  title,
  children,
}: {
  active: boolean;
  className: string;
  title?: string;
  children: React.ReactNode;
}) {
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
      const extra = o.scrollWidth - o.clientWidth;
      setOver(extra > 2 ? Math.ceil(extra) : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    return () => ro.disconnect();
  }, [active, children, title]);
  useEffect(() => {
    const i = inner.current;
    if (!over || !i || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = moveSeconds(over, GLANCE_ACCEL);
    const total = GLANCE_HOLD_START + move + GLANCE_HOLD_END + move;
    const at = (s: number) => s / total;
    const end = `translateX(-${over}px)`;
    const anim = i.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: at(GLANCE_HOLD_START), easing: MIN_JERK_EASING },
        { transform: end, offset: at(GLANCE_HOLD_START + move) },
        {
          transform: end,
          offset: at(GLANCE_HOLD_START + move + GLANCE_HOLD_END),
          easing: MIN_JERK_EASING,
        },
        { transform: "translateX(0)", offset: 1 },
      ],
      { duration: total * 1000, iterations: Infinity },
    );
    return () => anim.cancel();
  }, [over]);
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
  const left = due - now;
  if (left > 0) return <>{formatInterval(left)}</>;
  return back ? <span className="lk-back">↓ back</span> : <>now</>;
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
  /**
   * Where `reading` goes. Words put it on the hidden back (kana or pinyin is
   * part of the answer); alphabets keep it on the front as a hint.
   */
  readingOnBack?: boolean;
  /** Offer importing Anki decks (/words/import) and show the imported lists. */
  imports?: boolean;
};

const WORDS: DrillConfig = {
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
 */
function useListParam(): [string | null, (id: string | null) => void] {
  const read = () =>
    typeof location === "undefined" ? null : new URLSearchParams(location.search).get("list");
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(read());
    const onPop = () => setId(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((next: string | null) => {
    const url = new URL(location.href);
    if (next) url.searchParams.set("list", next);
    else url.searchParams.delete("list");
    history.pushState(null, "", url);
    setId(next);
  }, []);
  return [id, go];
}

export default function WordsClient({ config = WORDS }: { config?: DrillConfig }) {
  const [allLists, setLists] = useState<WordList[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogMeta[] | null>(null);
  const [listId, setListId] = useListParam();
  const [error, setError] = useState<string | null>(null);
  /** The lists shown came from the offline copy. */
  const [offline, setOffline] = useState(false);
  useOfflineShell();

  const refreshLists = useCallback(async () => {
    try {
      const { lists } = await api<{ lists: WordList[] }>("/api/words/lists");
      setLists(lists);
      setOffline(false);
      idbPut("lists", lists, "all").catch(() => {});
    } catch (e) {
      const cached =
        e instanceof OfflineError
          ? await idbGet<WordList[]>("lists", "all").catch(() => undefined)
          : undefined;
      if (cached) {
        setLists(cached);
        setOffline(true);
      } else setError((e as Error).message);
    }
  }, []);

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
    return (
      allLists?.filter(
        (l) =>
          l.source &&
          (ids.has(l.source) || l.source === group || (config.imports && isImported(l))),
      ) ?? null
    );
  }, [allLists, catalog, config]);
  // The built-in catalogs plus this user's imported decks.
  const fullCatalog = useMemo(
    () => (catalog && lists ? [...catalog, ...importedCatalog(lists)] : null),
    [catalog, lists],
  );

  if (error)
    return (
      <div className="p-8 text-red-400">
        {error === "Login required" ? "Sign in to use word lists." : error}
      </div>
    );
  if (!lists || !catalog || !fullCatalog) return <div className="p-8 opacity-60">Loading…</div>;

  // A row studies itself and everything below it, in tree order; groups hold
  // no words of their own.
  const flat = flatten(lists);
  const scope =
    listId === ALL
      ? flat
      : flat.filter((x) => x.id === listId || descendants(flat, listId ?? "").includes(x.id));
  const studying = scope.filter((l) => l.source !== groupSourceOf(config));
  // "Study all" with only one list is just that list.
  if (studying.length)
    return (
      <Study
        key={listId}
        config={config}
        lists={studying}
        catalog={fullCatalog}
        title={
          listId === ALL
            ? `All ${config.title.toLowerCase()}`
            : (lists.find((l) => l.id === listId)?.name ?? studying[0].name)
        }
        onExit={() => {
          setListId(null);
          refreshLists();
        }}
      />
    );

  return (
    <ListPicker
      config={config}
      lists={lists}
      catalog={fullCatalog}
      offline={offline}
      onOpen={setListId}
      onCreated={async (id) => {
        await refreshLists();
        setListId(id);
      }}
      onDeleted={refreshLists}
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
type Totals = { due: number; learning: number; mastered: number; cards: number; total: number };

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
  onDeleted,
  keys,
}: {
  list: WordList;
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
  onDeleted: () => void;
}) {
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
        marginLeft: depth * INDENT,
      }}
      className={`relative flex items-center gap-3 rounded-lg px-4 py-3 ${
        isDragging
          ? "z-10 bg-black/10 dark:bg-white/15 ring-1 ring-black/20 dark:ring-white/30 shadow-lg"
          : isGroup
            ? "bg-black/[0.07] dark:bg-white/[0.08]"
            : "bg-black/5 dark:bg-white/5"
      }`}
    >
      <span
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
        title="Drag to reorder · drag right to put it inside the row above, left to take it out"
        className="cursor-grab active:cursor-grabbing select-none opacity-40 hover:opacity-100 px-1 text-lg leading-none touch-none"
      >
        ⠿
      </span>
      <button
        className={`w-4 text-xs opacity-60 hover:opacity-100 ${hasChildren ? "" : "invisible"}`}
        onClick={onToggle}
        aria-label={collapsed ? "Expand" : "Collapse"}
      >
        {collapsed ? "▸" : "▾"}
      </button>
      {keys && index < 9 && <kbd className="text-xs opacity-40 tabular-nums">{index + 1}</kbd>}
      <button className="flex-1 text-left min-w-0" onClick={() => onOpen(l.id)}>
        <div className="font-medium truncate">
          {isGroup && <Icon name="folder" className="me-1 opacity-70" />}
          {l.name}
        </div>
        <div className="text-xs opacity-60 tabular-nums">
          {totals.due} due · {totals.learning} learning · {totals.mastered} mastered (≥1y) ·{" "}
          {totals.cards}/{totals.total || "?"} seen
        </div>
      </button>
      <button
        className="px-3 py-1.5 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
        onClick={() => onOpen(l.id)}
      >
        {text.study}
      </button>
      <button
        // A 40px hit area (tap-40) around the small label.
        className="tap-40 text-xs opacity-40 hover:opacity-80"
        onClick={async () => {
          const what = isGroup
            ? `Delete group "${l.name}"? The lists inside it are kept and move up a level.`
            : `Delete "${l.name}" and its progress?`;
          if (!confirm(what)) return;
          await api(`/api/words/lists/${l.id}`, { method: "DELETE" });
          onDeleted();
        }}
      >
        {text.delete}
      </button>
    </div>
  );
}

function ListPicker({
  config,
  lists,
  catalog,
  offline,
  onOpen,
  onCreated,
  onDeleted,
  onReorder,
}: {
  config: DrillConfig;
  lists: WordList[];
  catalog: CatalogMeta[];
  /** Showing the offline copy of the lists. */
  offline: boolean;
  onOpen: (id: string) => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  /** The whole tree in display order; also the order new words are learned in. */
  onReorder: (order: { id: string; parentId: string | null }[]) => void;
}) {
  const groupSource = groupSourceOf(config);
  const isGroup = (l: WordList) => l.source === groupSource;
  const text = useIntlayer("words-page");
  // Number keys open lists: show them only with a hardware keyboard.
  const keys = useInputModality() === "keyboard";
  const flat = useMemo(() => flatten(lists), [lists]);
  const [download, setDownload] = useState<{
    done: number;
    total: number;
    error?: string;
  } | null>(null);

  // Collapsed groups, remembered per page.
  const collapsedKey = `lk:words-collapsed:${config.base}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      setCollapsed(new Set(JSON.parse(localStorage.getItem(collapsedKey) ?? "[]")));
    } catch {}
  }, [collapsedKey]);
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(collapsedKey, JSON.stringify([...n]));
      } catch {}
      return n;
    });

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
  const langs = useMemo(() => [...new Set(builtIn.map((c) => c.lang))], [builtIn]);
  const [lang, setLang] = useState<string>("");
  const added = new Set(lists.map((l) => l.source));
  const studyable = lists.filter((l) => !isGroup(l));

  // 1–9 open the matching row, 0 studies everything — no mouse needed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      const n = Number(e.key);
      if (e.key === "0" && studyable.length > 1) onOpen(ALL);
      else if (n >= 1 && n <= 9 && items[n - 1]) onOpen(items[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, studyable.length, onOpen]);

  const add = async (c: CatalogMeta) => {
    setBusy(true);
    try {
      const { list } = await api<{ list: WordList }>("/api/words/lists", {
        method: "POST",
        body: JSON.stringify({ name: c.name, lang: c.lang, source: c.id }),
      });
      onCreated(list.id);
    } finally {
      setBusy(false);
    }
  };

  const addGroup = async () => {
    const name = prompt("Group name")?.trim();
    if (!name) return;
    await api("/api/words/lists", {
      method: "POST",
      body: JSON.stringify({ name, lang: "mul", source: groupSource }),
    });
    onDeleted(); // refresh
  };

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{config.title}</h1>
        <p className="opacity-70 text-sm mt-1">{config.intro}</p>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
          {offline ? (
            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">
              Offline — showing your downloaded lists. Grades sync when you are back online.
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
              title="Save every list and today's due words on this device, to study without a network"
            >
              <Icon name="downloadSimple" className="me-1" />
              Download for offline
            </button>
          )}
          {download && !offline && (
            <span className="opacity-70 tabular-nums">
              {download.error
                ? `Download failed: ${download.error}`
                : download.done < download.total
                  ? `Downloading ${download.done}/${download.total}…`
                  : "Saved on this device ✓"}
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
            {studyable.reduce((n, l) => n + l.due, 0)} due
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
                  onDeleted={onDeleted}
                  keys={keys}
                />
              ))}
            </SortableContext>
          </DndContext>
          <p className="text-[11px] opacity-40">
            Drag ⠿ up or down to reorder; drag it right to put a list inside the one above (like
            Anki subdecks), left to take it out. Studying a group studies everything inside.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={addGroup}
          className="text-sm px-3 py-1.5 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
        >
          + New group
        </button>
        {config.imports && <ImportLink />}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium opacity-80">Add a list</h2>
        <div className="flex flex-wrap gap-2">
          {langs.map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`px-3 py-1 rounded text-sm ${l === lang ? "bg-black/20 dark:bg-white/25" : "bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"}`}
            >
              {l}
            </button>
          ))}
        </div>
        {lang && (
          <div className="space-y-1">
            {builtIn
              .filter((c) => c.lang === lang)
              .map((c) => (
                <div key={c.id} className="flex items-center gap-3 text-sm">
                  <span className="flex-1">{c.name}</span>
                  <span className="opacity-50 tabular-nums">{c.count}</span>
                  <button
                    disabled={busy || added.has(c.id)}
                    onClick={() => add(c)}
                    className="px-3 py-1 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20 disabled:opacity-40"
                  >
                    {added.has(c.id) ? "added" : "add"}
                  </button>
                </div>
              ))}
            <p className="text-[11px] opacity-40 pt-2">
              {builtIn.find((c) => c.lang === lang)?.source} —{" "}
              {builtIn.find((c) => c.lang === lang)?.license}
            </p>
          </div>
        )}
      </div>
    </div>
  );
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

/** Round-robin merge, so a "study all" screen alternates between lists. */
function interleave<T>(groups: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; groups.some((g) => i < g.length); i++)
    for (const g of groups) if (i < g.length) out.push(g[i]);
  return out;
}

/**
 * The study list: one endless column of words, each graded on its own and
 * saved the moment it is graded. Due words come first, then new words (green);
 * misses come back further down within minutes. Grading a word again re-grades
 * it (the server replaces the review while the word is not due yet); Z undoes.
 */
function Study({
  config,
  lists,
  catalog,
  title,
  onExit,
}: {
  config: DrillConfig;
  /** One list, or every list of a group / "study all". */
  lists: WordList[];
  catalog: CatalogMeta[];
  title: string;
  onExit: () => void;
}) {
  const [queue, setQueue] = useState<Item[]>([]);
  /** Grade per queue index; `card` is the server's card once saved. */
  const [grades, setGrades] = useState<Map<number, { rating: Rating; card?: string }>>(new Map());
  const [row, setRow] = useState(0);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The row whose other actions are open (double tap / right click). */
  const [sheet, setSheet] = useState<number | null>(null);
  const lastTap = useRef({ i: -1, t: 0 });
  const sheetOpen = useRef(false);
  sheetOpen.current = sheet !== null;
  const sync = useSyncStatus();
  /** The queue was built from the offline copy. */
  const [offlineCopy, setOfflineCopy] = useState(false);
  const [help, setHelp] = useState(false);
  /** Every meaning shown, not just the focused / pinned rows. */
  const [showAll, setShowAll] = usePref("lk:words-show-all", false);
  const [settings, setSettings] = useState(false);
  /** Touch: say the word as a swipe starts. Remembered; on by default. */
  const [swipeSpeak, setSwipeSpeak] = usePref("lk:words-swipe-speak", true);
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
  useEffect(() => setSwipeAb(swipeVariant()), []);
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
  /** Read with the server's voice instead of the browser's. Remembered. */
  const [serverVoice, setServerVoice] = usePref("lk:words-server-voice", true);
  const speech = useSpeech(serverVoice);
  const { locale } = useLocale();
  /** What a tap, a hold or the focus reads: word → meaning → example. */
  const partsOf = useCallback(
    (it: Item) => sayParts(it, it.lang, !!config.readingOnBack, String(locale)),
    [config.readingOnBack, locale],
  );
  const base = config.base;
  const listIds = lists.map((l) => l.id).join(",");
  const paramsOf = useMemo(() => new Map(lists.map((l) => [l.id, l.params])), [lists]);

  const catalogs = useRef<Map<string, Entry[]>>(new Map());
  const byTerm = useRef<Map<string, Map<string, Entry>>>(new Map());
  /** A word's example sentence, from its list's catalog (cards store none). */
  const exampleOf = (listId: string, term: string) => {
    let m = byTerm.current.get(listId);
    if (!m) {
      m = new Map((catalogs.current.get(listId) ?? []).map((e) => [e.term, e]));
      byTerm.current.set(listId, m);
    }
    const e = m.get(term);
    return e?.ex ? { ex: e.ex, exTr: e.exTr } : {};
  };
  /** Per list: next catalog index to consider for new words. */
  const nextNew = useRef<Map<string, number>>(new Map());
  /** Lists whose due words did not all fit in one session fetch. */
  const moreDue = useRef<Set<string>>(new Set());
  /** Queue indices in the order they were graded (and not undone): Z walks this back. */
  const gradeLog = useRef<number[]>([]);
  /** Indices whose miss was already queued again further down. */
  const requeued = useRef<Set<number>>(new Set());
  /**
   * Words in a learning step (due again within minutes) wait here until due —
   * met early, grading them would re-grade the review just made instead of
   * recording a new one — then join the list just below the screen.
   */
  const later = useRef<{ item: Item; due: number }[]>([]);
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
        p = meta
          ? loadCatalog<{ entries: Entry[] }>(catalogPath(base, meta)).then((d) => d.entries)
          : Promise.resolve([]);
        p = p.then((entries) => {
          catalogs.current.set(list.id, entries);
          byTerm.current.delete(list.id);
          return entries;
        });
        catalogLoads.current.set(list.id, p);
      }
      return p;
    },
    [catalog, base],
  );

  /** Pull up to `n` catalog words of one list that have no card yet. */
  const takeNewFrom = useCallback(
    async (list: WordList, n: number): Promise<Item[]> => {
      const entries = await ensureCatalog(list);
      const out: Item[] = [];
      while (out.length < n && (nextNew.current.get(list.id) ?? 0) < entries.length) {
        const from = nextNew.current.get(list.id) ?? 0;
        // The /known route takes at most 500 terms.
        const slice = entries.slice(from, from + Math.min(500, Math.max(n * 2, 40)));
        let known: string[] = [];
        try {
          ({ known } = await api<{ known: string[] }>(`/api/words/lists/${list.id}/known`, {
            method: "POST",
            body: JSON.stringify({ terms: slice.map((e) => e.term) }),
          }));
        } catch (e) {
          // Offline: no check; the stored cursor already skips introduced words.
          if (!(e instanceof OfflineError)) throw e;
        }
        // Advance only once the slice is checked, so a failed request leaves no
        // word behind the cursor.
        nextNew.current.set(list.id, from + slice.length);
        const skip = new Set(known);
        slice.forEach((e, i) => {
          if (out.length < n && !skip.has(e.term))
            out.push({ ...e, kind: "new", newIndex: from + i, listId: list.id, lang: list.lang });
        });
      }
      return out;
    },
    [ensureCatalog],
  );

  /** Up to `n` new words in the user's list order: the first list until it runs out. */
  const takeNew = useCallback(
    async (n: number) => {
      const out: Item[] = [];
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

  useEffect(() => {
    let alive = true;
    // Start from the stored cursors every run (Strict Mode mounts twice in dev).
    nextNew.current = new Map(lists.map((l) => [l.id, l.cursor]));
    (async () => {
      // All lists' due words in one request (one D1 query) — or, with no
      // network, the copy saved on the last visit / "download for offline",
      // minus words graded since that are still waiting to sync.
      const ids = lists.map((l) => l.id).join(",");
      let session: { lists: Record<string, { due: WordCard[] }>; more: boolean };
      try {
        session = await api(
          `/api/words/session?lists=${encodeURIComponent(ids)}&day=${localDay()}`,
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
      if (session.more) for (const l of lists) moreDue.current.add(l.id);
      // Catalogs only for lists with due words (for their examples); the rest
      // load when their new words are needed.
      const withDue = lists.filter((l) => session.lists[l.id]?.due.length);
      await Promise.all(withDue.map(ensureCatalog));
      // New words: two batches to start — enough headroom that a fast grader
      // never reaches the end before the next batch lands; more as you go.
      const fresh = await takeNew(AHEAD * 2);
      if (!alive) return;
      const due = interleave(lists.map((l) => dueItems(l, session.lists[l.id]?.due ?? [])));
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
      nextNew.current.get(listId) ?? 0,
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
    if (!it) return;
    const now = new Date();
    const elapsedMs = i === rowRef.current ? now.getTime() - dwellSince.current : null;
    // From the card as it was before this row's grade, so a re-grade replaces.
    const { card } = reviewWord(parseCard(it.card), rating, now, paramsOf.get(it.listId)!);
    const cardJson = JSON.stringify(card);
    setGrades((g) => new Map(g).set(i, { rating, card: cardJson }));
    gradeLog.current = [...gradeLog.current.filter((x) => x !== i), i];
    navigator.vibrate?.(10);
    tone(rating);
    // A miss comes back further down, within minutes (learning steps).
    if (!requeued.current.has(i) && card.due.getTime() - now.getTime() < SESSION_WINDOW_MS) {
      requeued.current.add(i);
      later.current.push({
        item: { ...it, kind: "again", newIndex: undefined, card: cardJson },
        due: card.due.getTime(),
      });
    }
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
  };

  /**
   * Z: undo the focused word's grade if it has one, else the most recent
   * grade not yet undone (and move there). Repeated Z walks back in time.
   * One level per word: the server keeps only the card before its last review.
   */
  const undo = (focusedOnly = false) => {
    const at = rowRef.current;
    const target = grades.has(at) ? at : focusedOnly ? -1 : (gradeLog.current.at(-1) ?? -1);
    if (target < 0) return;
    const it = queue[target];
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
  const [debug, debugTap] = useDebugToggle(
    useCallback((on: boolean) => setNotice(on ? "Debug log on" : "Debug log off"), []),
  );
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

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
      else if (KEY_RATING[e.code] && !e.shiftKey) {
        grade(row, KEY_RATING[e.code]);
        moveRow(row + 1);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The list is a box the height of the screen that scrolls inside itself;
  // only the rows in view (plus a margin) are rendered.
  const ROW_H = touch ? 44 : 28;
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
  const [viewH, setViewH] = useState(600);
  /** viewH holds the real measured height (the opening scroll depends on it). */
  const [measured, setMeasured] = useState(false);
  const listReady = !loading && !loadError && queue.length > 0;
  // Empty space above the first row and below the last (OVERSCROLL_FRACTION
  // of the list's height), so any row — the first and last included — can be
  // scrolled well past the middle (or to the touch focus line). Row positions
  // and the windowing below are all offset by it.
  const pad = Math.round(viewH * OVERSCROLL_FRACTION);
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
  useLayoutEffect(() => {
    if (!listEl || !listReady || !measured) return;
    if (opened.current.el !== listEl) opened.current = { el: listEl, moved: false };
    if (opened.current.moved) return;
    listEl.scrollTop = pad - bar.top;
  }, [listEl, listReady, measured, pad, bar.top, shownAt]);
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
  // Only the list scrolls: the page under it stays put.
  useEffect(() => {
    if (!listEl) return;
    // iOS scrolls the document past an html-only overflow lock (the header
    // plus the body's safe-area padding make it taller than the window), so
    // body is locked too, with no rubber band, and the page starts at the top.
    const els = [document.documentElement, document.body];
    const prev = els.map((el) => [el.style.overflow, el.style.overscrollBehavior]);
    for (const el of els) {
      el.style.overflow = "hidden";
      el.style.overscrollBehavior = "none";
    }
    window.scrollTo(0, 0);
    return () => {
      els.forEach((el, i) => {
        el.style.overflow = prev[i][0];
        el.style.overscrollBehavior = prev[i][1];
      });
    };
  }, [listEl]);
  // Keep the cursor in view as it moves, a couple of rows from the edges of
  // what the overlays leave uncovered.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
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
      const ready = later.current.filter((x) => x.due <= now);
      if (!ready.length || !el) return;
      if (touchingList.current || performance.now() - lastScrollAt.current < 400) return;
      later.current = later.current.filter((x) => x.due > now);
      // The list's top spacer (`pad`), from the live height.
      const top = Math.round(el.clientHeight * OVERSCROLL_FRACTION);
      const below = Math.floor((el.scrollTop - top + el.clientHeight) / ROW_H) + 1;
      // Updaters stay pure (Strict Mode runs them twice): the insertion point
      // is fixed here, from the queue length as last rendered.
      const at = Math.max(0, Math.min(queueLen.current, below));
      const n = ready.length;
      const shift = (i: number) => (i >= at ? i + n : i);
      setQueue((q) => [...q.slice(0, at), ...ready.map((x) => x.item), ...q.slice(at)]);
      setGrades((g) => new Map([...g].map(([k, v]) => [shift(k), v])));
      setRevealed((r) => new Set([...r].map(shift)));
      requeued.current = new Set([...requeued.current].map(shift));
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
    speech.once([{ kind: "word", text: focusText, lang: focusItem.lang }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touch, focusLine, focusText]);

  /** How far down the list the user has got: the cursor, or the last row in view. */
  const reach = Math.max(row, Math.floor((scrollTop - pad + viewH) / ROW_H));
  // Endless: when fewer than AHEAD ungraded words are left below the cursor
  // or below the bottom of the view (touch has no cursor; scrolling doesn't
  // move it), fetch more — remaining due words first, then new ones. Stops only when
  // every catalog runs out.
  const [exhausted, setExhausted] = useState(false);
  const fetching = useRef(false);
  useEffect(() => {
    if (loading || exhausted || fetching.current || queue.length - reach > AHEAD) return;
    fetching.current = true;
    const queued = new Set(queue.map(keyOf));
    const append = (items: Item[]) =>
      setQueue((q) => [...q, ...spreadPairs(items, PAGE, q.length, q.slice(-PAGE))]);
    (async () => {
      const due: Item[] = [];
      const waiting = lists.filter((l) => moreDue.current.has(l.id));
      if (waiting.length && navigator.onLine) {
        const s = await api<{ lists: Record<string, { due: WordCard[] }>; more: boolean }>(
          `/api/words/session?lists=${encodeURIComponent(waiting.map((l) => l.id).join(","))}&day=${localDay()}&limit=${DUE_PAGE}`,
        );
        await Promise.all(waiting.map(ensureCatalog));
        for (const list of waiting) {
          const fresh = (s.lists[list.id]?.due ?? []).filter(
            (c) => !queued.has(keyOf({ listId: list.id, term: c.term })),
          );
          if (!fresh.length || !s.more) moreDue.current.delete(list.id);
          due.push(...dueItems(list, fresh));
        }
      }
      if (due.length) return append(due);
      const fresh = await takeNew(AHEAD);
      if (!fresh.length) setExhausted(true);
      else append(fresh);
    })()
      .catch((e) => setSyncError((e as Error).message))
      .finally(() => {
        fetching.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, exhausted, queue.length, reach, takeNew]);

  // Say the focused row aloud on a loop (word, then example) while the page
  // is active; paused in a hidden tab or background window.
  const active = usePageActive();
  const focused = !touch && active ? queue[row] : undefined;
  // Keyed by content: re-rendering the same row must not restart its loop.
  const focusParts = JSON.stringify(focused ? partsOf(focused) : []);
  useEffect(() => speech.loop(JSON.parse(focusParts) as SayPart[]), [focusParts, speech]);

  // Prefetch the audio of the rows on screen and up to two screens below,
  // plus the next few in queue order, so a tap plays at once. The list is
  // windowed: rows are observed as they mount and let go as they unmount.
  const nearRows = useRef(new Set<number>());
  const prefetchNear = useRef(() => {});
  prefetchNear.current = () => {
    // Desktop with sound off says nothing (a click grades); a tap always speaks.
    if (!touch && !speech.on) return;
    const near = [...nearRows.current].sort((a, b) => a - b);
    if (!near.length) return;
    const last = near[near.length - 1];
    for (let i = last + 1; i <= last + PREFETCH_NEXT && i < queue.length; i++) near.push(i);
    speech.prefetch(prefetchOrder(near.flatMap((i) => (queue[i] ? [partsOf(queue[i])] : []))));
  };
  useEffect(() => prefetchNear.current(), [queue, speech, partsOf]);
  useEffect(() => {
    const root = listEl;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const rowIndex = (n: Node) =>
      n instanceof HTMLElement && n.dataset.i !== undefined ? Number(n.dataset.i) : null;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = rowIndex(e.target);
          if (i === null) continue;
          if (e.isIntersecting) nearRows.current.add(i);
          else nearRows.current.delete(i);
        }
        prefetchNear.current();
      },
      { root, rootMargin: "0px 0px 200% 0px" },
    );
    for (const el of root.children) if (rowIndex(el) !== null) io.observe(el);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (rowIndex(n) !== null) io.observe(n as Element);
        for (const n of r.removedNodes) {
          const i = rowIndex(n);
          if (i === null) continue;
          io.unobserve(n as Element);
          nearRows.current.delete(i);
        }
      }
    });
    mo.observe(root, { childList: true });
    const near = nearRows.current;
    return () => {
      io.disconnect();
      mo.disconnect();
      near.clear();
    };
  }, [listEl]);

  // Windowed rendering: the list is endless, the DOM is not.
  const OVERSCAN = 20;
  const from = Math.max(0, Math.floor((scrollTop - pad) / ROW_H) - OVERSCAN);
  const to = Math.min(queue.length, Math.ceil((scrollTop - pad + viewH) / ROW_H) + OVERSCAN);
  // Sticky over the whole loaded queue: a column appearing and disappearing
  // as example-less stretches scroll by would shift every other column.
  const hasExamples = useMemo(() => queue.some((it) => it.ex), [queue]);

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
        ctx.font = `500 ${touch ? 16 : 15}px ${family}`;
        w = ctx.measureText(it.term).width;
        if (!config.readingOnBack && it.reading && it.reading !== it.term) {
          ctx.font = `400 12px ${family}`;
          w += 8 + ctx.measureText(it.reading).width;
        }
        cache.set(k, w);
      }
      return w ?? 0;
    };
  }, [touch, config.readingOnBack]);
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
        ctx.font = `400 14px ${family}`;
        let back = ctx.measureText(it.back).width;
        let ex = it.ex ? ctx.measureText(it.ex).width : 0;
        if (config.readingOnBack && it.reading && it.reading !== it.term)
          back += 8 + ctx.measureText(it.reading).width;
        if (it.exTr) {
          ctx.font = `400 12px ${family}`;
          ex += 8 + ctx.measureText(it.exTr).width;
        }
        w = { back, ex };
        cache.set(k, w);
      }
      return w ?? { back: 0, ex: 0 };
    };
  }, [config.readingOnBack]);
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
  // Desktop with examples: the meaning column's share, the same way.
  const backGoal = useRef<number | null>(null);
  const backShown = useRef<number | null>(null);
  const backVelocity = useRef(0);
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
      backGoal.current = nextGoal(
        backGoal.current,
        splitTarget(weighted((c) => c.back) + rem, weighted((c) => c.ex) + rem, avail, rem),
        rem,
      );
    }
    if (termShown.current === null || (split && backShown.current === null)) {
      termShown.current = termGoal.current;
      el.style.setProperty("--term-w", `${termShown.current}px`);
      if (split) {
        backShown.current = backGoal.current;
        el.style.setProperty("--back-w", `${backShown.current}px`);
      }
      return;
    }
    // Glide every row together: one variable, moved by a critically damped
    // spring that keeps its velocity if the goal moves mid-glide.
    let raf = 0;
    let last = performance.now();
    /** One spring step of a column toward its goal; true once it has settled. */
    const glide = (
      goal: number,
      shown: { current: number | null },
      velocity: { current: number },
      prop: string,
      dt: number,
    ) => {
      const s = springStep(shown.current!, velocity.current, goal, dt, 14);
      const settled = Math.abs(s.x - goal) < 0.5 && Math.abs(s.v) < 5;
      shown.current = settled ? goal : s.x;
      velocity.current = settled ? 0 : s.v;
      el.style.setProperty(prop, `${shown.current}px`);
      return settled;
    };
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const a = glide(termGoal.current!, termShown, termVelocity, "--term-w", dt);
      const b = !split || glide(backGoal.current!, backShown, backVelocity, "--back-w", dt);
      if (!a || !b) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [from, to, scrollTop, viewH, pad, queue, measureTerm, measureCells, hasExamples, rem, touch]);

  const done = grades.size;
  const minutes = (Date.now() - started.current) / 60_000;
  const ahead = queue.filter((_, i) => i >= row && !grades.has(i));
  const dueLeft = ahead.filter((it) => it.kind !== "new").length;

  const status = (it: Item, i: number) => {
    const g = grades.get(i);
    if (g) {
      // Saved: when it actually comes back. Not yet saved: the preview.
      if (g.card) return <Countdown due={dueOf(g.card)} back={requeued.current.has(i)} />;
      return previewInterval(it.card, g.rating, paramsOf.get(it.listId)!);
    }
    if (it.kind === "new" || !it.card) return "new";
    return `${formatInterval(Date.now() - dueOf(it.card))} ago`;
  };

  // The help strip's text, by the input used last (keys or gestures).
  const hintText =
    exhausted && ahead.length === 0 ? (
      <>
        Every word learned. <Icon name="confetti" className="ms-0.5" />
      </>
    ) : modality === null ? null : modality === "touch" ? (
      // The gestures exist only in the touch layout; a touchscreen
      // laptop's tap is a click (= Again), and has no swipe to explain.
      touch &&
      "tap = show + say · hold = listen (loops) · swipe ← a little Hard, far Again · swipe → a little Good, far Easy · ↶ undo"
    ) : help ? (
      "↑↓ / W S / I U move (the focused row shows its meaning) · Space pin · E show all · 1 Again · 2 Hard · 3 Good · 4 Easy (right hand mirrored: L Again · K Hard · J Good · H Easy) · grading again re-grades · click = Again · Z / M undo (repeat to go further back) · Esc undo this row · Enter next ungraded · V sound · ? hide help"
    ) : (
      "1 Again · 2 Hard · 3 Good · 4 Easy · Z undo · ? all keys"
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
            {text.backToLists}
          </button>
          <span className="font-medium">{title}</span>
          <button
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
          {touch && (
            <button
              className="tap-40 px-2 py-0.5 rounded text-xs bg-black/10 dark:bg-white/10"
              onClick={() => undo()}
              aria-label={text.undo.value}
            >
              <Icon name="arrowCounterClockwise" className="me-1" />
              {text.undo}
            </button>
          )}
          <span className="w-full sm:w-auto sm:ml-auto tabular-nums opacity-70 text-xs sm:text-sm">
            {debug && (
              <>
                <span className="mr-1 rounded bg-red-700 px-1 text-white" data-debug-badge>
                  DEBUG
                </span>
                {/* Design prototypes, to try on the device itself. */}
                {["slip", "cords"].map((p) => (
                  <a key={p} href={`/proto/${p}`} data-debug-proto={p} className="mr-1 underline">
                    proto/{p}
                  </a>
                ))}
              </>
            )}
            {done} done · {minutes > 0.2 ? Math.round(done / minutes) : "–"}/min · {dueLeft} due ·{" "}
            {ahead.length - dueLeft} new
            {sync.pending > 0 ? (
              <span
                data-sync="pending"
                className={sync.online ? "" : "text-amber-700 dark:text-amber-300"}
              >
                {sync.online
                  ? ` · ${sync.pending} saving…`
                  : ` · offline · ${sync.pending} to sync`}
              </span>
            ) : (
              <span data-sync="synced">
                {!sync.online || offlineCopy ? " · offline" : ""}
                {sync.online && grades.size > 0 ? " · synced ✓" : ""}
              </span>
            )}
          </span>
          {settings && (
            <div className="w-full flex flex-wrap gap-2 pt-1 pb-1" aria-label="Study settings">
              <TogglePill
                on={showAll}
                onChange={setShowAll}
                label="Show all meanings"
                hint="Every meaning visible, not only the focused row (E)"
              />
              {speech.available && (
                <TogglePill
                  on={speech.on}
                  onChange={() => speech.toggle()}
                  label="Read cards aloud"
                  hint="Speak the word and its example (V)"
                />
              )}
              {speech.on && (
                <TogglePill
                  on={serverVoice}
                  onChange={setServerVoice}
                  label="Server voice"
                  hint="Use Lianki's voices (en, es, fr, de, it, pt, ru, zh, ja, ko) instead of the browser's"
                />
              )}
              {speech.on && serverVoice && (
                <span className="w-full text-xs opacity-60" data-voice-credit>
                  Voices: VOICEVOX:No.7 (Japanese) · Kokoro · Piper (Thorsten-Voice, Dmitri) ·
                  MeloTTS
                </span>
              )}
              <TogglePill
                on={tones}
                onChange={setTones}
                label="Grade tones"
                hint="A short tone per grade, for studying without looking"
              />
              {touch && (
                <TogglePill
                  on={swipeSpeak}
                  onChange={setSwipeSpeak}
                  label="Speak on swipe"
                  hint="Say the word as a swipe starts"
                />
              )}
              {touch && !fs.standalone && (
                <TogglePill
                  on={fs.active}
                  onChange={toggleFullscreen}
                  label="Full screen"
                  hint="Hide the address bar while studying"
                />
              )}
              {touch && (
                <div className="w-full pt-1" data-experimental>
                  <div className="text-[11px] font-medium uppercase tracking-wide opacity-50">
                    Experimental
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <TogglePill
                      on={swipeAb === "native"}
                      onChange={(on) => {
                        const v = on ? "native" : "js";
                        setSwipeVariant(v);
                        setSwipeAb(v);
                      }}
                      label="New swipe"
                      hint="Swipes done by the browser's own scrolling"
                    />
                    <span className="text-xs opacity-60">
                      Native scrolling swipe. It may change or go away.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {syncError && <div className="text-red-500 text-sm mt-1">Not saved: {syncError}</div>}
        {notice && <div className="text-amber-600 dark:text-amber-300 text-sm mt-1">{notice}</div>}
        {fsHint && (
          <div className="text-sm mt-1 opacity-80" onClick={() => setFsHint(false)}>
            This browser can&apos;t hide its address bar for a page. On iPhone: Share → Add to Home
            Screen, then open Lianki from the home screen — it runs without the address bar.
          </div>
        )}
      </div>

      {loadError ? (
        <div className="space-y-3 py-8 text-center">
          <div className="text-red-500">Couldn't load: {loadError}</div>
          <button
            className="px-4 py-2 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
            onClick={() => location.reload()}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="opacity-60">Loading…</div>
      ) : queue.length === 0 ? (
        <div className="py-8 text-center text-lg">
          {exhausted ? (
            <>
              Every word learned.{" "}
              <Icon name="confetti" className="ms-1 text-blue-600 dark:text-blue-400" />
            </>
          ) : (
            "Loading more…"
          )}
        </div>
      ) : (
        <>
          <div
            ref={setListRef}
            // The whole window, edge to edge, under the glass overlays
            // (.lk-words-list); scroll-padding keeps resting rows clear of them.
            className="lk-words-list overflow-y-auto overscroll-contain"
            data-touch={touch ? "true" : "false"}
            // overflow-anchor: none — the padding and spacers change as rows
            // load; the browser must not "help" by shifting the scroll.
            style={{
              overflowAnchor: "none",
              scrollPaddingTop: bar.top,
              scrollPaddingBottom: bar.bottom,
            }}
            onScroll={(e) => {
              setScrollTop(e.currentTarget.scrollTop);
              lastScrollAt.current = performance.now();
            }}
            onPointerDownCapture={() => (touchingList.current = true)}
            onPointerUpCapture={() => (touchingList.current = false)}
            onPointerCancelCapture={() => (touchingList.current = false)}
            // pointerup, not pointerdown: for touch it is the event that grants
            // the user activation full screen needs.
            onPointerUp={touch ? resumeFullscreen : undefined}
            role="list"
          >
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
                  onHover={() => moveRow(i)}
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
                    if (swipeSpeak)
                      speech.once([
                        {
                          kind: "word",
                          text: spokenText(it, it.lang, !!config.readingOnBack),
                          lang: it.lang,
                        },
                      ]);
                  }}
                  onHold={() => {
                    setHolding(i);
                    speech.loop(partsOf(it), true);
                  }}
                  onHoldEnd={() => {
                    setHolding(null);
                    speech.loop([]);
                  }}
                  onSwipe={(r) => {
                    // The slip glides home meanwhile: the grade's re-render can wait.
                    startTransition(() => {
                      grade(i, r);
                      if (touch) setFocusLine(Math.min(queue.length - 1, i + 1));
                    });
                    // The next word slides up under the thumb.
                    listRef.current?.scrollBy({ top: ROW_H, behavior: "smooth" });
                  }}
                  className={`slip group grid items-center gap-2 px-2 leading-none cursor-pointer select-none ${
                    touch
                      ? "slip-touch grid-cols-[1rem_var(--term-w,8rem)_1fr_3rem] text-base pr-4"
                      : hasExamples
                        ? "grid-cols-[1.25rem_var(--term-w,12rem)_var(--back-w,minmax(10rem,1fr))_minmax(8rem,1fr)_3.5rem] text-[15px]"
                        : "grid-cols-[1.25rem_var(--term-w,12rem)_1fr_3.5rem] text-[15px]"
                  } ${rating ? RATING_STYLE[rating] : ""}`}
                  style={{ height: ROW_H }}
                >
                  {/* The grade, stamped like a small seal (盖章) at the slip's left end. */}
                  <span className="flex justify-center text-[10px]" data-stamp-cell>
                    {rating ? (
                      <i key={rating} className="lk-stamp" aria-label={RATING_LABEL[rating]} />
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
                    {it.term}
                    {!config.readingOnBack && it.reading && it.reading !== it.term && (
                      <span className="ml-2 text-xs font-normal opacity-60">{it.reading}</span>
                    )}
                  </Glance>
                  <Glance
                    active={glancing && show}
                    title={show ? it.back : undefined}
                    className={`text-sm opacity-80 transition-[filter] duration-75 ${
                      show ? "" : "slip-blank"
                    }`}
                  >
                    {config.readingOnBack && it.reading && it.reading !== it.term && (
                      <span className="mr-2 font-medium">{it.reading}</span>
                    )}
                    {it.back}
                  </Glance>
                  {hasExamples && !touch && (
                    // The example is part of the answer side: hidden with the meaning.
                    <Glance
                      active={glancing && show}
                      className={`text-sm opacity-70 transition-[filter] duration-75 ${
                        show ? "" : "slip-blank"
                      }`}
                      title={it.ex && show ? `${it.ex}\n${it.exTr ?? ""}` : undefined}
                    >
                      {it.ex}
                      {it.exTr && <span className="ml-2 text-xs opacity-60">{it.exTr}</span>}
                    </Glance>
                  )}
                  {/* Graded: when it comes back. Ungraded: "new", or how long it has been due. */}
                  <span
                    className={`flex items-center justify-end gap-1.5 text-[11px] tabular-nums ${rating ? "font-medium" : "opacity-40"}`}
                    style={rating ? { color: "var(--grade)" } : undefined}
                    title={rating ? RATING_LABEL[rating] : "due"}
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
          </div>
          {sheet !== null && queue[sheet] && (
            <SlipSheet
              item={queue[sheet]}
              status={status(queue[sheet], sheet)}
              onClose={() => setSheet(null)}
              onListen={() => {
                const it = queue[sheet];
                speech.loop(partsOf(it), true);
              }}
              onCopy={() => {
                void navigator.clipboard?.writeText(queue[sheet].term).catch(() => {});
                setNotice(`Copied “${queue[sheet].term}”`);
              }}
            />
          )}
          {/* The help strip: glass over the bottom of the list, shown only
              when there is room (a tall window, no on-screen keyboard). */}
          {room && hintText && (
            <div
              ref={hintRef}
              data-words-help
              className="lk-words-bar lk-glass bottom-0 border-t border-[var(--glass-line)] pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] text-[11px]"
            >
              <span className="opacity-75">{hintText}</span>
            </div>
          )}
        </>
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
  status,
  onClose,
  onListen,
  onCopy,
}: {
  item: Item;
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
  const actions: [IconName, string, () => void][] = [
    ["speakerHigh", "Listen again (loops)", onListen],
    ["copy", "Copy the word", onCopy],
  ];
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Word actions" data-slip-sheet>
      <div className="absolute inset-0 bg-black/30 lk-fade-in" onClick={dismiss} />
      <div className="absolute inset-x-0 bottom-0 mx-auto max-w-lg rounded-t-2xl bg-[var(--background)] px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_oklch(0_0_0/0.25)] lk-sheet-in">
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-current opacity-20" />
        <div className="flex items-baseline gap-3 border-b border-black/10 dark:border-white/10 px-1 pb-3">
          <b className="text-2xl font-normal">{item.term}</b>
          <span className="truncate opacity-70">{item.back}</span>
          <small className="ml-auto shrink-0 text-xs opacity-60">{status}</small>
        </div>
        {/* Phones have no example column: the sheet is where the example shows. */}
        {item.ex && (
          <div
            className="border-b border-black/10 dark:border-white/10 px-1 py-3"
            data-sheet-example
          >
            <div lang={item.lang}>{item.ex}</div>
            {item.exTr && <div className="mt-1 text-sm opacity-60">{item.exTr}</div>}
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
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The focused slip's binding cords, come loose: drawn over the slip, pinned at
 * its top and bottom (counter-moved against the slip's slide), bowing inward
 * and dragged along as the slip slides. Loosening and tightening take 200 ms
 * of minimum jerk. Runs frames only while easing or while the slip is off
 * its rest position.
 */
function SlipCords({
  loose,
  moving,
  pos,
}: {
  loose: boolean;
  moving: boolean;
  /** The slip's position at a moment (touch rows); none = it never slides. */
  pos?: React.RefObject<(now: number) => number>;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const slack = useRef(0);
  useEffect(() => {
    const el = host.current;
    const row = el?.parentElement;
    if (!el || !row) return;
    const [left, right] = Array.from(el.querySelectorAll("path"));
    const from = slack.current;
    const to = loose ? 1 : 0;
    const t0 = performance.now();
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const frame = (now: number) => {
      const c0 = swipePerf.on ? performance.now() : 0;
      const t = still ? 1 : Math.min(1, (now - t0) / 200);
      slack.current = from + (to - from) * minJerk(t);
      const h = row.offsetHeight;
      const w = row.offsetWidth;
      const x = pos?.current(now) ?? 0;
      const pull = cordPull(x, slack.current, h);
      const bow = CORD_BOW * h * slack.current;
      el.style.transform = x ? `translateX(${-x}px)` : "";
      el.style.visibility = slack.current > 0.001 ? "visible" : "hidden";
      left.setAttribute("d", cordPath(4.5, h, bow, pull));
      right.setAttribute("d", cordPath(35.5, h, -bow, pull));
      right.parentElement!.style.left = `${w - 40}px`;
      if (swipePerf.on) {
        swipePerf.cordFrames++;
        swipePerf.cordMs += performance.now() - c0;
      }
      if (t < 1 || x !== 0 || moving) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [loose, moving, pos]);
  return (
    <span
      ref={host}
      aria-hidden
      data-cords={loose ? "loose" : "tied"}
      className="pointer-events-none absolute inset-0"
      style={{ visibility: "hidden" }}
    >
      <svg className="slip-cord" style={{ left: 0 }}>
        <path />
      </svg>
      <svg className="slip-cord" style={{ left: 0 }}>
        <path />
      </svg>
    </span>
  );
}

/**
 * What a sliding slip uncovers: one static strip per list, put under the slip
 * as it starts to slide. Slid right, the slip uncovers Good (its first row's
 * width a) then Easy; slid left, Hard then Again — the levels it snaps to
 * (lib/words/swipe.ts). Painted once: changing level repaints nothing, the
 * slip only moves over it.
 */
function SwipeUnderlay({ ref }: { ref: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={ref}
      aria-hidden
      data-swipe-underlay
      className="pointer-events-none absolute inset-x-0 overflow-hidden"
      style={{ visibility: "hidden", background: "var(--slip-seam)" }}
    >
      <GradeZones />
    </div>
  );
}

/** The strip's zones, in a row-wide box with --a set: shared by SwipeUnderlay and NativeSlipRow. */
function GradeZones() {
  // One slot per side, the width of both detents. Its first detent's grade
  // shows until the slip reaches the far detent; then the far grade takes
  // over the same spot (crossfade + a short slide, CSS .lk-reveal), and
  // gives it back on the way home. The container's data-good / data-hard
  // (showReveal) pick which.
  const layer = (r: Rating, side: "left" | "right", far: boolean) => (
    <span
      data-reveal={r}
      data-far={far ? "" : undefined}
      className="lk-reveal absolute inset-0"
      style={{ background: SWIPE_BG[r] }}
    >
      <span
        className="absolute inset-y-0 flex items-center justify-center text-[11px] font-medium opacity-90"
        style={{ [side]: 0, width: "var(--a)" }}
      >
        {RATING_LABEL[r]}
      </span>
    </span>
  );
  return (
    <>
      <span
        data-reveal-slot="good"
        className="absolute inset-y-0 left-0 overflow-hidden"
        style={{ width: "calc(var(--a) * 2.5)" }}
      >
        {layer(3, "left", false)}
        {layer(4, "left", true)}
      </span>
      <span
        data-reveal-slot="hard"
        className="absolute inset-y-0 right-0 overflow-hidden"
        style={{ width: "calc(var(--a) * 2.5)" }}
      >
        {layer(2, "right", false)}
        {layer(1, "right", true)}
      </span>
    </>
  );
}

/** Point a GradeZones container at level `k`: which grade each side shows. */
function showReveal(el: HTMLElement | null | undefined, k: number) {
  if (!el) return;
  const s = revealShown(k);
  if (el.dataset.good !== String(s.good)) el.dataset.good = String(s.good);
  if (el.dataset.hard !== String(s.hard)) el.dataset.hard = String(s.hard);
}

type RowProps = {
  index: number;
  touch: boolean;
  /** Focused: its cords come loose (and only a loose slip slides). */
  loose?: boolean;
  onHover: () => void;
  /** `at`: when the finger lifted (the event's own time, not when it was handled). */
  onTap: (at: number) => void;
  /** The slip's other actions (desktop: right click). */
  onMore?: () => void;
  onSwipe: (r: Rating) => void;
  /** The finger has started moving sideways (a grade is being decided). */
  onSwipeStart?: () => void;
  /** The list's one SwipeUnderlay: moved under this slip as it starts sliding. */
  underlay?: React.RefObject<HTMLDivElement | null>;
  /** Held still for HOLD_MS: listen mode until the finger lifts. */
  onHold?: () => void;
  onHoldEnd?: () => void;
  /** The list is (or just was) scrolling: a touch now is catching a fling. */
  scrolling?: () => boolean;
  className: string;
  style: React.CSSProperties;
  children: React.ReactNode;
};

function WordRow({
  index,
  touch,
  loose = false,
  onHover,
  onTap,
  onMore,
  onSwipe,
  onSwipeStart,
  onHold,
  onHoldEnd,
  scrolling,
  underlay,
  className,
  style,
  children,
}: RowProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  /** Sliding sideways: re-renders only as a drag starts and ends. */
  const [moving, setMoving] = useState(false);
  /** Where the slip is held now. The drag writes it straight to the row's
   * style once a frame — a React render per pointermove dropped frames on Android. */
  const dx = useRef(0);
  const frame = useRef(0);
  /** Where the slip is at a given moment, for its cords: the finger while
   * dragging, then the return spring — no reading the transform back. */
  const pos = useRef<(now: number) => number>(() => 0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  /** The axis this gesture committed to (lib/words/swipe.ts lockAxis). */
  const axis = useRef<Axis | null>(null);
  const rowEl = useRef<HTMLDivElement>(null);
  // touch-action: pan-y alone does not hold: iOS Safari still takes over a
  // sideways drag that wanders vertically, scrolling and cancelling the
  // swipe. A non-passive touchmove keeps the page from scrolling once the
  // gesture is sideways — and while it is undecided but leaning sideways,
  // since a scroll that has started can no longer be stopped.
  useEffect(() => {
    const el = rowEl.current;
    if (!el || !touch) return;
    let x0 = 0;
    let y0 = 0;
    const down = (e: TouchEvent) => {
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    };
    const move = (e: TouchEvent) => {
      if (axis.current === "v" || !e.cancelable) return;
      const dx = Math.abs(e.touches[0].clientX - x0);
      const dy = Math.abs(e.touches[0].clientY - y0);
      if (axis.current === "h" || dx > dy) e.preventDefault();
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
    };
  }, [touch]);
  /** The touch landed on a moving list: it stops the fling, nothing more. */
  const catching = useRef(false);
  /** Recent finger positions, for the release velocity. */
  const samples = useRef<{ t: number; x: number }[]>([]);
  /** The finger's own travel (the row resists beyond a, so they differ). */
  const finger = useRef(0);
  /** The level the slip has snapped to: crossing into another gives a light buzz. */
  const level = useRef<SwipeLevel>(0);
  /** Travel unit: the row's own height. */
  const a = typeof style.height === "number" ? style.height : 44;
  if (swipePerf.on && touch) swipePerf.renders++;

  if (!touch)
    return (
      <div
        role="listitem"
        data-i={index}
        // Only a real mouse move takes the cursor: Chrome replays mouse events
        // at a resting pointer when rows re-render, which would otherwise yank
        // the cursor back under the mouse after every key press.
        onMouseMove={(e) => (e.movementX || e.movementY) && onHover()}
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
        <SlipCords loose={loose} moving={false} />
      </div>
    );

  /** Moves the slip to dx, tinted by what it would grade if released now. */
  const paint = () => {
    frame.current = 0;
    const el = rowEl.current;
    if (!el) return;
    const x = dx.current;
    el.style.transform = x ? `translateX(${x}px)` : "";
  };
  /** Back to rest: spring home from where it was let go, on the compositor. */
  const release = () => {
    const el = rowEl.current;
    cancelAnimationFrame(frame.current);
    const x0 = dx.current;
    if (el && x0) {
      el.style.transition = `transform ${SWIPE_RETURN_S}s ${SPRING_EASING}`;
      const t0 = performance.now();
      pos.current = (now) => x0 * (1 - springProgress((now - t0) / 1000 / SWIPE_RETURN_S));
    }
    dx.current = 0;
    paint();
    if (el) el.style.willChange = "";
    setMoving(false);
  };
  return (
    <div
      ref={rowEl}
      role="listitem"
      data-i={index}
      className={`relative ${className} ${loose ? "slip-loose" : ""}`}
      style={{
        ...style,
        touchAction: "pan-y",
        // A hold is listen mode, not iOS's callout / text-selection menu.
        WebkitTouchCallout: "none",
        // transform and transition are the drag's: paint() writes them.
      }}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY };
        samples.current = [{ t: performance.now(), x: 0 }];
        held.current = false;
        axis.current = null;
        level.current = 0;
        finger.current = 0;
        catching.current = scrolling?.() ?? false;
        swipePerf.start();
        // Keep receiving the gesture even if the finger leaves this row.
        e.currentTarget.setPointerCapture(e.pointerId);
        clearTimeout(holdTimer.current);
        if (catching.current) return;
        holdTimer.current = setTimeout(() => {
          held.current = true;
          onHold?.();
        }, HOLD_MS);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const x = e.clientX - start.current.x;
        const y = e.clientY - start.current.y;
        // Commit to one axis once past the slop; until then nothing moves,
        // so the start of a scroll never jiggles the row.
        if (!axis.current) {
          axis.current = lockAxis(x, y);
          if (!axis.current) return;
          // Any real movement is a swipe or a scroll, not a hold.
          if (!held.current) clearTimeout(holdTimer.current);
          if (axis.current === "h" && !held.current) {
            // Following the finger: no easing, on its own layer.
            e.currentTarget.style.transition = "none";
            e.currentTarget.style.willChange = "transform";
            pos.current = () => dx.current;
            // Only one slip slides at a time: the list's underlay goes under
            // it, once — what the slip uncovers then shows the grade, with no
            // repaint as the level changes.
            const u = underlay?.current;
            if (u) {
              const row = e.currentTarget;
              u.style.top = `${row.offsetTop}px`;
              u.style.height = `${row.offsetHeight}px`;
              // Under the row itself: on a tablet the list is padded by the
              // glass nav, and the zones must line up with the slip.
              u.style.left = `${row.offsetLeft}px`;
              u.style.right = "auto";
              u.style.width = `${row.offsetWidth}px`;
              u.style.setProperty("--a", `${a}px`);
              showReveal(u, 0);
              u.style.visibility = "visible";
            }
            setMoving(true);
            onSwipeStart?.();
          }
        }
        // A scroll stays a scroll however it drifts; a hold stays a hold.
        if (axis.current === "h" && !held.current) {
          const t = performance.now();
          const kept = samples.current.filter((s) => t - s.t <= SWIPE_VELOCITY_MS * 2);
          kept.push({ t, x });
          samples.current = kept;
          finger.current = x;
          const k = swipeLevel(x, level.current, a);
          if (k !== level.current) {
            // A light tick at each level, either way (Android; iOS has no API).
            navigator.vibrate?.(Math.abs(k) === 2 ? 12 : 6);
            level.current = k;
            showReveal(underlay?.current, k);
          }
          dx.current = snapSwipe(x, a);
          frame.current ||= requestAnimationFrame(paint);
        }
      }}
      onPointerUp={(e) => {
        clearTimeout(holdTimer.current);
        swipePerf.stop(axis.current === "h" ? "swipe" : axis.current === "v" ? "scroll" : "tap");
        release();
        if (!start.current) return;
        start.current = null;
        if (held.current) {
          // Listening, not grading: the hold ends, nothing else happens.
          held.current = false;
          onHoldEnd?.();
          return;
        }
        if (axis.current === "h") {
          const v = releaseVelocity(samples.current, performance.now());
          const r = releaseRating(finger.current, v, level.current, a);
          logSwipe({
            finger: finger.current,
            v,
            projected: releaseLevel(finger.current, v, level.current, a) * a,
            rating: r,
            a,
          });
          if (r) onSwipe(r);
        }
        // Never moved past the slop: a tap — unless it was catching a fling.
        else if (axis.current === null && !catching.current) onTap(e.timeStamp);
      }}
      onPointerCancel={() => {
        clearTimeout(holdTimer.current);
        swipePerf.stop(axis.current === "h" ? "swipe-cancel" : "scroll");
        if (held.current) onHoldEnd?.();
        held.current = false;
        start.current = null;
        release();
      }}
    >
      {children}
      <SlipCords loose={loose} moving={moving} pos={pos} />
    </div>
  );
}

/**
 * Variant B of the swipe A/B test (lib/words/swipe-ab.ts): WordRow's slip,
 * but each row is its own horizontal scroller (public/proto/slip.html). The
 * browser locks the axis, follows the finger, coasts, snaps to the levels at
 * 0, ±a, ±2a and stops hard at ±2a — all on the compositor; script runs only
 * as a gesture starts and ends. What the slip uncovers is the same grade
 * strip as SwipeUnderlay, held still behind the face (sticky); its cords stay
 * pinned by a scroll-driven animation; it glides home by a smooth scroll.
 * Touch only: desktop rows are always WordRow.
 */
function NativeSlipRow({
  index,
  loose = false,
  onTap,
  onSwipe,
  onSwipeStart,
  onHold,
  onHoldEnd,
  scrolling,
  className,
  style,
  children,
}: RowProps) {
  const a = typeof style.height === "number" ? style.height : 44;
  const scroller = useRef<HTMLDivElement>(null);
  // Rows mount as the list scrolls: each starts centred before it is painted.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = 2 * a;
  }, [a]);
  // The listeners below are attached once; they call the latest props.
  const props = useRef({ onTap, onSwipe, onSwipeStart, onHold, onHoldEnd, scrolling });
  props.current = { onTap, onSwipe, onSwipeStart, onHold, onHoldEnd, scrolling };
  if (swipePerf.on) swipePerf.renders++;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const home = 2 * a;
    /**
     * One gesture's state. `panned`: the browser took the touch over
     * (pointercancel) — a slide or a list scroll; `moved`: this slip scrolled
     * under the finger — a slide; `caught`: the touch landed on a slip
     * still gliding home.
     */
    const g = {
      touching: false,
      panned: false,
      moved: false,
      caught: false,
      /** A steep drag: a scroll, never a grade (lockAxis, as WordRow). */
      steep: false,
      returning: false,
      held: false,
      catching: false,
      x0: 0,
      y0: 0,
      finger: 0,
      hold: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    const hasScrollEnd = "onscrollend" in window;
    const glideHome = () => {
      g.returning = true;
      el.scrollTo({ left: home, behavior: "smooth" });
    };
    /** The scroller came to rest: grade where it landed, then glide home. */
    const settle = () => {
      if (g.touching) return; // still under the finger: the gesture isn't over
      const offset = home - el.scrollLeft; // + = slid right
      if (g.returning) {
        if (Math.abs(offset) < 1) g.returning = false;
        return;
      }
      // Only a slide this gesture made grades (not a glide caught by a tap,
      // nor a steep drag the browser let slide anyway).
      const swiped = g.panned && g.moved && !g.steep;
      g.panned = g.moved = false;
      if (g.steep) return void glideHome();
      if (!swiped) return void (Math.abs(offset) >= 1 && glideHome());
      const r = restRating(offset, a);
      swipePerf.stop(r ? "swipe" : "swipe-cancel");
      logSwipe({ finger: g.finger, v: 0, projected: offset, rating: r, a, params: NATIVE_PARAMS });
      if (Math.abs(offset) >= 1) glideHome();
      if (r) props.current.onSwipe(r);
    };
    /** The first scroll under the finger: a slide (a vertical drag never scrolls this). */
    const slid = () => {
      g.moved = true;
      if (!g.caught && !g.steep) props.current.onSwipeStart?.();
    };
    const touchstart = (e: TouchEvent) => {
      g.touching = true;
      g.caught = g.returning;
      g.returning = false;
      g.panned = g.moved = false;
      g.x0 = e.touches[0].clientX;
      g.y0 = e.touches[0].clientY;
      g.finger = 0;
      g.steep = false;
      swipePerf.start();
      el.addEventListener("scroll", slid, { once: true, passive: true });
      el.addEventListener("touchmove", axis, { passive: false });
    };
    /**
     * The browser hands a diagonal drag to this slip when it can scroll that
     * way at all; WordRow's rule is stricter (lockAxis: clearly sideways).
     * Decided once per gesture, before the browser starts scrolling (this
     * listener blocks only until then): a steep drag locks the slip, so the
     * list scrolls instead.
     */
    const axis = (e: TouchEvent) => {
      const t = e.touches[0];
      const locked = t && lockAxis(t.clientX - g.x0, t.clientY - g.y0);
      if (!locked) return;
      el.removeEventListener("touchmove", axis);
      if (locked === "v") {
        g.steep = true;
        el.style.overflowX = "hidden";
      }
    };
    const touchend = (e: TouchEvent) => {
      if (e.touches.length) return;
      g.touching = false;
      g.finger = (e.changedTouches[0]?.clientX ?? g.x0) - g.x0;
      el.removeEventListener("scroll", slid);
      el.removeEventListener("touchmove", axis);
      if (g.steep && !g.held) el.style.overflowX = "";
      if (!g.moved) swipePerf.stop(g.panned ? "scroll" : "tap");
      // No scrollend: lifted while resting on a level, the quiet timer has
      // already run (and waited for the finger). scrollend comes after the lift.
      if (!hasScrollEnd)
        setTimeout(() => {
          const k = el.scrollLeft / a;
          if (!g.touching && Math.abs(k - Math.round(k)) < 1 / a) settle();
        }, 50);
    };
    const pointerdown = (e: PointerEvent) => {
      g.held = false;
      g.catching = props.current.scrolling?.() ?? false;
      clearTimeout(g.hold);
      if (g.catching) return;
      g.hold = setTimeout(() => {
        g.held = true;
        // A hold stays a hold: the slip no longer slides until the finger lifts.
        el.style.overflowX = "hidden";
        props.current.onHold?.();
      }, HOLD_MS);
    };
    const endHold = () => {
      clearTimeout(g.hold);
      if (!g.held) return false;
      g.held = false;
      el.style.overflowX = "";
      props.current.onHoldEnd?.();
      return true;
    };
    const pointerup = (e: PointerEvent) => {
      if (endHold()) return;
      // The browser never took the touch over: a tap — unless it caught a fling.
      if (!g.panned && !g.catching) props.current.onTap(e.timeStamp);
    };
    const pointercancel = () => {
      // Scrolling began (this slip or the list): not a tap, not a hold.
      g.panned = true;
      endHold();
    };
    const snapping = () => g.touching && navigator.vibrate?.(6);
    // Older Safari has no scrollend: no scroll for 150 ms counts as settled.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const scrolled = () => {
      clearTimeout(quiet);
      quiet = setTimeout(settle, 150);
    };
    // The reveal follows the detent the slip is nearest (the far one's grade
    // takes over the first one's spot).
    const strip = el.querySelector<HTMLElement>("[data-swipe-strip]");
    const reveal = () =>
      showReveal(strip, Math.max(-2, Math.min(2, Math.round((home - el.scrollLeft) / a))));
    el.addEventListener("scroll", reveal, { passive: true });
    el.addEventListener("touchstart", touchstart, { passive: true });
    el.addEventListener("touchend", touchend, { passive: true });
    el.addEventListener("touchcancel", touchend, { passive: true });
    el.addEventListener("pointerdown", pointerdown);
    el.addEventListener("pointerup", pointerup);
    el.addEventListener("pointercancel", pointercancel);
    el.addEventListener("scrollsnapchanging", snapping);
    if (hasScrollEnd) el.addEventListener("scrollend", settle);
    else el.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      clearTimeout(g.hold);
      clearTimeout(quiet);
      el.removeEventListener("touchstart", touchstart);
      el.removeEventListener("touchend", touchend);
      el.removeEventListener("touchcancel", touchend);
      el.removeEventListener("pointerdown", pointerdown);
      el.removeEventListener("pointerup", pointerup);
      el.removeEventListener("pointercancel", pointercancel);
      el.removeEventListener("scrollsnapchanging", snapping);
      el.removeEventListener("scrollend", settle);
      el.removeEventListener("scroll", scrolled);
      el.removeEventListener("scroll", reveal);
      el.removeEventListener("scroll", slid);
      el.removeEventListener("touchmove", axis);
    };
  }, [a]);
  return (
    <div
      role="listitem"
      data-i={index}
      data-swipe="native"
      // The wrapper lifts the focused slip (z-index, shadow): the scroller
      // would clip a shadow drawn by the face.
      className={`slip-native ${loose ? "slip-loose" : ""}`}
      style={{ height: style.height, ["--a" as string]: `${a}px` }}
    >
      <div ref={scroller} className="slip-scroller" style={{ WebkitTouchCallout: "none" }}>
        <div className="slip-track">
          <div aria-hidden className="slip-strip" data-swipe-strip>
            <GradeZones />
          </div>
          {[0, 1, 2, 3, 4].map((k) => (
            <i key={k} className="slip-snap" style={{ left: k * a }} />
          ))}
          <div className={`slip-face ${className} ${loose ? "slip-loose" : ""}`}>
            {children}
            {/* Counter-moved by the scroll position (CSS): the cords stay pinned. */}
            <span className="slip-pin pointer-events-none absolute inset-0">
              <SlipCords loose={loose} moving={false} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
