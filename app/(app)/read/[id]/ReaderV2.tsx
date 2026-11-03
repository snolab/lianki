"use client";

/**
 * The reader v2 (flag `read.reader-v2`; docs/books-plan.md, the 2026-11-03
 * reader sections). The whole book in one continuous scroll of the WINDOW
 * (no inner scroller, so browser bars collapse and the island's capsule
 * works), virtualised with measured heights. The book as it is: its own
 * paragraphs and headings, a readable measure, flat (design-principles.md:
 * content fills the screen; one glass layer; no fixed numbers).
 *
 * - Words carry their familiarity as marks (CSS only, `html[data-read-marks]`).
 * - Items (runs of whole sentences, lib/read/reader-model.ts) are graded by a
 *   sideways swipe exactly as on /words; the next item then takes the graded
 *   one's place on screen, so his finger stays put. Undo as on /words.
 * - Read-aloud reads the current item, then simply waits for his swipe
 *   (auto-continue reads on). The sentence being read is highlighted;
 *   follow keeps the item at the eye line; his own scroll stops following.
 * - Chrome steps back while he reads (lib/read/reader-chrome.ts): the top
 *   strip reduces on his own scroll toward content, the island stays a
 *   capsule (lib/nav/reading.ts). Follow, auto-advance and swipes never count.
 * - Position: an anchor at the eye line, synced through the data layer
 *   (lib/read/reader-adapter.ts), the device copy only a cache.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useIntlayer, useLocale } from "next-intlayer";
import { type Virtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import { pageAudio } from "@lianki/debug-chat/page-audio";
import { createUiStore, useUi } from "@lianki/ui-state";
import type { ReadMaterial } from "../ReadListClient";
import { chapterAt, type BookMeta } from "@/lib/read/book";
import { catalogKeys } from "@/lib/read/dict";
import {
  initialPlayer,
  playerReducer,
  readLang,
  type PlayerCfg,
  type PlayerEvent,
  type PlayerState,
} from "@/lib/read/player";
import { browserReadSpeaker } from "@/lib/read/speaker-browser";
import type { WordsSummary } from "@/lib/read/progress";
import { inKeys, wordLang } from "@/lib/read/words";
import {
  type Block,
  type Fam,
  type WordRow,
  ParaCache,
  blockLine,
  blockOfAnchor,
  blockOfLine,
  blockSpeech,
  famMap,
  roughWords,
} from "@/lib/read/reader-model";
import { localReaderData, type GradeReceipt, type ReaderBook } from "@/lib/read/reader-adapter";
import { anchorAt, type Anchor } from "@/lib/read/reader-pos";
import { CHROME_FULL, SCROLL_KEYS, chromeStep, type ChromeState } from "@/lib/read/reader-chrome";
import { setReading, readingUi } from "@/lib/nav/reading";
import { SwipeFeelProvider } from "@/lib/words/swipe-core";
import { SWIPE_MIRROR_KEY, sideRating, type SwipeRating } from "@/lib/words/swipe";
import { swipeVariant } from "@/lib/words/swipe-ab";
import { ProgressRingSvg } from "@/app/components/progress-ring";
import { fill } from "@/lib/nav/nav-core";
import { setTextSize, stepScale, TEXT_MAX, TEXT_MIN } from "@/lib/text-size";
import { useTextSizes } from "@/lib/use-text-size";
import { useBackToClose } from "@/lib/use-back-to-close";
import { BookScan } from "../BookWords";
import { getLocalMaterial } from "./ReadViewClient";
import { BlockRow, GradeStrip, type RowCommon } from "./reader-blocks";

type WindowVirtualizer = Virtualizer<Window, Element>;

// ── Device preferences ──────────────────────────────────────────────────

export type MarkLevel = "off" | "unknown" | "all";
/** Word marks (local `lk:pref:read-marks`): every word not mastered, by default. */
export const readMarks = createUiStore(
  "read-marks",
  1,
  { level: "all" as MarkLevel },
  {
    storage: "local",
    clean: (v): { level?: MarkLevel } => {
      const l = (v as { level?: unknown } | null)?.level;
      return l === "off" || l === "unknown" || l === "all" ? { level: l } : {};
    },
  },
);

