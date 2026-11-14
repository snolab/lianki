/**
 * Files attached to a chat line: pasted, dropped on the chat, or picked with
 * the + menu's File / Photo, video or audio (docs/dev-debug-widget.md,
 * "Attachments and the inbox"). The widget never stores bytes and knows no
 * server: the host passes `files` (ChatFiles), which uploads one file, says
 * where to fetch one, and optionally lists and deletes what was sent. Without
 * it the two kinds stay "coming soon" and paste/drop do nothing.
 *
 * Here: the host contract, the pending list above the input (one entry per
 * file, its progress, removable before sending), and small pure helpers.
 * Nothing a user sent is rendered as HTML: names are text, and only an image
 * type in INLINE_IMAGE is shown as an <img>, from the host's own URL.
 */
import { type AttachmentRef, MAX_ATTACHMENTS, cleanFileName } from "./wire";

/** One file the host has stored (the inbox view's rows). */
export type InboxEntry = AttachmentRef & { at: number; processedAt?: number };

/** What the user has stored with the host: shown at the top of the inbox view. */
export type InboxUsage = {
  /** Bytes stored now. */
  bytes: number;
  /** Files stored now. */
  items: number;
  /** The user's storage quota in bytes, if the host has one. */
  quota?: number;
};

/** The inbox view's data: the files, newest first, and the usage. */
export type InboxListing = { items: InboxEntry[]; usage?: InboxUsage };

/** One host action on a stored file (a button on its inbox row and its chip in the log). */
export type FileAction = {
  id: string;
  /** Localized by the host. */
  label: string;
  run: () => void;
};

/** The host's file handling. Every method may throw; the widget shows it as a failed chip or row. */
export type ChatFiles = {
  /** Opaque signed-in account key: switching it clears pending private uploads. */
  scope?: string;
  /**
   * Upload one file; resolves with its ref once stored. `onProgress` gets the
   * bytes sent so far; `signal` aborts it (× on the chip before it finished).
   */
  upload(
    file: File,
    onProgress: (sent: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<AttachmentRef>;
  /** Where the page may fetch a stored file (an <img> src, or a download link). Same-origin or signed. */
  url(ref: AttachmentRef): string;
  /** Largest file the host takes, in bytes: a bigger one is refused before upload. */
  maxBytes?: number;
  /** The stored files, newest first, and the usage: the + menu's Inbox. */
  list?(): Promise<InboxListing>;
  /** Delete one stored file for good (the inbox's Delete, confirmed). */
  remove?(id: string): Promise<void>;
  /** What the host can do with one stored file (e.g. open it in one of its own tools); none: []. */
  actions?(ref: AttachmentRef): FileAction[];
};

/** Image types shown inline as <img>; anything else (SVG included) is a file chip. */
export const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;
export const isInlineImage = (type: string) => INLINE_IMAGE.test(type);

/** "12 KB", "3.4 MB": bytes for a chip. */
export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** The slice of a DataTransfer (paste or drop) read here. */
export type TransferLike = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
  types?: ArrayLike<string> | readonly string[];
};

/** The files in a paste or a drop (items first: a pasted screenshot is only there). */
export function filesFrom(dt: TransferLike | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  if (!out.length) out.push(...Array.from(dt.files ?? []));
  return out;
}

/** Whether a drag carries files (dragover cannot read them yet, only the types). */
export function dragHasFiles(dt: TransferLike | null | undefined): boolean {
  return Array.from(dt?.types ?? []).includes("Files");
}

/** One file above the input: uploading, stored (ref), or failed. */
export type PendingFile = {
  key: string;
  name: string;
  type: string;
  size: number;
  /** Bytes sent so far. */
  sent: number;
  state: "uploading" | "done" | "failed" | "too-big";
  ref?: AttachmentRef;
  /** A local object URL for an image's thumbnail, revoked when the chip goes. */
  thumb?: string;
};

type Deps = {
  files: () => ChatFiles | undefined;
  /** URL.createObjectURL / revokeObjectURL (absent in tests). */
  objectUrl?: { create(f: File): string; revoke(u: string): void };
};

/**
 * The pending files above the input, as a small store (subscribe/get, like
 * the page selection): add() starts each upload, remove() aborts or drops
 * one, take() hands the stored refs to a sent line and clears them.
 */
export function createPendingFiles(deps: Deps) {
  let list: PendingFile[] = [];
  const aborts = new Map<string, AbortController>();
  const subs = new Set<() => void>();
  let n = 0;
  const set = (next: PendingFile[]) => {
    list = next;
    for (const f of subs) f();
  };
  const patch = (key: string, p: Partial<PendingFile>) =>
    set(list.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const drop = (x: PendingFile) => {
    aborts.get(x.key)?.abort();
    aborts.delete(x.key);
    if (x.thumb) deps.objectUrl?.revoke(x.thumb);
  };
  return {
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    get: () => list,
    /** Start uploading these (past MAX_ATTACHMENTS in all, the rest are left out). */
    add(files: readonly File[]) {
      const host = deps.files();
      if (!host) return;
      const room = Math.max(0, MAX_ATTACHMENTS - list.length);
      const added: PendingFile[] = [];
      const starts: (() => void)[] = [];
      for (const file of files.slice(0, room)) {
        const key = `f${++n}`;
        const type = file.type || "application/octet-stream";
        const big = host.maxBytes !== undefined && file.size > host.maxBytes;
        const p: PendingFile = {
          key,
          name: cleanFileName(file.name),
          type,
          size: file.size,
          sent: 0,
          state: big ? "too-big" : "uploading",
          ...(isInlineImage(type) && deps.objectUrl ? { thumb: deps.objectUrl.create(file) } : {}),
        };
        added.push(p);
        if (big) continue;
        const ac = new AbortController();
        aborts.set(key, ac);
        // Started once the chips are listed, so a first progress report has a chip to land on.
        starts.push(() => {
          host
          .upload(file, (sent) => patch(key, { sent }), ac.signal)
          .then(
            (ref) => {
              if (aborts.get(key) !== ac) return;
              patch(key, { state: "done", sent: file.size, ref });
            },
            () => {
              if (aborts.get(key) !== ac) return;
              patch(key, { state: "failed" });
            },
          )
          .finally(() => {
            if (aborts.get(key) === ac) aborts.delete(key);
          });
        });
      }
      if (added.length) set([...list, ...added]);
      for (const go of starts) go();
    },
    /** × on a chip: abort its upload (if running) and drop it. */
    remove(key: string) {
      const x = list.find((p) => p.key === key);
      if (!x) return;
      drop(x);
      set(list.filter((p) => p.key !== key));
    },
    /** Any file still on its way: the line waits (send is held). */
    busy: () => list.some((p) => p.state === "uploading"),
    /** The stored files' refs for the line being sent; every chip goes (failed ones too). */
    take(): AttachmentRef[] {
      const refs = list.flatMap((p) => (p.state === "done" && p.ref ? [p.ref] : []));
      for (const x of list) drop(x);
      set([]);
      return refs;
    },
  };
}
export type PendingFiles = ReturnType<typeof createPendingFiles>;
