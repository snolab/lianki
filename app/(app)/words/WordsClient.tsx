"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WordCard, WordList } from "@/lib/repos/wordsD1";
import { spokenText } from "@/lib/words/spoken";

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
type Entry = { term: string; reading?: string; back: string };
type Item = Entry & { kind: "due" | "new" | "again"; newIndex?: number };

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
function spreadPairs(items: Item[], size: number, offset: number): Item[] {
  const out: Item[] = [];
  let pending = items;
  let room = size - (offset % size);
  while (pending.length) {
    const screen: Item[] = [];
    const later: Item[] = [];
    for (const it of pending) {
      if (screen.length < room && !screen.some((s) => answers(s, it))) screen.push(it);
      else later.push(it);
    }
    if (!screen.length) screen.push(later.shift()!);
    out.push(...screen);
    pending = later;
    room = size;
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
 * language the OS has a voice for. Silent when there is no voice for `lang`.
 */
function useSpeech(lang: string) {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem("lk:words-sound") !== "off";
    } catch {
      return true;
    }
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const pick = () => {
      const vs = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
      setVoice(vs.find((v) => v.localService) ?? vs[0] ?? null);
    };
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
    return () => speechSynthesis.removeEventListener("voiceschanged", pick);
  }, [lang]);

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }, []);

  const speak = useCallback(
    (text: string, then?: () => void) => {
      if (!voice || !on || !text) return;
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 0.9;
      if (then) u.onend = then;
      speechSynthesis.speak(u);
    },
    [voice, on],
  );

  /** Repeat `text` with a pause until the next call; "" just stops. */
  const loop = useCallback(
    (text: string) => {
      stop();
      if (!text) return;
      // A short delay so flicking through rows does not start a word per row.
      const again = () => {
        timer.current = setTimeout(() => speak(text, again), 900);
      };
      timer.current = setTimeout(() => speak(text, again), 250);
      return stop;
    },
    [speak, stop],
  );

  const once = useCallback(
    (text: string) => {
      stop();
      speak(text);
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
    () => ({ available: !!voice, on, loop, once, toggle }),
    [voice, on, loop, once, toggle],
  );
}

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

