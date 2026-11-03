// What the reader v2 needs from the server, behind one interface, so the UI
// does not wait for the backend (feat/reader-data, lib/read/reader-api.ts:
// sentence ids, items sized by his reading time, per-sentence FSRS grades, a
// synced position). Until that lands, `localReaderData` serves it on the
// device: items from the book's lines (lib/read/reader-model.ts), grades
// kept in memory for this visit only, the position in the device cache.

import type { SwipeRating } from "@/lib/words/swipe";
import { type Block, itemWords, localItems } from "./reader-model";
import { type Anchor, loadAnchor, saveAnchor } from "./reader-pos";

export interface ReaderBook {
  id: string;
  lines: readonly string[];
  headings: ReadonlySet<number>;
  chapterStarts: ReadonlySet<number>;
  lang: string;
}

/** A grade as given, to take back with `undo`. */
export interface GradeReceipt {
  itemId: string;
  rating: SwipeRating;
  at: number;
}

export interface ReaderData {
  /** "local": derived on this device (no backend yet); "server": the backend's. */
  readonly source: "local" | "server";
  blocks(book: ReaderBook): Block[];
  /** The item's grades this visit (local) or its last grade (server), for the rail. */
  lastGrade(itemId: string): SwipeRating | null;
  grade(
    book: ReaderBook,
    item: Extract<Block, { kind: "item" }>,
    r: SwipeRating,
  ): Promise<GradeReceipt>;
  undo(book: ReaderBook, receipt: GradeReceipt): Promise<void>;
  anchor(bookId: string): Promise<Anchor | null>;
  saveAnchor(bookId: string, a: Anchor): void;
}

/**
 * A starting reading speed, words a minute, until his own is measured: a
 * common-knowledge figure for reading a foreign language (design-principles.md,
 * "No fixed numbers for users": a rule that holds at every scale, replaced by
 * his measured speed as data comes in — the backend's job).
 */
export const START_WPM = 120;

export function localReaderData(): ReaderData {
  const grades = new Map<string, SwipeRating[]>();
  return {
    source: "local",
    blocks: (b) =>
      localItems({
        lines: b.lines,
        headings: b.headings,
        chapterStarts: b.chapterStarts,
        lang: b.lang,
        target: itemWords(START_WPM),
      }),
    lastGrade: (id) => grades.get(id)?.at(-1) ?? null,
    async grade(_b, item, rating) {
      const list = grades.get(item.id) ?? [];
      list.push(rating);
      grades.set(item.id, list);
      return { itemId: item.id, rating, at: Date.now() };
    },
    async undo(_b, r) {
      const list = grades.get(r.itemId);
      if (!list) return;
      const i = list.lastIndexOf(r.rating);
      if (i >= 0) list.splice(i, 1);
    },
    anchor: async (id) => loadAnchor(id),
    saveAnchor: (id, a) => saveAnchor(id, a),
  };
}
