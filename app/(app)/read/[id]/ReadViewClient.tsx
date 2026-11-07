"use client";
import { useSignedIn } from "@/app/components/BoxApiBridge";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import { pageAudio } from "@lianki/debug-chat/page-audio";
import type { ReadMaterial } from "../ReadListClient";
import { chapterAt, type BookMeta } from "@/lib/read/book";
import {
  initialPlayer,
  playerReducer,
  readLang,
  shadowVerdict,
  type PlayerCfg,
  type PlayerEvent,
  type PlayerState,
} from "@/lib/read/player";
import { browserReadSpeaker } from "@/lib/read/speaker-browser";
import type { WordsSummary } from "@/lib/read/progress";
import { BookScan } from "../BookWords";
import { BookSourceNote } from "../BookSourceNote";
import { ReaderBack } from "./reader-back";

/** Lines rendered at once: a whole book never goes into the DOM in one go. */
const SECTION_LINES = 200;
const POS_KEY = (id: string) => `lk:read-pos:${id}`;

function loadPos(id: string): number {
  try {
    const n = Number(localStorage.getItem(POS_KEY(id)));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function savePos(id: string, line: number) {
  try {
    localStorage.setItem(POS_KEY(id), String(line));
  } catch {
    // private mode or storage full: the position is a convenience
  }
}

/** Render windows: each chapter, cut into pieces of at most SECTION_LINES. */
function sectionsOf(total: number, book?: BookMeta): number[] {
  const starts = (book?.chapters ?? []).map((c) => c.start).filter((s) => s < total);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  const out: number[] = [];
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : total;
    for (let x = s; x < end; x += SECTION_LINES) out.push(x);
  });
  return out.length ? out : [0];
}

const STORAGE_KEY = "lianki-read-materials";

export function getLocalMaterial(id: string): ReadMaterial | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    const materials: ReadMaterial[] = JSON.parse(stored);
    return materials.find((m) => m.id === id) || null;
  } catch {
    return null;
  }
}

/** Device preference: read on line after line without waiting (off by default). */
const AUTO_KEY = "lk:pref:read-auto";
const loadAuto = () => {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
};
/** The chat's voice-out setting (packages/debug-chat/src/voice-out.ts VOICE_OUT_KEY). */
const outMode = (): "speech" | "cloud" => {
  try {
    return localStorage.getItem("lk:voice-out") === "cloud" ? "cloud" : "speech";
  } catch {
    return "speech";
  }
};
/** A shadowed utterance must have begun after the line ended (less this slack). */
const SHADOW_SLACK_MS = 200;

