/**
 * The browser side of the user's file store (lib/import/files.ts): upload one
 * file with progress, and delete one with a short undo window. Used by the
 * /self-intro add-file area and /my/files. No React here.
 */

import { publicCfg } from "@/lib/config-client";

/**
 * Milliseconds the "Deleted · Undo" toast waits before the delete is sent:
 * config `files.undoMs` (lib/config.ts, docs/config-store.md).
 */
export const undoMs = (): number => publicCfg("files.undoMs");

export type UploadResult =
  | { ok: true; id: string }
  | { ok: false; error: "too-large" | "full" | "rate" | "failed" | "aborted" };

/** A failed upload's status/body → what the page says. */
export function uploadErrorOf(
  status: number,
  error: unknown,
): Exclude<UploadResult, { ok: true }>["error"] {
  if (error === "day-cap" || error === "storage-cap") return "full";
  if (status === 413) return "too-large";
  if (status === 429) return "rate";
  return "failed";
}

/** Minimal XHR surface (tests pass a fake). */
export type XhrLike = {
  open(method: string, url: string): void;
  setRequestHeader(k: string, v: string): void;
  send(body: Blob): void;
  abort(): void;
  status: number;
  responseText: string;
  upload: {
    onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

/**
 * Upload `file` to the store under `source`, reporting progress 0..1. The
 * returned `abort` cancels it (the promise then answers `aborted`).
 */
export function uploadFile(
  file: Blob & { name: string; type: string },
  source: "import" | "self-intro",
  onProgress: (p: number) => void,
  makeXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
): { done: Promise<UploadResult>; abort: () => void } {
  const xhr = makeXhr();
  const done = new Promise<UploadResult>((resolve) => {
    xhr.open("POST", `/api/import/files?source=${source}`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      let body: { id?: string; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 201 && body.id) {
        onProgress(1);
        resolve({ ok: true, id: body.id });
      } else resolve({ ok: false, error: uploadErrorOf(xhr.status, body.error) });
    };
    xhr.onerror = () => resolve({ ok: false, error: "failed" });
    xhr.onabort = () => resolve({ ok: false, error: "aborted" });
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

/**
 * Deletes that wait `undoMs()` before they are sent, so a toast can offer
 * Undo. `flush()` sends every pending one now (the page is being left).
 */
export function pendingDeletes(
  send: (id: string) => Promise<unknown> = (id) =>
    fetch(`/api/my/files/${id}`, { method: "DELETE", keepalive: true }),
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (t: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
) {
  const waiting = new Map<string, unknown>();
  return {
    /** Schedule the delete of `id`. */
    remove(id: string) {
      if (waiting.has(id)) return;
      waiting.set(
        id,
        timers.set(() => {
          waiting.delete(id);
          void send(id);
        }, undoMs()),
      );
    },
    /** Keep `id` after all. True when there was a delete to cancel. */
    undo(id: string) {
      const t = waiting.get(id);
      if (t === undefined) return false;
      timers.clear(t);
      waiting.delete(id);
      return true;
    },
    /** Send every waiting delete now. */
    flush() {
      for (const [id, t] of waiting) {
        timers.clear(t);
        void send(id);
      }
      waiting.clear();
    },
    pending: () => [...waiting.keys()],
  };
}
