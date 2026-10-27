"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WordCard, WordList } from "@/lib/repos/wordsD1";
import { spokenText } from "@/lib/words/spoken";
import { formatInterval, previewInterval } from "@/lib/words/schedule";

/**
 * Sub-second word-list review.
 *
 * A screen shows PAGE words at once — due words first, then new words in a
 * different colour, so finishing the due words flows straight into learning
 * new ones. Grading is by exception: mark only the words you missed, press
 * Enter, and every unmarked word counts as Good. The screen is submitted in one
 * request in the background; the next screen never waits for the network.
 */

const PAGE = 20;
/** Due words per /session fetch; more are fetched as the queue drains. */
const DUE_PAGE = 200;
/** Fewer, taller rows on a touch screen: 44px is a comfortable thumb target. */
const PAGE_TOUCH = 12;
/**
 * Touch grading by swipe distance: a short swipe is the milder grade, a long
 * one the stronger. ← short Hard, ← long Again; → short Good, → long Easy.
 */
const SWIPE_PX = 40;
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
  3: "",
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
    (text: string, lang: string, then?: () => void) => {
      const voice = voiceFor(lang);
      if (!voice || !on || !text) return;
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
  const loop = useCallback(
    (text: string, lang: string) => {
      stop();
      if (!text) return;
      const gen = generation.current;
      const say = () => gen === generation.current && speak(text, lang, again);
      // A short delay so flicking through rows does not start a word per row.
      const again = () => {
        if (gen === generation.current) timer.current = setTimeout(say, 900);
      };
      timer.current = setTimeout(say, 250);
      return stop;
    },
    [speak, stop],
  );

  const once = useCallback(
    (text: string, lang: string) => {
      stop();
      speak(text, lang);
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

type Draft = { day: string; items: Item[]; marks: [string, Rating][]; flushed: [string, Rating][] };

/** Today's draft screen for a list, if one was saved. */
function readDraft(key: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null;
    return d && d.day === localDay() && Array.isArray(d.items) && d.items.every((it) => it.listId)
      ? d
      : null;
  } catch {
    return null;
  }
}

function writeDraft(
  key: string,
  page: Item[],
  marks: Map<number, Rating>,
  flushed: Map<string, Rating>,
) {
  try {
    const draft: Draft = {
      day: localDay(),
      items: page,
      marks: [...marks].filter(([i]) => page[i]).map(([i, r]) => [keyOf(page[i]), r]),
      flushed: [...flushed],
    };
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {}
}

function clearDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return res.json() as Promise<T>;
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
  intro: "Fast review: a screen of words at once. Mark only the ones you miss, press Enter.",
  readingOnBack: true,
};

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

  const refreshLists = useCallback(async () => {
    try {
      const { lists } = await api<{ lists: WordList[] }>("/api/words/lists");
      setLists(lists);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refreshLists();
    fetch(`${config.base}/index.json`)
      .then((r) => (r.ok ? r.json() : { lists: [] }))
      .then((d) => setCatalog(d.lists ?? []))
      .catch(() => setCatalog([]));
  }, [refreshLists, config.base]);

  // Both pages share the word_lists table; each shows only lists from its own
  // catalog, so alphabets never appear among the vocabulary lists.
  const lists = useMemo(() => {
    if (!catalog) return null;
    const ids = new Set(catalog.map((c) => c.id));
    return allLists?.filter((l) => l.source && ids.has(l.source)) ?? null;
  }, [allLists, catalog]);

  if (error)
    return (
      <div className="p-8 text-red-400">
        {error === "Login required" ? "Sign in to use word lists." : error}
      </div>
    );
  if (!lists || !catalog) return <div className="p-8 opacity-60">Loading…</div>;

  const studying = listId === ALL ? lists : lists.filter((l) => l.id === listId);
  // "Study all" with only one list is just that list.
  if (studying.length)
    return (
      <Study
        key={listId}
        config={config}
        lists={studying}
        catalog={catalog}
        title={listId === ALL ? `All ${config.title.toLowerCase()}` : studying[0].name}
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
      onOpen={setListId}
      onCreated={async (id) => {
        await refreshLists();
        setListId(id);
      }}
      onDeleted={refreshLists}
      onReorder={async (order) => {
        // Show the new order at once; the server confirms with its own.
        setLists((all) => {
          if (!all) return all;
          const pos = new Map(order.map((id, i) => [id, i]));
          return [...all].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
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

function ListPicker({
  config,
  lists,
  catalog,
  onOpen,
  onCreated,
  onDeleted,
  onReorder,
}: {
  config: DrillConfig;
  lists: WordList[];
  catalog: CatalogMeta[];
  onOpen: (id: string) => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  /** New order of list ids; also the order "study all" learns new words in. */
  onReorder: (order: string[]) => void;
}) {
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= lists.length) return;
    const order = lists.map((l) => l.id);
    [order[i], order[j]] = [order[j], order[i]];
    onReorder(order);
  };
  const [busy, setBusy] = useState(false);
  const langs = useMemo(() => [...new Set(catalog.map((c) => c.lang))], [catalog]);
  const [lang, setLang] = useState<string>("");
  const added = new Set(lists.map((l) => l.source));

  // 1–9 open the matching list, so the whole flow works without a mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(e.key);
      if (e.key === "0" && lists.length > 1) onOpen(ALL);
      else if (n >= 1 && n <= 9 && lists[n - 1]) onOpen(lists[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lists, onOpen]);

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

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{config.title}</h1>
        <p className="opacity-70 text-sm mt-1">{config.intro}</p>
      </div>

      {lists.length > 1 && (
        <button
          onClick={() => onOpen(ALL)}
          className="w-full flex items-center gap-3 rounded-lg bg-emerald-700/40 hover:bg-emerald-700/60 px-4 py-3 text-left"
        >
          <kbd className="hidden sm:inline text-xs opacity-50">0</kbd>
          <span className="flex-1">
            <span className="font-medium">Study all lists together</span>
            <span className="block text-xs opacity-60">New words come in the order below.</span>
          </span>
          <span className="text-xs opacity-70 tabular-nums">
            {lists.reduce((n, l) => n + l.due, 0)} due
          </span>
        </button>
      )}
      {lists.length > 0 && (
        <div className="space-y-2">
          {lists.map((l, i) => (
            <div key={l.id} className="flex items-center gap-3 rounded-lg bg-white/5 px-4 py-3">
              <div className="flex flex-col -my-1 text-[10px] leading-none">
                <button
                  className="opacity-40 hover:opacity-100 disabled:opacity-10 px-1"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  className="opacity-40 hover:opacity-100 disabled:opacity-10 px-1"
                  disabled={i === lists.length - 1}
                  onClick={() => move(i, 1)}
                  title="Move down"
                >
                  ▼
                </button>
              </div>
              {i < 9 && (
                <kbd className="hidden sm:inline text-xs opacity-40 tabular-nums">{i + 1}</kbd>
              )}
              <button className="flex-1 text-left" onClick={() => onOpen(l.id)}>
                <div className="font-medium">{l.name}</div>
                <div className="text-xs opacity-60 tabular-nums">
                  {l.due} due · {l.learning} learning · {l.mastered} mastered (≥1y) · {l.cards}/
                  {catalog.find((c) => c.id === l.source)?.count ?? "?"} seen
                </div>
              </button>
              <button
                className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20"
                onClick={() => onOpen(l.id)}
              >
                Study
              </button>
              <button
                className="text-xs opacity-40 hover:opacity-80"
                onClick={async () => {
                  if (!confirm(`Delete "${l.name}" and its progress?`)) return;
                  await api(`/api/words/lists/${l.id}`, { method: "DELETE" });
                  onDeleted();
                }}
              >
                delete
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-medium opacity-80">Add a list</h2>
        <div className="flex flex-wrap gap-2">
          {langs.map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`px-3 py-1 rounded text-sm ${l === lang ? "bg-white/25" : "bg-white/10 hover:bg-white/20"}`}
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
                    className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40"
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

function Study({
  config,
  lists,
  catalog,
  title,
  onExit,
}: {
  config: DrillConfig;
  /** One list, or every list for "study all". */
  lists: WordList[];
  catalog: CatalogMeta[];
  title: string;
  onExit: () => void;
}) {
  const [queue, setQueue] = useState<Item[]>([]);
  const [pos, setPos] = useState(0);
  const [marks, setMarks] = useState<Map<number, Rating>>(new Map());
  const [row, setRow] = useState(0);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(0);
  const [pending, setPending] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const started = useRef(Date.now());
  const catalogs = useRef<Map<string, Entry[]>>(new Map());
  /** A word's example sentence, from its list's catalog (cards store none). */
  const byTerm = useRef<Map<string, Map<string, Entry>>>(new Map());
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
  const nextNew = useRef<Map<string, number>>(new Map(lists.map((l) => [l.id, l.cursor])));
  const listIds = lists.map((l) => l.id).join(",");
  const paramsOf = useMemo(() => new Map(lists.map((l) => [l.id, l.params])), [lists]);
  const dwell = useRef<Map<number, number>>(new Map());
  const rowSince = useRef(Date.now());
  const touch = useTouch();
  const base = config.base;
  const speech = useSpeech();
  const pageSize = touch ? PAGE_TOUCH : PAGE;
  // Read by the one-time session load, which must not re-run when it changes.
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;
  const [help, setHelp] = useState(false);
  /** Rows marked in order, so Z can undo the last one. */
  const markOrder = useRef<number[]>([]);
  /**
   * Marks already sent by a flush on leaving the page (term → rating), so the
   * screen's own submit does not grade them a second time.
   */
  const flushed = useRef<Map<string, Rating>>(new Map());
  /** Lists whose due words did not all fit in one session fetch. */
  const moreDue = useRef<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const draftKey =
    lists.length === 1 ? `lk:words-draft:${lists[0].id}` : `lk:words-draft:all${base}`;

  /** Pull up to `n` catalog words of one list that have no card yet. */
  const takeNewFrom = useCallback(async (list: WordList, n: number): Promise<Item[]> => {
    const entries = catalogs.current.get(list.id) ?? [];
    const out: Item[] = [];
    while (out.length < n && (nextNew.current.get(list.id) ?? 0) < entries.length) {
      const from = nextNew.current.get(list.id) ?? 0;
      // The /known route takes at most 500 terms.
      const slice = entries.slice(from, from + Math.min(500, Math.max(n * 2, 40)));
      const { known } = await api<{ known: string[] }>(`/api/words/lists/${list.id}/known`, {
        method: "POST",
        body: JSON.stringify({ terms: slice.map((e) => e.term) }),
      });
      // Advance only once the slice is checked: a failed request must not
      // leave its words behind the cursor, never to be introduced.
      nextNew.current.set(list.id, from + slice.length);
      const skip = new Set(known);
      slice.forEach((e, i) => {
        if (out.length < n && !skip.has(e.term))
          out.push({ ...e, kind: "new", newIndex: from + i, listId: list.id, lang: list.lang });
      });
    }
    return out;
  }, []);

  /**
   * Up to `n` new words, in the user's list order: the first list until it
   * runs out, then the next.
   */
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

  useEffect(() => {
    let alive = true;
    // Start from the stored cursors every run: a discarded run (React Strict
    // Mode mounts twice in dev) must not have advanced them.
    nextNew.current = new Map(lists.map((l) => [l.id, l.cursor]));
    (async () => {
      const loaded = await Promise.all(
        lists.map(async (list) => {
          const meta = catalog.find((c) => c.id === list.source);
          const [session, entries] = await Promise.all([
            api<{ due: WordCard[]; newRemaining: number }>(
              `/api/words/lists/${list.id}/session?day=${localDay()}`,
            ),
            meta
              ? fetch(`${base}/${meta.file}`)
                  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`catalog ${r.status}`))))
                  .then((d) => d.entries as Entry[])
              : Promise.resolve([] as Entry[]),
          ]);
          catalogs.current.set(list.id, entries);
          if (session.due.length >= DUE_PAGE) moreDue.current.add(list.id);
          const due: Item[] = session.due.map((c) => ({
            ...exampleOf(list.id, c.term),
            term: c.term,
            reading: c.reading ?? undefined,
            back: c.back,
            kind: "due",
            listId: list.id,
            lang: list.lang,
            card: c.card,
          }));
          return { due, fresh: await takeNewFrom(list, session.newRemaining) };
        }),
      );
      if (!alive) return;
      const due = interleave(loaded.map((l) => l.due));
      // New words follow the user's list order; due words alternate lists.
      const fresh = loaded.flatMap((l) => l.fresh);
      const size = pageSizeRef.current;
      const queued = [...due, ...spreadPairs(fresh, size, due.length, due)];
      // A draft is the screen that was open when the page was left: put it back
      // first, with its marks, and drop those words from the rest of the queue.
      const draft = readDraft(draftKey);
      const ids = new Set(lists.map((l) => l.id));
      if (draft && draft.items.every((it) => ids.has(it.listId))) {
        const onScreen = new Set(draft.items.map(keyOf));
        setQueue([...draft.items, ...queued.filter((it) => !onScreen.has(keyOf(it)))]);
        const index = new Map(draft.items.map((it, i) => [keyOf(it), i]));
        setMarks(new Map(draft.marks.map(([k, r]) => [index.get(k)!, r])));
        markOrder.current = draft.marks.map(([k]) => index.get(k)!);
        flushed.current = new Map(draft.flushed);
      } else setQueue(queued);
      setLoading(false);
    })().catch((e) => alive && setLoadError((e as Error).message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listIds, catalog, takeNewFrom, base, draftKey]);

  const page = queue.slice(pos, pos + pageSize);
  const hasExamples = page.some((it) => it.ex);

  const moveRow = useCallback(
    (to: number) => {
      const now = Date.now();
      dwell.current.set(row, (dwell.current.get(row) ?? 0) + now - rowSince.current);
      rowSince.current = now;
      // On desktop the Next button sits after the last word as one more row.
      setRow(Math.max(0, Math.min(touch ? page.length - 1 : page.length, to)));
    },
    [row, page.length, touch],
  );

  const mark = useCallback((i: number, r: Rating | null) => {
    setMarks((m) => {
      const n = new Map(m);
      if (r == null) n.delete(i);
      else n.set(i, r);
      return n;
    });
    markOrder.current = markOrder.current.filter((x) => x !== i);
    if (r != null) {
      markOrder.current.push(i);
      navigator.vibrate?.(10);
    }
  }, []);

  /**
   * Submit the screen. Every word must carry an explicit grade — nothing is
   * graded in bulk; `next` sends the cursor to the first ungraded word instead.
   */
  const submit = useCallback(() => {
    if (!page.length || page.some((_, i) => !marks.has(i))) return;
    const now = Date.now();
    dwell.current.set(row, (dwell.current.get(row) ?? 0) + now - rowSince.current);
    const reviews = page
      .map((it, i) => ({
        listId: it.listId,
        term: it.term,
        reading: it.reading ?? null,
        back: it.back,
        rating: marks.get(i)!,
        elapsedMs: Math.round(dwell.current.get(i) ?? 0),
        newIndex: it.kind === "new" ? it.newIndex : null,
      }))
      // Already graded by a flush on leaving: never grade it twice, even if
      // the mark changed afterwards.
      .filter((r) => !flushed.current.has(keyOf(r)));
    // Flushed misses still come back this session, like any other Again.
    const flushedBack = page.filter((it) => (flushed.current.get(keyOf(it)) ?? 3) <= 2);
    if (flushedBack.length)
      setQueue((q) => [...q, ...flushedBack.map((it): Item => ({ ...it, kind: "again" }))]);
    flushed.current = new Map();
    // Per list, the first catalog word not yet introduced: the lowest new
    // word still waiting in the queue, else where loading has got to.
    const waiting = queue.slice(pos + page.length);
    const cursorOf = (listId: string) =>
      Math.min(
        nextNew.current.get(listId) ?? 0,
        ...waiting
          .filter((it) => it.listId === listId && it.kind === "new")
          .map((it) => it.newIndex ?? Infinity),
      );
    clearDraft(draftKey);
    const byKey = new Map(page.map((it) => [keyOf(it), it]));
    setPos((p) => p + page.length);
    setMarks(new Map());
    markOrder.current = [];
    setRevealed(new Set());
    setRow(0);
    dwell.current = new Map();
    rowSince.current = Date.now();
    setDone((d) => d + page.length);
    // One request per list on the screen.
    for (const listId of new Set(reviews.map((r) => r.listId))) {
      const mine = reviews.filter((r) => r.listId === listId).map(({ listId: _, ...r }) => r);
      setPending((n) => n + 1);
      api<{ cards: WordCard[] }>(`/api/words/lists/${listId}/review`, {
        method: "POST",
        body: JSON.stringify({ day: localDay(), reviews: mine, cursor: cursorOf(listId) }),
        // Survives the tab closing right after Enter.
        keepalive: true,
      })
        .then(({ cards }) => {
          // Learning steps: words due again within minutes come back this session.
          const back = cards
            .filter((c) => new Date(c.due).getTime() - Date.now() < SESSION_WINDOW_MS)
            .map(
              (c): Item => ({
                ...byKey.get(keyOf({ listId, term: c.term }))!,
                kind: "again",
                newIndex: undefined,
                card: c.card,
              }),
            );
          if (back.length) setQueue((q) => [...q, ...back]);
          setSyncError(null);
        })
        .catch((e) => setSyncError((e as Error).message))
        .finally(() => setPending((n) => n - 1));
    }
  }, [page, marks, row, draftKey, queue, pos]);

  const firstUngraded = page.findIndex((_, i) => !marks.has(i));
  /** Next: jump to the first ungraded word, or submit once all are graded. */
  const next = useCallback(() => {
    if (firstUngraded >= 0) {
      moveRow(firstUngraded);
      document
        .querySelectorAll('[role="listitem"]')
        [firstUngraded]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstUngraded, submit]);

  // Save the open screen and its marks as a draft on every change, so a
  // refresh or a closed tab comes back to the same screen.
  useEffect(() => {
    if (!loading && page.length) writeDraft(draftKey, page, marks, flushed.current);
  }, [loading, page, marks, draftKey]);

  // Leaving the page (hidden, closed, refreshed) sends the marks made so far.
  // Unmarked words are not counted as Good — they stay on the draft screen.
  const latest = useRef({ page, marks });
  latest.current = { page, marks };
  const flush = useCallback(() => {
    const { page, marks } = latest.current;
    const reviews = [...marks]
      .filter(([i, r]) => page[i] && flushed.current.get(keyOf(page[i])) !== r)
      .map(([i, r]) => ({
        listId: page[i].listId,
        term: page[i].term,
        reading: page[i].reading ?? null,
        back: page[i].back,
        rating: r,
        // No newIndex: the catalog cursor must not skip the unmarked words
        // before this one; they still need introducing.
        newIndex: null,
      }));
    if (!reviews.length) return;
    for (const listId of new Set(reviews.map((r) => r.listId))) {
      const mine = reviews.filter((r) => r.listId === listId).map(({ listId: _, ...r }) => r);
      const body = JSON.stringify({ day: localDay(), reviews: mine });
      const url = `/api/words/lists/${listId}/review`;
      const sent = navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }));
      if (!sent)
        fetch(url, {
          method: "POST",
          body,
          keepalive: true,
          headers: { "content-type": "application/json" },
        }).catch(() => {});
    }
    for (const r of reviews) flushed.current.set(keyOf(r), r.rating);
    writeDraft(draftKey, page, marks, flushed.current);
  }, [draftKey]);
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [flush]);

  // No daily stop: when the queue runs low, keep pulling new words — anyone
  // still here has time to learn more. Stops only when the catalogs run out.
  const [exhausted, setExhausted] = useState(false);
  const fetching = useRef(false);
  useEffect(() => {
    if (loading || exhausted || fetching.current || queue.length - pos > pageSize * 2) return;
    fetching.current = true;
    const queued = new Set(queue.map(keyOf));
    const appendSpread = (items: Item[]) =>
      setQueue((q) => [...q, ...spreadPairs(items, pageSize, q.length - pos, q.slice(pos))]);
    // Due words the first fetch left out come before any new word.
    const topUpDue = async () => {
      const due: Item[] = [];
      for (const list of lists.filter((l) => moreDue.current.has(l.id))) {
        const s = await api<{ due: WordCard[] }>(
          `/api/words/lists/${list.id}/session?day=${localDay()}&limit=${DUE_PAGE}`,
        );
        const fresh = s.due.filter((c) => !queued.has(keyOf({ listId: list.id, term: c.term })));
        if (!fresh.length) moreDue.current.delete(list.id);
        for (const c of fresh)
          due.push({
            ...exampleOf(list.id, c.term),
            term: c.term,
            reading: c.reading ?? undefined,
            back: c.back,
            kind: "due",
            listId: list.id,
            lang: list.lang,
            card: c.card,
          });
      }
      return due;
    };
    topUpDue()
      .then(async (due) => {
        if (due.length) return appendSpread(due);
        const fresh = await takeNew(pageSize * 2);
        if (!fresh.length) setExhausted(true);
        else appendSpread(fresh);
      })
      .catch((e) => setSyncError((e as Error).message))
      .finally(() => {
        fetching.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, exhausted, queue.length, pos, pageSize, takeNew]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      // Holding a key repeats movement only: a held grade key must not run
      // onto Next and grade the rest of the screen, nor a held Enter skip screens.
      const moves = ["ArrowDown", "ArrowUp", "KeyF", "KeyU", "KeyR", "KeyI"];
      if (e.repeat && !moves.includes(e.code)) return e.preventDefault();
      // R/I up, F/U down: home-row alternatives to the arrows for either hand.
      if (["ArrowDown", "KeyF", "KeyU"].includes(e.code)) moveRow(row + 1);
      else if (["ArrowUp", "KeyR", "KeyI"].includes(e.code)) moveRow(row - 1);
      // On the Next row, Space or a grade key acts as Next: to the first
      // ungraded word, or submit when every word has its grade.
      else if (row === page.length && (e.code === "Space" || KEY_RATING[e.code])) next();
      else if (e.code === "Space")
        setRevealed((s) => {
          const n = new Set(s);
          if (n.has(row)) n.delete(row);
          else n.add(row);
          return n;
        });
      else if (e.code === "KeyE") setRevealed(new Set(page.map((_, i) => i)));
      else if (e.code === "Enter") next();
      else if (e.code === "KeyZ" || e.code === "KeyM" || e.code === "Backspace") {
        // Undo the last mark and go back to that row.
        const last = markOrder.current.at(-1);
        if (last == null) return;
        mark(last, null);
        moveRow(last);
      } else if (e.code === "Escape") mark(row, null);
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.code === "KeyV") speech.toggle();
      else if (KEY_RATING[e.code] && !e.shiftKey) {
        mark(row, KEY_RATING[e.code]);
        moveRow(row + 1);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, page, next, moveRow, mark, speech]);

  // Say the focused row aloud, on a loop, while it stays focused.
  // Paused while the tab is hidden or the window is in the background; the
  // same row picks the loop back up when the page is active again.
  const active = usePageActive();
  const focused = !touch && active ? page[row] : undefined;
  const say = focused ? spokenText(focused, focused.lang, !!config.readingOnBack) : "";
  const sayLang = focused?.lang ?? "";
  useEffect(() => speech.loop(say, sayLang), [say, sayLang, speech]);

  const minutes = (Date.now() - started.current) / 60_000;
  const left = queue.length - pos;
  const dueLeft = queue.slice(pos).filter((q) => q.kind !== "new").length;

  return (
    // Full width: wide screens get room for longer explanations.
    <div className="w-full px-3 py-4 sm:px-8 sm:py-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm mb-4">
        <button
          className="opacity-60 hover:opacity-100 whitespace-nowrap"
          onClick={() => (flush(), onExit())}
        >
          ← lists
        </button>
        <span className="font-medium">{title}</span>
        <span className="w-full sm:w-auto sm:ml-auto tabular-nums opacity-70 text-xs sm:text-sm">
          {done} done · {minutes > 0.2 ? Math.round(done / minutes) : "–"}/min · {dueLeft} due ·{" "}
          {left - dueLeft} new
          {pending > 0 && " · saving…"}
          {speech.available && (
            <button className="ml-2 opacity-80" onClick={speech.toggle} title="Sound (V)">
              {speech.on ? "🔊" : "🔇"}
            </button>
          )}
        </span>
      </div>
      {syncError && <div className="text-red-400 text-sm mb-2">Not saved: {syncError}</div>}

      {loadError ? (
        <div className="space-y-3 py-8 text-center">
          <div className="text-red-400">Couldn't load: {loadError}</div>
          <button
            className="px-4 py-2 rounded bg-white/10 hover:bg-white/20"
            onClick={() => location.reload()}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="opacity-60">Loading…</div>
      ) : page.length === 0 ? (
        <div className="space-y-4 py-8 text-center">
          <div className="text-lg">{exhausted ? "Every word learned. 🎉" : "Loading more…"}</div>
        </div>
      ) : (
        <>
          <div className="rounded-lg overflow-hidden border border-white/10" role="list">
            {page.map((it, i) => {
              const rating = marks.get(i);
              // The keyboard cursor reveals its row, just as hovering does.
              const show = revealed.has(i) || (!touch && i === row);
              return (
                <WordRow
                  key={`${pos}-${i}`}
                  touch={touch}
                  onHover={() => moveRow(i)}
                  // Desktop click = Again; on touch a tap reveals instead.
                  onTap={() =>
                    touch
                      ? (speech.once(spokenText(it, it.lang, !!config.readingOnBack), it.lang),
                        setRevealed((s) => {
                          const n = new Set(s);
                          if (n.has(i)) n.delete(i);
                          else n.add(i);
                          return n;
                        }))
                      : mark(i, rating === 1 ? null : 1)
                  }
                  onSwipe={(r) => mark(i, rating === r ? null : r)}
                  className={`group grid items-center gap-2 px-2 leading-none cursor-pointer select-none border-b border-white/5 last:border-0 ${
                    touch
                      ? "grid-cols-[minmax(6rem,12rem)_1fr_3rem] h-11 text-base"
                      : hasExamples
                        ? "grid-cols-[1.25rem_minmax(8rem,16rem)_minmax(10rem,1fr)_minmax(12rem,1.4fr)_3.5rem] h-7 text-[15px]"
                        : "grid-cols-[1.25rem_minmax(8rem,18rem)_1fr_3.5rem] h-7 text-[15px]"
                  } ${rating ? RATING_STYLE[rating] : ""} ${
                    i === row && !touch
                      ? "outline outline-1 -outline-offset-1 outline-white/40"
                      : ""
                  }`}
                >
                  {!touch && <span className="text-[10px] opacity-40">{i === row ? "▸" : ""}</span>}
                  <span
                    className={`truncate font-medium ${it.kind === "new" ? "text-emerald-400" : it.kind === "again" ? "text-amber-300" : ""}`}
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
                  {/* Graded: when it comes back for that grade. Ungraded: "new",
                      or how long the word has been due ("5m ago"). */}
                  <span
                    className={`text-[11px] text-right tabular-nums ${rating ? "opacity-90 font-medium" : "opacity-40"}`}
                    title={rating ? `next, if ${RATING_LABEL[rating]}` : "due"}
                  >
                    {rating
                      ? previewInterval(it.card, rating, paramsOf.get(it.listId)!)
                      : it.kind === "new" || !it.card
                        ? "new"
                        : `${formatInterval(Date.now() - dueOf(it.card))} ago`}
                  </span>
                </WordRow>
              );
            })}
          </div>
          {touch ? (
            <>
              <div className="text-[11px] opacity-50 mt-2 pb-20">
                tap = show · swipe ← a little Hard, far Again · swipe → a little Good, far Easy
              </div>
              <div className="fixed inset-x-0 bottom-0 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-black/80 backdrop-blur flex gap-2">
                <button
                  className="px-4 rounded-lg bg-white/10 text-sm"
                  onClick={() =>
                    setRevealed((s) =>
                      s.size === page.length ? new Set() : new Set(page.map((_, i) => i)),
                    )
                  }
                >
                  {revealed.size === page.length ? "Hide" : "Show all"}
                </button>
                <button
                  className={`flex-1 py-3 rounded-lg font-medium ${firstUngraded < 0 ? "bg-emerald-600 text-white" : "bg-white/15"}`}
                  onClick={next}
                >
                  {firstUngraded < 0
                    ? "Next"
                    : `${page.filter((_, i) => !marks.has(i)).length} left to grade`}
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-start justify-between gap-4 mt-3 text-[11px] opacity-50">
              {help ? (
                <span className="leading-relaxed">
                  ↑↓ / R F / I U move (the focused row shows its meaning) · Space pin · E show all ·
                  A Again · S Hard · W Good · D Easy (also H/J/K/L, 1–4) · click = Again · Z / M
                  undo · Esc clear · V sound · Enter / Next = first ungraded word, or submit when
                  all are graded · ? hide help
                </span>
              ) : (
                <span>A Again · S Hard · W Good · D Easy · Enter = next · ? all keys</span>
              )}
              <button
                className={`px-3 py-1 rounded hover:bg-white/20 opacity-100 text-xs shrink-0 ${
                  row === page.length
                    ? "bg-emerald-600 text-white outline outline-1 outline-white/60"
                    : "bg-white/10"
                }`}
                onClick={next}
              >
                {firstUngraded < 0
                  ? "Next ⏎"
                  : `${page.filter((_, i) => !marks.has(i)).length} left ⏎`}
              </button>
            </div>
          )}
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
  touch,
  onHover,
  onTap,
  onSwipe,
  className,
  children,
}: {
  touch: boolean;
  onHover: () => void;
  onTap: () => void;
  onSwipe: (r: Rating) => void;
  className: string;
  children: React.ReactNode;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);

  if (!touch)
    return (
      <div
        role="listitem"
        // Only a real mouse move takes the cursor: Chrome replays mouse events
        // at a resting pointer when rows re-render, which would otherwise yank
        // the cursor back under the mouse after every key press.
        onMouseMove={(e) => (e.movementX || e.movementY) && onHover()}
        onClick={onTap}
        className={className}
      >
        {children}
      </div>
    );

  const pending = swipeRating(dx);
  return (
    <div
      role="listitem"
      className={`relative ${className}`}
      style={{
        touchAction: "pan-y",
        transform: dx ? `translateX(${dx}px)` : undefined,
        background: pending ? SWIPE_BG[pending] : undefined,
      }}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY };
        // Keep receiving the gesture even if the finger leaves this row.
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const x = e.clientX - start.current.x;
        const y = e.clientY - start.current.y;
        if (Math.abs(x) > Math.abs(y)) setDx(Math.max(-160, Math.min(160, x)));
      }}
      onPointerUp={() => {
        const moved = dx;
        setDx(0);
        if (!start.current) return;
        start.current = null;
        const r = swipeRating(moved);
        if (r) onSwipe(r);
        else if (Math.abs(moved) < 8) onTap();
      }}
      onPointerCancel={() => {
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
