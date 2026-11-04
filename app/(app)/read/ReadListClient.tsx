"use client";

import { useState, useEffect, useRef } from "react";
import { useIntlayer } from "next-intlayer";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isoDay, longDate } from "@/lib/dates";
import type { WordsSummary } from "@/lib/read/progress";
import { BookRing, WordCountText } from "./BookWords";

export interface ReadMaterial {
  id: string;
  title: string;
  content?: string;
  lines: string[];
  /** From the list API: the count, without the lines themselves. */
  lineCount?: number;
  /** Word count and the reader's progress (signed in only). */
  words?: WordsSummary;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = "lianki-read-materials";
const PAGE_SIZE = 10;

function generateId(): string {
  return crypto.randomUUID();
}

function parseLinesFromContent(content: string): string[] {
  return content
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// LocalStorage helpers for guests
function getLocalMaterials(): ReadMaterial[] {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

function saveLocalMaterials(materials: ReadMaterial[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(materials));
}

export function ReadListClient({
  isLoggedIn,
  gdoc = false,
}: {
  isLoggedIn: boolean;
  /** Google Docs import shown (the reader-v2 gate, page.tsx). */
  gdoc?: boolean;
}) {
  const router = useRouter();
  const [materials, setMaterials] = useState<ReadMaterial[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importTitle, setImportTitle] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const epubText = useIntlayer("read-epub");
  const epubInput = useRef<HTMLInputElement>(null);
  const [epubBusy, setEpubBusy] = useState(false);
  const [epubError, setEpubError] = useState("");
  const gdocText = useIntlayer("read-gdoc");
  const [gdocOpen, setGdocOpen] = useState(false);
  const [gdocUrl, setGdocUrl] = useState("");
  const [gdocBusy, setGdocBusy] = useState(false);
  const [gdocError, setGdocError] = useState("");

  // Google Docs: the server fetches the doc's public export by its id
  // (app/api/read/gdoc); the same doc again updates that book.
  const handleGdoc = async () => {
    const url = gdocUrl.trim();
    if (!url) return;
    setGdocError("");
    if (!/^(https?:\/\/)?docs\.google\.com\/document\//i.test(url)) {
      setGdocError(gdocText.errBadUrl.value);
      return;
    }
    setGdocBusy(true);
    try {
      const res = await fetch("/api/read/gdoc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const code = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        const msg: Record<string, string> = {
          "bad-url": gdocText.errBadUrl.value,
          "not-shared": gdocText.errNotShared.value,
          "not-found": gdocText.errNotFound.value,
          "too-large": gdocText.errTooLarge.value,
          "too-much-text": gdocText.errTooLarge.value,
          "no-text": gdocText.errNoText.value,
          "rate-limited": gdocText.errRateLimited.value,
        };
        setGdocError(msg[code ?? ""] ?? gdocText.errFailed.value);
        return;
      }
      const saved = await res.json();
      router.push(`/read/${saved.id}`);
    } catch (err) {
      console.error("Google Docs import failed:", err);
      setGdocError(gdocText.errFailed.value);
    } finally {
      setGdocBusy(false);
    }
  };

  // EPUB: unpacked and parsed here in the browser (lib/epub/), so the Worker
  // never inflates an untrusted zip; the server validates and caps the result.
  const handleEpub = async (file: File) => {
    setEpubError("");
    const { EPUB_LIMITS, importEpub } = await import("@/lib/epub/unzip");
    if (file.size > EPUB_LIMITS.maxFileBytes) {
      setEpubError(epubText.errTooLarge.value);
      return;
    }
    setEpubBusy(true);
    try {
      let book;
      try {
        book = await importEpub(await file.arrayBuffer());
      } catch (err) {
        const code = (err as { code?: string }).code;
        setEpubError(
          code === "drm"
            ? epubText.errDrm.value
            : code === "too-large"
              ? epubText.errTooLarge.value
              : code === "no-text"
                ? epubText.errNoText.value
                : code === "too-much-text"
                  ? epubText.errTooMuch.value
                  : epubText.errNotEpub.value,
        );
        return;
      }
      const res = await fetch("/api/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book }),
      });
      if (!res.ok) {
        setEpubError(res.status === 413 ? epubText.errTooMuch.value : epubText.errFailed.value);
        return;
      }
      const saved = await res.json();
      // The reader's header shows the scan summary of what was imported.
      router.push(`/read/${saved.id}`);
    } catch (err) {
      console.error("EPUB import failed:", err);
      setEpubError(epubText.errFailed.value);
    } finally {
      setEpubBusy(false);
      if (epubInput.current) epubInput.current.value = "";
    }
  };

  // Load materials
  useEffect(() => {
    async function loadMaterials() {
      setLoading(true);
      if (isLoggedIn) {
        try {
          const res = await fetch(`/api/read?page=${page}&pageSize=${PAGE_SIZE}`);
          if (res.ok) {
            const data = await res.json();
            setMaterials(data.materials);
            setTotalPages(data.totalPages);
          }
        } catch (err) {
          console.error("Failed to load materials:", err);
        }
      } else {
        const local = getLocalMaterials();
        setMaterials(local.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));
        setTotalPages(Math.ceil(local.length / PAGE_SIZE) || 1);
      }
      setLoading(false);
    }
    loadMaterials();
  }, [isLoggedIn, page]);

