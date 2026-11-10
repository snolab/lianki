// Import your own book (docs/books-plan.md, "Your own books"): a book file the
// user stored in My Files (inbox_item source 'books') becomes one of their
// books on /books, opening in the reader.
//
// - **Formats:** EPUB 2/3 (the reader's own parser, lib/epub/), and plain
//   text (.txt, .md: one paragraph per line, the file name as the title).
// - **Parsed on the server**, no AI and no credits: chapters, title, author,
//   language (the book's own, else detected from its text,
//   lib/read/lang-detect.ts) and the cover (lib/epub/cover.ts).
// - **Private:** the file stays the user's own in My Files; the cover is kept
//   beside it at `books-cover/<user>/<file id>` (R2) and served to them only.
//   Deleting the file in My Files deletes the cover; the book stays in their
//   reading until they delete it there.
// - **Limits** come from the file store (lib/inbox/config.ts): one file's
//   size, the rolling day, the stored total.
// - **Once per file:** the book is keyed `file:<file id>`; importing the same
//   file again opens the book they already have.

import { INBOX } from "@/lib/inbox/config";
import { EpubError, parseEpub } from "@/lib/epub/parse";
import { openEpub } from "@/lib/epub/unzip";
import { coverMatches, epubCoverRef } from "@/lib/epub/cover";
import { canonicalLang } from "@/lib/lang-order";
import { primaryLang } from "@/lib/read/lang-detect";
import { BOOK_LIMITS, bookMetaOf, checkBook, type ParsedBook } from "@/lib/read/book";
import { bookHash } from "@/lib/read/units";

/** The limits and file types of an own-book import, in one place (ready for the config store). */
export const OWN_BOOK = {
  /** Largest book file: the file store's own cap for one file. */
  maxFileBytes: INBOX.maxFileBytes,
  /** Largest cover image kept; a bigger one is left out (the book still imports). */
  maxCoverBytes: 2 * 1024 * 1024,
  /** The file picker's `accept`. */
  accept: ".epub,application/epub+zip,.txt,.md,text/plain,text/markdown",
  /** Lines the language detector reads when the book does not state one. */
  detectLines: 400,
} as const;

/** The My Files source an own book is stored under. */
export const OWN_BOOK_SOURCE = "books" as const;
/** The read_materials source key of a book imported from file `id`. */
export const ownSourceKey = (fileId: string) => `file:${fileId}`;
/** The R2 key of a book file's cover. */
export const coverKey = (userId: string, fileId: string) => `books-cover/${userId}/${fileId}`;

export type OwnFormat = "epub" | "text";
export type OwnBookErrorCode =
  | "unsupported"
  | "not-epub"
  | "drm"
  | "no-text"
  | "too-much-text"
  | "too-large";

export class OwnBookError extends Error {
  constructor(public code: OwnBookErrorCode) {
    super(code);
    this.name = "OwnBookError";
  }
}

