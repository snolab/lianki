"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
/**
 * Touch grading by swipe distance: a short swipe is the milder grade, a long
 * one the stronger. ← short Hard, ← long Again; → short Good, → long Easy.
 */
const SWIPE_PX = 40;
/** A touch held this long without moving starts listen mode (looped audio). */
const HOLD_MS = 300;
const SWIPE_FAR_PX = 110;
const swipeRating = (dx: number): Rating | null =>
  dx <= -SWIPE_FAR_PX
    ? 1
    : dx <= -SWIPE_PX
      ? 2
      : dx >= SWIPE_FAR_PX
        ? 4
        : dx >= SWIPE_PX
          ? 3
          : null;
const SWIPE_BG: Record<Rating, string> = {
  1: "rgb(239 68 68 / 0.4)",
  2: "rgb(245 158 11 / 0.35)",
  3: "rgb(16 185 129 / 0.3)",
  4: "rgb(14 165 233 / 0.4)",
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
};
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

const KEY_RATING: Record<string, Rating> = {
  KeyA: 1,
  KeyH: 1,
  KeyS: 2,
  KeyJ: 2,
  KeyW: 3,
  KeyK: 3,
  KeyD: 4,
  KeyL: 4,
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
};
const RATING_STYLE: Record<Rating, string> = {
  1: "bg-red-500/25",
  2: "bg-amber-500/25",
  3: "bg-emerald-500/20",
  4: "bg-sky-500/25",
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
 * language the OS has a voice for. A word in a language with no voice is silent.
 */
function useSpeech() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem("lk:words-sound") !== "off";
    } catch {
      return true;
    }
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * Bumped by stop(). cancel() can fire the old utterance's onend, which would
   * otherwise schedule the old word again beside the new loop, forever.
   */
  const generation = useRef(0);

  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const pick = () => setVoices(speechSynthesis.getVoices());
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
    return () => speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  const voiceFor = useCallback(
    (lang: string) => {
      const vs = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
      return vs.find((v) => v.localService) ?? vs[0] ?? null;
    },
    [voices],
  );

  const stop = useCallback(() => {
    generation.current++;
    clearTimeout(timer.current);
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }, []);

  const speak = useCallback(
    (text: string, lang: string, then?: () => void, force = false) => {
      const voice = voiceFor(lang);
      if (!voice || (!on && !force) || !text) return;
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 0.9;
      if (then) u.onend = then;
      speechSynthesis.speak(u);
    },
    [voiceFor, on],
  );

  /** Repeat `text` with a pause until the next call; "" just stops. */
  /**
   * Say `texts` in turn (the word, then its example), pause, repeat — until
   * the next call; an empty list just stops.
   */
  const loop = useCallback(
    (texts: string[], lang: string, force = false) => {
      stop();
      const parts = texts.filter(Boolean);
      if (!parts.length) return;
      const gen = generation.current;
      let i = 0;
      const say = () => gen === generation.current && speak(parts[i], lang, after, force);
      const after = () => {
        if (gen !== generation.current) return;
        i = (i + 1) % parts.length;
        // A short gap between word and example; a longer one before repeating.
        timer.current = setTimeout(say, i === 0 ? 1200 : 400);
      };
      // A short delay so flicking through rows does not start a word per row.
      timer.current = setTimeout(say, 250);
      return stop;
    },
    [speak, stop],
  );

  const once = useCallback(
    (text: string, lang: string, force = false) => {
      stop();
      speak(text, lang, undefined, force);
    },
    [speak, stop],
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
    () => ({ available: voices.length > 0, on, loop, once, toggle }),
    [voices, on, loop, once, toggle],
  );
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
  if (flushing) return;
  flushing = true;
  clearTimeout(retryTimer);
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
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    // Ops left from an earlier visit, and a slow heartbeat in case "online"
    // never fires (it is unreliable on some phones).
    void flushPending();
    const t = setInterval(() => void flushPending(), 30_000);
    return () => {
      syncListeners.delete(setS);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      clearInterval(t);
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
};

