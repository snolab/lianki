"use client";

/**
 * /my/files: the user's stored files in folders by origin (the `source` of
 * each row: /self-intro, the /words Import panel, the chat), each with Open
 * (served to them only) and × (deleted for good after a short Undo).
 */
import { useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { formatSize } from "@lianki/debug-chat/files";
import { pendingDeletes } from "@/lib/import/uploads-client";
import { FOLDERS, folderOf, type MyFile } from "@/lib/import/my-files";

export default function MyFilesClient({ back }: { back: string }) {
  const t = useIntlayer("my-files");
  const { locale } = useLocale();
  const [files, setFiles] = useState<MyFile[] | null>(null);
  const [toast, setToast] = useState<MyFile | null>(null);
  const deletes = useRef<ReturnType<typeof pendingDeletes> | null>(null);
  deletes.current ??= pendingDeletes();

  useEffect(() => {
    fetch("/api/my/files", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items?: MyFile[] }) => setFiles(b.items ?? []))
      .catch(() => setFiles([]));
    const flush = () => deletes.current?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const remove = (f: MyFile) => {
    setFiles((fs) => fs?.filter((x) => x.id !== f.id) ?? null);
    deletes.current?.remove(f.id);
    setToast(f);
  };
  const undo = () => {
    if (toast && deletes.current?.undo(toast.id))
      setFiles((fs) => [...(fs ?? []), toast].sort((a, b) => b.at - a.at));
    setToast(null);
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
  const muted = "text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]";

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-8" data-qa="my-files">
      <a href="/my" className="mb-3 inline-flex items-center gap-1 text-sm underline">
        <Icon name="folder" />
        {back}
      </a>
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Icon name="folderSimple" />
        {t.title}
      </h1>
      <p className={`mt-1 text-sm ${muted}`}>{t.intro}</p>

      {files && files.length === 0 && (
        <p
          className={`mt-6 text-sm ${muted}`}
          data-qa="my-files-empty"
          data-testid="my-files-empty"
        >
          {t.empty}
        </p>
      )}

      {FOLDERS.map((folder) => {
        const inFolder = (files ?? []).filter((f) => folderOf(f.source) === folder);
        if (!inFolder.length) return null;
        return (
          <section key={folder} className="mt-6" data-qa={`my-files-folder-${folder}`}>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Icon name="folderSimple" />
              {t.folders[folder]}
              <span className={`text-sm font-normal ${muted}`}>
                {t.count.value.replace("{n}", inFolder.length.toLocaleString(locale))}
              </span>
            </h2>
            <ul className="mt-1 divide-y divide-[oklch(0.5_0_0/0.15)]">
              {inFolder.map((f) => (
                <li key={f.id} className="flex items-center gap-2 py-2" data-qa="my-file">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={f.name}>
                      {f.name}
                    </span>
                    <span className={`block text-xs ${muted}`}>
                      {formatSize(f.size)} · {when(f.at)}
                    </span>
                  </span>
                  <a
                    href={`/api/my/files/${f.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-qa="my-file-open"
                    className="flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-medium underline"
                  >
                    {t.open}
                  </a>
                  <button
                    type="button"
                    data-qa="my-file-delete"
                    aria-label={t.deleteFile.value.replace("{file}", f.name)}
                    title={t.deleteFile.value.replace("{file}", f.name)}
                    onClick={() => remove(f)}
                    className="flex size-11 shrink-0 items-center justify-center rounded-lg text-[oklch(0.5_0.18_25)] hover:bg-[oklch(0.6_0.2_25/0.1)] dark:text-[oklch(0.78_0.12_25)]"
                  >
                    <Icon name="trash" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {toast && (
        <div
          role="status"
          data-qa="my-files-deleted"
          className="fixed inset-x-4 bottom-[calc(16px+env(safe-area-inset-bottom,0px))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl bg-[oklch(0.25_0.02_260/0.92)] px-4 py-3 text-sm text-[oklch(0.97_0_0)]"
        >
          <span className="min-w-0 flex-1 truncate">
            {t.deleted.value.replace("{file}", toast.name)}
          </span>
          <button type="button" onClick={undo} className="font-semibold underline">
            {t.undo}
          </button>
        </div>
      )}
    </div>
  );
}
