"use client";

/**
 * The /words Import panel's third source, "AI: any file"
 * (docs/import-material.md, "AI: any file"). A file is read on this device
 * (lib/import/ai-read.ts: the self-intro import's parsers and the .xlsx
 * reader); only its text and shrunk images go to POST /api/import/ai, which
 * answers the word-list CSV template (lib/import/ai-convert.ts). The CSV is
 * shown here, editable and downloadable, and goes through the CSV import's
 * own check, preview and "Add N words" (`WordListImport seed`).
 */
import { useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { readAnyFile } from "@/lib/import/ai-read";
import { ImportFileError } from "@/lib/self-intro/import-parse";
import { shrinkImage } from "@/lib/self-intro/shrink-image";
import WordListImport from "../import/WordListImport";

const text = (s: unknown): string =>
  typeof s === "string" ? s : String((s as { value?: unknown } | null)?.value ?? s);
const fill = (s: unknown, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), text(s));

type ErrorKey =
  | "aiErrTooLarge"
  | "aiErrUnsupported"
  | "aiErrUnreadable"
  | "aiErrEmpty"
  | "aiErrNothing"
  | "aiErrFailed"
  | "aiErrCredits"
  | "aiErrPaused"
  | "aiErrRate";

const FILE_ERROR: Record<ImportFileError["code"], ErrorKey> = {
  "too-large": "aiErrTooLarge",
  unsupported: "aiErrUnsupported",
  unreadable: "aiErrUnreadable",
  empty: "aiErrEmpty",
};

/** A route answer's error → the message key. */
function routeError(status: number, error: unknown): ErrorKey {
  if (status === 402) return "aiErrCredits";
  if (status === 503 && error === "credits-paused") return "aiErrPaused";
  if (status === 429) return "aiErrRate";
  if (status === 413) return "aiErrTooLarge";
  if (error === "nothing-found") return "aiErrNothing";
  if (error === "empty") return "aiErrEmpty";
  return "aiErrFailed";
}

