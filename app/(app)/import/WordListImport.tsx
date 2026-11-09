"use client";

/**
 * /import (and the Import panel on /words) → a .txt/.csv/.tsv/.xlsx word list
 * (file or paste) → a new /words list (docs/import-material.md, M1). An .xlsx
 * is read here (lib/import/xlsx.ts, first sheet) and goes on as CSV text, so
 * the server sees one format and keeps its limits. Templates with the header
 * row in the user's language are made on the click (lib/import/template.ts). The text is parsed here first, so a wrong
 * file is caught at once; the server parses it again for the preview counts
 * (new / already have / skipped) and for the import itself, which runs as a
 * job (lib/import/words-handler.ts). Nothing is saved before "Add N words".
 *
 * `seed`: the CSV "Words with AI" made from a stored file (app/(app)/words/AiFileImport.tsx)
 * goes through this same check, preview and add; the templates and the file
 * and paste inputs are then left out (that source has its own).
 * A table (CSV, TSV, a sheet) gets a column-mapping step first
 * (ColumnMapper, lib/import/column-map.ts): its columns as chips on the
 * fields they fill, set from the header names, and the first rows as the
 * /words cards they become, live. The mapping goes with the preview and the
 * commit, so the server parses exactly what the cards show.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ColumnMapper, CardPreview } from "./ColumnMapper";
import type { ColumnMapping } from "@/lib/import/column-map";
import { useIntlayer, useLocale } from "next-intlayer";
import {
  MAX_BYTES,
  MAX_WORDS,
  WordListError,
  listNameFrom,
  parseWordList,
  tableShape,
  type TableShape,
} from "@/lib/import/wordlist";
import type { JobRow, PreviewAnswer } from "@/lib/import/words-handler";
import { IMPORT_LANGS } from "@/lib/words/anki";
import { TEMPLATE_FILE, templateCsv, templateXlsx } from "@/lib/import/template";
import { XlsxError, readXlsx, rowsToCsv } from "@/lib/import/xlsx";
import { downloadCatalog } from "@/lib/words/catalog-cache";

const text = (s: unknown): string =>
  typeof s === "string" ? s : String((s as { value?: unknown } | null)?.value ?? s);
const fill = (s: unknown, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), text(s));

type Source = { text: string; fileName: string };
type Done = { listId: string; added: number; name: string };
type ErrorKey =
  | "errEmpty"
  | "errBinary"
  | "errTooLarge"
  | "errEncoding"
  | "errXls"
  | "errXlsx"
  | "errNothingNew"
  | "errRate"
  | "errSignIn"
  | "errFailed";

const ERROR_OF: Record<string, ErrorKey> = {
  empty: "errEmpty",
  binary: "errBinary",
  "too-large": "errTooLarge",
  "nothing-new": "errNothingNew",
  "rate-limited": "errRate",
  unauthorized: "errSignIn",
};

/** A file's text, or the error key: too large, or not UTF-8. */
async function readFile(f: File): Promise<string | ErrorKey> {
  if (f.size > MAX_BYTES) return "errTooLarge";
  const bytes = await f.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // A NUL in the first bytes is binary (an image, a zip), not a text encoding.
    return new Uint8Array(bytes.slice(0, 512)).includes(0) ? "errBinary" : "errEncoding";
  }
}

/** A spreadsheet by its name: read as a workbook, not as text. */
const isSheet = (name: string) => /\.xlsx?$/i.test(name);

/** An .xlsx's first sheet as CSV text, or the error key. */
async function readSheet(f: File): Promise<string | ErrorKey> {
  try {
    return rowsToCsv(await readXlsx(await f.arrayBuffer()));
  } catch (e) {
    const code = e instanceof XlsxError ? e.code : null;
    return code === "xls"
      ? "errXls"
      : code === "too-large"
        ? "errTooLarge"
        : code === "empty"
          ? "errEmpty"
          : "errXlsx";
  }
}

