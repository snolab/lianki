// A catalogue book's text (lib/books/catalogue.ts) → a parsed book.
//
// The server fetches the entry's one file, never a user-supplied URL; a
// redirect is followed by hand and only to SOURCE_HOSTS. The answer is
// untrusted data: capped in size, required to be HTML, decoded from its
// declared charset (Aozora Bunko serves Shift_JIS), cleaned by its host's
// format (one cleaner per host format, never per language: Gutenberg's licence
// header and footer, Aozora's bibliography and notes, Wikisource's header and
// licence templates), and parsed by the same markup collector as EPUB and
// Google Docs (lib/gdoc/parse.ts), which keeps text only (no scripts, styles or
// images; a ruby reading <rt> is dropped and its base text kept, as the reader
// has no ruby yet).
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

export const SOURCE_LIMITS: {
  /** The HTML kept, after inline images (data: URIs) are dropped. */
  maxBytes: number;
  /**
   * The file as sent: a single-page edition can carry its illustrations
   * inline (Standard Ebooks' Alice is 74 MB of data: URIs around 200 KB of
   * text). They are dropped while it streams, never kept. Defaults to maxBytes.
   */
  maxStreamBytes?: number;
  maxRedirects: number;
  timeoutMs: number;
} = {
  maxBytes: 6_000_000,
  maxStreamBytes: 120_000_000,
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

const DATA_URI = [0x64, 0x61, 0x74, 0x61, 0x3a]; // "data:"
const EQ = 0x3d;
const QUOTES = new Set([0x22, 0x27]);

/**
 * Drops inline data: URIs from attribute values (`src="data:…"` → `src="data:"`)
 * as bytes stream past; the state carries across chunks. The importer keeps
 * text only, so an inline image is never needed.
 */
export function dataUriStripper(): (chunk: Uint8Array) => Uint8Array {
  let prev = 0;
  /** The quote that opened the value being matched or skipped; 0 = none. */
  let quote = 0;
  let matched = -1;
  let skipping = false;
  return (chunk) => {
    const out = new Uint8Array(chunk.byteLength);
    let n = 0;
    for (let i = 0; i < chunk.byteLength; i++) {
      const b = chunk[i];
      if (skipping) {
        if (b === quote) {
          skipping = false;
          quote = 0;
          out[n++] = b;
          prev = b;
        }
        continue;
      }
      out[n++] = b;
      if (matched >= 0) {
        if (b === DATA_URI[matched]) {
          matched++;
          if (matched === DATA_URI.length) {
            matched = -1;
            skipping = true;
          }
        } else matched = -1;
      }
      if (!skipping && matched < 0 && QUOTES.has(b) && prev === EQ) {
        quote = b;
        matched = 0;
      }
      prev = b;
    }
    return out.subarray(0, n);
  };
}

/**
 * Read a body: at most `maxStream` bytes as sent and `max` bytes once inline
 * data: URIs are dropped, else too-large.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
  maxStream = max,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const strip = dataUriStripper();
  const parts: Uint8Array[] = [];
  let sent = 0;
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sent += value.byteLength;
      if (sent > maxStream) throw new BookSourceFail("too-large");
      const kept = strip(value);
      n += kept.byteLength;
      if (n > max) throw new BookSourceFail("too-large");
      parts.push(kept);
    }
  } finally {
    await reader.cancel().then(undefined, String);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Charsets a source file may declare; anything else is refused. */
const CHARSETS = new Set([
  "utf-8",
  "shift_jis",
  "euc-jp",
  "iso-2022-jp",
  "gb18030",
  "gbk",
  "big5",
  "windows-1252",
  "iso-8859-1",
]);

/**
 * A file's charset: the Content-Type header's, else a <meta> or the XML
 * declaration in its first bytes, else UTF-8. Null for one we do not decode.
 */
export function sourceCharset(contentType: string, head: Uint8Array): string | null {
  const ascii = new TextDecoder("latin1").decode(head.subarray(0, 2048));
  const raw = (
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(ascii)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(ascii)?.[1] ??
    "utf-8"
  ).toLowerCase();
  const cs = raw === "utf8" ? "utf-8" : raw === "sjis" || raw === "x-sjis" ? "shift_jis" : raw;
  return CHARSETS.has(cs) ? cs : null;
}

/** A file's bytes as text, from its declared charset. */
export function decodeSource(bytes: Uint8Array, contentType: string): string {
  const cs = sourceCharset(contentType, bytes);
  if (!cs) throw new BookSourceFail("fetch-failed");
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    throw new BookSourceFail("fetch-failed");
  }
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
        headers: {
          Accept: "text/html, application/xhtml+xml",
          "User-Agent": "Lianki (lianki.com) catalogue import",
        },
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
    const type = res.headers.get("content-type") ?? "";
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(type)) {
      void drop(res);
      throw new BookSourceFail("fetch-failed");
    }
    const maxStream = Math.max(limits.maxBytes, limits.maxStreamBytes ?? limits.maxBytes);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxStream) {
      void drop(res);
      throw new BookSourceFail("too-large");
    }
    return decodeSource(await readCapped(res.body, limits.maxBytes, maxStream), type);
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