/** What a stored file is, from its first bytes and name; null when it is neither. */
export function formatOf(name: string, type: string, head: Uint8Array): OwnFormat | null {
  // A zip (an EPUB is one): "PK\x03\x04".
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "epub";
  if (/\.(txt|text|md|markdown)$/i.test(name) || /^text\/(plain|markdown)\b/i.test(type)) {
    // Text has no NUL byte in its first kilobytes (UTF-16 has a BOM, handled below).
    const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
    if (utf16 || !head.subarray(0, 4096).includes(0)) return "text";
  }
  return null;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

/** A file name without its extension, as a title. */
export function titleFromName(name: string): string {
  const t = name
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .replace(/[_]+/g, " ")
    .trim();
  return (t || "Book").slice(0, BOOK_LIMITS.maxTitleChars);
}

/** The book's language: as it states it (canonical BCP 47), else detected from its text. */
export function bookLang(stated: string | undefined, lines: readonly string[]): string | undefined {
  const own = stated ? canonicalLang(stated) : null;
  if (own) return own;
  const detected = primaryLang(lines.slice(0, OWN_BOOK.detectLines));
  return detected && canonicalLang(detected) ? detected : undefined;
}

export interface OwnParsed {
  format: OwnFormat;
  book: ParsedBook;
  cover: { type: string; bytes: Uint8Array } | null;
}

/** File bytes → a checked book (and its cover). Throws `OwnBookError`. */
export async function parseOwnBook(
  bytes: Uint8Array,
  name: string,
  type: string,
): Promise<OwnParsed> {
  if (bytes.byteLength > OWN_BOOK.maxFileBytes) throw new OwnBookError("too-large");
  const format = formatOf(name, type, bytes.subarray(0, 4096));
  if (!format) throw new OwnBookError("unsupported");
  let raw: ParsedBook;
  let cover: OwnParsed["cover"] = null;
  if (format === "epub") {
    try {
      const zip = await openEpub(bytes);
      raw = await parseEpub(zip);
      const ref = await epubCoverRef(zip);
      const data = ref && zip.readBytes ? await zip.readBytes(ref.path).catch(() => null) : null;
      if (ref && data && data.byteLength <= OWN_BOOK.maxCoverBytes && coverMatches(ref.type, data))
        cover = { type: ref.type, bytes: data };
    } catch (err) {
      if (err instanceof EpubError)
        throw new OwnBookError(err.code === "too-much-text" ? "too-much-text" : err.code);
      throw err;
    }
  } else {
    const lines = decodeText(bytes)
      .split(/\r?\n|\r/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) throw new OwnBookError("no-text");
    const title = titleFromName(name);
    raw = { title, lines, chapters: [{ title, start: 0 }], headings: [] };
  }
  const checked = checkBook({ ...raw, lang: bookLang(raw.lang, raw.lines) });
  if (!checked.ok)
    throw new OwnBookError(checked.error === "too-much-text" ? "too-much-text" : "no-text");
  return { format, book: checked.book, cover };
}

/** A stored file, as the import reads it (lib/inbox/store.ts InboxItem). */
export interface OwnFile {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  source: string;
  r2Key: string;
}

export interface OwnImportDeps {
  file(id: string): Promise<OwnFile | null>;
  bytes(r2Key: string): Promise<Uint8Array | null>;
  /** The user's book from this source key, if any. */
  find(userId: string, sourceKey: string): Promise<{ id: string } | null>;
  save(
    userId: string,
    title: string,
    content: string,
    lines: string[],
    hash: string,
    sourceKey: string,
  ): Promise<{ id: string }>;
  putCover(key: string, bytes: Uint8Array, type: string): Promise<void>;
  /** A file that is not a readable book is removed again (it was stored for this import only). */
  dropFile(userId: string, fileId: string): Promise<void>;
}

export type OwnImportResult =
  | { ok: true; id: string; existing: boolean }
  | { ok: false; status: 404 | 413 | 422; error: OwnBookErrorCode | "not-found" };

/** Import the user's stored book file `fileId` as their book (once per file). */
export async function importOwnBook(
  userId: string,
  fileId: string,
  deps: OwnImportDeps,
): Promise<OwnImportResult> {
  const file = await deps.file(fileId);
  // Only the owner's own file from the books folder; anything else does not exist for them.
  if (!file || file.ownerId !== userId || file.source !== OWN_BOOK_SOURCE)
    return { ok: false, status: 404, error: "not-found" };
  const key = ownSourceKey(file.id);
  const prev = await deps.find(userId, key);
  if (prev) return { ok: true, id: prev.id, existing: true };

  const bytes = await deps.bytes(file.r2Key);
  if (!bytes) return { ok: false, status: 404, error: "not-found" };
  let parsed: OwnParsed;
  try {
    parsed = await parseOwnBook(bytes, file.name, file.type);
  } catch (err) {
    if (!(err instanceof OwnBookError)) throw err;
    await deps.dropFile(userId, file.id);
    const status = err.code === "too-large" || err.code === "too-much-text" ? 413 : 422;
    return { ok: false, status, error: err.code };
  }
  const { book, cover } = parsed;
  if (cover) await deps.putCover(coverKey(userId, file.id), cover.bytes, cover.type);
  const meta = {
    ...bookMetaOf(book, { source: parsed.format }),
    ...(cover ? { cover: 1 as const } : {}),
  };
  const saved = await deps.save(
    userId,
    book.title,
    JSON.stringify(meta),
    book.lines,
    await bookHash(book.lines),
    key,
  );
  console.log(
    JSON.stringify({
      event: "books.own-import",
      format: parsed.format,
      lines: book.lines.length,
      cover: !!cover,
    }),
  );
  return { ok: true, id: saved.id, existing: false };
}