/** Save the CSV as a file: UTF-8 with a BOM, so Excel opens any script correctly. */
function download(csv: string, name: string) {
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The top-up page (TOP_UP_PATH in lib/payments/metered.ts, a server module). */
const TOP_UP = "/membership";

/** The CSV's file name: the picked file's, with .csv (also the list's default name). */
const csvNameOf = (name: string) => `${name.replace(/\.[^.]{1,5}$/, "") || "lianki-words"}.csv`;

type Result = { csv: string; rows: number; truncated: boolean; charged: number };

export default function AiFileImport({ onAdded }: { onAdded?: (listId: string) => void }) {
  const t = useIntlayer("words-import-panel");
  const { locale } = useLocale();
  const n = (v: number) => v.toLocaleString(locale);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<"idle" | "reading" | "converting">("idle");
  const [error, setError] = useState<{ key: ErrorKey; need?: number; balance?: number } | null>(
    null,
  );
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [csv, setCsv] = useState("");
  const [seed, setSeed] = useState<{ text: string; fileName: string; rev: number } | null>(null);

  const onFile = async (f: File) => {
    setError(null);
    setResult(null);
    setSeed(null);
    setFileName(f.name);
    setPhase("reading");
    try {
      const payload = await readAnyFile(f, { shrinkImage });
      setPhase("converting");
      const r = await fetch("/api/import/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: payload.text,
          images: payload.images,
          locale,
          fileName: f.name.slice(0, 200),
        }),
      });
      const b = (await r.json().catch(() => ({}))) as Partial<Result> & {
        error?: string;
        need?: number;
        balance?: number;
      };
      if (!r.ok || typeof b.csv !== "string") {
        setError({ key: routeError(r.status, b.error), need: b.need, balance: b.balance });
        return;
      }
      const res: Result = {
        csv: b.csv,
        rows: b.rows ?? 0,
        truncated: !!(b.truncated || payload.truncated),
        charged: b.charged ?? 0,
      };
      setResult(res);
      setCsv(res.csv);
      setSeed({ text: res.csv, fileName: csvNameOf(f.name), rev: 1 });
    } catch (e) {
      setError({ key: e instanceof ImportFileError ? FILE_ERROR[e.code] : "aiErrFailed" });
    } finally {
      setPhase("idle");
    }
  };

  const busy = phase !== "idle";
  return (
    <section data-qa="words-import-ai-body" className="space-y-4">
      <div
        role="button"
        tabIndex={0}
        aria-disabled={busy}
        data-qa="words-import-ai-drop"
        className={`rounded-xl border-2 border-dashed p-6 text-center ${busy ? "cursor-wait" : "cursor-pointer"} ${
          dragging
            ? "border-[oklch(0.5_0.14_155)] bg-[oklch(0.55_0.14_155/0.1)]"
            : "border-[oklch(0.5_0_0/0.3)] hover:border-[oklch(0.5_0_0/0.55)]"
        }`}
        onClick={() => !busy && input.current?.click()}
        onKeyDown={(e) => {
          if (!busy && (e.key === "Enter" || e.key === " ")) input.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f && !busy) void onFile(f);
        }}
      >
        <input
          ref={input}
          type="file"
          className="hidden"
          data-qa="words-import-ai-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void onFile(f);
          }}
        />
        <Icon name="uploadSimple" className="text-2xl" />
        <p className="mt-1 text-sm font-medium" aria-live="polite">
          {phase === "reading"
            ? t.aiReading
            : phase === "converting"
              ? t.aiConverting
              : fileName || t.aiDrop}
        </p>
        <p className="mt-1 text-xs text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]">
          {t.aiPrivacy}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          data-qa="words-import-ai-error"
          className="rounded-lg bg-[oklch(0.6_0.2_25/0.12)] p-3 text-sm text-[oklch(0.42_0.16_25)] dark:text-[oklch(0.85_0.1_25)]"
        >
          <p>
            {fill(t[error.key], {
              need: n(error.need ?? 0),
              balance: n(error.balance ?? 0),
            })}
          </p>
          {error.key === "aiErrCredits" && (
            <a href={TOP_UP} className="mt-1 inline-block font-medium underline">
              {t.aiGetCredits}
            </a>
          )}
        </div>
      )}

      {result && seed && (
        <div className="space-y-2" data-qa="words-import-ai-result">
          <p className="text-xs text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]">
            {fill(t.aiMade, { n: n(result.rows), credits: n(result.charged) })}
            {result.truncated && <> {t.aiTruncated}</>}
          </p>
          <label className="block text-sm font-medium" htmlFor="words-import-ai-csv">
            {t.aiCsvLabel}
          </label>
          <textarea
            id="words-import-ai-csv"
            data-qa="words-import-ai-csv"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={8}
            spellCheck={false}
            className="w-full rounded-lg border border-[oklch(0.5_0_0/0.3)] bg-[oklch(1_0_0)] p-3 font-mono text-xs dark:bg-[oklch(0.22_0_0)]"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-qa="words-import-ai-download"
              onClick={() => download(csv, seed.fileName)}
              className="min-h-11 rounded-lg border border-[oklch(0.5_0.14_155)] px-4 text-sm font-medium text-[oklch(0.4_0.12_155)] hover:bg-[oklch(0.55_0.14_155/0.12)] dark:text-[oklch(0.82_0.12_155)]"
            >
              ⬇ {t.aiDownload}
            </button>
            <button
              type="button"
              data-qa="words-import-ai-recheck"
              disabled={csv === seed.text}
              onClick={() => setSeed({ text: csv, fileName: seed.fileName, rev: seed.rev + 1 })}
              className="min-h-11 rounded-lg bg-[oklch(0.3_0_0)] px-4 text-sm font-medium text-[oklch(0.98_0_0)] disabled:opacity-50 dark:bg-[oklch(0.92_0_0)] dark:text-[oklch(0.2_0_0)]"
            >
              {t.aiCheckAgain}
            </button>
          </div>
          <WordListImport signedIn embedded seed={seed} onAdded={onAdded} />
        </div>
      )}
    </section>
  );
}
