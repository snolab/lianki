// A catalogue book's text (lib/books/catalogue.ts) → a parsed book.
//
// The server fetches the entry's one file, never a user-supplied URL; a
// redirect is followed by hand and only to SOURCE_HOSTS. The answer is
// untrusted data: capped in size, required to be HTML, and parsed by the same
// markup collector as EPUB and Google Docs (lib/gdoc/parse.ts), which keeps
// text only (no scripts, styles or images).
//
// The fetched file is cached (R2 `lianki-blobs`, `preset-cache/`, through
// SourceCache) for every user: the first import of a book fetches it, every
// later one reads the cache. Nothing of the text is ever in the repo.

import { parseGdocHtml } from "@/lib/gdoc/parse";
import { BOOK_LIMITS, type ParsedBook } from "@/lib/read/book";
import { allowedSourceUrl, type CatalogueBook } from "./catalogue";
import type { BookChapter } from "@/lib/read/book";

export type BookSourceError = "fetch-failed" | "too-large" | "no-text";

export class BookSourceFail extends Error {
  constructor(public code: BookSourceError) {
    super(code);
    this.name = "BookSourceFail";
  }
}

export const SOURCE_LIMITS = {
  /** The whole HTML file, images are separate files and never fetched. */
  maxBytes: 6_000_000,
  maxRedirects: 3,
  timeoutMs: 25_000,
};

/** Where fetched source files are kept; R2 in production (lib/books/cache-r2.ts). */
export interface SourceCache {
  get(key: string): Promise<string | null>;
  put(key: string, text: string): Promise<void>;
}

/** The cache key of an entry's source file: changes when the file URL does. */
export async function sourceCacheKey(book: CatalogueBook): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(book.source.file));
  const hex = [...new Uint8Array(d)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `preset-cache/${encodeURIComponent(book.lang)}/${encodeURIComponent(book.slug)}/${hex}.html`;
}

async function drop(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

/** Read at most `max` bytes of a body as UTF-8, else too-large. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const parts: string[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) throw new BookSourceFail("too-large");
      parts.push(dec.decode(value, { stream: true }));
    }
    parts.push(dec.decode());
  } finally {
    await reader.cancel().then(undefined, String);
  }
  return parts.join("");
}

/** Fetch an entry's source file from its host (no cache). */
export async function fetchSourceFile(
  book: CatalogueBook,
  fetchImpl: typeof fetch = fetch,
  limits = SOURCE_LIMITS,
): Promise<string> {
  let url = allowedSourceUrl(book.source.file);
  if (!url) throw new BookSourceFail("fetch-failed");
  const signal = AbortSignal.timeout(limits.timeoutMs);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal,
        headers: { Accept: "text/html", "User-Agent": "Lianki (lianki.com) catalogue import" },
      });
    } catch {
      throw new BookSourceFail("fetch-failed");
    }
    if (res.status >= 300 && res.status < 400) {
      void drop(res);
      let next: URL | null = null;
      try {
        next = allowedSourceUrl(new URL(res.headers.get("location") ?? "", url).toString());
      } catch {
        next = null;
      }
      if (!next || hop >= limits.maxRedirects) throw new BookSourceFail("fetch-failed");
      url = next;
      continue;
    }
    if (!res.ok || !res.body) {
      void drop(res);
      throw new BookSourceFail("fetch-failed");
    }
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(res.headers.get("content-type") ?? "")) {
      void drop(res);
      throw new BookSourceFail("fetch-failed");
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > limits.maxBytes) {
      void drop(res);
      throw new BookSourceFail("too-large");
    }
    return readCapped(res.body, limits.maxBytes);
  }
}

/** The source file: from the cache, else fetched and cached. A failing cache is skipped. */
export async function loadSource(
  book: CatalogueBook,
  cache: SourceCache | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ html: string; cached: boolean }> {
  const key = await sourceCacheKey(book);
  if (cache) {
    try {
      const hit = await cache.get(key);
      if (hit) return { html: hit, cached: true };
    } catch (err) {
      console.error("books: cache read failed", err);
    }
  }
  const html = await fetchSourceFile(book, fetchImpl);
  if (cache) {
    try {
      await cache.put(key, html);
    } catch (err) {
      console.error("books: cache write failed", err);
    }
  }
  return { html, cached: false };
}

/**
 * Where the block holding `pos` starts: an inline tag at `pos` (an anchor in
 * a heading, <h4><a id="x"></a>LE …) moves back to the enclosing block's
 * start tag, so a heading cut there stays a heading.
 */
