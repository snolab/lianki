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
  marksByLine,
  cutPara,
  blockLine,
  blockOfAnchor,
  blockOfLine,
  blockSpeech,
  famMap,
  roughWords,
} from "@/lib/read/reader-model";
import {
  localReaderData,
  type GradeReceipt,
  type Loaded,
  type ReaderBook,
} from "@/lib/read/reader-adapter";
import { GRADE_HOLD_MS, serverReaderData } from "@/lib/read/reader-server";
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
import { SelectCard, type CardActions, type UnitView } from "./reader-select-card";
import { useReaderSelect } from "./use-reader-select";
import {
  MadeToast,
  WordReview,
  makeCards,
  rangeWordsOf,
  unmakeCards,
  type RangeWord,
} from "./reader-word-review";
import { missingWords, paraWords, spanWords } from "@/lib/read/word-review";
import {
  COMBO_MS,
  type ComboCtx,
  type Unit,
  countRange,
  countSentences,
  decodeUnit,
  rangeParts,
  rangeText,
  emptyCounts,
  sameUnit,
  tapVoice,
  type SayUnit,
  sentenceOfToken,
  tokenOffset,
  tokenText,
  tokenWord,
  unitLink,
} from "@/lib/read/reader-select";
import { segmentLine } from "@/lib/read/units";
import { sentenceId } from "@/lib/read/reader-api";
import { onPageLeave } from "@/lib/page-leave";

type WindowVirtualizer = Virtualizer<Window, Element>;
/** The units whose card offers the review and 制卡. */
type ReviewUnit = Extract<Unit, { kind: "word" | "phrase" | "sentence" | "para" | "range" }>;

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