  const handleImport = async () => {
    if (!importText.trim()) return;

    const lines = parseLinesFromContent(importText);
    const title = importTitle.trim() || `Import ${isoDay()}`;

    if (isLoggedIn) {
      try {
        const res = await fetch("/api/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content: importText }),
        });
        if (res.ok) {
          const newMaterial = await res.json();
          setImportText("");
          setImportTitle("");
          setIsImporting(false);
          router.push(`/read/${newMaterial.id}`);
        }
      } catch (err) {
        console.error("Failed to save material:", err);
      }
    } else {
      const now = new Date().toISOString();
      const newMaterial: ReadMaterial = {
        id: generateId(),
        title,
        content: importText,
        lines,
        createdAt: now,
        updatedAt: now,
      };

      const all = getLocalMaterials();
      const updated = [newMaterial, ...all];
      saveLocalMaterials(updated);
      setImportText("");
      setImportTitle("");
      setIsImporting(false);
      router.push(`/read/${newMaterial.id}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this material?")) return;

    if (isLoggedIn) {
      try {
        await fetch(`/api/read/${id}`, { method: "DELETE" });
        setMaterials((prev) => prev.filter((m) => m.id !== id));
      } catch (err) {
        console.error("Failed to delete:", err);
      }
    } else {
      const all = getLocalMaterials();
      const updated = all.filter((m) => m.id !== id);
      saveLocalMaterials(updated);
      setMaterials((prev) => prev.filter((m) => m.id !== id));
    }
  };

  return (
    <div className="space-y-6">
      {/* Import Button / Form */}
      {!isImporting ? (
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={() => setIsImporting(true)}
              className="flex-1 py-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-500 dark:text-gray-400 hover:border-blue-500 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-colors"
            >
              + Import Text Material
            </button>
            {isLoggedIn && (
              <label
                data-testid="read-import-epub"
                className={`flex-1 py-4 text-center cursor-pointer border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-500 dark:text-gray-400 hover:border-blue-500 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-colors ${epubBusy ? "pointer-events-none opacity-60" : ""}`}
              >
                {epubBusy ? epubText.reading : <>+ {epubText.importEpub}</>}
                <input
                  ref={epubInput}
                  type="file"
                  accept=".epub,application/epub+zip"
                  className="sr-only"
                  disabled={epubBusy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleEpub(f);
                  }}
                />
              </label>
            )}
            {isLoggedIn && gdoc && !gdocOpen && (
              <button
                type="button"
                data-testid="read-import-gdoc"
                onClick={() => setGdocOpen(true)}
                className="flex-1 py-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-500 dark:text-gray-400 hover:border-blue-500 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-colors"
              >
                + {gdocText.importGdoc}
              </button>
            )}
          </div>
          {isLoggedIn && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{epubText.note}</p>
          )}
          {isLoggedIn && gdoc && gdocOpen && (
            <form
              data-testid="read-gdoc-form"
              className="flex flex-col sm:flex-row gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleGdoc();
              }}
            >
              <input
                type="url"
                inputMode="url"
                autoFocus
                value={gdocUrl}
                onChange={(e) => setGdocUrl(e.target.value)}
                aria-label={gdocText.urlLabel.value}
                placeholder="https://docs.google.com/document/d/…"
                disabled={gdocBusy}
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setGdocOpen(false);
                    setGdocUrl("");
                    setGdocError("");
                  }}
                  className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                >
                  {gdocText.cancel}
                </button>
                <button
                  type="submit"
                  disabled={gdocBusy || !gdocUrl.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {gdocBusy ? gdocText.importing : gdocText.submit}
                </button>
              </div>
            </form>
          )}
          {isLoggedIn && gdoc && gdocOpen && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{gdocText.note}</p>
          )}
          {gdocError && (
            <p
              role="alert"
              data-testid="read-gdoc-error"
              className="text-sm text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]"
            >
              {gdocError}
            </p>
          )}
          {epubError && (
            <p
              role="alert"
              data-testid="read-epub-error"
              className="text-sm text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]"
            >
              {epubError}
            </p>
          )}
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
          <input
            type="text"
            value={importTitle}
            onChange={(e) => setImportTitle(e.target.value)}
            placeholder="Title (optional)"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste your text here... Each line will become a learning segment."
            rows={10}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y font-mono text-sm"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setIsImporting(false);
                setImportText("");
                setImportTitle("");
              }}
              className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={!importText.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Import ({parseLinesFromContent(importText).length} lines)
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">Loading...</div>
      ) : materials.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No materials imported yet. Click the button above to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {materials.map((material) => (
            <div
              key={material.id}
              className="flex items-center justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
            >
              <Link href={`/read/${material.id}`} className="flex-1 min-w-0">
                <h3 className="font-medium truncate">{material.title}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {material.lineCount ?? material.lines.length} lines &middot;{" "}
                  {material.words && (
                    <span className="tabular-nums" data-testid="read-row-words">
                      <WordCountText words={material.words} /> &middot;{" "}
                    </span>
                  )}
                  {longDate(material.updatedAt)}
                </p>
              </Link>
              {material.words && (
                <Link href={`/read/${material.id}`} className="ms-2" tabIndex={-1}>
                  <BookRing words={material.words} />
                </Link>
              )}
              <button
                onClick={() => handleDelete(material.id)}
                className="ml-4 p-2 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                title="Delete"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
          >
            Prev
          </button>
          <span className="text-sm text-gray-600 dark:text-gray-400">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
