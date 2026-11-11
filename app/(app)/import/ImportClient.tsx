"use client";

import { useCallback, useRef, useState } from "react";
import JSZip from "jszip";
import { useIntlayer } from "next-intlayer";
import { authClient } from "@/lib/auth-client";
import { around, fill } from "./text";

type ParsedNote = {
  url: string;
  title: string;
  notes: string;
};

type Stage = "idle" | "parsing" | "syncing" | "done" | "error" | "auth";

/** Why an import stopped, as a key of the translated messages; the raw detail goes to the console only. */
type ImportError = "errBadFile" | "errSaveFailed" | "errFailed";

/** A failure with a known meaning; anything else is shown as the generic line. */
class ImportFailure extends Error {
  constructor(readonly kind: ImportError | "auth") {
    super(kind);
  }
}

async function parseApkgInBrowser(
  file: File,
  onProgress: (parsed: number, total: number) => void,
): Promise<{ deckName: string; notes: ParsedNote[] }> {
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer).catch((e: unknown) => {
    console.warn("[import] not a zip", e);
    throw new ImportFailure("errBadFile");
  });

  const dbFileName = zip.file("collection.anki21")
    ? "collection.anki21"
    : zip.file("collection.anki2")
      ? "collection.anki2"
      : null;
  if (!dbFileName) {
    console.warn("[import] no collection database in the .apkg");
    throw new ImportFailure("errBadFile");
  }

  const dbData = await zip.file(dbFileName)!.async("uint8array");

  // dynamically import sql.js (browser build) to avoid SSR issues
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  let db: InstanceType<typeof SQL.Database>;
  try {
    db = new SQL.Database(dbData);
  } catch (e) {
    console.warn("[import] unreadable collection", e);
    throw new ImportFailure("errBadFile");
  }

  try {
    const colResult = db.exec("SELECT models, decks FROM col LIMIT 1");
    if (!colResult.length) {
      console.warn("[import] empty col table");
      throw new ImportFailure("errBadFile");
    }

    const modelsJson = JSON.parse(colResult[0].values[0][0] as string);
    const decksJson = JSON.parse(colResult[0].values[0][1] as string);

    const deckEntries = Object.values(decksJson) as Array<{ name: string }>;
    const mainDeck = deckEntries.find((d) => d.name !== "Default") || deckEntries[0];
    const deckName = mainDeck?.name || "Imported Deck";

    const modelMap = new Map<string, { name: string; fields: string[] }>();
    for (const [mid, model] of Object.entries(modelsJson) as Array<[string, any]>) {
      const fields = (model.flds as Array<{ name: string }>).map((f) => f.name);
      modelMap.set(mid, { name: model.name, fields });
    }

    const notesResult = db.exec("SELECT id, mid, flds, tags FROM notes");
    if (!notesResult.length) return { deckName, notes: [] };

    const rows = notesResult[0].values;
    const notes: ParsedNote[] = [];
    for (let i = 0; i < rows.length; i++) {
      const [id, mid, flds, tags] = rows[i];
      const model = modelMap.get(String(mid));
      if (!model) continue;

      const fieldValues = (flds as string).split("\x1f");
      const fields: Record<string, string> = {};
      for (let j = 0; j < model.fields.length; j++) {
        fields[model.fields[j]] = fieldValues[j] || "";
      }
      const title = Object.values(fields).slice(0, 2).join(" — ").slice(0, 200);

      notes.push({
        url: `lianki://anki-import/${encodeURIComponent(deckName)}/${id}`,
        title,
        notes: `[anki] ${model.name}${(tags as string).trim() ? " | " + (tags as string).trim() : ""}`,
      });

      if (i % 50 === 0) onProgress(i, rows.length);
    }
    onProgress(rows.length, rows.length);
    return { deckName, notes };
  } catch (e) {
    if (e instanceof ImportFailure) throw e;
    console.warn("[import] could not read the deck", e);
    throw new ImportFailure("errBadFile");
  } finally {
    db.close();
  }
}

const BATCH_SIZE = 50;

async function syncBatches(
  notes: ParsedNote[],
  onProgress: (synced: number, total: number) => void,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (let i = 0; i < notes.length; i += BATCH_SIZE) {
    const batch = notes.slice(i, i + BATCH_SIZE);
    const res = await fetch("/api/import/anki-client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cards: batch }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new ImportFailure("auth");
      console.warn("[import] save failed", res.status, await res.text().catch(() => ""));
      throw new ImportFailure("errSaveFailed");
    }
    const data = await res.json();
    imported += data.imported;
    skipped += data.skipped;
    onProgress(Math.min(i + BATCH_SIZE, notes.length), notes.length);
  }
  return { imported, skipped };
}