/** Save bytes as a file (the template downloads). */
function saveFile(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function WordListImport({
  signedIn,
  embedded = false,
  onAdded,
  seed,
}: {
  signedIn: boolean;
  /** Inside the /words Import panel: no section heading or top margin. */
  embedded?: boolean;
  /** A list was made (the /words picker reloads its lists). */
  onAdded?: (listId: string) => void;
  /** A ready CSV to check at once (a new `rev` checks it again, after an edit). */
  seed?: { text: string; fileName: string; rev: number };
}) {
  const t = useIntlayer("import-wordlist");
  const { locale } = useLocale();
  const n = (v: number) => v.toLocaleString(locale);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [paste, setPaste] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [preview, setPreview] = useState<PreviewAnswer | null>(null);
  const [name, setName] = useState("");
  const [lang, setLang] = useState("");
  const [busy, setBusy] = useState<"checking" | "adding" | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  /** The table's columns (null for a plain list) and the user's mapping of them. */
  const [shape, setShape] = useState<TableShape | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [headerOn, setHeaderOn] = useState(false);
  /** What the preview counts were asked for, so a moved chip asks again. */
  const asked = useRef("");

  const langName = useMemo(() => {
    try {
      const names = new Intl.DisplayNames([locale], { type: "language" });
      return (code: string) => names.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, [locale]);

  const loadJobs = () =>
    fetch("/api/import/jobs")
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((b: { jobs?: JobRow[] }) => setJobs(b.jobs ?? []))
      .catch(() => {});
  useEffect(() => {
    if (signedIn) loadJobs();
  }, [signedIn]);
  useEffect(() => {
    if (seed && signedIn) void check({ text: seed.text, fileName: seed.fileName });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a new seed only
  }, [seed?.rev, signedIn]);

  const reset = () => {
    setShape(null);
    setMapping(null);
    asked.current = "";
    setSource(null);
    setPreview(null);
    setError(null);
    setDone(null);
    setPaste("");
    setName("");
    setLang("");
  };

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/import/words", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(b?.error ?? "failed"));
    return b;
  };

  const check = async (src: Source) => {
    setError(null);
    setDone(null);
    setPreview(null);
    // Caught here at once; the server says the same.
    let sh: TableShape;
    try {
      sh = tableShape(src.text, src.fileName);
    } catch (e) {
      setError(e instanceof WordListError ? (ERROR_OF[e.code] ?? "errFailed") : "errFailed");
      return;
    }
    const table = sh.format !== "lines";
    setShape(table ? sh : null);
    setMapping(table ? sh.defaults : null);
    setHeaderOn(sh.header);
    setSource(src);
    setBusy("checking");
    try {
      const how = table ? { mapping: sh.defaults, header: sh.header } : {};
      asked.current = JSON.stringify(how);
      const p = (await post({ step: "preview", ...src, ...how })) as PreviewAnswer;
      setPreview(p);
      setName(listNameFrom(src.fileName) || text(t.pastedName));
      setLang(p.lang);
    } catch (e) {
      setError(ERROR_OF[(e as Error).message] ?? "errFailed");
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (f: File) => {
    const read = isSheet(f.name) ? await readSheet(f) : await readFile(f);
    if (
      read === "errTooLarge" ||
      read === "errBinary" ||
      read === "errEncoding" ||
      read === "errXls" ||
      read === "errXlsx" ||
      read === "errEmpty"
    ) {
      setPreview(null);
      setDone(null);
      setError(read);
      return;
    }
    await check({ text: read, fileName: f.name });
  };

  /** The mapping step's answer, as the server takes it; nothing for a plain list. */
  const how = () => (shape && mapping ? { mapping, header: headerOn } : {});

  // A moved chip or the header switch: the counts again, once the chips rest.
  useEffect(() => {
    if (!source || !shape || !mapping || busy) return;
    const key = JSON.stringify({ mapping, header: headerOn });
    if (key === asked.current) return;
    const timer = setTimeout(async () => {
      asked.current = key;
      try {
        setPreview(
          (await post({ step: "preview", ...source, mapping, header: headerOn })) as PreviewAnswer,
        );
      } catch (e) {
        setError(ERROR_OF[(e as Error).message] ?? "errFailed");
      }
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- post and source are stable per file
  }, [mapping, headerOn, source, shape, busy]);

  /** The first rows as the cards will hold them, from this page's own parse. */
  const cards = useMemo(() => {
    if (!source) return [];
    try {
      return parseWordList(
        source.text,
        source.fileName,
        shape && mapping ? { mapping, header: headerOn } : {},
      ).rows.slice(0, 4);
    } catch {
      return [];
    }
  }, [source, shape, mapping, headerOn]);

  const commit = async () => {
    if (!source || !preview || !lang || !name.trim()) return;
    if (mapping && !mapping.term.length) return;
    setBusy("adding");
    setError(null);
    try {
      const b = await post({ step: "commit", ...source, ...how(), name: name.trim(), lang });
      setDone({ listId: b.listId, added: b.added, name: name.trim() });
      setPreview(null);
      onAdded?.(b.listId);
      // This device's copy of the list's words, so /words opens with them.
      await downloadCatalog(`/api/words/lists/${b.listId}/entries`).catch(() => {});
    } catch (e) {
      setError(ERROR_OF[(e as Error).message] ?? "errFailed");
    } finally {
      setBusy(null);
      loadJobs();
    }
  };

  const langs: string[] = (IMPORT_LANGS as readonly string[]).includes(lang)
    ? [...IMPORT_LANGS]
    : lang
      ? [lang, ...IMPORT_LANGS]
      : [...IMPORT_LANGS];
  const why = preview
    ? (
        [
          ["duplicate", t.whyDuplicate],
          ["no-term", t.whyNoTerm],
          ["too-long", t.whyTooLong],
          ["over-limit", t.whyOverLimit],
        ] as const
      ).filter(([k]) => preview.skippedBy[k] > 0)
    : [];

  return (
    <section className={embedded ? "" : "mt-10"} data-qa="wordlist-import">
      {!embedded && <h2 className="text-2xl font-bold mb-2">{t.heading}</h2>}
      {!seed && <p className="text-sm mb-4 text-gray-600 dark:text-gray-300">{t.intro}</p>}

      {/* The templates first: fill one in and nobody thinks about column names. */}
      <div
        hidden={!!seed}
        data-qa="wordlist-templates"
        className="mb-4 rounded-xl border border-[oklch(0.55_0.14_155/0.45)] bg-[oklch(0.55_0.14_155/0.08)] p-3"
      >
        <p className="text-sm font-medium">{t.templateHeading}</p>
        <p className="mt-0.5 text-xs text-[oklch(0.4_0_0)] dark:text-[oklch(0.82_0_0)]">
          {t.templateHint}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            data-qa="wordlist-template-xlsx"
            onClick={async () =>
              saveFile(
                (await templateXlsx(locale)) as BlobPart,
                `${TEMPLATE_FILE}.xlsx`,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              )
            }
            className="min-h-11 rounded-lg bg-[oklch(0.5_0.14_155)] px-4 text-sm font-medium text-[oklch(0.99_0_0)] hover:bg-[oklch(0.45_0.14_155)]"
          >
            ⬇ {t.templateXlsx}
          </button>
          <button
            type="button"
            data-qa="wordlist-template-csv"
            onClick={() =>
              saveFile(templateCsv(locale), `${TEMPLATE_FILE}.csv`, "text/csv;charset=utf-8")
            }
            className="min-h-11 rounded-lg border border-[oklch(0.5_0.14_155)] px-4 text-sm font-medium text-[oklch(0.4_0.12_155)] hover:bg-[oklch(0.55_0.14_155/0.12)] dark:text-[oklch(0.82_0.12_155)]"
          >
            ⬇ {t.templateCsv}
          </button>
        </div>
      </div>

      {!signedIn ? (
        <p className="text-sm p-3 rounded-lg bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {t.errSignIn}
        </p>
      ) : done ? (
        <div className="p-4 rounded-lg bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100">
          <p className="font-medium" data-qa="wordlist-done">
            {fill(t.done, { n: n(done.added), name: done.name })}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <a
              href={`/words?list=${done.listId}`}
              className="px-4 py-2 rounded-lg bg-green-700 text-white hover:bg-green-800 text-sm font-medium"
            >
              {t.open}
            </a>
            {!seed && (
              <button type="button" onClick={reset} className="px-4 py-2 text-sm underline">
                {t.another}
              </button>
            )}
          </div>
        </div>
      ) : seed ? (
        busy === "checking" && <p className="text-sm">{t.checking}</p>
      ) : (
        <>
          <div
            role="button"
            tabIndex={0}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              dragging
                ? "border-blue-600 bg-blue-50 dark:bg-blue-950"
                : "border-gray-300 dark:border-gray-600 hover:border-gray-500"
            }`}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
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
              if (f) onFile(f);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".txt,.csv,.tsv,.xlsx,.xls,text/plain,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="hidden"
              data-qa="wordlist-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) onFile(f);
              }}
            />
            <div className="text-gray-700 dark:text-gray-200">
              {source?.fileName || text(t.drop)}
            </div>
            <div className="text-xs mt-1 text-gray-600 dark:text-gray-400">
              {fill(t.limits, { mb: MAX_BYTES / 1_000_000, max: n(MAX_WORDS) })}
            </div>
          </div>

          <label className="block mt-4 text-sm font-medium" htmlFor="wordlist-paste">
            {t.paste}
          </label>
          <textarea
            id="wordlist-paste"
            data-qa="wordlist-paste"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={text(t.pastePlaceholder)}
            rows={4}
            className="mt-1 w-full p-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 font-mono text-sm"
          />
          <button
            type="button"
            data-qa="wordlist-preview"
            disabled={!paste.trim() || busy !== null}
            onClick={() => check({ text: paste, fileName: "" })}
            className="mt-2 px-4 py-2 rounded-lg bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-900 text-sm font-medium disabled:opacity-50"
          >
            {busy === "checking" ? t.checking : t.preview}
          </button>
        </>
      )}

      {error && (
        <div
          role="alert"
          data-qa="wordlist-error"
          className="mt-4 p-3 rounded-lg bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-100 text-sm"
        >
          <p>{fill(t[error], { mb: MAX_BYTES / 1_000_000 })}</p>
          {source && !seed && (
            <button type="button" onClick={reset} className="mt-2 underline">
              {t.another}
            </button>
          )}
        </div>
      )}

      {preview && !done && (
        <div className="mt-6" data-qa="wordlist-preview-box">
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="px-2 py-1 rounded bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-50">
              {fill(t.countNew, { n: n(preview.fresh) })}
            </span>
            <span className="px-2 py-1 rounded bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-50">
              {fill(t.countHave, { n: n(preview.have) })}
            </span>
            {preview.skipped > 0 && (
              <span className="px-2 py-1 rounded bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-50">
                {fill(t.countSkipped, { n: n(preview.skipped) })}
              </span>
            )}
          </div>
          {why.length > 0 && (
            <ul className="mt-2 text-xs list-disc pl-5 text-gray-700 dark:text-gray-300">
              {why.map(([k, s]) => (
                <li key={k}>{fill(s, { n: n(preview.skippedBy[k]), max: n(MAX_WORDS) })}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
            {preview.format === "lines"
              ? t.formatLines
              : preview.header
                ? t.headerFound
                : t.headerNone}
          </p>

          {shape && mapping && (
            <>
              <label className="mt-4 flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-qa="wordlist-header"
                  checked={headerOn}
                  onChange={(e) => setHeaderOn(e.target.checked)}
                  className="size-4 accent-[var(--brand)]"
                />
                {t.firstRowHeader}
              </label>
              <ColumnMapper
                names={headerOn ? shape.first : null}
                samples={(headerOn ? shape.rows[0] : shape.first) ?? []}
                width={shape.width}
                mapping={mapping}
                onChange={setMapping}
              />
            </>
          )}
          <CardPreview rows={cards} lang={lang || undefined} />

          {preview.fresh > 0 ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="block font-medium">{t.listName}</span>
                <input
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full p-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                />
              </label>
              <label className="text-sm">
                <span className="block font-medium">{t.language}</span>
                <select
                  value={lang}
                  data-qa="wordlist-lang"
                  onChange={(e) => setLang(e.target.value)}
                  className="mt-1 w-full p-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                >
                  {!lang && <option value="">{text(t.chooseLang)}</option>}
                  {langs.map((l) => (
                    <option key={l} value={l}>
                      {langName(l)} ({l})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                data-qa="wordlist-add"
                disabled={
                  busy !== null || !lang || !name.trim() || (!!mapping && !mapping.term.length)
                }
                onClick={commit}
                className="sm:col-span-2 py-3 rounded-lg bg-blue-700 text-white hover:bg-blue-800 font-medium disabled:opacity-50"
              >
                {busy === "adding" ? t.adding : fill(t.add, { n: n(preview.fresh) })}
              </button>
            </div>
          ) : (
            <p className="mt-4 text-sm">{t.errNothingNew}</p>
          )}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.recent}</h3>
          <ul className="mt-1 text-sm divide-y divide-gray-200 dark:divide-gray-700">
            {jobs.map((j) => {
              const added = j.status === "done" ? safeAdded(j.note) : null;
              return (
                <li key={j.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium break-all">{j.name}</span>
                  <span className="text-gray-600 dark:text-gray-400">
                    {j.status === "done"
                      ? fill(t.jobAdded, { n: n(added ?? 0) })
                      : j.status === "failed"
                        ? t.jobFailed
                        : t.adding}
                  </span>
                  {j.status === "done" && j.result_ref && (
                    <a href={`/words?list=${j.result_ref}`} className="underline">
                      {t.open}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function safeAdded(note: string | null): number | null {
  try {
    const v = JSON.parse(note ?? "null")?.added;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}