const VOID = new Set([
  "br",
  "hr",
  "img",
  "meta",
  "link",
  "input",
  "wbr",
  "col",
  "area",
  "base",
  "source",
]);

/**
 * Remove every element whose start tag matches `drop` (name, attribute text),
 * with all it contains. Same-name nesting is counted; markup is not otherwise
 * interpreted (the collector parses what is left).
 */
export function dropElements(html: string, drop: (name: string, attrs: string) => boolean): string {
  // Quoted attribute values may hold ">" (Parsoid's data-mw JSON does).
  const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const out: string[] = [];
  let keepFrom = 0;
  /** The dropped element being skipped: its name and same-name depth. */
  let skip: { name: string; depth: number } | null = null;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    const close = m[1] === "/";
    const name = m[2].toLowerCase();
    const selfClosing = VOID.has(name) || m[3].endsWith("/");
    if (skip) {
      if (name !== skip.name || selfClosing) continue;
      skip.depth += close ? -1 : 1;
      if (skip.depth === 0) {
        skip = null;
        keepFrom = TAG.lastIndex;
      }
      continue;
    }
    if (close || !drop(name, m[3])) continue;
    out.push(html.slice(keepFrom, m.index));
    if (selfClosing) keepFrom = TAG.lastIndex;
    else skip = { name, depth: 1 };
  }
  if (!skip) out.push(html.slice(keepFrom));
  return out.join("");
}

const classOf = (attrs: string) => /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
const hasClass = (attrs: string, names: Set<string>) =>
  classOf(attrs)
    .split(/\s+/)
    .some((c) => names.has(c));

/** The element with this class, and everything in it; "" when there is none. */
function elementWithClass(html: string, cls: string): string {
  const start = new RegExp(
    `<([A-Za-z][\\w-]*)\\b[^>]*\\bclass=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`,
    "i",
  ).exec(html);
  if (!start) return "";
  const name = start[1].toLowerCase();
  const TAG = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  TAG.lastIndex = start.index + start[0].length;
  let depth = 1;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start.index, TAG.lastIndex);
  }
  return html.slice(start.index);
}

/** Aozora Bunko's editorial notes inside the text: ［＃…］ annotations. */
const AOZORA_DROP = new Set(["notes"]);

/**
 * An Aozora Bunko XHTML file: only its `main_text` (not the title block, the
 * bibliography — 底本, 入力, 校正, kept with the entry's attribution — or the
 * notation notes). A line ends with <br /> there: each one is a paragraph.
 * Ruby keeps its base text (the collector drops <rt>/<rp>).
 */
