"use client";

/**
 * The editor of a roadmap doc step: its Markdown, an optional /reader doc
 * and official page, and images pasted or picked (lib/roadmap/doc-image.ts:
 * stored as the learner's own files, the address put into the Markdown). A
 * refused image (file space full, too big) leaves the text as it is and the
 * Save button working: the text never waits on the image store.
 */
import { useRef, useState } from "react";
import { Icon } from "@/app/components/icons";
import type { RoadmapDoc } from "@/types/roadmap";
import { FILES_PAGE, addDocImage, isImageFile, readerIdOf } from "@/lib/roadmap/doc-image";

export type DocEditorStrings = {
  docPlaceholder: string;
  docMarkdownLabel: string;
  docReaderLabel: string;
  docUrlLabel: string;
  docAddImage: string;
  imageUploading: string;
  imageFull: string;
  imageFullLink: string;
  imageTooBig: string;
  imageFailed: string;
  docTooLong: string;
  saveFailed: string;
  save: string;
  saving: string;
  cancel: string;
};

export type SaveResult = "ok" | "too-long" | "failed";
type Notice = "full" | "too-large" | "failed" | "too-long" | "save-failed" | null;

export default function DocEditor({
  doc,
  maxChars,
  strings: s,
  onSave,
  onCancel,
}: {
  doc: RoadmapDoc | undefined;
  maxChars: number;
  strings: DocEditorStrings;
  onSave: (doc: RoadmapDoc) => Promise<SaveResult>;
  onCancel: () => void;
}) {
  const [md, setMd] = useState(doc?.markdown ?? "");
  const [reader, setReader] = useState(doc?.readerId ?? "");
  const [url, setUrl] = useState(doc?.url ?? "");
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // The latest text, for uploads that finish after more typing.
  const mdRef = useRef(md);
  mdRef.current = md;

  const addImages = async (files: File[]) => {
    for (const f of files.filter(isImageFile)) {
      setUploading((n) => n + 1);
      const at = area.current?.selectionStart ?? mdRef.current.length;
      const out = await addDocImage(f, mdRef.current, at);
      setUploading((n) => n - 1);
      if (out.ok) {
        setMd(out.md);
        setNotice(null);
      } else
        setNotice(
          out.reason === "full" ? "full" : out.reason === "too-large" ? "too-large" : "failed",
        );
    }
  };

  const save = async () => {
    if (md.length > maxChars) return setNotice("too-long");
    setSaving(true);
    const next: RoadmapDoc = { ...doc, markdown: md };
    const rid = readerIdOf(reader);
    if (rid) next.readerId = rid;
    else delete next.readerId;
    if (/^https?:\/\//i.test(url.trim())) next.url = url.trim();
    else delete next.url;
    const r = await onSave(next);
    setSaving(false);
    if (r === "too-long") setNotice("too-long");
    else if (r === "failed") setNotice("save-failed");
  };

  const input =
    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 md:text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100";

  return (
    <div data-doc-editor className="mt-2 space-y-2">
      <textarea
        ref={area}
        value={md}
        onChange={(e) => setMd(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter(isImageFile);
          if (!files.length) return;
          e.preventDefault();
          void addImages(files);
        }}
        placeholder={s.docPlaceholder}
        aria-label={s.docMarkdownLabel}
        rows={8}
        className={`${input} min-h-40 font-mono`}
      />
      <input
        value={reader}
        onChange={(e) => setReader(e.target.value)}
        placeholder={s.docReaderLabel}
        aria-label={s.docReaderLabel}
        className={input}
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        type="url"
        inputMode="url"
        placeholder={s.docUrlLabel}
        aria-label={s.docUrlLabel}
        className={input}
      />
      {(uploading > 0 || notice) && (
        <p
          role={notice ? "alert" : "status"}
          data-doc-notice={notice ?? "uploading"}
          className="flex flex-wrap items-center gap-x-2 text-sm text-gray-700 dark:text-gray-300"
        >
          {notice && <Icon name="warning" className="shrink-0" />}
          <span>
            {uploading > 0 && !notice
              ? s.imageUploading
              : notice === "full"
                ? s.imageFull
                : notice === "too-large"
                  ? s.imageTooBig
                  : notice === "failed"
                    ? s.imageFailed
                    : notice === "too-long"
                      ? s.docTooLong
                      : s.saveFailed}
          </span>
          {notice === "full" && (
            <a
              href={FILES_PAGE}
              data-doc-files-link
              className="font-medium text-blue-600 underline dark:text-blue-300"
            >
              {s.imageFullLink}
            </a>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50"
        >
          {saving ? s.saving : s.save}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-10 rounded-lg px-3 text-sm text-gray-700 dark:text-gray-300"
        >
          {s.cancel}
        </button>
        <button
          type="button"
          onClick={() => picker.current?.click()}
          className="ms-auto inline-flex min-h-10 items-center gap-1 rounded-lg px-3 text-sm text-blue-600 dark:text-blue-300"
        >
          <Icon name="uploadSimple" />
          {s.docAddImage}
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addImages([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