/** Read on item after item (local `lk:pref:read-auto`, the first reader's key). */
const AUTO_KEY = "lk:pref:read-auto";
const loadAuto = () => {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
};
const outMode = (): "speech" | "cloud" => {
  try {
    return localStorage.getItem("lk:voice-out") === "cloud" ? "cloud" : "speech";
  } catch {
    return "speech";
  }
};
const mirrored = () => {
  try {
    return localStorage.getItem(SWIPE_MIRROR_KEY) === "1";
  } catch {
    return false;
  }
};

/** The eye line: a share of the screen's height from its top. */
const EYE_SHARE = 0.3;
/** Position written this long after scrolling stops (and on pagehide). */
const ANCHOR_QUIET_MS = 1500;

type Material = ReadMaterial & { book?: BookMeta; words?: WordsSummary };

const still = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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

export function ReaderV2({ id, isLoggedIn }: { id: string; isLoggedIn: boolean }) {
  const t = useIntlayer("read-reader");
  const [material, setMaterial] = useState<Material | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      if (isLoggedIn) {
        try {
          const res = await fetch(`/api/read/${id}`);
          if (res.ok && live) setMaterial(await res.json());
        } catch (err) {
          console.error("read: failed to load the book", err);
        }
      } else if (live) setMaterial(getLocalMaterial(id));
      if (live) setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [id, isLoggedIn]);

  if (loading)
    return (
      <p className="py-16 text-center opacity-60" data-testid="reader-loading">
        {t.loading}
      </p>
    );
  if (!material)
    return (
      <div className="py-16 text-center">
        <p className="mb-4 opacity-70">{t.notFound}</p>
        <Link href="/read" className="underline">
          {t.back}
        </Link>
      </div>
    );
  return <Reader id={id} material={material} signedIn={isLoggedIn} />;
}

