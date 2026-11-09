"use client";

/**
 * The /words Import panel's "Any file" (docs/import-material.md, "Any file:
 * stored, not processed"): upload files of any type; each is kept as the
 * user's own (POST /api/import/files → R2), listed with its name, size and
 * time, and deleted on request. Nothing reads or converts it yet.
 */
import { useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { formatSize } from "@lianki/debug-chat/files";
import { INBOX } from "@/lib/inbox/config";

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

export default function StoredFiles() {
  const t = useIntlayer("words-import-panel");
  const { locale } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<{ key: ErrorKey; name: string } | null>(null);

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
      if (f.size > INBOX.maxFileBytes) {
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
      if (r.ok) setFiles((fs) => fs?.filter((x) => x.id !== f.id) ?? null);
      else setError({ key: "anyErrFailed", name: f.name });
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
          {fill(t.anyLimit, { mb: Math.round(INBOX.maxFileBytes / (1024 * 1024)) })}
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
        <h3 className="text-sm font-medium">{t.anyListTitle}</h3>
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
      </div>
    </section>
  );
}
