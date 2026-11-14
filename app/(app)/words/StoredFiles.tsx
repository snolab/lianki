"use client";

/**
 * The /words Import panel's "Any file" (docs/import-material.md, "Any file:
 * stored, not processed"): upload files of any type; each is kept as the
 * user's own (POST /api/import/files → R2), listed with its name, size and
 * time, and deleted on request. Stored only: nothing reads it unless the
 * user asks "Words with AI" on one file (`ai`, AiFileImport.tsx), offered
 * only behind `words.import-ai` and with credits to cover it.
 */
import { useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { formatSize } from "@lianki/debug-chat/files";
import { publicCfg } from "@/lib/config-client";
import dynamic from "next/dynamic";

// Loaded on the first "Words with AI" tap.
const AiFileImport = dynamic(() => import("./AiFileImport"), { ssr: false });

const text = (s: unknown): string =>
  typeof s === "string" ? s : String((s as { value?: unknown } | null)?.value ?? s);
const fill = (s: unknown, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), text(s));

type StoredFile = { id: string; name: string; type: string; size: number; at: number };
type ErrorKey =
  | "anyErrTooBig"
  | "anyErrDayCap"
  | "anyErrStorageCap"
  | "anyErrRate"
  | "anyErrFailed";

/** A route's error → the message key. */
export function uploadError(status: number, error: unknown): ErrorKey {
  if (error === "day-cap") return "anyErrDayCap";
  if (error === "storage-cap") return "anyErrStorageCap";
  if (status === 413) return "anyErrTooBig";
  if (status === 429) return "anyErrRate";
  return "anyErrFailed";
}

export default function StoredFiles({
  ai = false,
  onAdded,
}: {
  /** Offer "Words with AI" on each file (the gate and the user's credits allow it). */
  ai?: boolean;
  /** A list was made from a converted file (the /words picker reloads). */
  onAdded?: (listId: string) => void;
}) {
  const t = useIntlayer("words-import-panel");
  const { locale } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<{ key: ErrorKey; name: string } | null>(null);
  const [converting, setConverting] = useState<StoredFile | null>(null);

  const load = () =>
    fetch("/api/import/files", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items?: StoredFile[] }) => setFiles(b.items ?? []))
      .catch(() => setFiles([]));
  useEffect(() => {
    void load();
  }, []);

  const upload = async (list: File[]) => {
    setError(null);
    for (const f of list) {
      if (f.size > publicCfg("inbox.maxFileBytes")) {
        setError({ key: "anyErrTooBig", name: f.name });
        continue;
      }
      setBusy(f.name);
      try {
        const r = await fetch("/api/import/files", {
          method: "POST",
          headers: {
            "content-type": f.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(f.name),
          },
          body: f,
        });
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          setError({ key: uploadError(r.status, b.error), name: f.name });
          if (r.status === 429) break;
        }
      } catch {
        setError({ key: "anyErrFailed", name: f.name });
      }
    }
    setBusy(null);
    await load();
  };

  const remove = async (f: StoredFile) => {
    setBusy(f.id);
    try {
      const r = await fetch(`/api/import/files/${f.id}`, { method: "DELETE" });
      if (r.ok) {
        setFiles((fs) => fs?.filter((x) => x.id !== f.id) ?? null);
        if (converting?.id === f.id) setConverting(null);
      } else setError({ key: "anyErrFailed", name: f.name });
    } finally {
      setBusy(null);
    }
  };

  const when = (ms: number) => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        ms,
      );
    } catch {
      return new Date(ms).toISOString();
    }
  };

  return (
    <section data-qa="words-import-files-body" className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        aria-disabled={busy !== null}
        data-qa="words-import-files-drop"
        className={`rounded-xl border-2 border-dashed p-5 text-center ${busy ? "cursor-wait" : "cursor-pointer"} ${
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
          if (!busy && e.dataTransfer.files.length) void upload([...e.dataTransfer.files]);
        }}
      >
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          data-qa="words-import-files-input"
          onChange={(e) => {
            const fs = e.target.files ? [...e.target.files] : [];
            e.target.value = "";
            if (fs.length) void upload(fs);
          }}
        />
        <Icon name="uploadSimple" className="text-2xl" />
        <p className="mt-1 text-sm font-medium" aria-live="polite">
          {busy && !files?.some((f) => f.id === busy)
            ? fill(t.anyUploading, { name: busy })
            : t.anyDrop}
        </p>
        <p className="mt-1 text-xs text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]">
          {fill(t.anyLimit, { mb: Math.round(publicCfg("inbox.maxFileBytes") / (1024 * 1024)) })}
        </p>
      </div>

      {error && (
        <p
          role="alert"
          data-qa="words-import-files-error"
          className="rounded-lg bg-[oklch(0.6_0.2_25/0.12)] p-3 text-sm text-[oklch(0.42_0.16_25)] dark:text-[oklch(0.85_0.1_25)]"
        >
          {fill(t[error.key], { name: error.name })}
        </p>
      )}

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">{t.anyListTitle}</h3>
          <a href="/my/files" className="text-xs underline" data-qa="words-import-my-files">
            {t.anyAllFiles}
          </a>
        </div>
        {files && files.length === 0 && (
          <p className="mt-1 text-sm text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]">
            {t.anyEmpty}
          </p>
        )}
        <ul
          className="mt-1 divide-y divide-[oklch(0.5_0_0/0.15)]"
          data-qa="words-import-files-list"
        >
          {files?.map((f) => (
            <li key={f.id} className="flex items-center gap-3 py-2" data-qa="words-import-file">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium" title={f.name}>
                  {f.name}
                </span>
                <span className="block text-xs text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]">
                  {formatSize(f.size)} · {when(f.at)}
                </span>
              </span>
              {ai && (
                <button
                  type="button"
                  data-qa="words-import-file-ai"
                  disabled={busy !== null}
                  aria-pressed={converting?.id === f.id}
                  onClick={() => setConverting(f)}
                  className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-[oklch(0.5_0.14_155)] px-3 text-xs font-medium text-[oklch(0.4_0.12_155)] hover:bg-[oklch(0.55_0.14_155/0.12)] disabled:opacity-50 dark:text-[oklch(0.82_0.12_155)]"
                >
                  <Icon name="sparkle" />
                  {t.aiMake}
                </button>
              )}
              <button
                type="button"
                data-qa="words-import-file-delete"
                disabled={busy !== null}
                aria-label={fill(t.anyDelete, { name: f.name })}
                title={fill(t.anyDelete, { name: f.name })}
                onClick={() => void remove(f)}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-[oklch(0.5_0.18_25)] hover:bg-[oklch(0.6_0.2_25/0.1)] disabled:opacity-50 dark:text-[oklch(0.78_0.12_25)]"
              >
                <Icon name="trash" />
              </button>
            </li>
          ))}
        </ul>
        {ai && !!files?.length && (
          <p className="mt-1 text-xs text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]">
            {t.aiNote}
          </p>
        )}
      </div>

      {ai && converting && (
        <div className="border-t border-[oklch(0.5_0_0/0.15)] pt-3">
          <AiFileImport key={converting.id} file={converting} onAdded={onAdded} />
        </div>
      )}
    </section>
  );
}
