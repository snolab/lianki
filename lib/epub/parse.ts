// EPUB → book (title, author, paragraphs, chapters). Pure: reads entries
// through `EpubArchive`, so tests feed it an in-memory map and the browser
// feeds it a size-capped unzip (lib/epub/unzip.ts).
//
// EPUB 2 and 3: META-INF/container.xml → OPF (metadata, manifest, spine) →
// XHTML documents in spine order. Chapters come from the EPUB 3 nav toc, else
// the EPUB 2 NCX, else one per spine document. DRM-protected books are refused,
// never decrypted.

import { BOOK_LIMITS, type BookChapter, type ParsedBook } from "@/lib/read/book";
import { INLINE_KINDS, type InlineKind, type InlineMark } from "@/lib/read/reader-api";
import { find, findAll, parseXml, textOf, type XmlElement } from "./xml";

export interface EpubArchive {
  /** Every entry path in the zip. */
  list(): string[];
  /** The entry as text, or null when it does not exist. */
  read(path: string): Promise<string | null>;
}

export type EpubErrorCode = "not-epub" | "drm" | "no-text" | "too-much-text" | "too-large";

export class EpubError extends Error {
  constructor(
    public code: EpubErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "EpubError";
  }
}

// Font obfuscation (IDPF and Adobe) is allowed by the spec in DRM-free books:
// it only scrambles embedded fonts, never the text.
const FONT_OBFUSCATION = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#rc",
]);
// Present only in DRM-protected books: Apple FairPlay, Readium LCP, Adobe ADEPT.
const DRM_MARKERS = ["meta-inf/sinf.xml", "meta-inf/license.lcpl", "meta-inf/rights.xml"];

/** True when the book is DRM-protected (anything beyond font obfuscation is encrypted). */
export async function isDrmProtected(zip: EpubArchive): Promise<boolean> {
  const names = zip.list().map((n) => n.toLowerCase());
  if (DRM_MARKERS.some((m) => names.includes(m))) return true;
  const encPath = zip.list().find((n) => n.toLowerCase() === "meta-inf/encryption.xml");
  if (!encPath) return false;
  const xml = await zip.read(encPath);
  if (xml === null) return false;
  const doc = parseXml(xml);
  for (const data of findAll(doc, "encrypteddata")) {
    const alg = (find(data, "encryptionmethod")?.attrs.algorithm ?? "").trim().toLowerCase();
    if (!FONT_OBFUSCATION.has(alg)) return true;
  }
  // An encryption.xml we cannot read as font-only (e.g. EncryptedKey alone) is DRM too.
  return findAll(doc, "encryptedkey").length > 0;
}

/** Resolve `href` against the directory of `from`. Null when it leaves the archive root. */
export function resolvePath(from: string, href: string): string | null {
  let h = href.split("#")[0];
  try {
    h = decodeURIComponent(h);
  } catch {
    // keep as written
  }
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // empty, or an absolute URL
  const base = h.startsWith("/") ? [] : from.split("/").slice(0, -1);
  const parts = [...base];
  for (const seg of h.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

function fragmentOf(href: string): string {
  const i = href.indexOf("#");
  if (i < 0) return "";
  // Element ids are decoded text: "#caf%C3%A9" names id="café".
  try {
    return decodeURIComponent(href.slice(i + 1));
  } catch {
    return href.slice(i + 1);
  }
}

interface TocEntry {
  title: string;
  file: string;
  frag: string;
}

// Collapse ASCII whitespace only: a no-break space (French "boa&nbsp;:") is kept.
const clean = (s: string) =>
  s
    .replace(/[ \t\n\r\f\v]+/g, " ")
    .trim()
    .normalize("NFC");

function tocFromNav(navXml: string, navPath: string): TocEntry[] {
  const doc = parseXml(navXml);
  const navs = findAll(doc, "nav");
  const nav =
    navs.find((n) => /(^|\s)toc(\s|$)/.test(n.attrs["epub:type"] ?? "")) ??
    navs.find((n) => n.attrs.role === "doc-toc") ??
    navs[0];
  if (!nav) return [];
  const out: TocEntry[] = [];
  for (const a of findAll(nav, "a")) {
    const href = a.attrs.href;
    const file = href ? resolvePath(navPath, href) : null;
    const title = clean(textOf(a));
    if (file && title) out.push({ title, file, frag: fragmentOf(href) });
  }
  return out;
}

function tocFromNcx(ncxXml: string, ncxPath: string): TocEntry[] {
  const doc = parseXml(ncxXml);
  const map = find(doc, "navmap");
  if (!map) return [];
  const out: TocEntry[] = [];
  for (const np of findAll(map, "navpoint")) {
    const label = np.children.find(
      (c): c is XmlElement => typeof c !== "string" && c.name === "navlabel",
    );
    const src = np.children.find(
      (c): c is XmlElement => typeof c !== "string" && c.name === "content",
    )?.attrs.src;
    const file = src ? resolvePath(ncxPath, src) : null;
    const title = label ? clean(textOf(label)) : "";
    if (file && title) out.push({ title, file, frag: fragmentOf(src!) });
  }
  return out;
}

// ── text extraction ─────────────────────────────────────────────────────────

const BLOCK = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "dt",
  "dd",
  "pre",
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "figcaption",
  "caption",
  "td",
  "th",
  "tr",
  "table",
  "ul",
  "ol",
  "dl",
  "nav",
  "main",
  "body",
  "hr",
  "address",
  "center",
  "figure",
]);
const SKIP = new Set([
  "head",
  "script",
  "style",
  "svg",
  "math",
  "img",
  "noscript",
  "rt",
  "rp",
  "object",
  "video",
  "audio",
  "iframe",
  "template",
  "button",
  "input",
  "select",
  "textarea",
  "title",
  "image",
]);