type Material = ReadMaterial & {
  book?: BookMeta;
  words?: WordsSummary;
  /** Reader v2's server side is on for him (GET /api/read/[id], lib/read/reader-api.ts). */
  readerV2?: boolean;
  /** The content hash: deep links name the book by it (lib/read/book-link.ts). */
  bookHash?: string;
};

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
  // The server's items, grades and position when its reader v2 is on for him
  // (D1); otherwise (a guest, MongoDB) the device derives them.
  // If the server cannot give its items, the whole visit goes local (its
  // item ids have no server sentences to grade).
  const [serverDown, setServerDown] = useState(false);
  const data = useMemo(
    () =>
      signedIn && material.readerV2 && material.bookHash && !serverDown
        ? serverReaderData(id, material.bookHash)
        : localReaderData(),
    [signedIn, material.readerV2, material.bookHash, id, serverDown],
  );
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
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [grades, setGrades] = useState<Record<string, SwipeRating>>({});
  useEffect(() => {
    let live = true;
    data
      .load(rbook)
      .then((l) => {
        if (!live) return;
        setLoaded(l);
        if (l.grades) setGrades(l.grades);
      })
      .catch((err) => {
        // The server could not give its items: read on with the device's.
        console.error("read: items failed, cutting on the device", err);
        if (live) setServerDown(true);
      });
    return () => {
      live = false;
    };
  }, [data, rbook]);
  const blocks = useMemo(() => loaded?.blocks ?? [], [loaded]);
  useEffect(() => () => data.flush(), [data]);
  // The EPUB's own markup, when the book was imported with it (BookMeta
  // marks / breaks / continues, feat/reader-data): emphasis and joins.
  const markup = book as
    | (BookMeta & {
        marks?: [number, number, number, string][];
        breaks?: number[];
        continues?: number[];
      })
    | undefined;
  const inline = useMemo(() => marksByLine(markup?.marks), [markup]);
  const joins = useMemo(() => {
    const m = new Map<number, "br" | "sp">();
    for (const l of markup?.breaks ?? []) m.set(l, "br");
    for (const l of markup?.continues ?? []) m.set(l, "sp");
    return m;
  }, [markup]);
  const joinOf = useCallback((line: number) => joins.get(line), [joins]);
  const isHeading = useCallback((line: number) => rbook.headings.has(line), [rbook]);
  const paras = useMemo(
    () =>
      new ParaCache(lines, lang, normLang, 400, {
        marks: (l) => inline.get(l) ?? null,
        cuts: (l) => loaded?.cuts?.get(l) ?? null,
      }),
    [lines, lang, normLang, inline, loaded],
  );
  const para = useCallback((line: number) => paras.get(line), [paras]);
  const lineText = useCallback((line: number) => lines[line] ?? "", [lines]);
  const chapters = useMemo(() => book?.chapters ?? [], [book]);
  /** A chapter's lines, [start, end). */
  const chapterRange = useCallback(
    (n: number): [number, number] | null =>
      n >= 0 && n < chapters.length
        ? [chapters[n].start, chapters[n + 1]?.start ?? lines.length]
        : null,
    [chapters, lines.length],
  );

  // ── Familiarity: the per-book word map, fetched once ──
  const [fam, setFam] = useState<{ map: Map<string, Fam>; v: number } | null>(null);
  /** Bumped when cards were made or graded from the reader: the map is fetched again. */
  const [famTick, setFamTick] = useState(0);
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
        setFam((f) => ({ map, v: (f?.v ?? 0) + 1 }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, signedIn, material.words, famTick]);

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
  /** When each item first reached the eye line (the grade's reading time). */
  const shownAt = useRef(new Map<number, number>());

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
  const saveNow = useCallback(
    (leaving = false) => {
      const a = takeAnchor();
      if (a) data.saveAnchor(id, a, { leaving });
    },
    [takeAnchor, data, id],
  );

  // ── Combo-click selection (lib/read/reader-select.ts, use-reader-select.ts) ──
  const comboCtx = useMemo<ComboCtx>(
    () => ({
      interval: COMBO_MS,
      // Phrase bounds come with extraction (books-plan phase 1): until then the level is skipped.
      phraseAt: () => null,
      chapterAt: (line) => (chapters.length ? chapterAt(chapters, line) : -1),
      chapterRange,
    }),
    [chapters, chapterRange],
  );
  /** Says what a click of the combo selected (set below, with the card's strings). */
  const tapRef = useRef<(u: Unit, continued: boolean) => void>(() => {});
  const sel = useReaderSelect({
    listRef,
    ctx: comboCtx,
    scrolling: () => performance.now() - lastScrollAt.current < 100,
    onTap: (u, continued) => tapRef.current(u, continued),
  });
  useBackToClose(sel.unit !== null, sel.clear);

  /** The block a unit sits in, or -1 when the book has no such unit. */
  const unitBlock = useCallback(
    (u: Unit): number => {
      if (!blocks.length) return -1;
      if (u.kind === "book") return 0;
      if (u.kind === "chapter") {
        const r = chapterRange(u.n);
        return r ? blockOfLine(blocks, r[0]) : -1;
      }
      if (u.kind === "range") {
        // Both ends must be words of the book (a link names them).
        const has = (l: number, t: number) =>
          l < lines.length && !!lines[l]?.trim() && sentenceOfToken(para(l).sentences, t) >= 0;
        if (!has(u.l0, u.t0) || !has(u.l1, u.t1)) return -1;
        return blockOfAnchor(blocks, u.l0, sentenceOfToken(para(u.l0).sentences, u.t0));
      }
      if (u.line >= lines.length || !lines[u.line]?.trim()) return -1;
      const ss = para(u.line).sentences;
      let s = 0;
      if (u.kind === "sentence") {
        if (u.s >= ss.length) return -1;
        s = u.s;
      } else if (u.kind === "word" || u.kind === "phrase") {
        const [t0, t1] = u.kind === "word" ? [u.t, u.t] : [u.t0, u.t1];
        s = sentenceOfToken(ss, t0);
        if (s < 0 || sentenceOfToken(ss, t1) < 0) return -1;
      }
      return blockOfAnchor(blocks, u.line, s);
    },
    [blocks, chapterRange, lines, para],
  );

  /** Opens a deep link: the unit at the eye line, flashed, its card shown. False: no such unit. */
  const openLink = useCallback(
    (u: Unit): boolean => {
      const i = unitBlock(u);
      if (i < 0) return false;
      placed.current = i;
      prog.current = true;
      vz().scrollToIndex(i, { align: "start" });
      dispatch({ type: "select", line: i });
      sel.select(u, { flash: true });
      // Twice: the rows around it are measured on the first frame.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const y =
            u.kind === "chapter" || u.kind === "book"
              ? (strip.current?.offsetHeight ?? 44) + 8
              : eye();
          const root = listRef.current;
          const el =
            u.kind === "range"
              ? root?.querySelector<HTMLElement>(`[data-line="${u.l0}"] [data-t="${u.t0}"]`)
              : u.kind === "word" || u.kind === "phrase" || u.kind === "sentence"
                ? root?.querySelector<HTMLElement>(
                    u.kind === "sentence"
                      ? `[data-line="${u.line}"] [data-s="${u.s}"]`
                      : `[data-line="${u.line}"] [data-t="${u.kind === "word" ? u.t : u.t0}"]`,
                  )
                : null;
          if (el) scrollTo(window.scrollY + el.getBoundingClientRect().top - y);
          else placeBlock(i, y);
        }),
      );
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unitBlock, dispatch, placeBlock, scrollTo, sel.select],
  );
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;
  useEffect(() => {
    const on = () => {
      const u = decodeUnit(location.hash);
      if (u) openLinkRef.current(u);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // Restore once: a deep link's unit, else the synced anchor (or this device's copy).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !blocks.length) return;
    restored.current = true;
    const linked = decodeUnit(location.hash);
    if (linked && openLinkRef.current(linked)) return;
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
          if (!shownAt.current.has(idx)) shownAt.current.set(idx, Date.now());
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
    // Leaving: the position is written now, not ANCHOR_QUIET_MS later — the
    // unmount after a Back (Android's edge swipe takes one with no warning)
    // can no longer measure the list. A popstate may only be a sheet closing
    // (lib/back-to-close.ts): it saves the position and leaves grades in
    // their undo window; so does hiding (an app switch). Grades not yet
    // sent are kept on the device and sent on the next load either way.
    const offLeave = onPageLeave((why) => {
      clearTimeout(saveT);
      if (why !== "pagehide") return saveNow(why === "hidden");
      saveNow(true);
      data.flush();
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", settle);
    window.addEventListener("touchstart", touchstart, { passive: true });
    window.addEventListener("touchend", touchend, { passive: true });
    window.addEventListener("touchcancel", touchend, { passive: true });
    window.addEventListener("wheel", begin, { passive: true });
    window.addEventListener("keydown", key);
    return () => {
      offLeave();
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
      saveNow();
    };
  }, [saveNow, data]);

  // ── Grading ──
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
      void data.grade(rbook, b, r, { shownAt: shownAt.current.get(index) }).then((receipt) => {
        undoStack.current.push({ receipt, index, top });
        setCanUndo(true);
        // A grade sent to the server can no longer be taken back.
        setTimeout(
          () => setCanUndo(undoStack.current.some((e) => data.canUndo(e.receipt))),
          GRADE_HOLD_MS + 50,
        );
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
    undoStack.current = undoStack.current.filter((e) => data.canUndo(e.receipt));
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
      // A modal over the book (the word review, a sheet) has its own keys.
      if (document.querySelector("[aria-modal=true]")) return;
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
  // A sheet over the book takes the selection's place.
  const clearSel = sel.clear;
  useEffect(() => {
    if (sheet) clearSel();
  }, [sheet, clearSel]);

  // ── The selection card: what is selected, its familiarity, its actions ──
  const ts = useIntlayer("read-select");
  const { locale } = useLocale();
  const [selStatus, setSelStatus] = useState<string | null>(null);
  useEffect(() => setSelStatus(null), [sel.unit]);
  // Translate: the selected text in his own language, on the card (our API,
  // lib/read/translate.ts). Keyed by the text, so a new selection drops it.
  const [trans, setTrans] = useState<{ src: string; out: string | null } | null>(null);
  useEffect(() => setTrans(null), [sel.unit]);

  // ── A paragraph's words: /words' review over the book, and 制卡 ──
  const tr = useIntlayer("read-word-review");
  const [review, setReview] = useState<{ words: RangeWord[]; range: boolean } | null>(null);
  const [made, setMade] = useState<{ text: string; terms?: string[] } | null>(null);
  const reviewBack = useRef<HTMLElement | null>(null);
  const famChanged = useCallback(() => setFamTick((n) => n + 1), []);
  const closeReview = useCallback(() => setReview(null), []);
  /** A line's sentences, or null for a blank line. */
  const lineSentences = useCallback(
    (l: number) => (lines[l]?.trim() ? para(l).sentences : null),
    [lines, para],
  );
  /**
   * The words a card's review and 制卡 take: a hand-made range's own words
   * (across its paragraphs), else the paragraph holding the unit.
   */
  const lineWords = useCallback(
    (u: ReviewUnit) => {
      if (u.kind === "range") {
        const parts = rangeParts(u).flatMap((p) => {
          const ss = lineSentences(p.line);
          return ss ? [{ ss, from: p.from, to: p.to }] : [];
        });
        const { sentences, words } = spanWords(parts, fam?.map ?? null);
        return { ss: sentences, words, line: u.l0 };
      }
      const ss = para(u.line).sentences;
      return { ss, words: paraWords(ss, fam?.map ?? null), line: u.line };
    },
    [para, fam, lineSentences],
  );
  /** The one trigger of the review (owner, 22:19 JST: the card's button): the unit's words. */
  const openReview = useCallback(
    (u: ReviewUnit) => {
      const { ss, words, line } = lineWords(u);
      // Focus comes back to the paragraph's item when the review closes.
      const el = rowEl(blockOfLine(blocks, line));
      if (el && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      reviewBack.current = el ?? null;
      void rangeWordsOf(words, ss, normLang).then((w) => {
        sel.clear();
        setReview({ words: w, range: u.kind === "range" });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lineWords, blocks, normLang, sel.clear],
  );
  const makeLine = useCallback(
    (u: ReviewUnit) => {
      const { ss, words } = lineWords(u);
      void rangeWordsOf(missingWords(words), ss, normLang)
        .then((w) => makeCards(id, w))
        .then((r) => {
          setMade({
            text: fill(tr.madeCards.value, { n: String(r.terms.length) }),
            terms: r.terms,
          });
          famChanged();
        })
        .catch(() => setMade({ text: tr.makeFailed.value }));
    },
    [lineWords, normLang, id, tr, famChanged],
  );

  // ── Saying the selected unit (lib/read/reader-select.ts, tapVoice) ──
  /** Cuts what the last tap said, or its pending say. */
  const said = useRef<(() => void) | null>(null);
  const [sayFail, setSayFail] = useState<{ u: Unit; why: string } | null>(null);
  const unitSpeech = useCallback(
    (u: SayUnit): string => {
      if (u.kind === "range") return rangeText(u, lineSentences, "\n");
      if (u.kind === "para") return lineText(u.line);
      const ss = para(u.line).sentences;
      if (u.kind === "sentence") return ss[u.s]?.text ?? "";
      return u.kind === "word" ? tokenText(ss, u.t, u.t) : tokenText(ss, u.t0, u.t1);
    },
    [para, lineText, lineSentences],
  );
  tapRef.current = (u, continued) => {
    const v = tapVoice(u, continued, playingRef.current);
    said.current?.();
    said.current = null;
    setSayFail(null);
    // Paused, not moved: ▶ reads on from where he is.
    if (v.pause) dispatch({ type: "stop" });
    const target = v.say;
    if (!target) return;
    const text = unitSpeech(target).trim();
    if (!text) return;
    // In the gesture, also when the unit is said after the combo rests.
    speaker.unlock();
    const go = () => {
      const stop = speaker.speak(text, lang, {
        onend: () => {
          if (said.current === stop) said.current = null;
        },
        // Never silent without saying so: the card says why.
        onerror: (why) => {
          if (said.current === stop) said.current = null;
          setSayFail({ u: target, why });
        },
      });
      said.current = stop;
    };
    if (!v.wait) return go();
    const timer = setTimeout(() => {
      said.current = null;
      // ▶ was pressed meanwhile: the book has the voice.
      if (!playingRef.current) go();
    }, COMBO_MS);
    said.current = () => clearTimeout(timer);
  };
  useEffect(() => () => said.current?.(), []);
  const view = useMemo<UnitView | null>(() => {
    const u = sel.unit;
    if (!u) return null;
    const fm = fam?.map ?? null;
    const v: UnitView = {
      unit: u,
      text: null,
      title: null,
      size: null,
      counts: null,
      coverage: null,
    };
    if (u.kind === "book") {
      v.title = material.title;
      v.size = {
        words: material.words?.tokens ?? Math.round(lines.reduce((n, l) => n + roughWords(l), 0)),
        chapters: chapters.length,
      };
      v.coverage = material.words?.coverage ?? null;
      return v;
    }
    if (u.kind === "chapter") {
      const r = chapterRange(u.n);
      if (!r) return v;
      v.title = chapters[u.n].title;
      const heads = new Set(book?.headings ?? []);
      const c = emptyCounts();
      let words = 0;
      let paras = 0;
      for (let l = r[0]; l < r[1]; l++) {
        if (!lines[l]?.trim() || heads.has(l)) continue;
        paras++;
        // Cut here, not through the row cache: a chapter would push the rows on screen out.
        const p = cutPara(lines[l], lang, normLang);
        for (const st of p.sentences) for (const g of st.segs) if (g.t >= 0) words++;
        if (fm) countSentences(p.sentences, fm, undefined, c);
      }
      v.size = { words, paras };
      v.counts = fm ? c : null;
      return v;
    }
    if (u.kind === "range") {
      v.text = rangeText(u, lineSentences);
      v.counts = fm ? countRange(u, lineSentences, fm) : null;
      return v;
    }
    const ss = para(u.line).sentences;
    if (u.kind === "word") {
      v.text = tokenText(ss, u.t, u.t);
      const w = tokenWord(ss, u.t);
      v.fam = w && fm ? fm.get(w) : undefined;
      return v;
    }
    if (u.kind === "phrase") {
      v.text = tokenText(ss, u.t0, u.t1);
      v.counts = fm ? countSentences(ss, fm, [u.t0, u.t1]) : null;
      return v;
    }
    const part = u.kind === "sentence" ? ss.slice(u.s, u.s + 1) : ss;
    v.text = u.kind === "para" ? lineText(u.line) : (part[0]?.text ?? "");
    v.counts = fm ? countSentences(part, fm) : null;
    return v;
  }, [
    sel.unit,
    fam,
    material,
    lines,
    chapters,
    chapterRange,
    book,
    lang,
    normLang,
    para,
    lineText,
    lineSentences,
  ]);

  const copy = useCallback(
    async (text: string, ok: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setSelStatus(ok);
      } catch {
        setSelStatus(ts.copyFailed.value);
      }
    },
    [ts],
  );
  const actions = useMemo<CardActions | null>(() => {
    const u = view?.unit;
    if (!view || !u) return null;
    const ui = String(locale).split("-")[0];
    const from = lang && lang !== "und" ? lang : undefined;
    const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
    const text =
      u.kind === "chapter"
        ? (() => {
            const r = chapterRange(u.n);
            return r
              ? lines
                  .slice(r[0], r[1])
                  .filter((l) => l.trim())
                  .join("\n\n")
              : null;
          })()
        : view.text;
    const a: CardActions = {
      copyLink: () =>
        void copy(unitLink(location.origin, material.bookHash ?? id, u), ts.linkCopied.value),
      readFrom: () => {
        const i = unitBlock(u);
        if (i < 0) return;
        speaker.unlock();
        placed.current = null;
        setFollow(true);
        dispatch({ type: "select", line: i });
        dispatch({ type: "play" });
      },
    };
    if (text && u.kind !== "book") a.copyText = () => void copy(text, ts.textCopied.value);
    if (view.text && (u.kind === "word" || u.kind === "phrase"))
      a.lookUp = () =>
        open(
          `https://${ui}.wiktionary.org/w/index.php?search=${encodeURIComponent(view.text!.trim())}`,
        );
    if (
      view.text &&
      signedIn &&
      material.readerV2 &&
      (u.kind === "word" ||
        u.kind === "phrase" ||
        u.kind === "sentence" ||
        u.kind === "para" ||
        u.kind === "range")
    )
      a.translate = () => {
        const src = view.text!.trim();
        if (trans?.src === src) return;
        setTrans({ src, out: null });
        void fetch(`/api/read/${id}/translate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: src, to: String(locale), from }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { text?: string } | null) => {
            if (!d?.text) throw new Error("no translation");
            setTrans((t) => (t?.src === src ? { src, out: d.text! } : t));
          })
          .catch(() => {
            setTrans((t) => (t?.src === src ? null : t));
            setSelStatus(ts.translateFailed.value);
          });
      };
    const hash = material.bookHash;
    if (
      signedIn &&
      material.readerV2 &&
      hash &&
      (u.kind === "word" ||
        u.kind === "phrase" ||
        u.kind === "sentence" ||
        u.kind === "para" ||
        u.kind === "range")
    ) {
      // The word's, the phrase's and the sentence's own paragraph; a range's own words.
      a.reviewWords = () => openReview(u);
      const n = fam ? missingWords(lineWords(u).words).length : 0;
      if (n > 0) a.makeCards = { n, run: () => makeLine(u) };
    }
    // His own selection: read exactly it (the same voice and rules as a tap's).
    if (u.kind === "range" && view.text) a.readAloud = () => tapRef.current(u, false);
    if (u.kind === "word" && signedIn && material.readerV2 && hash)
      a.markNew = () => {
        // An explicit "not recognised" (books-plan, option A): the exposure log
        // only; its sentence as the server cuts the line (lib/read/units.ts).
        const ss = para(u.line).sentences;
        const off = tokenOffset(ss, u.t);
        const idx = segmentLine(lines[u.line] ?? "", normLang).findIndex(
          ([s0, s1]) => off >= s0 && off < s1,
        );
        if (off < 0 || idx < 0) return setSelStatus(ts.markFailed.value);
        void fetch(`/api/read/${id}/exposures`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            events: [
              {
                kind: "select",
                sid: sentenceId(hash, u.line, idx),
                word: tokenText(ss, u.t, u.t),
                at: new Date().toISOString(),
              },
            ],
          }),
        })
          .then((r) => r.json().catch(() => null))
          .then((d: { accepted?: number; duplicates?: number } | null) =>
            setSelStatus(
              d && (d.accepted || d.duplicates) ? ts.markedNew.value : ts.markFailed.value,
            ),
          )
          .catch(() => setSelStatus(ts.markFailed.value));
      };
    return a;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view,
    locale,
    lang,
    normLang,
    lines,
    chapterRange,
    material,
    id,
    signedIn,
    copy,
    unitBlock,
    ts,
    fam,
    openReview,
    makeLine,
    lineWords,
    trans,
  ]);

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
      joinOf,
      isHeading,
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
    [
      para,
      lineText,
      joinOf,
      isHeading,
      fam,
      lang,
      touch,
      variant,
      mirror,
      onSwipe,
      onTap,
      scrolling,
    ],
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
            // Text runs right under it: the near-opaque glass keeps it legible
            // (design-principles: 4.5:1 over the worst content behind).
            style={{ background: "var(--glass-bg-solid)" }}
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
        {!loaded && (
          <p className="py-16 text-center opacity-60" data-testid="reader-loading">
            {t.loading}
          </p>
        )}
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
        {view && actions && (
          <SelectCard
            view={view}
            actions={actions}
            atTop={sel.low}
            bottom={`calc(env(safe-area-inset-bottom) + ${(islandOpen ? 8.5 : 4.75) + (playing && !follow ? 3 : 0)}rem)`}
            status={
              selStatus ??
              (sayFail && sameUnit(sayFail.u, sel.unit)
                ? `${ts.sayFailed.value} (${sayFail.why})`
                : null)
            }
            translation={trans && view.text?.trim() === trans.src ? { text: trans.out } : null}
            onClose={sel.clear}
          />
        )}
        {review && (
          <WordReview
            id={id}
            title={review.range ? tr.selectionTitle.value : tr.title.value}
            words={review.words}
            returnTo={reviewBack}
            onClose={closeReview}
            onChanged={famChanged}
          />
        )}
        {made && (
          <MadeToast
            text={made.text}
            undoLabel={tr.undo.value}
            onUndo={
              made.terms?.length
                ? () =>
                    void unmakeCards(id, made.terms!)
                      .then(famChanged)
                      .catch(() => {})
                : undefined
            }
            onDone={() => setMade(null)}
          />
        )}
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
