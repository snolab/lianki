"use client";
import { useSignedIn } from "@/app/components/BoxApiBridge";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ModalSheet } from "@/app/components/ModalSheet";
import { loadAnchor } from "@/lib/read/reader-pos";
import { useIntlayer, useLocale } from "next-intlayer";
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

/** "Continue reading": a list row plus where the reading position is. */
export type LastRead = ReadMaterial & { line: number; readAt?: string };

const STORAGE_KEY = "lianki-read-materials";

/** Signed out: the text in this browser whose position moved last (its anchors). */
function lastLocal(materials: ReadMaterial[]): LastRead | null {
  let best: LastRead | null = null;
  let at = 0;
  for (const m of materials) {
    const a = loadAnchor(m.id);
    if (!a || a.at <= at) continue;
    at = a.at;
    best = {
      ...m,
      lineCount: m.lines.length,
      line: a.line,
      readAt: new Date(a.at).toISOString(),
    };
  }
  return best;
}

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
  extra,
}: {
  isLoggedIn: boolean;
  /** More entries for the Import pop-up's foot (the /vibe link where allowed). */
  extra?: ReactNode;
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
  // The Import pop-up, and the book read last ("Continue reading").
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const [last, setLast] = useState<LastRead | null>(null);
  // No pages (owner, 2026-11-10): batches as the list nears its end. Signed
  // out, the whole list is this browser's, so it comes in one batch.
  const list = useInfiniteList<ReadMaterial, number>({
    getKey: (m) => m.id,
    deps: [isLoggedIn],
    fetchBatch: async (page, size) => {
      if (!isLoggedIn) {
        const local = getLocalMaterials();
        setLast(lastLocal(local));
        return { items: local, next: null };
      }
      const p = page ?? 1;
      const res = await fetch(`/api/read?page=${p}&pageSize=${size}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        materials: ReadMaterial[];
        last?: LastRead | null;
        total: number;
        totalPages: number;
      };
      if (p === 1) setLast(data.last ?? null);
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
  const listText = useIntlayer("read-list");
  const homeText = useIntlayer("read-home");
  const { locale } = useLocale();
  const linesText = (n: number) =>
    (new Intl.PluralRules(locale).select(n) === "one"
      ? listText.linesOne.value
      : listText.linesOther.value
    ).replace("{n}", String(n));
  // The row whose title is a text field right now (row menu → Rename).
  const [renaming, setRenaming] = useState<string | null>(null);
  const [gdocOpen, setGdocOpen] = useState(false);
  const [gdocUrl, setGdocUrl] = useState("");
  const [gdocBusy, setGdocBusy] = useState(false);
  const [gdocError, setGdocError] = useState("");
  // A doc that is not shared by link: offer Google Drive instead (GdocDriveImport).
  const [gdocPrivate, setGdocPrivate] = useState(false);
  const [driveReturned, setDriveReturned] = useState<string | null>(null);

  // Back from Google's consent screen (?pick=… for Drive, ?gdoc=… for one
  // doc): the pop-up opens on it. A layout effect, so it reads the URL before
  // the children's effects clean it.
  useLayoutEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has("pick") || q.has("gdoc")) setSheetOpen(true);
  }, []);

  // An EPUB that could not be read says why inside the pop-up: open it.
  useEffect(() => {
    if (epubError) setSheetOpen(true);
  }, [epubError]);

  // Signed out, pasting text is the only way in: the pop-up opens on its form.
  const openSheet = () => {
    if (!isLoggedIn) setIsImporting(true);
    setSheetOpen(true);
  };

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
    const title = importTitle.trim() || listText.defaultTitle.value.replace("{date}", isoDay());

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
        setLast((l) => (l?.id === id ? { ...l, title: j.title! } : l));
        return true;
      } catch {
        return false;
      }
    }
    const clean = cleanTitle(title);
    if (!clean) return false;
    saveLocalMaterials(getLocalMaterials().map((m) => (m.id === id ? { ...m, title: clean } : m)));
    setMaterials((prev) => prev.map((m) => (m.id === id ? { ...m, title: clean } : m)));
    setLast((l) => (l?.id === id ? { ...l, title: clean } : l));
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
        setLast((l) => (l?.id === id ? null : l));
      } catch (err) {
        console.error("Failed to delete:", err);
      }
    } else {
      const all = getLocalMaterials();
      const updated = all.filter((m) => m.id !== id);
      saveLocalMaterials(updated);
      setMaterials((prev) => prev.filter((m) => m.id !== id));
      setLast((l) => (l?.id === id ? null : l));
    }
  };

  const errorLine = "text-sm text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]";
  const field =
    "w-full min-w-0 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-primary focus:border-transparent";
  const option = "lk-btn lk-btn-secondary w-full py-3 justify-start text-start";
  const libraryLink = books && (
    <Link
      href="/library"
      data-testid="read-browse-books"
      className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-300 hover:underline"
    >
      {booksText.browse} &rarr;
    </Link>
  );

  return (
    <div>
      {/* A compact header: the title and the one main action. */}
      <header className="mb-5 flex items-center gap-3">
        <h1 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold leading-tight">
          {listText.heading}
        </h1>
        <button
          type="button"
          data-testid="read-import"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={openSheet}
          className="lk-btn lk-btn-primary min-h-11 shrink-0 px-4"
        >
          <span aria-hidden="true">+</span> {homeText.importButton}
        </button>
      </header>

      {!isLoggedIn && (
        <section data-testid="read-welcome" className="mb-6">
          <p className="text-gray-600 dark:text-gray-400">
            {listText.intro}
            {/* No space after a full-width stop (zh, ja). */}
            {/[。！？]$/.test(String(listText.intro.value)) ? "" : " "}
            {listText.signInToSave}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link
              href="/sign-in?to=%2Freader"
              data-testid="read-sign-in"
              className="lk-btn lk-btn-secondary min-h-11 px-5"
            >
              {homeText.signIn}
            </Link>
            {libraryLink}
          </div>
        </section>
      )}

      {last && <ContinueCard last={last} label={homeText.continueHeading.value} />}

      {materials.length > 0 && (
        <h2 className="mb-2 text-sm font-semibold text-gray-600 dark:text-gray-400">
          {homeText.listHeading}
        </h2>
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
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">{listText.empty}</div>
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
                    {linesText(material.lineCount ?? material.lines.length)} &middot;{" "}
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

      {/* Every way to add something to read, in one pop-up. Its content stays
          mounted while closed: the EPUB input, the Drive return auto-pick. */}
      <ModalSheet
        open={sheetOpen}
        onClose={closeSheet}
        title={homeText.sheetTitle}
        closeLabel={homeText.close.value}
        testId="read-import-sheet"
      >
        {isImporting && (
          <form
            data-testid="read-text-form"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleImport();
            }}
          >
            <input
              type="text"
              value={importTitle}
              onChange={(e) => setImportTitle(e.target.value)}
              placeholder={listText.titlePlaceholder.value}
              aria-label={listText.titlePlaceholder.value}
              className={field}
            />
            <textarea
              data-autofocus
              autoFocus
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={listText.textPlaceholder.value}
              aria-label={listText.textPlaceholder.value}
              rows={8}
              className={`${field} resize-y font-mono text-sm`}
            />
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => {
                  setIsImporting(false);
                  setImportText("");
                  setImportTitle("");
                  if (!isLoggedIn) setSheetOpen(false);
                }}
                className="lk-btn lk-btn-quiet min-h-11"
              >
                {listText.cancel}
              </button>
              <button
                type="submit"
                disabled={!importText.trim()}
                className="lk-btn lk-btn-primary min-h-11"
              >
                {listText.submit} ({linesText(parseLinesFromContent(importText).length)})
              </button>
            </div>
            {!isLoggedIn && (
              <p className="text-xs text-gray-500 dark:text-gray-400">{homeText.signInForMore}</p>
            )}
          </form>
        )}

        {isLoggedIn && gdoc && gdocOpen && !isImporting && (
          <div className="space-y-2">
            <form
              data-testid="read-gdoc-form"
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleGdoc();
              }}
            >
              <input
                type="url"
                inputMode="url"
                data-autofocus
                autoFocus
                value={gdocUrl}
                onChange={(e) => setGdocUrl(e.target.value)}
                aria-label={gdocText.urlLabel.value}
                placeholder="https://docs.google.com/document/d/…"
                disabled={gdocBusy}
                className={field}
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
                  className="lk-btn lk-btn-quiet min-h-11"
                >
                  {gdocText.cancel}
                </button>
                <button
                  type="submit"
                  disabled={gdocBusy || !gdocUrl.trim()}
                  className="lk-btn lk-btn-primary min-h-11"
                >
                  {gdocBusy ? gdocText.importing : gdocText.submit}
                </button>
              </div>
            </form>
            <p className="text-xs text-gray-500 dark:text-gray-400">{gdocText.note}</p>
            {drive && gdocPrivate && (
              <GdocDriveImport
                key={`${gdocUrl}|${driveReturned ?? ""}`}
                url={gdocUrl}
                returned={driveReturned}
                errorText={gdocErrorText}
                onImported={(id) => router.push(`/reader/${id}`)}
              />
            )}
            {gdocError && (
              <p role="alert" data-testid="read-gdoc-error" className={errorLine}>
                {gdocError}
              </p>
            )}
          </div>
        )}

        {/* The options: hidden, not unmounted, while a form is open. */}
        <div hidden={isImporting || gdocOpen} className="flex flex-col gap-2">
          <button
            type="button"
            data-testid="read-import-text"
            onClick={() => setIsImporting(true)}
            className={option}
          >
            <span aria-hidden="true">+</span> {listText.importText}
          </button>
          {isLoggedIn && (
            <>
              <label
                data-testid="read-import-epub"
                className={`${option} focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${epubBusy ? "pointer-events-none opacity-60" : ""}`}
              >
                {epubBusy ? (
                  epubText.reading
                ) : (
                  <>
                    <span aria-hidden="true">+</span> {epubText.importEpub}
                  </>
                )}
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
              <p className="-mt-1 mb-1 text-xs text-gray-500 dark:text-gray-400">{epubText.note}</p>
              {epubError && (
                <p role="alert" data-testid="read-epub-error" className={errorLine}>
                  {epubError}
                </p>
              )}
            </>
          )}
          {isLoggedIn && gdoc && (
            <button
              type="button"
              data-testid="read-import-gdoc"
              onClick={() => setGdocOpen(true)}
              className={option}
            >
              <span aria-hidden="true">+</span> {gdocText.importGdoc}
            </button>
          )}
          {isLoggedIn && drive && (
            <>
              <DrivePick page="/reader" compact onImported={list.reload} />
              <DrivePickHowTo />
            </>
          )}
          {isLoggedIn && youtube && (
            <Link href="/reader/youtube" data-testid="read-import-youtube" className={option}>
              <span aria-hidden="true">+</span> {ytText.entry}
            </Link>
          )}
          {!isLoggedIn && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{homeText.signInForMore}</p>
          )}
          {(libraryLink || extra) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-5">
              {libraryLink}
              {extra}
            </div>
          )}
        </div>
      </ModalSheet>
    </div>
  );
}

/** Where a line sits in a text, 0–100: the first line 0, the last 100. */
function throughPct(line: number, lineCount: number): number {
  if (lineCount <= 1) return line > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((line / (lineCount - 1)) * 100)));
}

/** The book read last, reopened where it was left, with how far in. */
function ContinueCard({ last, label }: { last: LastRead; label: string }) {
  const homeText = useIntlayer("read-home");
  const pct = throughPct(last.line, last.lineCount ?? last.lines.length);
  return (
    <section aria-label={label} data-testid="read-continue" className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-gold-ink">{label}</h2>
      <Link
        href={`/reader/${last.id}`}
        data-testid="read-continue-link"
        className="flex items-center gap-3 rounded-xl bg-gold-100 p-4 text-[var(--foreground)] transition-colors hover:bg-gold-200 dark:bg-gold-950 dark:hover:bg-gold-900"
      >
        <span className="flex-1 min-w-0">
          <span className="block text-lg font-semibold leading-snug line-clamp-2">
            {last.title}
          </span>
          <span
            aria-hidden="true"
            className="mt-2 block h-1.5 overflow-hidden rounded-full bg-gold-200 dark:bg-gold-800"
          >
            <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </span>
          <span
            className="mt-1.5 block text-sm tabular-nums text-gray-700 dark:text-gray-300"
            data-testid="read-continue-pct"
          >
            {homeText.through.value.replace("{p}", String(pct))}
            {last.readAt ? ` · ${longDate(last.readAt)}` : null}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="text-2xl text-blue-600 dark:text-blue-300 rtl:-scale-x-100"
        >
          {"›"}
        </span>
      </Link>
    </section>
  );
}