function isSkipped(el: XmlElement): boolean {
  if (SKIP.has(el.name)) return true;
  if ("hidden" in el.attrs) return true;
  const type = el.attrs["epub:type"] ?? "";
  const role = el.attrs.role ?? "";
  if (/(^|\s)(noteref|backlink|pagebreak|footnote|endnote|rearnote)(\s|$)/.test(type)) return true;
  if (/doc-(noteref|backlink|pagebreak|footnote|endnote)/.test(role)) return true;
  if (el.name === "a" && (el.attrs.href ?? "").includes("#")) {
    // Classic footnote markers and back-references: [1], 12, *, †, ↩.
    const t = textOf(el).trim();
    if (/^(\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}|[*†‡§↩↑^]|\[[*†‡]\])$/.test(t)) return true;
  }
  return false;
}

const SPLIT_AT = 4_000;

/** Split an over-long paragraph at sentence ends so no stored line is huge. */
function splitLong(text: string): string[] {
  if (text.length <= BOOK_LIMITS.maxLineChars) return [text];
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?…。！？])\s+/)) {
    if (cur && cur.length + s.length + 1 > SPLIT_AT) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s;
    while (cur.length > BOOK_LIMITS.maxLineChars) {
      out.push(cur.slice(0, SPLIT_AT));
      cur = cur.slice(SPLIT_AT);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ── inline markup ───────────────────────────────────────────────────────────
//
// Emphasis is kept beside the plain line, never in it (docs/books-plan.md,
// "Review units"): while a paragraph is collected, an inline element writes
// a sentinel (Unicode noncharacters, stripped from the book's own text) at
// its start and end; at the end the plain line is made exactly as before and
// the sentinels become [start, end, kind] ranges into it.

const INLINE_TAGS: Record<string, InlineKind> = {
  i: "em",
  em: "em",
  cite: "em",
  dfn: "em",
  var: "em",
  b: "strong",
  strong: "strong",
  sup: "sup",
  sub: "sub",
};
const OPEN = 0xfdd0;
const CLOSE = 0xfde0;
const SENTINELS = /[\uFDD0-\uFDEF]/g;
const ASCII_WS = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/**
 * The plain text of a collected paragraph (exactly `clean` of it without
 * sentinels) and its marks as offsets into that text.
 */
export function extractMarks(raw: string): { text: string; marks: [number, number, InlineKind][] } {
  let out = "";
  let space = false;
  let queued: number[] = [];
  const open: number[][] = INLINE_KINDS.map(() => []);
  const marks: [number, number, InlineKind][] = [];
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c >= OPEN && c < OPEN + INLINE_KINDS.length) {
      queued.push(c - OPEN);
    } else if (c >= CLOSE && c < CLOSE + INLINE_KINDS.length) {
      const k = c - CLOSE;
      const q = queued.lastIndexOf(k);
      if (q >= 0) queued.splice(q, 1);
      else {
        const start = open[k].pop();
        if (start !== undefined && start < out.length)
          marks.push([start, out.length, INLINE_KINDS[k]]);
      }
    } else if (ASCII_WS.has(ch)) {
      if (out) space = true;
    } else {
      if (space) out += " ";
      space = false;
      for (const k of queued) open[k].push(out.length);
      queued = [];
      out += ch;
    }
  }
  open.forEach((starts, k) => {
    for (const s of starts) if (s < out.length) marks.push([s, out.length, INLINE_KINDS[k]]);
  });
  // `clean` trims every Unicode space (a leading no-break space too) and NFCs.
  const lead = out.length - out.trimStart().length;
  const trimmed = out.trim();
  const nfc = trimmed.normalize("NFC");
  const at = (o: number) => {
    const t = Math.max(0, Math.min(trimmed.length, o - lead));
    return nfc === trimmed ? t : trimmed.slice(0, t).normalize("NFC").length;
  };
  const text = clean(raw.replace(SENTINELS, ""));
  if (text !== nfc) return { text, marks: [] };
  const kept: [number, number, InlineKind][] = [];
  for (const [a, z, k] of marks) {
    const s = at(a);
    const e = at(z);
    if (e > s) kept.push([s, e, k]);
  }
  kept.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  return { text, marks: kept };
}