const WORDS: DrillConfig = {
  base: "/words",
  title: "Word lists",
  intro: "An endless list: grade each word with A / S / W / D — it is saved at once. Z undoes.",
  readingOnBack: true,
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
    return allLists?.filter((l) => l.source && (ids.has(l.source) || l.source === group)) ?? null;
  }, [allLists, catalog, config]);

  if (error)
    return (
      <div className="p-8 text-red-400">
        {error === "Login required" ? "Sign in to use word lists." : error}
      </div>
    );
  if (!lists || !catalog) return <div className="p-8 opacity-60">Loading…</div>;

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
        catalog={catalog}
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
      catalog={catalog}
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
    .map((l) => catalog.find((c) => c.id === l.source)?.file)
    .filter((f): f is string => !!f);
  const total = files.length + 2;
  let done = 0;
  const step = () => progress(++done, total);
  await downloadCatalog(`${config.base}/index.json`);
  step();
  for (const f of files) {
    await downloadCatalog(`${config.base}/${f}`);
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
}: {
  list: WordList;
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
      {index < 9 && (
        <kbd className="hidden sm:inline text-xs opacity-40 tabular-nums">{index + 1}</kbd>
      )}
      <button className="flex-1 text-left min-w-0" onClick={() => onOpen(l.id)}>
        <div className="font-medium truncate">
          {isGroup && "📁 "}
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
        Study
      </button>
      <button
        className="text-xs opacity-40 hover:opacity-80"
        onClick={async () => {
          const what = isGroup
            ? `Delete group "${l.name}"? The lists inside it are kept and move up a level.`
            : `Delete "${l.name}" and its progress?`;
          if (!confirm(what)) return;
          await api(`/api/words/lists/${l.id}`, { method: "DELETE" });
          onDeleted();
        }}
      >
        delete
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
  const langs = useMemo(() => [...new Set(catalog.map((c) => c.lang))], [catalog]);
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
              ⬇ Download for offline
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
          <kbd className="hidden sm:inline text-xs opacity-50">0</kbd>
          <span className="flex-1">
            <span className="font-medium">Study all lists together</span>
            <span className="block text-xs opacity-60">New words come in the order below.</span>
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
      <button
        onClick={addGroup}
        className="text-sm px-3 py-1.5 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
      >
        + New group
      </button>

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
            {catalog
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
              {catalog.find((c) => c.lang === lang)?.source} —{" "}
              {catalog.find((c) => c.lang === lang)?.license}
            </p>
          </div>
        )}
      </div>
    </div>
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
  const sync = useSyncStatus();
  /** The queue was built from the offline copy. */
  const [offlineCopy, setOfflineCopy] = useState(false);
  const [help, setHelp] = useState(false);
  /** Every meaning shown, not just the focused / pinned rows. */
  const [showAll, setShowAll] = useState(false);
  /** Touch: say the word as a swipe starts. Remembered; on by default. */
  const [swipeSpeak, setSwipeSpeak] = useState(true);
  useEffect(() => {
    try {
      setSwipeSpeak(localStorage.getItem("lk:words-swipe-speak") !== "0");
    } catch {}
  }, []);
  const toggleSwipeSpeak = (on: boolean) => {
    setSwipeSpeak(on);
    try {
      localStorage.setItem("lk:words-swipe-speak", on ? "1" : "0");
    } catch {}
  };
  /** Touch: the row being held (listen mode) — revealed and looped while held. */
  const [holding, setHolding] = useState<number | null>(null);
  /** After a swipe grades a row, scroll the list down one row. Remembered. */
  const [swipeScroll, setSwipeScroll] = useState(false);
  useEffect(() => {
    try {
      setSwipeScroll(localStorage.getItem("lk:words-swipe-scroll") === "1");
    } catch {}
  }, []);
  const toggleSwipeScroll = (on: boolean) => {
    setSwipeScroll(on);
    try {
      localStorage.setItem("lk:words-swipe-scroll", on ? "1" : "0");
    } catch {}
  };
  const started = useRef(Date.now());
  const touch = useTouch();
  const speech = useSpeech();
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
   * Words in a learning step (due again within minutes) wait here and join the
   * end of the list only once due — met early, grading them would re-grade
   * the review just made instead of recording a new one.
   */
  const later = useRef<{ item: Item; due: number }[]>([]);
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const ready = later.current.filter((x) => x.due <= now);
      if (!ready.length) return;
      later.current = later.current.filter((x) => x.due > now);
      setQueue((q) => [...q, ...ready.map((x) => x.item)]);
    }, 3000);
    return () => clearInterval(t);
  }, []);
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
          ? loadCatalog<{ entries: Entry[] }>(`${base}/${meta.file}`).then((d) => d.entries)
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
      // New words: just enough to start, in list order; more load as you go.
      const fresh = await takeNew(AHEAD);
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
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const row = rowRef.current;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      // Holding a key repeats movement only, never grading or undo.
      const moves = ["ArrowDown", "ArrowUp", "KeyF", "KeyU", "KeyR", "KeyI"];
      if (e.repeat && !moves.includes(e.code)) return e.preventDefault();
      // R/I up, F/U down: home-row alternatives to the arrows for either hand.
      if (["ArrowDown", "KeyF", "KeyU"].includes(e.code)) moveRow(row + 1);
      else if (["ArrowUp", "KeyR", "KeyI"].includes(e.code)) moveRow(row - 1);
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
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const listReady = !loading && !loadError && queue.length > 0;
  useLayoutEffect(() => {
    const fit = () => {
      const el = listRef.current;
      if (!el) return;
      // Fill down to the bottom of the window, leaving room for the key hints.
      setViewH(Math.max(160, window.innerHeight - el.getBoundingClientRect().top - 40));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [listReady]);
  // Keep the cursor in view as it moves, a couple of rows from the edges.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const top = row * ROW_H;
    if (top < el.scrollTop + ROW_H) el.scrollTop = Math.max(0, top - ROW_H);
    else if (top + ROW_H > el.scrollTop + el.clientHeight - ROW_H * 2)
      el.scrollTop = top + ROW_H * 3 - el.clientHeight;
  }, [row, ROW_H]);

  // Touch has no cursor: the row a third of the way down the list is the
  // "focus line". When scrolling settles there, it is read once — so with
  // scroll-after-swipe each next word speaks itself, like the desktop loop.
  const [focusLine, setFocusLine] = useState(0);
  useEffect(() => {
    if (!touch) return;
    const t = setTimeout(
      () =>
        setFocusLine(
          Math.max(0, Math.min(queue.length - 1, Math.floor((scrollTop + viewH / 3) / ROW_H))),
        ),
      200,
    );
    return () => clearTimeout(t);
  }, [touch, scrollTop, viewH, ROW_H, queue.length]);
  const focusItem = touch ? queue[focusLine] : undefined;
  const focusText = focusItem ? spokenText(focusItem, focusItem.lang, !!config.readingOnBack) : "";
  useEffect(() => {
    if (!touch || !active || holding !== null || !focusItem) return;
    speech.once(focusText, focusItem.lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touch, focusLine, focusText]);

  /** How far down the list the user has got: the cursor, or the last row in view. */
  const reach = Math.max(row, Math.floor((scrollTop + viewH) / ROW_H));
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
  const say = focused ? spokenText(focused, focused.lang, !!config.readingOnBack) : "";
  const sayEx = focused?.ex ?? "";
  const sayLang = focused?.lang ?? "";
  useEffect(() => speech.loop([say, sayEx], sayLang), [say, sayEx, sayLang, speech]);

  // Windowed rendering: the list is endless, the DOM is not.
  const OVERSCAN = 20;
  const from = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const to = Math.min(queue.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const hasExamples = queue.slice(from, to).some((it) => it.ex);

  const done = grades.size;
  const minutes = (Date.now() - started.current) / 60_000;
  const ahead = queue.filter((_, i) => i >= row && !grades.has(i));
  const dueLeft = ahead.filter((it) => it.kind !== "new").length;

  const status = (it: Item, i: number) => {
    const g = grades.get(i);
    if (g) {
      // Saved: when it actually comes back. Not yet saved: the preview.
      if (g.card) return formatInterval(dueOf(g.card) - Date.now());
      return previewInterval(it.card, g.rating, paramsOf.get(it.listId)!);
    }
    if (it.kind === "new" || !it.card) return "new";
    return `${formatInterval(Date.now() - dueOf(it.card))} ago`;
  };

  return (
    // Full width: wide screens get room for longer explanations.
    <div className="w-full px-3 py-4 sm:px-8 sm:py-6">
      <div className="sticky top-0 z-10 -mx-3 sm:-mx-8 px-3 sm:px-8 py-2 mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm bg-[var(--background)] backdrop-blur">
        <button className="opacity-60 hover:opacity-100 whitespace-nowrap" onClick={onExit}>
          ← lists
        </button>
        <span className="font-medium">{title}</span>
        <button
          className={`px-2 py-0.5 rounded text-xs ${
            showAll
              ? "bg-black/20 dark:bg-white/25"
              : "bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
          }`}
          onClick={() => setShowAll((v) => !v)}
          title="Show every meaning (E)"
        >
          {showAll ? "Hide meanings" : "Show all"}
        </button>
        {touch && (
          <button
            className="px-2 py-0.5 rounded text-xs bg-black/10 dark:bg-white/10"
            onClick={() => undo()}
            aria-label="Undo"
          >
            ↶ Undo
          </button>
        )}
        {touch && (
          <label className="flex items-center gap-1 text-xs opacity-80">
            <input
              type="checkbox"
              checked={swipeScroll}
              onChange={(e) => toggleSwipeScroll(e.target.checked)}
            />
            scroll after swipe
          </label>
        )}
        {touch && (
          <label className="flex items-center gap-1 text-xs opacity-80">
            <input
              type="checkbox"
              checked={swipeSpeak}
              onChange={(e) => toggleSwipeSpeak(e.target.checked)}
            />
            speak on swipe
          </label>
        )}
        <span className="w-full sm:w-auto sm:ml-auto tabular-nums opacity-70 text-xs sm:text-sm">
          {done} done · {minutes > 0.2 ? Math.round(done / minutes) : "–"}/min · {dueLeft} due ·{" "}
          {ahead.length - dueLeft} new
          {sync.pending > 0 ? (
            <span
              data-sync="pending"
              className={sync.online ? "" : "text-amber-700 dark:text-amber-300"}
            >
              {sync.online ? ` · ${sync.pending} saving…` : ` · offline · ${sync.pending} to sync`}
            </span>
          ) : (
            <span data-sync="synced">
              {!sync.online || offlineCopy ? " · offline" : ""}
              {sync.online && grades.size > 0 ? " · synced ✓" : ""}
            </span>
          )}
          {speech.available && (
            <button className="ml-2 opacity-80" onClick={speech.toggle} title="Sound (V)">
              {speech.on ? "🔊" : "🔇"}
            </button>
          )}
        </span>
      </div>
      {syncError && <div className="text-red-500 text-sm mb-2">Not saved: {syncError}</div>}
      {notice && <div className="text-amber-600 dark:text-amber-300 text-sm mb-2">{notice}</div>}

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
          {exhausted ? "Every word learned. 🎉" : "Loading more…"}
        </div>
      ) : (
        <>
          <div
            ref={listRef}
            className="rounded-lg border border-black/10 dark:border-white/10 overflow-y-auto overscroll-contain"
            style={{ height: viewH }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            role="list"
          >
            <div style={{ height: from * ROW_H }} />
            {queue.slice(from, to).map((it, k) => {
              const i = from + k;
              const g = grades.get(i);
              const rating = g?.rating;
              // The keyboard cursor reveals its row, as hovering does.
              const show = showAll || revealed.has(i) || (!touch && i === row) || holding === i;
              return (
                <WordRow
                  key={i}
                  index={i}
                  touch={touch}
                  onHover={() => moveRow(i)}
                  // Desktop click = Again; on touch a tap reveals and reads it.
                  onTap={() =>
                    touch
                      ? (speech.once(
                          spokenText(it, it.lang, !!config.readingOnBack),
                          it.lang,
                          true,
                        ),
                        setRevealed((s) => {
                          const n = new Set(s);
                          if (n.has(i)) n.delete(i);
                          else n.add(i);
                          return n;
                        }))
                      : grade(i, 1)
                  }
                  onSwipeStart={() =>
                    swipeSpeak &&
                    speech.once(spokenText(it, it.lang, !!config.readingOnBack), it.lang)
                  }
                  onHold={() => {
                    setHolding(i);
                    speech.loop(
                      [spokenText(it, it.lang, !!config.readingOnBack), it.ex ?? ""],
                      it.lang,
                      true,
                    );
                  }}
                  onHoldEnd={() => {
                    setHolding(null);
                    speech.loop([], "");
                  }}
                  onSwipe={(r) => {
                    grade(i, r);
                    if (swipeScroll) listRef.current?.scrollBy({ top: ROW_H, behavior: "smooth" });
                  }}
                  className={`group grid items-center gap-2 px-2 leading-none cursor-pointer select-none border-b border-black/5 dark:border-white/5 ${
                    touch
                      ? "grid-cols-[minmax(6rem,12rem)_1fr_3rem] text-base"
                      : hasExamples
                        ? "grid-cols-[1.25rem_minmax(8rem,16rem)_minmax(10rem,1fr)_minmax(12rem,1.4fr)_3.5rem] text-[15px]"
                        : "grid-cols-[1.25rem_minmax(8rem,18rem)_1fr_3.5rem] text-[15px]"
                  } ${rating ? RATING_STYLE[rating] : ""} ${
                    i === row && !touch
                      ? "outline outline-1 -outline-offset-1 outline-black/40 dark:outline-white/40"
                      : touch && i === focusLine
                        ? "shadow-[inset_3px_0_0_0] shadow-emerald-500"
                        : ""
                  }`}
                  style={{ height: ROW_H }}
                >
                  {!touch && <span className="text-[10px] opacity-40">{i === row ? "▸" : ""}</span>}
                  <span
                    className={`truncate font-medium ${
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
                  </span>
                  <span
                    className={`truncate text-sm opacity-80 transition-[filter] duration-75 ${
                      show ? "" : touch ? "blur-[6px]" : "blur-[5px] group-hover:blur-none"
                    }`}
                  >
                    {config.readingOnBack && it.reading && it.reading !== it.term && (
                      <span className="mr-2 font-medium">{it.reading}</span>
                    )}
                    {it.back}
                  </span>
                  {hasExamples && !touch && (
                    // The example is part of the answer side: hidden with the meaning.
                    <span
                      className={`truncate text-sm opacity-70 transition-[filter] duration-75 ${
                        show ? "" : "blur-[5px] group-hover:blur-none"
                      }`}
                      title={it.ex ? `${it.ex}\n${it.exTr ?? ""}` : undefined}
                    >
                      {it.ex}
                      {it.exTr && <span className="ml-2 text-xs opacity-60">{it.exTr}</span>}
                    </span>
                  )}
                  {/* Graded: when it comes back. Ungraded: "new", or how long it has been due. */}
                  <span
                    className={`text-[11px] text-right tabular-nums ${rating ? "opacity-90 font-medium" : "opacity-40"}`}
                    title={rating ? RATING_LABEL[rating] : "due"}
                  >
                    {status(it, i)}
                  </span>
                </WordRow>
              );
            })}
            <div style={{ height: (queue.length - to) * ROW_H }} />
          </div>
          <div className="mt-2 text-[11px] opacity-50">
            {exhausted && ahead.length === 0
              ? "Every word learned. 🎉"
              : touch
                ? "tap = show + say · hold = listen (loops) · swipe ← a little Hard, far Again · swipe → a little Good, far Easy · ↶ undo"
                : help
                  ? "↑↓ / R F / I U move (the focused row shows its meaning) · Space pin · E show all · A Again · S Hard · W Good · D Easy (also H/J/K/L, 1–4) · grading again re-grades · click = Again · Z / M undo (repeat to go further back) · Esc undo this row · Enter next ungraded · V sound · ? hide help"
                  : "A Again · S Hard · W Good · D Easy · Z undo · ? all keys"}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One row. On touch, tap = onTap and a horizontal swipe grades by distance
 * (see swipeRating); the row follows the finger and shows the grade it will
 * give. Rows only claim horizontal drags (touch-action: pan-y), so vertical
 * scrolling stays native.
 */
function WordRow({
  index,
  touch,
  onHover,
  onTap,
  onSwipe,
  onSwipeStart,
  onHold,
  onHoldEnd,
  className,
  style,
  children,
}: {
  index: number;
  touch: boolean;
  onHover: () => void;
  onTap: () => void;
  onSwipe: (r: Rating) => void;
  /** The finger has started moving sideways (a grade is being decided). */
  onSwipeStart?: () => void;
  /** Held still for HOLD_MS: listen mode until the finger lifts. */
  onHold?: () => void;
  onHoldEnd?: () => void;
  className: string;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const swiping = useRef(false);

  if (!touch)
    return (
      <div
        role="listitem"
        data-i={index}
        // Only a real mouse move takes the cursor: Chrome replays mouse events
        // at a resting pointer when rows re-render, which would otherwise yank
        // the cursor back under the mouse after every key press.
        onMouseMove={(e) => (e.movementX || e.movementY) && onHover()}
        onClick={onTap}
        className={className}
        style={style}
      >
        {children}
      </div>
    );

  const pending = swipeRating(dx);
  return (
    <div
      role="listitem"
      data-i={index}
      className={`relative ${className}`}
      style={{
        ...style,
        touchAction: "pan-y",
        // A hold is listen mode, not iOS's callout / text-selection menu.
        WebkitTouchCallout: "none",
        transform: dx ? `translateX(${dx}px)` : undefined,
        background: pending ? SWIPE_BG[pending] : undefined,
      }}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY };
        held.current = false;
        swiping.current = false;
        // Keep receiving the gesture even if the finger leaves this row.
        e.currentTarget.setPointerCapture(e.pointerId);
        clearTimeout(holdTimer.current);
        holdTimer.current = setTimeout(() => {
          held.current = true;
          onHold?.();
        }, HOLD_MS);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const x = e.clientX - start.current.x;
        const y = e.clientY - start.current.y;
        // Any real movement is a swipe or a scroll, not a hold.
        if (!held.current && Math.hypot(x, y) > 8) clearTimeout(holdTimer.current);
        if (Math.abs(x) > Math.abs(y)) {
          if (!swiping.current && Math.abs(x) > 12) {
            swiping.current = true;
            onSwipeStart?.();
          }
          setDx(Math.max(-160, Math.min(160, x)));
        }
      }}
      onPointerUp={() => {
        clearTimeout(holdTimer.current);
        const moved = dx;
        setDx(0);
        if (!start.current) return;
        start.current = null;
        if (held.current) {
          // Listening, not grading: the hold ends, nothing else happens.
          held.current = false;
          onHoldEnd?.();
          return;
        }
        const r = swipeRating(moved);
        if (r) onSwipe(r);
        else if (Math.abs(moved) < 8) onTap();
      }}
      onPointerCancel={() => {
        clearTimeout(holdTimer.current);
        if (held.current) onHoldEnd?.();
        held.current = false;
        start.current = null;
        setDx(0);
      }}
    >
      {children}
      {pending && (
        <span
          className={`absolute top-1/2 -translate-y-1/2 text-xs font-semibold ${dx < 0 ? "right-2" : "left-2"}`}
        >
          {RATING_LABEL[pending]}
        </span>
      )}
    </div>
  );
}
