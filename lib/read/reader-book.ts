// Server side of reader v2: a material as sentences, paragraphs and chapters,
// cached per isolate by content hash (a few books, small typed arrays), and
// the access rule. docs/books-plan.md, "Review units".

import { flagIn, type FlagValues } from "@/lib/flags";
import type { ReadMaterial } from "@/lib/getReadMaterialsCollection";
import type { BookMeta } from "./book";
import { sentenceWords, type SentenceWords } from "./familiarity";
import type { Paragraph } from "./reader-api";
import { bookHash, chapterRanges, paragraphsOf, segmentBook, type BookSentences } from "./units";
import { wordLang } from "./words";

/** Reader v2 for this user: the flag for everyone, else the owner alone. */
export function readerV2On(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return flagIn(flags, "read.reader-v2") || owner;
}

/** The side-by-side word review in the reader (flag `read.side-review`): the flag, else the owner alone. */
export function sideReviewOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return flagIn(flags, "read.side-review") || owner;
}

export interface ReaderBook {
  hash: string;
  lang: string;
  lines: string[];
  sentences: BookSentences;
  paragraphs: Paragraph[];
  /** Chapter line ranges [start, end), by index into the book's chapters. */
  chapters: [number, number][];
  /** Running words per sentence, made on first use. */
  words(): SentenceWords;
}

const CACHE_MAX = 3;
const cache = new Map<string, ReaderBook>();

/** The material's content hash: stored, or computed (the caller saves it). */
export async function hashOf(m: Pick<ReadMaterial, "lines" | "contentHash">): Promise<string> {
  return m.contentHash ?? (await bookHash(m.lines));
}

export function readerBook(lines: string[], meta: BookMeta | null, hash: string): ReaderBook {
  const lang = wordLang(meta?.lang, lines);
  const key = `${hash}\n${lang}\n${meta?.breaks?.length ?? 0}\n${meta?.continues?.length ?? 0}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const sentences = segmentBook(lines, lang, hash);
  let sw: SentenceWords | null = null;
  const book: ReaderBook = {
    hash,
    lang,
    lines,
    sentences,
    paragraphs: paragraphsOf(lines.length, meta ?? {}),
    chapters: chapterRanges(
      lines.length,
      (meta?.chapters ?? []).map((c) => c.start).filter((s) => s < lines.length),
    ),
    words: () => (sw ??= sentenceWords(sentences, lines)),
  };
  cache.set(key, book);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return book;
}

/** The chapter index holding `line`. */
export function chapterOf(book: Pick<ReaderBook, "chapters">, line: number): number {
  let ans = 0;
  for (let i = 0; i < book.chapters.length; i++) if (book.chapters[i][0] <= line) ans = i;
  return ans;
}
