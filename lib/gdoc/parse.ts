// A Google Doc's HTML export → a book (lib/read/book.ts), through the same
// block collector as EPUB (lib/epub/parse.ts): paragraphs as written, headings
// kept as headings, bold/italic/super/subscript as inline marks.
//
// The export styles text by class (`.c5{font-weight:700}`), not tags, so the
// class rules are read from its <style> and such spans become <b>/<i>/<sup>/
// <sub> first. Comments ([a] anchors and the comment list at the end) are
// dropped; footnote markers are dropped by the collector, footnote text stays.
// Chapters start at the top heading level that occurs more than once.

import { Collector, EpubError } from "@/lib/epub/parse";
import { parseXml, find, textOf, type XmlElement, type XmlNode } from "@/lib/epub/xml";
import { BOOK_LIMITS, type BookChapter, type ParsedBook } from "@/lib/read/book";
import { GdocError } from "./fetch";

type Style = "b" | "i" | "sup" | "sub";

/** Class name → the inline styles its rule sets. */
export function classStyles(html: string): Map<string, Style[]> {
  const out = new Map<string, Style[]>();
  const STYLE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m = STYLE.exec(html); m; m = STYLE.exec(html)) {
    const RULE = /\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
    for (let r = RULE.exec(m[1]); r; r = RULE.exec(m[1])) {
      const decl = r[2].toLowerCase();
      const st: Style[] = [];
      const w = /font-weight\s*:\s*(\w+)/.exec(decl)?.[1];
      if (w === "bold" || (w && Number(w) >= 600)) st.push("b");
      if (/font-style\s*:\s*italic/.test(decl)) st.push("i");
      const va = /vertical-align\s*:\s*(\w+)/.exec(decl)?.[1];
      if (va === "super") st.push("sup");
      else if (va === "sub") st.push("sub");
      if (st.length) out.set(r[1], st);
    }
  }
  return out;
}

/** A comment anchor in the text ("[a]" linking to the comment list). */
const isComment = (el: XmlElement) => el.name === "a" && /^#cmnt\d+$/.test(el.attrs.href ?? "");

/** A comment block at the end of the export: a div whose anchor is a comment back-link. */
function isCommentBlock(el: XmlElement): boolean {
  if (el.name !== "div") return false;
  const a = find(el, "a");
  return !!a && /^cmnt\d+$/.test(a.attrs.id ?? "");
}

function transform(el: XmlElement, styles: Map<string, Style[]>): XmlElement {
  const children: XmlNode[] = [];
  for (const c of el.children) {
    if (typeof c === "string") {
      children.push(c);
      continue;
    }
    if (isComment(c) || isCommentBlock(c)) continue;
    let node = transform(c, styles);
    const cls = (c.attrs.class ?? "").split(/\s+/).filter(Boolean);
    if (c.name === "p" && (cls.includes("title") || cls.includes("subtitle"))) {
      // The doc's Title / Subtitle styles: headings above h1.
      node = { ...node, name: "h1", attrs: { ...node.attrs, "data-lk-level": "0" } };
    }
    if (c.name === "span") {
      const st = [...new Set(cls.flatMap((k) => styles.get(k) ?? []))];
      for (const s of st.reverse()) node = { name: s, attrs: {}, children: [node] };
    }
    children.push(node);
  }
  return { ...el, children };
}

/** The level that starts chapters: the top one used more than once, else none. */
function chapterLevel(levels: number[]): number | null {
  const count = new Map<number, number>();
  for (const l of levels) count.set(l, (count.get(l) ?? 0) + 1);
  const many = [...count].filter(([, n]) => n > 1).map(([l]) => l);
  return many.length ? Math.min(...many) : null;
}

export function parseGdocHtml(html: string, title: string | null): ParsedBook {
  const styles = classStyles(html);
  const doc = parseXml(html);
  const body = find(doc, "body") ?? doc;
  const col = new Collector();
  try {
    col.walk(transform(body, styles), new Map());
    col.block();
  } catch (err) {
    if (err instanceof EpubError && err.code === "too-much-text")
      throw new GdocError("too-much-text");
    throw err;
  }
  if (!col.lines.length) throw new GdocError("no-text");

  const htmlTitle = find(doc, "title");
  const firstHeading = col.headings.length ? col.lines[col.headings[0]] : undefined;
  const bookTitle = (
    title ||
    (htmlTitle ? textOf(htmlTitle).replace(/\s+/g, " ").trim() : "") ||
    firstHeading ||
    "Google Doc"
  ).slice(0, BOOK_LIMITS.maxTitleChars);

  const level = chapterLevel(col.levels);
  const chapters: BookChapter[] = [];
  if (level !== null) {
    col.headings.forEach((line, i) => {
      if (col.levels[i] > level) return;
      if (chapters.length && chapters[chapters.length - 1].start === line) return;
      chapters.push({ title: col.lines[line].slice(0, BOOK_LIMITS.maxTitleChars), start: line });
    });
    if (chapters.length && chapters[0].start !== 0)
      chapters.unshift({ title: bookTitle, start: 0 });
  }
  const lang = /<html[^>]*\blang="([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)"/i.exec(
    html.slice(0, 2000),
  )?.[1];

  return {
    title: bookTitle,
    ...(lang ? { lang } : {}),
    lines: col.lines,
    chapters: chapters.slice(0, BOOK_LIMITS.maxChapters),
    headings: col.headings,
    marks: col.marks.slice(0, BOOK_LIMITS.maxMarks),
    breaks: col.breaks,
    continues: col.continues,
  };
}