/**
 * Where each part of a split paragraph sits in the paragraph: part offset →
 * paragraph offset (a part's spaces may stand for a longer run of spaces).
 */
function partOffsets(text: string, parts: string[]): Int32Array[] {
  let i = 0;
  return parts.map((part) => {
    const pos = new Int32Array(part.length + 1);
    while (i < text.length && /\s/.test(text[i]) && !/\s/.test(part[0] ?? "")) i++;
    for (let j = 0; j < part.length; j++) {
      if (text[i] !== part[j] && /\s/.test(part[j])) {
        while (i < text.length && /\s/.test(text[i])) i++;
        pos[j] = i;
        continue;
      }
      pos[j] = i;
      i++;
    }
    pos[part.length] = i;
    return pos;
  });
}

/** The first part offset whose paragraph offset is ≥ `o`. */
function toPart(pos: Int32Array, o: number): number {
  let lo = 0;
  let hi = pos.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid] < o) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Collects block text into book lines; shared with the Google Docs import (lib/gdoc). */
export class Collector {
  lines: string[] = [];
  headings: number[] = [];
  /** The heading level (1–6; 0 for a document title) of each entry in `headings`. */
  levels: number[] = [];
  marks: InlineMark[] = [];
  /** Lines that continue a paragraph after a <br>. */
  breaks: number[] = [];
  /** Lines that continue a long paragraph split here. */
  continues: number[] = [];
  bytes = 0;
  private buf = "";
  private afterBr = false;
  private paraStart = 0;
  private heading = 0;
  private level = 0;
  /** Marks waiting for the next line: they start there. */
  private pending: number[] = [];
  /** Resolved marks: mark id → line index. */
  resolved = new Map<number, number>();
  private enc = new TextEncoder();

  mark(id: number) {
    this.pending.push(id);
  }

  text(s: string) {
    this.buf += s.replace(SENTINELS, "");
  }

  open(kind: InlineKind) {
    this.buf += String.fromCharCode(OPEN + INLINE_KINDS.indexOf(kind));
  }

  close(kind: InlineKind) {
    this.buf += String.fromCharCode(CLOSE + INLINE_KINDS.indexOf(kind));
  }

  /** A block starts or ends: the next line is a new paragraph. */
  block() {
    this.flush();
    this.afterBr = false;
    this.paraStart = this.lines.length;
  }

  br() {
    this.flush();
    this.afterBr = true;
  }