export default function ImportClient() {
  const t = useIntlayer("import-page");
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [parseProgress, setParseProgress] = useState({ done: 0, total: 0 });
  const [syncProgress, setSyncProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{
    deckName: string;
    imported: number;
    skipped: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<ImportError | "wrongType" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File) => {
    if (!f.name.endsWith(".apkg")) {
      setError("wrongType");
      return;
    }
    setFile(f);
    setError(null);
    setResult(null);
    setStage("idle");
  }, []);

  const handleImport = async () => {
    if (!file) return;
    setError(null);
    setResult(null);
    setStage("parsing");
    setParseProgress({ done: 0, total: 0 });
    setSyncProgress({ done: 0, total: 0 });

    try {
      const { deckName, notes } = await parseApkgInBrowser(file, (done, total) =>
        setParseProgress({ done, total }),
      );

      setStage("syncing");
      setSyncProgress({ done: 0, total: notes.length });

      const { imported, skipped } = await syncBatches(notes, (done, total) =>
        setSyncProgress({ done, total }),
      );

      setResult({ deckName, imported, skipped, total: notes.length });
      setStage("done");
      setFile(null);
    } catch (err) {
      const kind = err instanceof ImportFailure ? err.kind : "errFailed";
      if (!(err instanceof ImportFailure)) console.warn("[import] failed", err);
      if (kind === "auth") {
        setStage("auth");
      } else {
        setError(kind);
        setStage("error");
      }
    }
  };

  const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold mb-4">{t.title}</h1>
        <p className="text-lg mb-8 text-gray-600 dark:text-gray-400">{t.description}</p>

        {/* Drop zone */}
        <div
          className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors cursor-pointer ${
            isDragging
              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
              : "border-gray-300 dark:border-gray-700 hover:border-gray-400"
          }`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".apkg"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          {file ? (
            <div>
              <div className="text-lg font-medium">{file.name}</div>
              <div className="text-sm text-gray-500 mt-1">
                {fill(t.sizeMb, { n: (file.size / 1024 / 1024).toFixed(2) })}
              </div>
            </div>
          ) : (
            <div>
              <div className="text-lg text-gray-500 mb-2">{t.dropzone}</div>
              <div className="text-sm text-gray-400">{t.maxSize}</div>
            </div>
          )}
        </div>

        {/* Import button */}
        {file && stage === "idle" && (
          <button
            onClick={handleImport}
            className="w-full mt-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            {t.importButton}
          </button>
        )}

        {/* Parsing progress */}
        {stage === "parsing" && (
          <div className="mt-6">
            <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400 mb-2">
              <span>{t.parsing}</span>
              <span>
                {parseProgress.done} / {parseProgress.total || "?"}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${pct(parseProgress.done, parseProgress.total)}%` }}
              />
            </div>
          </div>
        )}

        {/* Sync progress */}
        {stage === "syncing" && (
          <div className="mt-6">
            <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400 mb-2">
              <span>{t.syncing}</span>
              <span>
                {syncProgress.done} / {syncProgress.total}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-600 dark:bg-blue-400 h-2 rounded-full transition-all"
                style={{ width: `${pct(syncProgress.done, syncProgress.total)}%` }}
              />
            </div>
          </div>
        )}

        {/* Auth required — show sign-in tiles */}
        {stage === "auth" && (
          <div className="mt-6 p-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg">
            <p className="text-yellow-800 dark:text-yellow-200 font-medium mb-4">
              {t.signInToSave}
            </p>
            <div className="space-y-3">
              <button
                onClick={() =>
                  authClient.signIn.social({
                    provider: "github",
                    callbackURL: window.location.pathname,
                  })
                }
                className="w-full px-6 py-2 bg-gray-900 text-white rounded hover:bg-gray-700 font-medium"
              >
                {t.signInGithub}
              </button>
              <button
                onClick={() =>
                  authClient.signIn.social({
                    provider: "google",
                    callbackURL: window.location.pathname,
                  })
                }
                className="w-full px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium"
              >
                {t.signInGoogle}
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
            {t[error]}
          </div>
        )}

        {/* Result */}
        {result && stage === "done" && (
          <div className="mt-4 p-6 bg-green-50 dark:bg-green-900/20 rounded-lg">
            <h2 className="text-xl font-semibold text-green-700 dark:text-green-400 mb-2">
              {t.importComplete}
            </h2>
            <div className="space-y-1 text-sm">
              <div>
                {around(t.resultDeck, "name")[0]}
                <strong>{result.deckName}</strong>
                {around(t.resultDeck, "name")[1]}
              </div>
              <div>{fill(t.resultImported, { n: result.imported })}</div>
              {result.skipped > 0 && <div>{fill(t.resultSkipped, { n: result.skipped })}</div>}
              <div>{fill(t.resultTotal, { n: result.total })}</div>
            </div>
            <a
              href="/list"
              className="inline-block mt-4 px-4 py-2 bg-primary text-on-primary rounded hover:bg-blue-700 text-sm"
            >
              {t.viewDashboard}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
