"use client";
import { useSignedIn } from "@/app/components/BoxApiBridge";

import { useState, useEffect, useRef } from "react";
import { useIntlayer } from "next-intlayer";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isoDay, longDate } from "@/lib/dates";
import type { WordsSummary } from "@/lib/read/progress";
import { BookRing, WordCountText } from "./BookWords";
import { GdocDriveImport } from "./GdocDriveImport";
import { DrivePick, DrivePickHowTo } from "../connections/DrivePick";
import { RowMenu, TitleEditor } from "./RowMenu";
import { cleanTitle } from "@/lib/read/title";
import { gdocUrlOf } from "@/lib/gdoc/url";
import { VirtualList } from "@/app/components/VirtualList";
import { useInfiniteList } from "@/app/components/useInfiniteList";

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
  isLoggedIn: serverSignedIn,
  gdoc = false,
  drive = false,
  books = false,
  youtube = false,
}: {
  isLoggedIn: boolean;
  /** A YouTube song with timed lyrics can be added (lib/yt-songs/gate.ts). */
  youtube?: boolean;
  /** Google Docs import shown (signed in on D1, page.tsx). */
  gdoc?: boolean;
  /** Private docs through Google Drive offered (connectionsOn, docs/connections.md). */
  drive?: boolean;
  /** The public-domain library /books is open to this viewer (lib/books/gate.ts). */
  books?: boolean;
}) {
  // On a box, from lianki.com (BoxApiBridge); else the server's answer.
  const isLoggedIn = useSignedIn(serverSignedIn);
  const router = useRouter();
  const [isImporting, setIsImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importTitle, setImportTitle] = useState("");
  // No pages (owner, 2026-11-10): batches as the list nears its end. Signed
  // out, the whole list is this browser's, so it comes in one batch.
  const list = useInfiniteList<ReadMaterial, number>({
    getKey: (m) => m.id,
    deps: [isLoggedIn],
    fetchBatch: async (page, size) => {
      if (!isLoggedIn) return { items: getLocalMaterials(), next: null };
      const p = page ?? 1;
      const res = await fetch(`/api/read?page=${p}&pageSize=${size}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        materials: ReadMaterial[];
        total: number;
        totalPages: number;
      };
      return { items: data.materials, next: p < data.totalPages ? p + 1 : null, total: data.total };
    },
  });
  const materials = list.items;
  const setMaterials = list.setItems;
  const epubText = useIntlayer("read-epub");
  const booksText = useIntlayer("books-page");
  const epubInput = useRef<HTMLInputElement>(null);
  const [epubBusy, setEpubBusy] = useState(false);
  const [epubError, setEpubError] = useState("");
  const gdocText = useIntlayer("read-gdoc");
  const ytText = useIntlayer("yt-songs");
  const rowText = useIntlayer("read-row-menu");
  // The row whose title is a text field right now (row menu → Rename).
  const [renaming, setRenaming] = useState<string | null>(null);
  const [gdocOpen, setGdocOpen] = useState(false);
  const [gdocUrl, setGdocUrl] = useState("");
  const [gdocBusy, setGdocBusy] = useState(false);
  const [gdocError, setGdocError] = useState("");
  // A doc that is not shared by link: offer Google Drive instead (GdocDriveImport).
  const [gdocPrivate, setGdocPrivate] = useState(false);
  const [driveReturned, setDriveReturned] = useState<string | null>(null);

  // Back from Google's consent screen (/read?gdoc=<id>&google=<result>):
  // reopen the import on that doc with the Drive button, then clean the URL.
  useEffect(() => {
    if (!drive || !gdoc) return;
    const q = new URLSearchParams(window.location.search);
    const id = q.get("gdoc");
    if (!id || !/^[A-Za-z0-9_-]{25,128}$/.test(id)) return;
    setGdocOpen(true);
    setGdocUrl(gdocUrlOf(id));
    setGdocPrivate(true);
    setDriveReturned(q.get("google"));
    window.history.replaceState(null, "", "/reader");
  }, [drive, gdoc]);

  const gdocErrorText = (code: string | undefined): string =>
    ({
      "bad-url": gdocText.errBadUrl.value,
      "not-shared": gdocText.errNotShared.value,
      "not-found": gdocText.errNotFound.value,
      "too-large": gdocText.errTooLarge.value,
      "too-much-text": gdocText.errTooLarge.value,
      "no-text": gdocText.errNoText.value,
      "rate-limited": gdocText.errRateLimited.value,
    })[code ?? ""] ?? gdocText.errFailed.value;

  // Google Docs: the server fetches the doc's public export by its id
  // (app/api/read/gdoc); the same doc again updates that book.
  const handleGdoc = async () => {
    const url = gdocUrl.trim();
    if (!url) return;
    setGdocError("");
    setGdocPrivate(false);
    setDriveReturned(null);
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
        if (drive && code === "not-shared") setGdocPrivate(true);
        else setGdocError(gdocErrorText(code));
        return;
      }
      const saved = await res.json();
      router.push(`/reader/${saved.id}`);
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
      router.push(`/reader/${saved.id}`);
    } catch (err) {
      console.error("EPUB import failed:", err);
      setEpubError(epubText.errFailed.value);
    } finally {
      setEpubBusy(false);
      if (epubInput.current) epubInput.current.value = "";
    }
  };

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
          router.push(`/reader/${newMaterial.id}`);
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
      router.push(`/reader/${newMaterial.id}`);
    }
  };

  // Rename from the row menu: the server (or this browser's list, signed out)
  // takes the new title; a gdoc re-sync keeps it (title_custom).
  const handleRename = async (id: string, title: string): Promise<boolean> => {
    if (isLoggedIn) {
      try {
        const res = await fetch(`/api/read/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        });
        const j = (await res.json().catch(() => null)) as { title?: string } | null;
        if (!res.ok || !j?.title) return false;
        setMaterials((prev) => prev.map((m) => (m.id === id ? { ...m, title: j.title! } : m)));
        return true;
      } catch {
        return false;
      }
    }
    const clean = cleanTitle(title);
    if (!clean) return false;
    saveLocalMaterials(getLocalMaterials().map((m) => (m.id === id ? { ...m, title: clean } : m)));
    setMaterials((prev) => prev.map((m) => (m.id === id ? { ...m, title: clean } : m)));
    return true;
  };

  // Rename closed: focus back on that row's menu button.
  const endRename = (id: string) => {
    setRenaming(null);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-row-id="${id}"] [data-testid="read-row-menu"]`)
        ?.focus(),
    );
  };

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(rowText.confirmDelete.value.replace("{title}", title))) return;

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
      {/* The shared catalogue /library: a link only, its books never listed here. */}
      {books && (
        <Link
          href="/library"
          data-testid="read-browse-books"
          className="inline-flex items-center gap-1 text-sm font-medium text-[oklch(0.5_0.176_22.3)] dark:text-[oklch(0.78_0.132_22.3)] hover:underline"
        >
          {booksText.browse} &rarr;
        </Link>
      )}
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
            {isLoggedIn && drive && <DrivePick page="/reader" compact onImported={list.reload} />}
            {isLoggedIn && youtube && (
              <Link
                href="/reader/youtube"
                data-testid="read-import-youtube"
                className="flex-1 py-4 text-center border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-500 dark:text-gray-400 hover:border-blue-500 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-colors"
              >
                + {ytText.entry}
              </Link>
            )}
          </div>
          {isLoggedIn && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{epubText.note}</p>
          )}
          {isLoggedIn && drive && <DrivePickHowTo />}
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
                    setGdocPrivate(false);
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
          {isLoggedIn && gdoc && drive && gdocOpen && gdocPrivate && (
            <GdocDriveImport
              key={`${gdocUrl}|${driveReturned ?? ""}`}
              url={gdocUrl}
              returned={driveReturned}
              errorText={gdocErrorText}
              onImported={(id) => router.push(`/reader/${id}`)}
            />
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

      <VirtualList
        items={materials}
        getKey={(m) => m.id}
        name="reader"
        hasMore={list.hasMore}
        loading={list.loading}
        error={list.error}
        total={list.total}
        onReachEnd={list.loadMore}
        estimateSize={76}
        gap={12}
        testId="read-list"
        empty={
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            No materials imported yet. Click the button above to get started.
          </div>
        }
        renderItem={(material) => (
          <div
            data-row-id={material.id}
            data-testid="read-row"
            className="flex items-center justify-between gap-2 p-4 pe-2 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            {renaming === material.id ? (
              <TitleEditor
                initial={material.title}
                onSave={(title) => handleRename(material.id, title)}
                onDone={() => endRename(material.id)}
              />
            ) : (
              <>
                <Link href={`/reader/${material.id}`} className="flex-1 min-w-0">
                  <h3 className="font-medium truncate" data-testid="read-row-title">
                    {material.title}
                  </h3>
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
                  <Link href={`/reader/${material.id}`} className="ms-2" tabIndex={-1}>
                    <BookRing words={material.words} />
                  </Link>
                )}
                <RowMenu
                  title={material.title}
                  onRename={() => setRenaming(material.id)}
                  onDelete={() => void handleDelete(material.id, material.title)}
                />
              </>
            )}
          </div>
        )}
      />
    </div>
  );
}