  flush() {
    const { text, marks } = extractMarks(this.buf);
    this.buf = "";
    if (!text) return;
    const parts = splitLong(text);
    const pos = parts.length > 1 ? partOffsets(text, parts) : null;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      for (const id of this.pending) this.resolved.set(id, this.lines.length);
      this.pending = [];
      const line = this.lines.length;
      if (p > 0) this.continues.push(line);
      else if (this.afterBr && line > this.paraStart) this.breaks.push(line);
      for (const [a, z, k] of marks) {
        if (!pos) {
          this.marks.push([line, a, z, k]);
          continue;
        }
        const s = toPart(pos[p], a);
        const e = toPart(pos[p], z);
        if (e > s) this.marks.push([line, s, Math.min(e, part.length), k]);
      }
      if (this.heading > 0) {
        this.headings.push(this.lines.length);
        this.levels.push(this.level);
      }
      this.lines.push(part);
      this.bytes += this.enc.encode(part).length + 4;
      if (this.bytes > BOOK_LIMITS.maxTextBytes || this.lines.length > BOOK_LIMITS.maxLines) {
        throw new EpubError("too-much-text");
      }
    }
  }

  walk(el: XmlElement, marksById: Map<string, number[]>) {
    for (const c of el.children) {
      if (typeof c === "string") {
        this.text(c);
        continue;
      }
      if (isSkipped(c)) continue;
      const id = c.attrs.id ?? c.attrs.name;
      const block = BLOCK.has(c.name);
      const isHeading = /^h[1-6]$/.test(c.name);
      if (block) this.block();
      if (id && marksById.has(id)) for (const m of marksById.get(id)!) this.mark(m);
      if (c.name === "br") {
        this.br();
        continue;
      }
      const outerLevel = this.level;
      if (isHeading) {
        this.heading++;
        const lv = c.attrs["data-lk-level"];
        this.level = lv !== undefined ? Number(lv) : Number(c.name[1]);
      }
      const inline = block ? undefined : INLINE_TAGS[c.name];
      if (inline) this.open(inline);
      this.walk(c, marksById);
      if (inline) this.close(inline);
      if (block) this.block();
      if (isHeading) {
        this.heading--;
        this.level = outerLevel;
      }
    }
  }
}

function lookup(zip: EpubArchive): (path: string) => string | undefined {
  const exact = new Set(zip.list());
  const lower = new Map(zip.list().map((n) => [n.toLowerCase(), n]));
  return (p) => (exact.has(p) ? p : lower.get(p.toLowerCase()));
}

