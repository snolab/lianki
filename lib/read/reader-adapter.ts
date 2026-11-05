// What the reader v2 needs from the server, behind one interface, so the UI
// does not wait for the backend (feat/reader-data, lib/read/reader-api.ts:
// sentence ids, items sized by his reading time, per-sentence FSRS grades, a
// synced position). Until that lands, `localReaderData` serves it on the
// device: items from the book's lines (lib/read/reader-model.ts), grades
// kept in memory for this visit only, the position in the device cache. It
// serves guests, the MongoDB backend, and anyone the server says reader v2 is
// off for; everyone else gets lib/read/reader-server.ts.

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
  /** The server's idempotency key (a grade waiting to be sent). */
  clientId?: string;
}

/** What `load` gives the page. */
export interface Loaded {
  blocks: Block[];
  /** Each line's sentences as [start, end) (the server's cuts); absent: cut on the device. */
  cuts?: Map<number, [number, number][]>;
  /** Items' last grades already given (rail tint). */
  grades?: Record<string, SwipeRating>;
}

export interface ReaderData {
  /** "local": derived on this device; "server": the backend's (lib/read/reader-server.ts). */
  readonly source: "local" | "server";
  load(book: ReaderBook): Promise<Loaded>;
  /** The item's last grade, for the rail. */
  lastGrade(itemId: string): SwipeRating | null;
  grade(
    book: ReaderBook,
    item: Extract<Block, { kind: "item" }>,
    r: SwipeRating,
    info?: { shownAt?: number },
  ): Promise<GradeReceipt>;
  /** This grade can still be taken back. */
  canUndo(receipt: GradeReceipt): boolean;
  undo(book: ReaderBook, receipt: GradeReceipt): Promise<void>;
  /**
   * Take a grade back even once it was sent (the selection card's handle):
   * held, as `undo`; sent, the server restores its sentences' states.
   */
  revert(book: ReaderBook, receipt: GradeReceipt): Promise<void>;
  anchor(bookId: string): Promise<Anchor | null>;
  saveAnchor(bookId: string, a: Anchor, opts?: { leaving?: boolean }): void;
  /** Send what waits (the page is going away). */
  flush(): void;
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
    load: async (b) => ({
      blocks: localItems({
        lines: b.lines,
        headings: b.headings,
        chapterStarts: b.chapterStarts,
        lang: b.lang,
        target: itemWords(START_WPM),
      }),
    }),
    canUndo: () => true,
    flush: () => {},
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
    async revert(b, r) {
      await this.undo(b, r);
    },
    anchor: async (id) => loadAnchor(id),
    saveAnchor: (id, a) => saveAnchor(id, a),
  };
}
