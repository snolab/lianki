// The AI polish of a raw speech-to-text transcript (docs/books-plan.md,
// "Import pipeline", step 3). Offered only when the detector says raw
// transcript (lib/read/prep.ts detectShape), applied only when he taps it.
//
// The same rule as the chat's polish of a voice line (docs/dev-debug-widget.md,
// "Agent edits of voice messages"): punctuation, case, spacing and the breaks
// between sentences and paragraphs may change; the words may not. Here the
// check is stricter, as a whole book has no context to judge a replaced word
// by: the polished chunk's words (letters and digits, NFKC, lower case) must
// be the raw chunk's, in order, but for hesitation sounds (LangData.fillers),
// which it may drop. A chunk that fails keeps its raw text. The raw text is
// kept beside the polished one (read_material_raw), never overwritten.
//
// Pure: the model call and the store are lib/read/polish-server.ts.

import type { ParsedBook } from "./book";
import { stripFillers } from "./prep";
import type { InlineMark } from "./reader-api";

/** Characters of raw text per model call: a chunk the model answers in one go. */
export const POLISH_CHUNK_CHARS = 3000;

/** A run of body lines polished together (never across a heading). */
export interface PolishChunk {
  lines: number[];
  text: string;
}

/** The book's body lines in chunks of about POLISH_CHUNK_CHARS, never across a heading. */
export function polishChunks(
  lines: readonly string[],
  headings: ReadonlySet<number>,
  max = POLISH_CHUNK_CHARS,
): PolishChunk[] {
  const out: PolishChunk[] = [];
  let cur: number[] = [];
  let len = 0;
  const flush = () => {
    if (cur.length) out.push({ lines: cur, text: cur.map((l) => lines[l]).join("\n\n") });
    cur = [];
    len = 0;
  };
  lines.forEach((l, i) => {
    if (headings.has(i)) return flush();
    if (cur.length && len + l.length > max) flush();
    cur.push(i);
    len += l.length + 2;
  });
  flush();
  return out;
}

export function polishMessages(text: string) {
  return [
    {
      role: "system" as const,
      content:
        "You get a raw speech-to-text transcript: it may lack punctuation, capitals and " +
        "paragraphs, and may switch between languages. Make it readable: add the punctuation " +
        "and capitals each language uses, end every sentence, and break it into paragraphs " +
        "(an empty line between them), starting a new paragraph where the topic or the " +
        "language changes. Never add, remove, reorder or replace a word, and never translate; " +
        "you may drop hesitation sounds (um, uh, 嗯). Answer with the text only.",
    },
    { role: "user" as const, content: text },
  ];
}

/** The words of a text as the check compares them: no fillers, letters, marks and digits only. */
export function polishKey(text: string): string {
  return stripFillers(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

/**
 * The model's answer as paragraphs, or null when it changed a word (or said
 * nothing): then the chunk keeps its raw text.
 */
export function checkPolish(raw: string, out: string): string[] | null {
  const paras = out
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!paras.length) return null;
  const want = polishKey(raw);
  if (!want || polishKey(paras.join(" ")) !== want) return null;
  return paras;
}

/**
 * The book with each chunk's lines replaced by its polished paragraphs
 * (null: kept raw). Headings stay, chapter starts follow their line (a
 * chapter starting inside a chunk starts at the chunk's first paragraph);
 * marks stay on lines kept raw. The result goes through biteSize after.
 */
export function applyPolish(
  book: ParsedBook,
  chunks: readonly PolishChunk[],
  polished: readonly (string[] | null)[],
): ParsedBook {
  const byFirst = new Map<number, number>();
  chunks.forEach((c, k) => byFirst.set(c.lines[0], k));
  const inChunk = new Map<number, number>();
  chunks.forEach((c, k) => c.lines.forEach((l) => inChunk.set(l, k)));
  const lines: string[] = [];
  const headings: number[] = [];
  const newOf = new Map<number, number>();
  const kept = new Map<number, number>();
  const heads = new Set(book.headings);
  for (let l = 0; l < book.lines.length; l++) {
    const k = inChunk.get(l);
    if (k !== undefined && polished[k]) {
      if (byFirst.get(l) === k) {
        for (const src of chunks[k].lines) newOf.set(src, lines.length);
        lines.push(...polished[k]!);
      }
      continue;
    }
    newOf.set(l, lines.length);
    kept.set(l, lines.length);
    if (heads.has(l)) headings.push(lines.length);
    lines.push(book.lines[l]);
  }
  const chapters = [];
  for (const c of book.chapters) {
    const start = newOf.get(c.start);
    if (start === undefined) continue;
    if (chapters.length && start <= chapters[chapters.length - 1].start) continue;
    chapters.push({ ...c, start });
  }
  const marks = (book.marks ?? []).flatMap(([l, a, z, kind]) => {
    const n = kept.get(l);
    return n === undefined ? [] : [[n, a, z, kind] as InlineMark];
  });
  return {
    ...book,
    lines,
    headings,
    chapters,
    ...(book.marks ? { marks } : {}),
    breaks: [],
    continues: [],
  };
}