function blockStart(html: string, pos: number, floor = 0): number {
  const tag = html.lastIndexOf("<", pos);
  if (tag < floor) return pos;
  const before = html.slice(Math.max(floor, tag - 400), tag);
  const block = /<(h[1-6]|p|div|section)\b[^>]*>(\s*<(a|i|b|em|strong|span)\b[^>]*>)*\s*$/i.exec(
    before,
  );
  return block ? tag - (before.length - block.index) : tag;
}

function idPos(html: string, id: string, from = 0): number {
  const re = new RegExp(`\\sid=["']${id.replace(/[^A-Za-z0-9_-]/g, "")}["']`, "g");
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? blockStart(html, m.index, from) : -1;
}
/**
 * Remove Project Gutenberg's licence header and footer from an HTML file: the
 * `pg-header` and `pg-footer` sections of current files, else everything
 * outside the "*** START OF / *** END OF THE PROJECT GUTENBERG EBOOK" lines.
 * The attribution is kept with the book's meta instead (catalogue entry).
 */
export function stripGutenberg(html: string): string {
  let out = html;
  const header = /<(header|section|div)\b[^>]*\bid=["']pg-header["'][^>]*>[\s\S]*?<\/\1>/i;
  const footer = /<(footer|section|div)\b[^>]*\bid=["']pg-footer["'][^>]*>[\s\S]*$/i;
  const hadHeader = header.test(out);
  out = out.replace(header, "");
  const hadFooter = footer.test(out);
  out = out.replace(footer, "</body></html>");
  if (!hadHeader) {
    const m = /\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG E-?BOOK[^*]*\*{3}/i.exec(out);
    if (m) {
      const body = /<body[^>]*>/i.exec(out);
      out = (body ? body[0] : "") + out.slice(m.index + m[0].length);
    }
  }
  if (!hadFooter) {
    const m = /\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG E-?BOOK/i.exec(out);
    if (m) out = out.slice(0, m.index) + "</body></html>";
  }
  return out;
}

/** Only the part named by `range`, or the whole file. The <head> (its class styles) is kept. */
export function cutRange(html: string, range: CatalogueBook["range"]): string {
  if (!range) return html;
  const from = range.from ? idPos(html, range.from) : -1;
  const start = from >= 0 ? from : 0;
  let end = range.to ? idPos(html, range.to, start + 1) : -1;
  if (end < 0 && range.toMarkup) {
    const at = html.indexOf(range.toMarkup, start + 1);
    if (at > 0) end = blockStart(html, at, start + 1);
  }
  if (end <= start) end = html.length;
  if (start === 0 && end === html.length) return html;
  const head = /<head\b[^>]*>[\s\S]*?<\/head>/i.exec(html.slice(0, start))?.[0] ?? "";
  return `<html>${head}<body>${html.slice(start, end)}</body></html>`;
}

/**
 * Chapters as printed headings: a heading broken over lines (LA BELLE<br>AU
 * BOIS<br>DORMANT) is one chapter titled by all its lines.
 */
export function joinHeadingChapters(b: ParsedBook): BookChapter[] {
  const cont = new Set(b.breaks ?? []);
  const out: BookChapter[] = [];
  for (const c of b.chapters) {
    if (cont.has(c.start) && out.length) continue;
    let title = c.title;
    for (let l = c.start + 1; cont.has(l) && l < b.lines.length && l < c.start + 6; l++)
      title += ` ${b.lines[l]}`;
    out.push({
      ...c,
      title: title.replace(/\s+/g, " ").trim().slice(0, BOOK_LIMITS.maxTitleChars),
    });
  }
  return out;
}

/** The catalogue entry's source file → its book, titled and credited from the entry. */
export function parseSource(book: CatalogueBook, html: string): ParsedBook {
  if (book.source.format !== "gutenberg-html") throw new BookSourceFail("no-text");
  const body = cutRange(stripGutenberg(html), book.range);
  let parsed: ParsedBook;
  try {
    // A printed book's title page has a couple of top headings: a level
    // starts chapters only when it is used three times or more.
    parsed = parseGdocHtml(body, book.title, 3);
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new BookSourceFail(
      code === "too-much-text" || code === "too-large" ? "too-large" : "no-text",
    );
  }
  return {
    ...parsed,
    title: book.title.slice(0, BOOK_LIMITS.maxTitleChars),
    author: book.author,
    lang: book.lang,
    chapters: joinHeadingChapters(parsed),
  };
}