export function cleanAozora(html: string): string {
  const head = /<head\b[^>]*>[\s\S]*?<\/head>/i.exec(html)?.[0] ?? "";
  const main = elementWithClass(html, "main_text");
  if (!main) return `<html>${head}<body></body></html>`;
  const text = dropElements(main, (_, attrs) => hasClass(attrs, AOZORA_DROP))
    .replace(/<br\s*\/?>/gi, "<p></p>")
    // A character outside JIS X 0208 is an image (gaiji): Aozora's own placeholder.
    .replace(/<img\b[^>]*\bclass=["'][^"']*\bgaiji\b[^>]*>/gi, "※");
  return `<html>${head}<body>${text}</body></html>`;
}

/**
 * What Wikisource puts around a text: the header and licence templates, edit
 * and navigation chrome, references (the class names MediaWiki and the
 * Wikisource templates use on every language's site).
 */
const WIKISOURCE_DROP = new Set([
  "licenseContainer",
  "licensetpl",
  "ws-header",
  "ws-noexport",
  "noprint",
  "mw-editsection",
  "mw-references-wrap",
  "mw-references",
  "references",
  "references-small",
  "reference",
  "mw-ref",
  "dablink",
  "navbox",
  "sisitem",
  "metadata",
  "mw-empty-elt",
]);

/**
 * A Wikisource page's REST HTML (Parsoid): the text without its header and
 * licence (both are data tables or classed boxes; the licence is kept with the
 * entry instead), styles, references and page chrome.
 */
export function cleanWikisource(html: string): string {
  const text = dropElements(
    html,
    (name, attrs) =>
      name === "table" ||
      name === "style" ||
      name === "link" ||
      hasClass(attrs, WIKISOURCE_DROP) ||
      /\bid=["'](headerContainer|plainSister)["']/.test(attrs),
  );
  // A heading left with nothing under it (a notes section whose notes were dropped).
  return text.replace(
    /<h([1-6])\b[^>]*>(?:(?!<\/?h[1-6]\b)[\s\S])*<\/h\1>(?=(?:\s|<(?!(?:p|h[1-6]|div|dl|ol|ul|li|dd|blockquote)\b)[^>]*>)*(?:<\/section>|<\/body>|$))/gi,
    "",
  );
}

/**
 * The EPUB structural types (epub:type) of a Standard Ebooks file that are the
 * edition's own matter, not the book: title pages, imprint, table of contents,
 * colophon, the CC0 "uncopyright", endnotes and lists of illustrations.
 */
const SE_DROP_TYPES = new Set([
  "titlepage",
  "halftitlepage",
  "imprint",
  "toc",
  "colophon",
  "copyright-page",
  "endnotes",
  "loi",
  "noteref",
]);

/**
 * A Standard Ebooks single-page XHTML: the book's sections only. The site's
 * navigation, the edition's front and back matter (by epub:type, the
 * vocabulary every Standard Ebooks file uses), styles and note markers go;
 * the CC0 dedication is kept with the entry's licence line instead.
 */
export function cleanStandardEbooks(html: string): string {
  const typeOf = (attrs: string) =>
    (/\bepub:type\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "").split(/\s+/);
  return dropElements(
    html,
    (name, attrs) =>
      name === "style" ||
      name === "link" ||
      name === "script" ||
      // The site's navigation bar and the table of contents; <header> and
      // <footer> stay (a chapter's heading, a letter's signature).
      name === "nav" ||
      typeOf(attrs).some((t) => SE_DROP_TYPES.has(t)),
  );
}

const plainText = (html: string) =>
  html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "").length;

/**
 * Whether a Wikisource page (Parsoid HTML) is mostly links to its own
 * sub-pages (`./Title/Chapter`): a contents page, whose text is elsewhere.
 * Half or more of its text inside such links is a contents page.
 */
export function isContentsPage(html: string): boolean {
  const total = plainText(html.replace(/<head\b[\s\S]*?<\/head>/i, ""));
  if (!total) return false;
  let linked = 0;
  for (const m of html.matchAll(
    /<a\b[^>]*\bhref=["']\.\/[^"'/]+\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  ))
    linked += plainText(m[1]);
  return linked * 2 >= total;
}

/** The host format's cleaner: what is left is the book's text. */
const CLEANERS: Record<CatalogueBook["source"]["format"], (html: string) => string> = {
  "gutenberg-html": stripGutenberg,
  "aozora-xhtml": cleanAozora,
  "wikisource-html": cleanWikisource,
  "standardebooks-xhtml": cleanStandardEbooks,
};

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
  const clean = CLEANERS[book.source.format];
  if (!clean) throw new BookSourceFail("no-text");
  const body = cutRange(clean(html), book.range);
  // A Wikisource work split into sub-pages: this page is its table of contents, not its text.
  if (book.source.format === "wikisource-html" && isContentsPage(body))
    throw new BookSourceFail("no-text");
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
