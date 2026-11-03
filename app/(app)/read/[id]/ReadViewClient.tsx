"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import type { ReadMaterial } from "../ReadListClient";
import { chapterAt, type BookMeta } from "@/lib/read/book";
import type { WordsSummary } from "@/lib/read/progress";
import { BookScan } from "../BookWords";

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

function getLocalMaterial(id: string): ReadMaterial | null {
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

export function ReadViewClient({ id, isLoggedIn }: { id: string; isLoggedIn: boolean }) {
  const [material, setMaterial] = useState<
    (ReadMaterial & { book?: BookMeta; words?: WordsSummary }) | null
  >(null);
  const epubText = useIntlayer("read-epub");
  const [currentLine, setCurrentLine] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1000);
  const [loading, setLoading] = useState(true);
  const [enableTTS, setEnableTTS] = useState(false);
  const [ttsVoice, setTtsVoice] = useState<
    "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"
  >("shimmer");
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);

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
            setCurrentLine(Math.min(loadPos(id), Math.max(0, (data.lines?.length ?? 1) - 1)));
          }
        } catch (err) {
          console.error("Failed to load material:", err);
        }
      } else {
        const local = getLocalMaterial(id);
        setMaterial(local);
        if (local) setCurrentLine(Math.min(loadPos(id), Math.max(0, local.lines.length - 1)));
      }
      setLoading(false);
    }
    loadMaterial();
  }, [id, isLoggedIn]);

  // Auto-advance when playing
  useEffect(() => {
    if (!isPlaying || !material) return;

    // If TTS is enabled, don't auto-advance - let audio control it
    if (enableTTS) return;

    const timer = setInterval(() => {
      setCurrentLine((prev) => {
        if (prev >= material.lines.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, playbackSpeed);

    return () => clearInterval(timer);
  }, [isPlaying, material, playbackSpeed, enableTTS]);

  // TTS playback
  useEffect(() => {
    if (!enableTTS || !material || !isPlaying) {
      audioElement?.pause();
      return;
    }

    const text = material.lines[currentLine];
    const audio = new Audio();
    let isMounted = true;

    // Use POST for TTS to avoid leaking text in URL
    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: ttsVoice }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`TTS request failed: ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (!isMounted) return;
        audio.src = URL.createObjectURL(blob);
        audio.play().catch((err) => console.error("TTS playback error:", err));
      })
      .catch((err) => console.error("TTS fetch error:", err));

    audio.onended = () => {
      if (!isMounted) return;
      setCurrentLine((prev) => {
        if (prev >= material.lines.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    };

    setAudioElement(audio);

    return () => {
      isMounted = false;
      audio.pause();
      if (audio.src.startsWith("blob:")) {
        URL.revokeObjectURL(audio.src);
      }
      audio.src = "";
    };
  }, [enableTTS, material, currentLine, isPlaying, ttsVoice]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!material) return;

      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          setCurrentLine((prev) => Math.min(prev + 1, material.lines.length - 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          setCurrentLine((prev) => Math.max(prev - 1, 0));
          break;
        case " ":
          e.preventDefault();
          setIsPlaying((prev) => !prev);
          break;
        case "Home":
          e.preventDefault();
          setCurrentLine(0);
          break;
        case "End":
          e.preventDefault();
          setCurrentLine(material.lines.length - 1);
          break;
      }
    },
    [material],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Remember where the reader is (this device), written when it changes.
  useEffect(() => {
    if (material) savePos(id, currentLine);
  }, [id, material, currentLine]);

  const total = material?.lines.length ?? 0;
  const book = material?.book;
  const sections = useMemo(() => sectionsOf(total, book), [total, book]);
  const headingSet = useMemo(() => new Set(book?.headings ?? []), [book]);
  let sec = 0;
  for (let i = 0; i < sections.length; i++) if (sections[i] <= currentLine) sec = i;
  const winStart = sections[sec] ?? 0;
  const winEnd = sections[sec + 1] ?? total;
  const chapter = book?.chapters?.length ? chapterAt(book.chapters, currentLine) : -1;

  // Scroll current line into view
  useEffect(() => {
    const element = document.getElementById(`line-${currentLine}`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentLine]);

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
          <Link
            href="/read"
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            &larr; Back to materials
          </Link>
          <h1 className="text-2xl font-bold mt-2">{material.title}</h1>
          {book?.author && (
            <p className="text-sm text-gray-600 dark:text-gray-300">{book.author}</p>
          )}
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {material.lines.length} lines &middot; Line {currentLine + 1} of {material.lines.length}
          </p>
        </div>
      </div>

      {/* The book's words: scanned at import, progress as a deck (lib/read/words.ts). */}
      {material.words && <BookScan id={id} words={material.words} />}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          onClick={() => setCurrentLine(0)}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          Reset
        </button>

        {/* TTS Toggle */}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableTTS}
              onChange={(e) => setEnableTTS(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">Enable TTS</span>
          </label>
        </div>

        {/* TTS Voice Selection */}
        {enableTTS && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400">Voice:</label>
            <select
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value as any)}
              className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
            >
              <option value="alloy">Alloy</option>
              <option value="echo">Echo</option>
              <option value="fable">Fable</option>
              <option value="onyx">Onyx</option>
              <option value="nova">Nova</option>
              <option value="shimmer">Shimmer</option>
            </select>
          </div>
        )}

        {/* Speed (only when TTS is disabled) */}
        {!enableTTS && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400">Speed:</label>
            <select
              value={playbackSpeed}
              onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
              className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
            >
              <option value={2000}>Slow (2s)</option>
              <option value={1000}>Normal (1s)</option>
              <option value={500}>Fast (0.5s)</option>
              <option value={250}>Very Fast (0.25s)</option>
            </select>
          </div>
        )}

        <div className="hidden sm:block ml-auto text-sm text-gray-500 dark:text-gray-400">
          Keys: j/k navigate, Space play/pause
        </div>
      </div>

      {/* Chapters (imported books) */}
      {book && book.chapters.length > 1 && (
        <div className="flex items-center gap-2" data-testid="read-chapters">
          <button
            onClick={() => setCurrentLine(book.chapters[Math.max(0, chapter - 1)].start)}
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
            onChange={(e) => setCurrentLine(book.chapters[Number(e.target.value)].start)}
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
              setCurrentLine(book.chapters[Math.min(book.chapters.length - 1, chapter + 1)].start)
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

      {/* Current Line Highlight */}
      <div className="p-6 bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-200 dark:border-blue-800 rounded-lg">
        <p className="text-xl font-medium text-center">{material.lines[currentLine]}</p>
      </div>

      {/* All Lines */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="max-h-96 overflow-y-auto">
          {winStart > 0 && (
            <button
              onClick={() => setCurrentLine(sections[sec - 1] ?? 0)}
              className="w-full px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50"
            >
              ↑ {sections[sec - 1] + 1}–{winStart}
            </button>
          )}
          {material.lines.slice(winStart, winEnd).map((line, i) => {
            const index = winStart + i;
            return (
              <button
                key={index}
                id={`line-${index}`}
                onClick={() => setCurrentLine(index)}
                className={`w-full text-left px-4 py-2 border-b border-gray-100 dark:border-gray-800 last:border-b-0 transition-colors ${
                  index === currentLine
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100"
                    : "hover:bg-gray-50 dark:hover:bg-gray-800/50"
                }`}
              >
                <span className="text-gray-400 dark:text-gray-500 text-sm mr-3 w-8 inline-block">
                  {index + 1}
                </span>
                <span className={headingSet.has(index) ? "font-semibold" : undefined}>{line}</span>
              </button>
            );
          })}
          {winEnd < total && (
            <button
              onClick={() => setCurrentLine(winEnd)}
              className="w-full px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50"
            >
              ↓ {winEnd + 1}–{sections[sec + 2] ?? total}
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
          onChange={(e) => setCurrentLine(Number(e.target.value))}
          className="w-full"
        />
      </div>
    </div>
  );
}