export default function WordsClient({ config = WORDS }: { config?: DrillConfig }) {
  const [allLists, setLists] = useState<WordList[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogMeta[]>([]);
  const [listId, setListId] = useState<string | null>(null);
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
    const ids = new Set(catalog.map((c) => c.id));
    return allLists?.filter((l) => l.source && ids.has(l.source)) ?? null;
  }, [allLists, catalog]);

  if (error)
    return (
      <div className="p-8 text-red-400">
        {error === "Login required" ? "Sign in to use word lists." : error}
      </div>
    );
  if (!lists) return <div className="p-8 opacity-60">Loading…</div>;

  const current = lists.find((l) => l.id === listId);
  if (current)
    return (
      <Study
        config={config}
        list={current}
        meta={catalog.find((c) => c.id === current.source)}
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
}: {
  config: DrillConfig;
  lists: WordList[];
  catalog: CatalogMeta[];
  onOpen: (id: string) => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const langs = useMemo(() => [...new Set(catalog.map((c) => c.lang))], [catalog]);
  const [lang, setLang] = useState<string>("");
  const added = new Set(lists.map((l) => l.source));

  // 1–9 open the matching list, so the whole flow works without a mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && lists[n - 1]) onOpen(lists[n - 1].id);
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

      {lists.length > 0 && (
        <div className="space-y-2">
          {lists.map((l, i) => (
            <div key={l.id} className="flex items-center gap-3 rounded-lg bg-white/5 px-4 py-3">
              {i < 9 && (
                <kbd className="hidden sm:inline text-xs opacity-40 tabular-nums">{i + 1}</kbd>
              )}
              <button className="flex-1 text-left" onClick={() => onOpen(l.id)}>
                <div className="font-medium">{l.name}</div>
                <div className="text-xs opacity-60 tabular-nums">
                  {l.due} due · {l.cards} learned · {l.cursor} introduced
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

function Study({
  config,
  list,
  meta,
  onExit,
}: {
  config: DrillConfig;
  list: WordList;
  meta?: CatalogMeta;
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
  const catalogRef = useRef<Entry[]>([]);
  /** Next catalog index to consider for new words. */
  const nextNew = useRef(list.cursor);
  const dwell = useRef<Map<number, number>>(new Map());
  const rowSince = useRef(Date.now());
  const touch = useTouch();
  const base = config.base;
  const speech = useSpeech(list.lang);
  const pageSize = touch ? PAGE_TOUCH : PAGE;
  // Read by the one-time session load, which must not re-run when it changes.
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;
  const [help, setHelp] = useState(false);
  /** Rows marked in order, so Z can undo the last one. */
  const markOrder = useRef<number[]>([]);

  /** Pull up to `n` catalog words that have no card yet. */
  const takeNew = useCallback(
    async (n: number): Promise<Item[]> => {
      const entries = catalogRef.current;
      const out: Item[] = [];
      while (out.length < n && nextNew.current < entries.length) {
        const from = nextNew.current;
        const slice = entries.slice(from, from + Math.max(n * 2, 40));
        nextNew.current = from + slice.length;
        const { known } = await api<{ known: string[] }>(`/api/words/lists/${list.id}/known`, {
          method: "POST",
          body: JSON.stringify({ terms: slice.map((e) => e.term) }),
        });
        const skip = new Set(known);
        slice.forEach((e, i) => {
          if (out.length < n && !skip.has(e.term))
            out.push({ ...e, kind: "new", newIndex: from + i });
        });
      }
      return out;
    },
    [list.id],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      const [session, entries] = await Promise.all([
        api<{ due: WordCard[]; newRemaining: number }>(
          `/api/words/lists/${list.id}/session?day=${localDay()}`,
        ),
        meta
          ? fetch(`${base}/${meta.file}`)
              .then((r) => r.json())
              .then((d) => d.entries as Entry[])
          : Promise.resolve([] as Entry[]),
      ]);
      catalogRef.current = entries;
      const due: Item[] = session.due.map((c) => ({
        term: c.term,
        reading: c.reading ?? undefined,
        back: c.back,
        kind: "due",
      }));
      const fresh = await takeNew(session.newRemaining);
      if (!alive) return;
      setQueue([...due, ...spreadPairs(fresh, pageSizeRef.current, due.length)]);
      setLoading(false);
    })().catch((e) => setSyncError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [list.id, meta, takeNew, base]);

  const page = queue.slice(pos, pos + pageSize);

  const moveRow = useCallback(
    (to: number) => {
      const now = Date.now();
      dwell.current.set(row, (dwell.current.get(row) ?? 0) + now - rowSince.current);
      rowSince.current = now;
      setRow(Math.max(0, Math.min(page.length - 1, to)));
    },
    [row, page.length],
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

  /** Submit the screen. Unmarked words get `rest`: Good, or Easy with Shift+Enter. */
  const submit = useCallback(
    (rest: Rating = 3) => {
      if (!page.length) return;
      const now = Date.now();
      dwell.current.set(row, (dwell.current.get(row) ?? 0) + now - rowSince.current);
      const reviews = page.map((it, i) => ({
        term: it.term,
        reading: it.reading ?? null,
        back: it.back,
        rating: marks.get(i) ?? rest,
        elapsedMs: Math.round(dwell.current.get(i) ?? 0),
        newIndex: it.kind === "new" ? it.newIndex : null,
      }));
      const byTerm = new Map(page.map((it) => [it.term, it]));
      setPos((p) => p + page.length);
      setMarks(new Map());
      markOrder.current = [];
      setRevealed(new Set());
      setRow(0);
      dwell.current = new Map();
      rowSince.current = Date.now();
      setDone((d) => d + page.length);
      setPending((n) => n + 1);
      api<{ cards: WordCard[] }>(`/api/words/lists/${list.id}/review`, {
        method: "POST",
        body: JSON.stringify({ day: localDay(), reviews }),
      })
        .then(({ cards }) => {
          // Learning steps: words due again within minutes come back this session.
          const back = cards
            .filter((c) => new Date(c.due).getTime() - Date.now() < SESSION_WINDOW_MS)
            .map((c): Item => ({ ...byTerm.get(c.term)!, kind: "again", newIndex: undefined }));
          if (back.length) setQueue((q) => [...q, ...back]);
          setSyncError(null);
        })
        .catch((e) => setSyncError((e as Error).message))
        .finally(() => setPending((n) => n - 1));
    },
    [page, marks, row, list.id],
  );

  const more = useCallback(async () => {
    const fresh = await takeNew(pageSize);
    setQueue((q) => [...q, ...spreadPairs(fresh, pageSize, q.length - pos)]);
  }, [takeNew, pageSize, pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
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
      else if (e.code === "KeyE") setRevealed(new Set(page.map((_, i) => i)));
      else if (e.code === "Enter") submit(e.shiftKey ? 4 : 3);
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
  }, [row, page, submit, moveRow, mark, speech]);

  // Say the focused row aloud, on a loop, while it stays focused.
  // Paused while the tab is hidden or the window is in the background; the
  // same row picks the loop back up when the page is active again.
  const active = usePageActive();
  const focused = !touch && active ? page[row] : undefined;
  const say = focused ? spokenText(focused, list.lang, !!config.readingOnBack) : "";
  useEffect(() => speech.loop(say), [say, speech]);

  const minutes = (Date.now() - started.current) / 60_000;
  const left = queue.length - pos;
  const dueLeft = queue.slice(pos).filter((q) => q.kind !== "new").length;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm mb-4">
        <button className="opacity-60 hover:opacity-100 whitespace-nowrap" onClick={onExit}>
          ← lists
        </button>
        <span className="font-medium">{list.name}</span>
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

      {loading ? (
        <div className="opacity-60">Loading…</div>
      ) : page.length === 0 ? (
        <div className="space-y-4 py-8 text-center">
          <div className="text-lg">All caught up.</div>
          {nextNew.current < catalogRef.current.length && (
            <button className="px-4 py-2 rounded bg-white/10 hover:bg-white/20" onClick={more}>
              Learn {pageSize} more new words
            </button>
          )}
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
                      ? (speech.once(spokenText(it, list.lang, !!config.readingOnBack)),
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
                      ? "grid-cols-[minmax(6rem,2fr)_3fr_3rem] h-11 text-base"
                      : "grid-cols-[1.25rem_minmax(8rem,2fr)_3fr_3.5rem] h-7 text-[15px]"
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
                  <span className="text-[11px] text-right opacity-60">
                    {rating ? RATING_LABEL[rating] : it.kind === "new" ? "new" : ""}
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
                  className="flex-1 py-3 rounded-lg bg-emerald-600 text-white font-medium"
                  onClick={() => submit(3)}
                >
                  Next · rest Good
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-start justify-between gap-4 mt-3 text-[11px] opacity-50">
              {help ? (
                <span className="leading-relaxed">
                  ↑↓ / R F / I U move (the focused row shows its meaning) · Space pin · E show all ·
                  A Again · S Hard · W Good · D Easy (also H/J/K/L, 1–4) · click = Again · Z / M
                  undo · Esc clear · V sound · Enter = rest Good · Shift+Enter = rest Easy · ? hide
                  help
                </span>
              ) : (
                <span>A Again · S Hard · D Easy · Enter = rest Good · ? all keys</span>
              )}
              <button
                className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 opacity-100 text-xs shrink-0"
                onClick={() => submit(3)}
              >
                Next ⏎
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