function Reader({ id, material, signedIn }: { id: string; material: Material; signedIn: boolean }) {
  const t = useIntlayer("read-reader");
  const tp = useIntlayer("read-player");
  const tw = useIntlayer("words-page");
  const lines = material.lines;
  const book = material.book;
  const touch = useTouch();
  const [variant, setVariant] = useState<"js" | "native">("js");
  const [mirror, setMirror] = useState(false);
  useEffect(() => {
    setVariant(swipeVariant());
    setMirror(mirrored());
  }, []);

  // ── The book's model ──
  const lang = useMemo(() => readLang(book?.lang, lines.slice(0, 20).join(" ")), [book, lines]);
  const normLang = material.words?.lang ?? wordLang(book?.lang, lines);
  const data = useMemo(() => localReaderData(), []);
  const rbook: ReaderBook = useMemo(
    () => ({
      id,
      lines,
      headings: new Set(book?.headings ?? []),
      chapterStarts: new Set((book?.chapters ?? []).map((c) => c.start)),
      lang,
    }),
    [id, lines, book, lang],
  );
  const blocks = useMemo(() => data.blocks(rbook), [data, rbook]);
  const paras = useMemo(() => new ParaCache(lines, lang, normLang), [lines, lang, normLang]);
  const para = useCallback((line: number) => paras.get(line), [paras]);
  const lineText = useCallback((line: number) => lines[line] ?? "", [lines]);

  // ── Familiarity: the per-book word map, fetched once ──
  const [fam, setFam] = useState<{ map: Map<string, Fam>; v: number } | null>(null);
  useEffect(() => {
    if (!signedIn || !material.words) return;
    let live = true;
    const wlang = material.words.lang;
    Promise.all([
      fetch(`/api/read/${id}/words`).then((r) => (r.ok ? r.json() : null)),
      catalogKeys(wlang).catch(() => new Set<string>()),
    ])
      .then(([d, keys]) => {
        if (!live || !d) return;
        const map = famMap(d.words as WordRow[], (w) => inKeys(w, wlang, keys));
        setFam({ map, v: 1 });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, signedIn, material.words]);

  // ── Marks: an attribute on <html>, so switching repaints, never re-renders ──
  const marks = useUi(readMarks, (s) => s.level);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.readMarks = marks;
    return () => {
      delete root.dataset.readMarks;
    };
  }, [marks]);

  // ── Reading mode for the island; scroll padding for the glass ──
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setReading({ on: true, island: false });
    const root = document.documentElement;
    root.style.scrollPaddingBottom = "var(--lk-bottom-reserve, 0px)";
    root.style.scrollPaddingTop = `${strip.current?.offsetHeight ?? 0}px`;
    return () => {
      setReading({ on: false, island: false });
      root.style.scrollPaddingBottom = "";
      root.style.scrollPaddingTop = "";
    };
  }, []);
  const islandOpen = useUi(readingUi, (s) => s.island);

  // ── The virtualised list on the window (BookList owns it; scrolling re-renders only the list) ──
  const listRef = useRef<HTMLDivElement>(null);
  const vRef = useRef<WindowVirtualizer | null>(null);
  const vz = () => vRef.current!;

  // ── Programmatic scrolls and his own ──
  const prog = useRef(false);
  const lastScrollAt = useRef(0);
  const scrollTo = useCallback((top: number) => {
    prog.current = true;
    window.scrollTo({ top: Math.max(0, top), behavior: still() ? "auto" : "smooth" });
  }, []);
  const eye = () => window.innerHeight * EYE_SHARE;
  const rowEl = (i: number) =>
    listRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`) ?? null;
  /** Put block `i`'s top at `y` px from the viewport top (rendered or not). */
  const placeBlock = useCallback(
    (i: number, y: number) => {
      const el = rowEl(i);
      if (el) return scrollTo(window.scrollY + el.getBoundingClientRect().top - y);
      prog.current = true;
      vz().scrollToIndex(i, { align: "start" });
      requestAnimationFrame(() => {
        const e2 = rowEl(i);
        if (e2) scrollTo(window.scrollY + e2.getBoundingClientRect().top - y);
      });
    },
    [scrollTo],
  );

  // ── Player: one item at a time (lib/read/player.ts, its "line" = a block) ──
  const speaker = useMemo(() => browserReadSpeaker(pageAudio, outMode), []);
  const [auto, setAuto] = useState(false);
  useEffect(() => setAuto(loadAuto()), []);
  const [player, setPlayer] = useState<PlayerState>(() => initialPlayer());
  const cfg: PlayerCfg = {
    total: blocks.length,
    auto,
    isHeading: (i) => blocks[i]?.kind === "heading",
    isBlank: () => false,
  };
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const dispatch = useCallback(
    (e: PlayerEvent) => setPlayer((s) => playerReducer(s, e, cfgRef.current)),
    [],
  );
  const [follow, setFollow] = useState(true);
  const playing = player.status === "speaking" || player.status === "waiting";
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const followRef = useRef(follow);
  followRef.current = follow;

  // The sentence being read: an attribute on its span (no re-render).
  const reading = useRef<{ line: number; s: number } | null>(null);
  const paintReading = useCallback(() => {
    const root = listRef.current;
    if (!root) return;
    root.querySelectorAll("[data-reading]").forEach((n) => n.removeAttribute("data-reading"));
    const r = reading.current;
    if (!r) return;
    root
      .querySelectorAll(`[data-line="${r.line}"] [data-s="${r.s}"]`)
      .forEach((n) => n.setAttribute("data-reading", ""));
  }, []);

  const speaking = player.status === "speaking";
  useEffect(() => {
    if (!speaking) return;
    const b = blocks[player.line];
    if (!b) return;
    const parts = blockSpeech(b, para, lineText);
    const token = player.token;
    return speaker.speak(
      parts.map((p) => p.text),
      lang,
      {
        onpart: (i) => {
          reading.current = { line: parts[i].line, s: parts[i].s };
          paintReading();
        },
        onend: () => dispatch({ type: "ended", token }),
        onerror: (error) => dispatch({ type: "failed", token, error }),
      },
    );
    // The token alone says which utterance this is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaking, player.token]);
  useEffect(() => {
    if (playing) return;
    reading.current = null;
    paintReading();
  }, [playing, paintReading]);
  useEffect(() => () => speaker.cancel(), [speaker]);

  // Follow: the current item at the eye line, once per item, while playing.
  // A swipe places the next item itself (where the graded one was).
  const placed = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !follow) return;
    if (placed.current === player.line) return;
    placed.current = player.line;
    placeBlock(player.line, eye());
  }, [playing, follow, player.line, placeBlock]);

  // ── Chrome ──
  const [chrome, setChrome] = useState<ChromeState>(CHROME_FULL);
  const [eyeIndex, setEyeIndex] = useState(0);
  const eyeIndexRef = useRef(0);

  // ── Position ──
  const takeAnchor = useCallback((): Anchor | null => {
    const root = listRef.current;
    if (!root) return null;
    const rects: { line: number; s: number; top: number; height: number }[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("[data-index]")) {
      const b = blocks[Number(el.dataset.index)];
      if (!b) continue;
      const r = el.getBoundingClientRect();
      rects.push({
        line: blockLine(b),
        s: b.kind === "item" ? b.pieces[0].s0 : 0,
        top: r.top,
        height: r.height,
      });
    }
    rects.sort((x, y) => x.top - y.top);
    return anchorAt(rects, eye());
  }, [blocks]);
  const saveNow = useCallback(() => {
    const a = takeAnchor();
    if (a) data.saveAnchor(id, a);
  }, [takeAnchor, data, id]);

  // Restore once: the synced anchor (or this device's copy).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !blocks.length) return;
    restored.current = true;
    let live = true;
    data.anchor(id).then((a) => {
      if (!live || !a) return;
      const i = blockOfAnchor(blocks, a.line, a.s ?? 0);
      prog.current = true;
      vz().scrollToIndex(i, { align: "start" });
      dispatch({ type: "select", line: i });
      // Twice: the rows around it are measured on the first frame.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const el = rowEl(i);
          if (!el) return;
          const r = el.getBoundingClientRect();
          prog.current = true;
          window.scrollTo({ top: window.scrollY + r.top + a.off * r.height - eye() });
        }),
      );
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  // His own input drives the scroll from touchstart / wheel / scroll keys
  // until the page is still again; only those scrolls move the chrome, stop
  // following and move the idle cursor.
  useEffect(() => {
    let input = false;
    let touching = false;
    let lastY = window.scrollY;
    let frame = 0;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let saveT: ReturnType<typeof setTimeout> | undefined;
    const begin = () => {
      input = true;
      prog.current = false;
    };
    const settle = () => {
      if (!touching) input = false;
      prog.current = false;
      // The idle cursor follows what he reads; playing, the player has it.
      if (!playingRef.current) {
        const i = eyeIndexRef.current;
        setPlayer((s) => (s.status === "idle" && s.line !== i ? { ...s, line: i } : s));
      }
    };
    const onScroll = () => {
      lastScrollAt.current = performance.now();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        const dy = y - lastY;
        lastY = y;
        // The block at the eye line, from the virtualiser's offsets.
        const v = vRef.current;
        if (!v) return;
        // Virtual items' start/end include the scroll margin: page coordinates.
        const at = y + eye();
        let idx = eyeIndexRef.current;
        for (const it of v.getVirtualItems())
          if (it.start <= at && it.end > at) {
            idx = it.index;
            break;
          }
        if (idx !== eyeIndexRef.current) {
          eyeIndexRef.current = idx;
          setEyeIndex(idx);
        }
        if (input && !prog.current && dy) {
          const vh = window.innerHeight;
          setChrome((c) => chromeStep(c, { type: "scroll", dy, y, vh }));
          if (dy > 0) setReading({ island: false });
          if (playingRef.current && followRef.current) setFollow(false);
        }
      });
      clearTimeout(quiet);
      quiet = setTimeout(settle, 150);
      clearTimeout(saveT);
      saveT = setTimeout(saveNow, ANCHOR_QUIET_MS);
    };
    const touchstart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      touching = true;
      begin();
    };
    const touchend = (e: TouchEvent) => {
      if (e.touches.length) return;
      touching = false;
    };
    const key = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && begin();
    const pagehide = () => saveNow();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", settle);
    window.addEventListener("touchstart", touchstart, { passive: true });
    window.addEventListener("touchend", touchend, { passive: true });
    window.addEventListener("touchcancel", touchend, { passive: true });
    window.addEventListener("wheel", begin, { passive: true });
    window.addEventListener("keydown", key);
    window.addEventListener("pagehide", pagehide);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(quiet);
      clearTimeout(saveT);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", settle);
      window.removeEventListener("touchstart", touchstart);
      window.removeEventListener("touchend", touchend);
      window.removeEventListener("touchcancel", touchend);
      window.removeEventListener("wheel", begin);
      window.removeEventListener("keydown", key);
      window.removeEventListener("pagehide", pagehide);
      saveNow();
    };
  }, [saveNow]);

  // ── Grading ──
  const [grades, setGrades] = useState<Record<string, SwipeRating>>({});
  const undoStack = useRef<{ receipt: GradeReceipt; index: number; top: number }[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [announce, setAnnounce] = useState("");
  const gradeName = (r: SwipeRating) =>
    ({ 1: tw.again.value, 2: tw.hard.value, 3: tw.good.value, 4: tw.easy.value })[r];
  const nextItem = (i: number) => {
    for (let j = i + 1; j < blocks.length; j++) if (blocks[j].kind === "item") return j;
    return -1;
  };

  const gradeAt = useCallback(
    (index: number, raw: SwipeRating, el: HTMLElement | null) => {
      const b = blocks[index];
      if (!b || b.kind !== "item") return;
      // The core reports the default side's grade; the mirror is applied once, here.
      const r = sideRating(raw, mirrored());
      const top = (el ?? rowEl(index))?.getBoundingClientRect().top ?? eye();
      setGrades((g) => ({ ...g, [b.id]: r }));
      setAnnounce(fill(t.graded.value, { grade: gradeName(r) }));
      void data.grade(rbook, b, r).then((receipt) => {
        undoStack.current.push({ receipt, index, top });
        setCanUndo(true);
      });
      const next = nextItem(index);
      if (next < 0) return;
      // The next item takes the graded one's place: his finger stays put.
      placed.current = next;
      dispatch({ type: "select", line: next });
      requestAnimationFrame(() => placeBlock(next, top));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, data, rbook, dispatch, placeBlock],
  );
  const undo = useCallback(() => {
    const last = undoStack.current.pop();
    setCanUndo(undoStack.current.length > 0);
    if (!last) return;
    void data.undo(rbook, last.receipt);
    setGrades((g) => {
      const n = { ...g };
      delete n[last.receipt.itemId];
      const prev = data.lastGrade(last.receipt.itemId);
      if (prev) n[last.receipt.itemId] = prev;
      return n;
    });
    placed.current = last.index;
    dispatch({ type: "select", line: last.index });
    requestAnimationFrame(() => placeBlock(last.index, last.top));
  }, [data, rbook, dispatch, placeBlock]);

  const onSwipe = useCallback(
    (index: number, r: SwipeRating, el: HTMLElement) => gradeAt(index, r, el),
    [gradeAt],
  );
  const onTap = useCallback(
    (index: number) => {
      // Playing: a tap on another item reads from there.
      if (playingRef.current && blocks[index]?.kind === "item") {
        placed.current = null;
        setFollow(true);
        dispatch({ type: "select", line: index });
      }
    },
    [blocks, dispatch],
  );
  const scrolling = useCallback(() => performance.now() - lastScrollAt.current < 100, []);

  // ── Keys (desktop): 1–4 / H J K L grade, Space plays, U or ⌘Z undoes ──
  const togglePlay = useCallback(() => {
    if (player.status !== "speaking") speaker.unlock();
    if (!playing) {
      placed.current = null;
      setFollow(true);
      // From the item he is reading.
      const i = eyeIndexRef.current;
      if (player.status !== "ended") dispatch({ type: "select", line: i });
    }
    dispatch({ type: player.status === "speaking" ? "stop" : "play" });
  }, [player.status, playing, speaker, dispatch]);
  useEffect(() => {
    const keys: Record<string, SwipeRating> = {
      "1": 1,
      "2": 2,
      "3": 3,
      "4": 4,
      h: 1,
      j: 2,
      k: 3,
      l: 4,
    };
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        return undo();
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        return togglePlay();
      }
      if (e.key === "u") return undo();
      const r = keys[e.key.toLowerCase()];
      if (!r) return;
      const i = playingRef.current ? player.line : eyeIndexRef.current;
      const b = blocks[i];
      if (b?.kind !== "item") return;
      // Keys name grades, not sides: no mirror (docs/swipe-core.md).
      gradeAt(i, sideRating(r, mirrored()), rowEl(i));
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [blocks, player.line, gradeAt, undo, togglePlay]);

  // ── Sheets ──
  const [sheet, setSheet] = useState<null | "toc" | "aa">(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  useBackToClose(sheet !== null, closeSheet);

  const chapters = book?.chapters ?? [];
  const eyeLine = blocks[eyeIndex] ? blockLine(blocks[eyeIndex]) : 0;
  const chapter = chapters.length ? chapterAt(chapters, eyeLine) : -1;
  const chapterTitle = chapter >= 0 ? chapters[chapter].title : material.title;
  const share = blocks.length ? (eyeIndex + 1) / blocks.length : 0;
  const coverage = material.words?.coverage ?? null;
  const underlay = useRef<HTMLDivElement>(null);

  const row = useMemo(
    () => ({
      para,
      lineText,
      fam: fam?.map ?? null,
      famV: fam?.v ?? 0,
      lang,
      touch,
      variant,
      mirror,
      onSwipe,
      onTap,
      underlay,
      scrolling,
    }),
    [para, lineText, fam, lang, touch, variant, mirror, onSwipe, onTap, scrolling],
  );

  // Rows remounted by the virtualiser get the reading highlight back.
  useLayoutEffect(() => {
    if (reading.current) paintReading();
  });

  return (
    <SwipeFeelProvider>
      <div className="lk-reader lk-fs-read" data-testid="reader-v2">
        {/* The top strip: back, chapter, ring. Reserve, don't push: a
            zero-height sticky holder, the glass floats over the book. */}
        <div className="sticky top-0 z-20 h-0" data-reader-strip>
          <div
            ref={strip}
            className={`lk-glass lk-glass-bleed-top absolute inset-x-0 top-0 overflow-hidden border-b border-[var(--glass-line)] transition-[height] duration-200 ease-out motion-reduce:transition-none ${
              chrome.reduced ? "h-7 cursor-pointer" : "h-11"
            }`}
            data-reduced={chrome.reduced ? "" : undefined}
            onClick={() => chrome.reduced && setChrome((c) => chromeStep(c, { type: "tap" }))}
          >
            {chrome.reduced ? (
              // Reduced: the chapter in one line; a tap brings the strip back.
              <div className="flex h-7 items-center justify-center px-4 fs-12 opacity-75">
                <span className="truncate">{chapterTitle}</span>
              </div>
            ) : (
              <div className="mx-auto flex h-11 max-w-[42rem] items-center gap-2 px-2">
                <Link
                  href="/read"
                  aria-label={t.back.value}
                  title={t.back.value}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-lg"
                >
                  <span aria-hidden>←</span>
                </Link>
                <span className="min-w-0 flex-1 truncate text-sm font-medium" data-reader-chapter>
                  {chapterTitle}
                </span>
                <button
                  type="button"
                  onClick={() => setSheet("toc")}
                  aria-label={t.contents.value}
                  title={t.contents.value}
                  className="flex h-10 shrink-0 items-center gap-1 rounded-full px-2 text-xs tabular-nums"
                  data-testid="reader-ring"
                >
                  {coverage !== null && material.words ? (
                    <ProgressRingSvg pct={coverage} passAt={material.words.passAt} />
                  ) : (
                    <span aria-hidden>☰</span>
                  )}
                </button>
              </div>
            )}
            {/* Where he is in the book: a share, never a count. */}
            <div className="absolute inset-x-0 bottom-0 h-px">
              <div
                className="h-full bg-[oklch(0.6_0.12_155/0.7)]"
                style={{ width: `${share * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Reserve, don't push: the strip's height of room above the book at rest. */}
        <div aria-hidden className="h-[3.25rem]" />

        {/* The book */}
        <BookList
          blocks={blocks}
          lines={lines}
          listRef={listRef}
          vRef={vRef}
          lang={lang}
          mirror={mirror}
          grades={grades}
          row={row}
        />
        {/* Room for the last item to reach the eye line. */}
        <div style={{ height: "60vh" }} aria-hidden />

        {/* Follow lost: one tap reads along again. */}
        {playing && !follow && (
          <button
            type="button"
            onClick={() => {
              placed.current = null;
              setFollow(true);
            }}
            data-testid="read-follow"
            className="lk-glass fixed end-4 z-30 rounded-full border border-[var(--glass-line)] px-4 py-2 text-sm"
            style={{ bottom: `calc(env(safe-area-inset-bottom) + ${islandOpen ? 8.5 : 4.75}rem)` }}
          >
            ↧ {tp.backToLine}
          </button>
        )}

        {/* The play pill, at the thumb. */}
        <div
          className="lk-glass fixed end-3 z-30 flex items-center gap-1 rounded-full border border-[var(--glass-line)] p-1 shadow-[0_8px_24px_-10px_oklch(0.22_0.015_65/0.4)] md:bottom-4"
          style={{ bottom: `calc(env(safe-area-inset-bottom) + ${islandOpen ? 4.75 : 0.75}rem)` }}
          data-testid="reader-pill"
        >
          <button
            type="button"
            onClick={() => setSheet("aa")}
            aria-label={t.textAndMarks.value}
            title={t.textAndMarks.value}
            className="grid h-10 w-10 place-items-center rounded-full text-sm font-semibold"
          >
            Aa
          </button>
          {canUndo && (
            <button
              type="button"
              onClick={undo}
              aria-label={t.undo.value}
              title={t.undo.value}
              data-testid="reader-undo"
              className="grid h-10 w-10 place-items-center rounded-full text-lg"
            >
              ↶
            </button>
          )}
          <button
            type="button"
            onClick={togglePlay}
            aria-label={speaking ? tp.pause.value : tp.play.value}
            title={speaking ? tp.pause.value : tp.play.value}
            data-testid="read-play"
            data-status={player.status}
            className="grid h-10 w-10 place-items-center rounded-full bg-[oklch(0.55_0.13_250)] text-[oklch(0.99_0_0)] [text-shadow:none]"
          >
            <span aria-hidden>{speaking ? "❚❚" : "▶"}</span>
          </button>
        </div>
        {player.status === "error" && (
          <p role="alert" data-testid="read-status" data-status="error" className="sr-only">
            {tp.failed} ({player.error})
          </p>
        )}
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>

        {sheet === "toc" && (
          <Sheet title={t.contents.value} onClose={closeSheet} closeLabel={t.close.value}>
            {material.words && <BookScan id={id} words={material.words} flat />}
            {chapters.length > 1 && (
              <ol className="mt-3 flex flex-col" data-testid="reader-toc">
                {chapters.map((c, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className={`w-full truncate rounded-lg px-2 py-2 text-start text-sm ${
                        i === chapter ? "font-semibold" : "opacity-80"
                      }`}
                      onClick={() => {
                        closeSheet();
                        placed.current = null;
                        const bi = blockOfLine(blocks, c.start);
                        dispatch({ type: "select", line: bi });
                        requestAnimationFrame(() =>
                          placeBlock(bi, (strip.current?.offsetHeight ?? 44) + 8),
                        );
                      }}
                    >
                      {c.title}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </Sheet>
        )}
        {sheet === "aa" && (
          <Sheet title={t.textAndMarks.value} onClose={closeSheet} closeLabel={t.close.value}>
            <AaControls
              auto={auto}
              setAuto={(on) => {
                setAuto(on);
                try {
                  localStorage.setItem(AUTO_KEY, on ? "1" : "0");
                } catch {}
              }}
            />
          </Sheet>
        )}
      </div>
    </SwipeFeelProvider>
  );
}

/** One glass layer over the book; what sits on it has no frame of its own. */
function Sheet({
  title,
  onClose,
  closeLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label={closeLabel}
        className="absolute inset-0 bg-[oklch(0.2_0.01_65/0.25)]"
        onClick={onClose}
      />
      <div className="lk-glass absolute inset-x-0 bottom-0 mx-auto max-h-[75vh] max-w-[38rem] overflow-y-auto overscroll-contain rounded-t-2xl border border-b-0 border-[var(--glass-line)] px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            className="grid h-10 w-10 place-items-center rounded-full text-lg opacity-70"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AaControls({ auto, setAuto }: { auto: boolean; setAuto: (on: boolean) => void }) {
  const t = useIntlayer("read-reader");
  const tp = useIntlayer("read-player");
  const ts = useIntlayer("text-size");
  const { locale } = useLocale();
  const sizes = useTextSizes();
  const level = useUi(readMarks, (s) => s.level);
  const pct = new Intl.NumberFormat(String(locale), { style: "percent" }).format(sizes.read);
  const btn = "grid h-10 w-10 place-items-center rounded-full font-medium disabled:opacity-30";
  const opts: [MarkLevel, string][] = [
    ["off", t.marksOff.value],
    ["unknown", t.marksUnknown.value],
    ["all", t.marksAll.value],
  ];
  return (
    <div className="flex flex-col gap-3 pt-1 text-sm">
      <div className="flex items-center gap-2" data-text-size-row="read">
        <span className="min-w-0 flex-1">{ts.read}</span>
        <button
          type="button"
          className={`${btn} text-xs`}
          aria-label={`${ts.read.value}: ${ts.smaller.value}`}
          disabled={sizes.read <= TEXT_MIN}
          onClick={() => setTextSize("read", stepScale(sizes.read, -1))}
        >
          A−
        </button>
        <output className="w-[5ch] text-center tabular-nums">{pct}</output>
        <button
          type="button"
          className={`${btn} text-lg`}
          aria-label={`${ts.read.value}: ${ts.larger.value}`}
          disabled={sizes.read >= TEXT_MAX}
          onClick={() => setTextSize("read", stepScale(sizes.read, 1))}
        >
          A+
        </button>
      </div>
      <div className="flex flex-col gap-1" role="radiogroup" aria-label={t.marks.value}>
        <span>{t.marks}</span>
        <div className="flex gap-1">
          {opts.map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={level === k}
              data-marks-option={k}
              onClick={() => readMarks.setState({ level: k })}
              className={`min-h-10 flex-1 rounded-full px-2 ${
                level === k ? "bg-[oklch(0.5_0_0/0.14)] font-semibold" : "opacity-75"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex min-h-10 items-center gap-2">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          data-testid="read-auto"
          className="h-4 w-4"
        />
        <span>{tp.autoAdvance}</span>
      </label>
    </div>
  );
}

type RowShared = Omit<RowCommon, "index" | "block" | "grade">;

/**
 * The book's rows on the window's scroll, virtualised with measured heights.
 * Its own component: the virtualiser re-renders on scroll, and only this
 * (a map over the ~20 mounted rows, each memoised) re-renders with it.
 */
const BookList = memo(function BookList({
  blocks,
  lines,
  listRef,
  vRef,
  lang,
  mirror,
  grades,
  row,
}: {
  blocks: Block[];
  lines: readonly string[];
  listRef: React.RefObject<HTMLDivElement | null>;
  vRef: React.RefObject<WindowVirtualizer | null>;
  lang: string;
  mirror: boolean;
  grades: Record<string, SwipeRating>;
  row: RowShared;
}) {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const set = () => setMargin(el.getBoundingClientRect().top + window.scrollY);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [listRef]);
  // A rough height per row, counted once: the virtualiser asks again for
  // every unmeasured row each time a measurement lands. Measured as it renders.
  const sizes = useMemo(
    () =>
      blocks.map((b) => {
        if (b.kind === "heading") return 72;
        const w = b.pieces.reduce((n, pc) => n + roughWords(lines[pc.line] ?? ""), 0);
        return 28 + Math.ceil(w / 9) * 30;
      }),
    [blocks, lines],
  );
  const estimate = useCallback((i: number) => sizes[i] ?? 40, [sizes]);
  const v = useWindowVirtualizer({
    count: blocks.length,
    estimateSize: estimate,
    overscan: 6,
    scrollMargin: margin,
    getItemKey: (i) => {
      const b = blocks[i];
      return b.kind === "heading" ? `h${b.line}` : b.id;
    },
  });
  vRef.current = v;
  return (
    <div
      ref={listRef}
      className="lk-book relative mx-auto w-full max-w-[38em] px-5"
      lang={lang}
      data-testid="reader-book"
      style={{ height: v.getTotalSize() }}
    >
      <div
        ref={row.underlay}
        aria-hidden
        data-swipe-underlay
        data-mirror={mirror ? "" : undefined}
        className="pointer-events-none absolute overflow-hidden"
        style={{ visibility: "hidden", background: "var(--slip-seam)" }}
      >
        <GradeStrip mirror={mirror} />
      </div>
      {v.getVirtualItems().map((it) => {
        const b = blocks[it.index];
        return (
          <div
            key={it.key}
            data-index={it.index}
            ref={v.measureElement}
            className="absolute inset-x-5 top-0"
            style={{ transform: `translateY(${it.start - v.options.scrollMargin}px)` }}
          >
            <BlockRow
              {...row}
              index={it.index}
              block={b}
              grade={b.kind === "item" ? (grades[b.id] ?? null) : null}
            />
          </div>
        );
      })}
    </div>
  );
});
