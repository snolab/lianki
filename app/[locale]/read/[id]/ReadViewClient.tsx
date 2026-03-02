"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type { ReadMaterial } from "../ReadListClient";

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

export function ReadViewClient({
  id,
  locale,
  isLoggedIn,
}: {
  id: string;
  locale: string;
  isLoggedIn: boolean;
}) {
  const [material, setMaterial] = useState<ReadMaterial | null>(null);
  const [currentLine, setCurrentLine] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1000);
  const [loading, setLoading] = useState(true);

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
          }
        } catch (err) {
          console.error("Failed to load material:", err);
        }
      } else {
        setMaterial(getLocalMaterial(id));
      }
      setLoading(false);
    }
    loadMaterial();
  }, [id, isLoggedIn]);

  // Auto-advance when playing
  useEffect(() => {
    if (!isPlaying || !material) return;

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
  }, [isPlaying, material, playbackSpeed]);

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
        <Link href={`/${locale}/read`} className="text-blue-600 dark:text-blue-400 hover:underline">
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
            href={`/${locale}/read`}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            &larr; Back to materials
          </Link>
          <h1 className="text-2xl font-bold mt-2">{material.title}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {material.lines.length} lines &middot; Line {currentLine + 1} of {material.lines.length}
          </p>
        </div>
      </div>

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
        <div className="hidden sm:block ml-auto text-sm text-gray-500 dark:text-gray-400">
          Keys: j/k navigate, Space play/pause
        </div>
      </div>

      {/* Current Line Highlight */}
      <div className="p-6 bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-200 dark:border-blue-800 rounded-lg">
        <p className="text-xl font-medium text-center">{material.lines[currentLine]}</p>
      </div>

      {/* All Lines */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="max-h-96 overflow-y-auto">
          {material.lines.map((line, index) => (
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
              {line}
            </button>
          ))}
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