export function ReadViewClient({
  id,
  isLoggedIn: serverSignedIn,
}: {
  id: string;
  isLoggedIn: boolean;
}) {
  // On a box, from lianki.com (BoxApiBridge); else the server's answer.
  const isLoggedIn = useSignedIn(serverSignedIn);
  const [material, setMaterial] = useState<
    (ReadMaterial & { book?: BookMeta; words?: WordsSummary }) | null
  >(null);
  const epubText = useIntlayer("read-epub");
  const t = useIntlayer("read-player");
  const tr = useIntlayer("read-reader");
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(false);
  const [player, setPlayer] = useState<PlayerState>(() => initialPlayer());
  const [follow, setFollow] = useState(true);
  const [frozenSec, setFrozenSec] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const speaker = useMemo(() => browserReadSpeaker(pageAudio, outMode), []);
  const currentLine = player.line;

  const total = material?.lines.length ?? 0;
  const book = material?.book;
  const headingSet = useMemo(() => new Set(book?.headings ?? []), [book]);
  const lang = useMemo(
    () => readLang(book?.lang, material?.lines.slice(0, 20).join(" ") ?? ""),
    [book, material],
  );
  const cfg: PlayerCfg = {
    total,
    auto,
    isHeading: (i) => headingSet.has(i),
    isBlank: (i) => !material?.lines[i]?.trim(),
  };
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const dispatch = useCallback(
    (e: PlayerEvent) => setPlayer((s) => playerReducer(s, e, cfgRef.current)),
    [],
  );
  /** The reader acted: the list follows the current line again. */
  const act = useCallback(
    (e: PlayerEvent) => {
      setFollow(true);
      dispatch(e);
    },
    [dispatch],
  );
  const select = useCallback((line: number) => act({ type: "select", line }), [act]);

  useEffect(() => setAuto(loadAuto()), []);
  const toggleAuto = (on: boolean) => {
    setAuto(on);
    try {
      localStorage.setItem(AUTO_KEY, on ? "1" : "0");
    } catch {
      // private mode: the switch still works for this visit
    }
  };

  // Load material
  useEffect(() => {
    async function loadMaterial() {
      setLoading(true);
      if (isLoggedIn) {
        try {
          const res = await fetch(`/api/read/${id}`);
          if (res.ok) {
            const data = await res.json();
            setMaterial(data);
            setPlayer(
              initialPlayer(Math.min(loadPos(id), Math.max(0, (data.lines?.length ?? 1) - 1))),
            );
          }
        } catch (err) {
          console.error("Failed to load material:", err);
        }
      } else {
        const local = getLocalMaterial(id);
        setMaterial(local);
        if (local)
          setPlayer(initialPlayer(Math.min(loadPos(id), Math.max(0, local.lines.length - 1))));
      }
      setLoading(false);
    }
    loadMaterial();
  }, [id, isLoggedIn]);

  // Read the current line aloud: once per utterance (token); its real end or
  // failure is what moves the player on (lib/read/player.ts).
  const speaking = player.status === "speaking";
  useEffect(() => {
    if (!speaking || !material) return;
    const token = player.token;
    return speaker.speak(material.lines[player.line] ?? "", lang, {
      onend: () => dispatch({ type: "ended", token }),
      onerror: (error) => dispatch({ type: "failed", token, error }),
    });
    // The token alone says which utterance this is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaking, player.token, speaker, dispatch]);

  // Stop speaking when the page goes away.
  useEffect(() => () => speaker.cancel(), [speaker]);

  // The chat mic's state, for the "read it aloud" hint.
  useEffect(() => {
    const pa = pageAudio();
    setMicOn(pa.mic());
    return pa.subscribe(() => setMicOn(pa.mic()));
  }, []);

  // Shadowing: while it waits, the reader reading the line aloud (chat mic on)
  // moves on, and his reading is not posted to the chat.
  const waiting = player.status === "waiting";
  useEffect(() => {
    if (!waiting || !material) return;
    const line = material.lines[player.line] ?? "";
    const endedAt = Date.now();
    const heard: string[] = [];
    const pa = pageAudio();
    pa.listen((text, spokeAt) => {
      if (spokeAt < endedAt - SHADOW_SLACK_MS) return false;
      heard.push(text);
      const v = shadowVerdict(heard, line);
      if (!v.consume) {
        heard.pop();
        return false;
      }
      if (v.done) dispatch({ type: "next" });
      return true;
    });
    return () => pa.listen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, player.line, player.token, material, dispatch]);

  const status = player.status;
  const togglePlay = useCallback(() => {
    // In the tap itself (a gesture), so iOS lets the voice play later. Silent.
    if (status !== "speaking") speaker.unlock();
    act({ type: status === "speaking" ? "stop" : "play" });
  }, [status, speaker, act]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!material) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          select(Math.min(currentLine + 1, material.lines.length - 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          select(Math.max(currentLine - 1, 0));
          break;
        case "n":
        case "Enter":
          e.preventDefault();
          act({ type: "next" });
          break;
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "Home":
          e.preventDefault();
          select(0);
          break;
        case "End":
          e.preventDefault();
          select(material.lines.length - 1);
          break;
      }
    },
    [material, currentLine, select, act, togglePlay],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Remember where the reader is (this device), written when it changes.
  useEffect(() => {
    if (material) savePos(id, currentLine);
  }, [id, material, currentLine]);

  const sections = useMemo(() => sectionsOf(total, book), [total, book]);
  let sec = 0;
  for (let i = 0; i < sections.length; i++) if (sections[i] <= currentLine) sec = i;
  // While the reader scrolls on his own, the rendered section stays where he is.
  const view = follow ? sec : Math.min(frozenSec, sections.length - 1);
  const winStart = sections[view] ?? 0;
  const winEnd = sections[view + 1] ?? total;
  const chapter = book?.chapters?.length ? chapterAt(book.chapters, currentLine) : -1;
  const playing = speaking || waiting;

  // Keep the current line in view, once per line: only the list scrolls, never
  // the page, and not while the reader scrolls on his own.
  useEffect(() => {
    if (!follow) return;
    const box = listRef.current;
    const el = document.getElementById(`line-${currentLine}`);
    if (!box || !el) return;
    const br = box.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    // Centred; a paragraph taller than the list shows from its first line.
    const slack = Math.max(8, (box.clientHeight - er.height) / 2);
    const top = box.scrollTop + (er.top - br.top) - slack;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ top: Math.max(0, top), behavior: still ? "auto" : "smooth" });
  }, [currentLine, follow, winStart]);

  /**
   * The reader scrolled the list himself (a finger, the wheel, its scrollbar):
   * stop following until he acts. Told by input events, not scroll events —
   * the list's own smooth scrolling fires those too.
   */
  const userScrolled = () => {
    if (!follow || !playing) return;
    setFrozenSec(sec);
    setFollow(false);
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!material) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400 mb-4">Material not found</p>
        <Link href="/read" className="text-blue-600 dark:text-blue-400 hover:underline">
          Back to materials
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <ReaderBack variant="text" label={tr.back.value} />
          <h1 className="text-2xl font-bold mt-2">{material.title}</h1>
          {book?.author && (
            <p className="text-sm text-gray-600 dark:text-gray-300">{book.author}</p>
          )}
          <BookSourceNote book={book} className="mt-1" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {material.lines.length} lines &middot; Line {currentLine + 1} of {material.lines.length}
          </p>
        </div>
      </div>

      {/* The book's words: scanned at import, progress as a deck (lib/read/words.ts). */}
      {material.words && <BookScan id={id} words={material.words} />}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
        {waiting ? (
          <>
            <button
              onClick={() => act({ type: "next" })}
              data-testid="read-next"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              {t.next.value} →
            </button>
            <button
              onClick={() => act({ type: "replay" })}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              {t.replay.value}
            </button>
            <button
              onClick={() => act({ type: "stop" })}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              {t.pause.value}
            </button>
          </>
        ) : (
          <button
            onClick={togglePlay}
            data-testid="read-play"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            {speaking ? t.pause.value : t.play.value}
          </button>
        )}
        <button
          onClick={() => {
            act({ type: "stop" });
            select(0);
          }}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          Reset
        </button>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => toggleAuto(e.target.checked)}
            data-testid="read-auto"
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-600 dark:text-gray-400">{t.autoAdvance.value}</span>
        </label>

        <div className="hidden sm:block ml-auto text-sm text-gray-500 dark:text-gray-400">
          Keys: j/k navigate, Space play/pause, n next
        </div>
      </div>

      {/* Chapters (imported books) */}
      {book && book.chapters.length > 1 && (
        <div className="flex items-center gap-2" data-testid="read-chapters">
          <button
            onClick={() => select(book.chapters[Math.max(0, chapter - 1)].start)}
            disabled={chapter <= 0}
            aria-label={epubText.prevChapter.value}
            title={epubText.prevChapter.value}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40"
          >
            ←
          </button>
          <select
            aria-label={epubText.chapters.value}
            value={chapter}
            onChange={(e) => select(book.chapters[Number(e.target.value)].start)}
            className="flex-1 min-w-0 px-2 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800"
          >
            {book.chapters.map((c, i) => (
              <option key={i} value={i}>
                {c.title}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              select(book.chapters[Math.min(book.chapters.length - 1, chapter + 1)].start)
            }
            disabled={chapter >= book.chapters.length - 1}
            aria-label={epubText.nextChapter.value}
            title={epubText.nextChapter.value}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40"
          >
            →
          </button>
        </div>
      )}

      {/* What the player is doing (first: a paragraph can be long), and the current line */}
      <div
        className={`p-6 rounded-lg border-2 ${
          waiting
            ? "bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700"
            : "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
        }`}
      >
        {status !== "idle" && (
          <p
            data-testid="read-status"
            data-status={status}
            role={status === "error" ? "alert" : "status"}
            className={`mb-3 text-sm text-center ${
              status === "error"
                ? "text-red-600 dark:text-red-400"
                : waiting
                  ? "text-amber-700 dark:text-amber-300 font-medium"
                  : "text-gray-500 dark:text-gray-400"
            }`}
          >
            {status === "speaking" && t.reading.value}
            {waiting && (micOn ? t.yourTurnMic.value : t.yourTurn.value)}
            {status === "ended" && t.finished.value}
            {status === "error" && `${t.failed.value} (${player.error})`}
          </p>
        )}
        <p className="text-xl font-medium text-center" lang={lang}>
          {material.lines[currentLine]}
        </p>
      </div>

      {/* All Lines */}
      <div className="relative border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        {!follow && playing && (
          <button
            onClick={() => setFollow(true)}
            data-testid="read-follow"
            className="absolute z-10 right-2 top-2 px-3 py-1 text-sm rounded-full bg-blue-600 text-white shadow"
          >
            ↧ {t.backToLine.value}
          </button>
        )}
        <div
          ref={listRef}
          data-testid="read-lines"
          onWheel={userScrolled}
          onTouchMove={userScrolled}
          onPointerDown={(e) => {
            // On the list itself (its scrollbar), not on a line: a tap on a line is an act.
            if (e.target === e.currentTarget) userScrolled();
          }}
          onKeyDown={(e) => {
            if (["PageUp", "PageDown", "ArrowUp", "ArrowDown"].includes(e.key)) userScrolled();
          }}
          className="max-h-96 overflow-y-auto overscroll-contain"
        >
          {winStart > 0 && (
            <button
              onClick={() => select(sections[view - 1] ?? 0)}
              className="w-full px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50"
            >
              ↑ {sections[view - 1] + 1}–{winStart}
            </button>
          )}
          {material.lines.slice(winStart, winEnd).map((line, i) => {
            const index = winStart + i;
            return (
              <button
                key={index}
                id={`line-${index}`}
                onClick={() => select(index)}
                aria-current={index === currentLine ? "true" : undefined}
                className={`w-full text-left px-4 py-2 border-b border-gray-100 dark:border-gray-800 last:border-b-0 transition-colors ${
                  index === currentLine
                    ? waiting
                      ? "bg-amber-100 dark:bg-amber-900/40 text-amber-950 dark:text-amber-100"
                      : "bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100"
                    : "hover:bg-gray-50 dark:hover:bg-gray-800/50"
                }`}
              >
                <span className="text-gray-400 dark:text-gray-500 text-sm mr-3 w-8 inline-block">
                  {index + 1}
                </span>
                <span className={headingSet.has(index) ? "font-semibold" : undefined} lang={lang}>
                  {line}
                </span>
              </button>
            );
          })}
          {winEnd < total && (
            <button
              onClick={() => select(winEnd)}
              className="w-full px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50"
            >
              ↓ {winEnd + 1}–{sections[view + 2] ?? total}
            </button>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-600 transition-all duration-300"
            style={{
              width: `${((currentLine + 1) / material.lines.length) * 100}%`,
            }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={material.lines.length - 1}
          value={currentLine}
          onChange={(e) => select(Number(e.target.value))}
          className="w-full"
        />
      </div>

      {/* The page's end: the same way back as the header's, no scrolling up. */}
      <ReaderBack variant="end" label={tr.back.value} />
    </div>
  );
}