export async function parseEpub(zip: EpubArchive): Promise<ParsedBook> {
  const entry = lookup(zip);
  const containerPath = entry("META-INF/container.xml");
  const container = containerPath ? await zip.read(containerPath) : null;
  if (container === null) throw new EpubError("not-epub", "META-INF/container.xml missing");

  if (await isDrmProtected(zip)) throw new EpubError("drm");

  const rootfiles = findAll(parseXml(container), "rootfile");
  const rootfile =
    rootfiles.find((r) => r.attrs["media-type"] === "application/oebps-package+xml") ??
    rootfiles[0];
  const opfHref = rootfile?.attrs["full-path"];
  const opfPath = opfHref ? entry(resolvePath("", opfHref) ?? "") : undefined;
  const opfXml = opfPath ? await zip.read(opfPath) : null;
  if (!opfPath || opfXml === null) throw new EpubError("not-epub", "OPF package missing");

  const opf = parseXml(opfXml);
  const metadata = find(opf, "metadata");
  const meta = (name: string) => {
    const el = metadata ? find(metadata, name) : undefined;
    const v = el ? clean(textOf(el)) : "";
    return v || undefined;
  };
  const creators = metadata
    ? findAll(metadata, "creator")
        .map((c) => clean(textOf(c)))
        .filter(Boolean)
    : [];

  interface Item {
    path: string;
    type: string;
    props: string;
  }
  const manifest = new Map<string, Item>();
  for (const it of findAll(find(opf, "manifest") ?? opf, "item")) {
    const path = it.attrs.href ? resolvePath(opfPath, it.attrs.href) : null;
    if (it.attrs.id && path) {
      manifest.set(it.attrs.id, {
        path,
        type: (it.attrs["media-type"] ?? "").toLowerCase(),
        props: it.attrs.properties ?? "",
      });
    }
  }
  const spineEl = find(opf, "spine");
  const spine: Item[] = [];
  for (const ref of spineEl ? findAll(spineEl, "itemref") : []) {
    if (ref.attrs.linear === "no") continue;
    const item = manifest.get(ref.attrs.idref ?? "");
    if (item && /html|xml/.test(item.type) && !spine.includes(item)) spine.push(item);
  }
  if (!spine.length) throw new EpubError("not-epub", "empty spine");

  // Table of contents: EPUB 3 nav first, EPUB 2 NCX second.
  let toc: TocEntry[] = [];
  const navItem = [...manifest.values()].find((i) => /(^|\s)nav(\s|$)/.test(i.props));
  const navPath = navItem && entry(navItem.path);
  if (navPath) {
    const x = await zip.read(navPath);
    if (x !== null) toc = tocFromNav(x, navPath);
  }
  if (!toc.length) {
    const ncxItem =
      manifest.get(spineEl?.attrs.toc ?? "") ??
      [...manifest.values()].find((i) => i.type === "application/x-dtbncx+xml");
    const ncxPath = ncxItem && entry(ncxItem.path);
    if (ncxPath) {
      const x = await zip.read(ncxPath);
      if (x !== null) toc = tocFromNcx(x, ncxPath);
    }
  }

  const col = new Collector();
  const tocByFile = new Map<string, number[]>();
  toc.forEach((t, i) => {
    const k = t.file.toLowerCase();
    tocByFile.set(k, [...(tocByFile.get(k) ?? []), i]);
  });
  // Without a toc, each spine document is a chapter; its title comes later.
  const docMarks: { mark: number; firstLine: number; title?: string }[] = [];

  for (const item of spine) {
    const path = entry(item.path);
    const xml = path ? await zip.read(path) : null;
    if (xml === null) continue;
    const doc = parseXml(xml);
    const marksById = new Map<string, number[]>();
    for (const i of tocByFile.get(item.path.toLowerCase()) ?? []) {
      const frag = toc[i].frag;
      if (frag) marksById.set(frag, [...(marksById.get(frag) ?? []), i]);
      else col.mark(i);
    }
    // A fragment that names no element in the document starts at the document.
    const ids = new Set<string>();
    walkIds(doc, ids);
    for (const [frag, ms] of marksById) {
      if (!ids.has(frag)) for (const m of ms) col.mark(m);
    }
    const before = col.lines.length;
    const docMark = toc.length + docMarks.length;
    if (!toc.length) col.mark(docMark);
    const body = find(doc, "body") ?? doc;
    col.walk(body, marksById);
    col.block();
    if (!toc.length && col.lines.length > before) {
      const firstHeading = col.headings.find((h) => h >= before);
      const docTitle = find(doc, "title");
      docMarks.push({
        mark: docMark,
        firstLine: before,
        title:
          firstHeading !== undefined
            ? col.lines[firstHeading]
            : docTitle
              ? clean(textOf(docTitle)) || undefined
              : undefined,
      });
    }
  }

  if (!col.lines.length) throw new EpubError("no-text");

  const title = meta("title") ?? docMarks[0]?.title ?? "EPUB";
  const starts: BookChapter[] = [];
  const titleOf = (m: number) =>
    m < toc.length
      ? toc[m].title
      : (docMarks.find((d) => d.mark === m)?.title ?? `${starts.length + 1}`);
  const resolved = [...col.resolved.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [m, line] of resolved) {
    if (starts.length && starts[starts.length - 1].start === line) continue; // outer entry wins
    starts.push({ title: titleOf(m).slice(0, BOOK_LIMITS.maxTitleChars), start: line });
  }
  if (!starts.length || starts[0].start !== 0) starts.unshift({ title, start: 0 });

  return {
    title: title.slice(0, BOOK_LIMITS.maxTitleChars),
    author: creators.length ? creators.join(", ").slice(0, BOOK_LIMITS.maxTitleChars) : undefined,
    lang: meta("language"),
    lines: col.lines,
    chapters: starts.slice(0, BOOK_LIMITS.maxChapters),
    headings: col.headings,
    marks: col.marks.slice(0, BOOK_LIMITS.maxMarks),
    breaks: col.breaks,
    continues: col.continues,
  };
}

function walkIds(el: XmlElement, ids: Set<string>) {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    const id = c.attrs.id ?? c.attrs.name;
    if (id) ids.add(id);
    walkIds(c, ids);
  }
}
