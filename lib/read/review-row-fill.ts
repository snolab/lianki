// What a review list's rows are filled with once they come near the screen
// (owner, 2026-11-06 23:07 JST: "gain/issues have no explaination, why?";
// 2026-11-07 16:39: "show translation in the example sentences column"): a new
// word's meaning, without swiping it first, and the example's translation. Only
// rows in or near view ask (Study's IntersectionObserver), a few at a time, and
// a row that left before its turn is dropped, so a long list never asks for
// everything on opening and a fast scroll pays for nothing it passed.
//
// Pure: the asking itself is given (the reader's lib/read/select-gloss-fetch.ts
// and select-translate-fetch.ts, which cache per tab and share one call per word).
// docs/books-plan.md, "Review a range's words".

import { normText, translationParts } from "./translate";

/** Requests in flight per kind: enough to fill a screen quickly, not a burst of a screen's worth. */
export const FILL_LANES = 3;

/** A few at a time, in the order asked, each key once; what left before its turn is dropped. */
export function nearQueue(lanes: number, run: (key: string) => Promise<unknown>) {
  const waiting = new Set<string>();
  const asked = new Set<string>();
  let busy = 0;
  const start = (k: string) => {
    waiting.delete(k);
    asked.add(k);
    busy++;
    void run(k)
      .catch(() => {})
      .finally(() => {
        busy--;
        pump();
      });
  };
  const pump = () => {
    for (const k of waiting) {
      if (busy >= lanes) return;
      start(k);
    }
  };
  return {
    enter(k: string) {
      if (asked.has(k) || waiting.has(k)) return;
      waiting.add(k);
      pump();
    },
    leave(k: string) {
      waiting.delete(k);
    },
    /** It cannot wait for its turn any more (a swipe is committing it). */
    now(k: string) {
      if (waiting.has(k)) start(k);
    },
  };
}

/** The same language: by the base tag ("en" and "en-GB"); an unknown one is never the same. */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  const base = (t: string | null | undefined) => t?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const x = base(a);
  return !!x && x !== "und" && x === base(b);
}

/**
 * A translation for one row's cell, in the owner's own form for translator's
 * notes: "use (...) to explain the cultural difference" (2026-11-06). Plain text,
 * so a row, its tooltip and its measuring take it as they take a deck's.
 */
export function rowTranslation(out: string): string {
  return translationParts(out)
    .map((p) => (p.note ? ` (${p.text}) ` : p.text))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export type FillRow = {
  listId: string;
  term: string;
  back: string;
  lang: string;
  ex?: string;
  exTr?: string;
  /** Stored card; none: a new word. */
  card?: string;
};
export type RowPatch = {
  back?: string;
  /** A new word with no meaning: on its way, or none came (calm; the row still swipes). */
  backState?: "loading" | "none";
  exTr?: string;
};
export type Patch = (listId: string, term: string, p: RowPatch) => void;
/** What Study calls as its rows come near the screen and leave it. */
export type RowFill = {
  enter(row: FillRow, patch: Patch): void;
  leave(row: FillRow): void;
};

export type Meaning = { term: string; back: string | null };

export function createRowFill(deps: {
  /** The learner's language. */
  to: string;
  /** The word as the reader knows it; none: no new word of this review. */
  wordOf(listId: string, term: string): { w: string; ex: string | null } | undefined;
  gloss(w: string, ex: string | null): Promise<Meaning | null>;
  translate(text: string, lang: string): Promise<string | null>;
  lanes?: number;
}): RowFill & {
  /** Its meaning, for the commit: what was found, once what is on its way has landed. */
  meaningOf(listId: string, term: string): Promise<Meaning | null> | undefined;
} {
  const keyOf = (listId: string, term: string) => `${listId}\u0000${term}`;
  type Slot = { row: FillRow; patch: Patch };
  const slots = new Map<string, Slot>();
  /** What came, replayed for a row that shows again (its copy, a re-render of the list). */
  const meanings = new Map<string, Promise<Meaning | null>>();
  const gotBack = new Map<string, RowPatch>();
  const gotTr = new Map<string, string | null>();

  const apply = (k: string, p: RowPatch) => {
    const s = slots.get(k);
    if (s) s.patch(s.row.listId, s.row.term, p);
  };
  const lanes = deps.lanes ?? FILL_LANES;
  const glossQ = nearQueue(lanes, (k) => {
    const { row } = slots.get(k)!;
    const word = deps.wordOf(row.listId, row.term);
    if (!word) return Promise.resolve();
    const m = deps.gloss(word.w, word.ex).catch(() => null);
    meanings.set(k, m);
    return m.then((g) => {
      const p: RowPatch = g?.back
        ? { back: g.back, backState: undefined }
        : { backState: "none" as const };
      gotBack.set(k, p);
      apply(k, p);
    });
  });
  const transQ = nearQueue(lanes, (k) => {
    const { row } = slots.get(k)!;
    return deps
      .translate(row.ex!, row.lang)
      .catch(() => null)
      .then((out) => {
        const text = out ? rowTranslation(out) : "";
        // Said back as it was: the sentence is already in his language.
        const tr = text && normText(text) !== normText(row.ex!) ? text : null;
        gotTr.set(k, tr);
        if (tr) apply(k, { exTr: tr });
      });
  });

  return {
    enter(row, patch) {
      const k = keyOf(row.listId, row.term);
      slots.set(k, { row, patch });
      const wantsMeaning = !row.back && !row.card && !!deps.wordOf(row.listId, row.term);
      if (wantsMeaning) {
        const had = gotBack.get(k);
        if (had) patch(row.listId, row.term, had);
        else {
          patch(row.listId, row.term, { backState: "loading" });
          glossQ.enter(k);
        }
      }
      if (row.ex && !row.exTr && !sameLanguage(row.lang, deps.to)) {
        const tr = gotTr.get(k);
        if (tr) patch(row.listId, row.term, { exTr: tr });
        else if (tr === undefined) transQ.enter(k);
      }
    },
    leave(row) {
      const k = keyOf(row.listId, row.term);
      glossQ.leave(k);
      transQ.leave(k);
    },
    meaningOf(listId, term) {
      const k = keyOf(listId, term);
      glossQ.now(k);
      return meanings.get(k);
    },
  };
}
