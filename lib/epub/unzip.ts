// Open an EPUB file as an `EpubArchive` with zip-bomb limits.
//
// Runs in the browser (the /read import dialog). jszip is already a
// dependency; it is loaded only when a file is picked. Entries are never
// written anywhere — they are looked up by name — so "../" in an entry name
// (zip slip) has nothing to escape into; `resolvePath` also refuses to leave
// the archive root.

import { EpubError, parseEpub, type EpubArchive } from "./parse";
import type { ParsedBook } from "@/lib/read/book";

export const EPUB_LIMITS = {
  /** The picked file. */
  maxFileBytes: 20 * 1024 * 1024,
  maxEntries: 5_000,
  /** One decompressed entry (an XHTML chapter, the OPF). */
  maxEntryBytes: 10 * 1024 * 1024,
  /** Everything decompressed for one book. */
  maxTotalBytes: 64 * 1024 * 1024,
  /** Uncompressed / compressed — real books stay far below. */
  maxRatio: 200,
};

type StreamHelper = {
  on(ev: "data", cb: (chunk: Uint8Array) => void): StreamHelper;
  on(ev: "end", cb: () => void): StreamHelper;
  on(ev: "error", cb: (e: Error) => void): StreamHelper;
  resume(): StreamHelper;
  pause(): StreamHelper;
};
type ZipEntry = { name: string; dir: boolean; internalStream(t: "uint8array"): StreamHelper };

function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

export async function openEpub(data: ArrayBuffer | Uint8Array): Promise<EpubArchive> {
  const size = data.byteLength;
  if (size > EPUB_LIMITS.maxFileBytes) throw new EpubError("too-large");
  const { default: JSZip } = await import("jszip");
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: false });
  } catch {
    throw new EpubError("not-epub", "not a zip file");
  }
  const files = Object.values(zip.files) as unknown as ZipEntry[];
  if (files.length > EPUB_LIMITS.maxEntries) throw new EpubError("too-large", "too many entries");
  const names = files.filter((f) => !f.dir).map((f) => f.name);
  const byName = new Map(files.map((f) => [f.name, f]));
  const budget = Math.min(EPUB_LIMITS.maxTotalBytes, Math.max(size, 1) * EPUB_LIMITS.maxRatio);
  let total = 0;

  const read = (path: string) =>
    new Promise<string | null>((resolve, reject) => {
      const f = byName.get(path);
      if (!f || f.dir) return resolve(null);
      const chunks: Uint8Array[] = [];
      let n = 0;
      let done = false;
      const stream = f.internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          if (done) return;
          n += chunk.length;
          total += chunk.length;
          if (n > EPUB_LIMITS.maxEntryBytes || total > budget) {
            done = true;
            stream.pause();
            reject(new EpubError("too-large", "decompressed size limit"));
            return;
          }
          chunks.push(chunk);
        })
        .on("error", (e) => {
          if (done) return;
          done = true;
          reject(new EpubError("not-epub", e.message));
        })
        .on("end", () => {
          if (done) return;
          done = true;
          const all = new Uint8Array(n);
          let o = 0;
          for (const c of chunks) {
            all.set(c, o);
            o += c.length;
          }
          resolve(decode(all));
        })
        .resume();
    });

  return { list: () => names, read };
}

/** File bytes → parsed book. Throws `EpubError` with a code the UI can show. */
export async function importEpub(data: ArrayBuffer | Uint8Array): Promise<ParsedBook> {
  return parseEpub(await openEpub(data));
}
