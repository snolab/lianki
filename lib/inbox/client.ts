/**
 * The page's ChatFiles for the chat widget (packages/debug-chat/src/files.ts):
 * uploads to the owner-only /api/dev/inbox, same origin, the session cookie.
 * Passed only on the owner's own pages (DebugEval); nobody else gets files.
 */
import type { ChatFiles, InboxListing } from "@lianki/debug-chat/files";
import type { AttachmentRef } from "@lianki/debug-chat/wire";
import { INBOX } from "./config";

const BASE = "/api/dev/inbox";

/** One file up, with progress (XHR: fetch has no upload progress). */
function upload(
  file: File,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
): Promise<AttachmentRef> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", BASE);
    x.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    x.setRequestHeader("content-type", file.type || "application/octet-stream");
    x.upload.onprogress = (e) => onProgress(e.loaded, e.total);
    x.onload = () => {
      if (x.status !== 201) return reject(new Error(`HTTP ${x.status}`));
      try {
        resolve(JSON.parse(x.responseText) as AttachmentRef);
      } catch (e) {
        reject(e);
      }
    };
    x.onerror = () => reject(new Error("network"));
    x.onabort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", () => x.abort(), { once: true });
    x.send(file);
  });
}

type ListBody = {
  items: InboxListing["items"];
  usage?: { bytesStored: number; items: number; capBytes?: number };
};

/** An Anki package: the inbox offers to import it as a deck (/words/import). */
export const isAnkiPackage = (name: string) => /\.(apkg|colpkg)$/i.test(name);

/**
 * The owner's ChatFiles. `importDeck` labels the one-tap import of an Anki
 * package; `go` navigates in the app (the import page reads ?inbox=<id>).
 */
export const inboxFiles = (opts: {
  importDeck: string;
  go: (path: string) => void;
}): ChatFiles => ({
  upload,
  actions: (ref) =>
    isAnkiPackage(ref.name)
      ? [
          {
            id: "import-deck",
            label: opts.importDeck,
            run: () => opts.go(`/words/import?inbox=${encodeURIComponent(ref.id)}`),
          },
        ]
      : [],
  url: (ref) => `${BASE}/${encodeURIComponent(ref.id)}`,
  maxBytes: INBOX.maxFileBytes,
  async list() {
    const r = await fetch(BASE, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = (await r.json()) as ListBody;
    return {
      items: b.items,
      ...(b.usage
        ? {
            usage: {
              bytes: b.usage.bytesStored,
              items: b.usage.items,
            },
          }
        : {}),
    };
  },
  async remove(id) {
    const r = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
});

/** One inbox file as a File (the import page's hand-off): the owner's session, our own URL. */
export async function inboxFile(id: string): Promise<File> {
  if (!/^[0-9a-f]{20}$/.test(id)) throw new Error("bad inbox id");
  const r = await fetch(`${BASE}/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const cd = r.headers.get("content-disposition") ?? "";
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  let name = "inbox.apkg";
  try {
    if (m) name = decodeURIComponent(m[1]!);
  } catch {}
  return new File([await r.blob()], name, { type: r.headers.get("content-type") ?? "" });
}

/** Tell the server which chat line these files went with (fire and forget). */
export function linkInboxLine(ids: string[], line: string) {
  if (!ids.length) return;
  void fetch(BASE, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, line }),
  }).catch(() => {});
}
