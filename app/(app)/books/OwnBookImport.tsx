"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";

/**
 * "Import your own book" on /books (lib/books/own-import.ts): the picked file
 * is stored in My Files (folder Books, private to the user), then the server
 * reads it (no AI, no credits) and the book opens in the reader.
 */
export function OwnBookImport({ accept, maxBytes }: { accept: string; maxBytes: number }) {
  const t = useIntlayer("my-books");
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mb = Math.round(maxBytes / (1024 * 1024));

  const reason = (code: string | undefined, status: number): string => {
    if (code === "too-big" || code === "too-large" || code === "too-much-text" || status === 413)
      return code === "day-cap" || code === "storage-cap"
        ? t.errStorage.value
        : code === "too-much-text"
          ? t.errTooMuch.value
          : t.errTooLarge.value.replace("{mb}", String(mb));
    if (code === "drm") return t.errDrm.value;
    if (code === "no-text") return t.errNoText.value;
    if (code === "unsupported" || code === "not-epub") return t.errUnsupported.value;
    if (code === "rate-limited" || status === 429) return t.errBusy.value;
    return t.errFailed.value;
  };

  const pick = async (file: File) => {
    setError("");
    if (file.size > maxBytes) {
      setError(t.errTooLarge.value.replace("{mb}", String(mb)));
      return;
    }
    setBusy(true);
    try {
      const up = await fetch("/api/import/files?source=books", {
        method: "POST",
        headers: {
          "x-file-name": encodeURIComponent(file.name),
          "content-type": file.type || "application/octet-stream",
        },
        body: file,
      });
      const stored = (await up.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!up.ok || !stored?.id) {
        setError(reason(stored?.error, up.status));
        return;
      }
      const res = await fetch("/api/books/mine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: stored.id }),
      });
      const book = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!res.ok || !book?.id) {
        setError(reason(book?.error, res.status));
        return;
      }
      router.push(`/reader/${encodeURIComponent(book.id)}`);
    } catch {
      setError(t.errFailed.value);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <section className="mt-6" data-testid="my-books-import">
      <label
        className={`flex items-center justify-center gap-2 py-4 cursor-pointer border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:border-blue-500 hover:text-blue-700 dark:hover:border-blue-400 dark:hover:text-blue-300 transition-colors ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        <Icon name="uploadSimple" />
        {busy ? t.importing : t.importButton}
        <input
          ref={input}
          type="file"
          accept={accept}
          className="sr-only"
          disabled={busy}
          data-testid="my-books-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
          }}
        />
      </label>
      <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
        {t.importNote.value.replace("{mb}", String(mb))}
      </p>
      {error && (
        <p
          role="alert"
          data-testid="my-books-error"
          className="mt-2 flex items-start gap-1 text-sm text-red-700 dark:text-red-300"
        >
          <Icon name="warning" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
