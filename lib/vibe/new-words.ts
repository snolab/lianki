// The 新词 list of a /vibe conversation (docs/vibe.md, "新词"): what the words
// heard are, in the reader's own marks, and adding one by a swipe. Pure, with the
// network and timers injected.
//
// Nothing here makes a card by itself. Reading the list and opening a word only
// read: `/words`, a probe, and a gloss with `cached: true` (decks and shared
// glosses, no model, no charge). Only `commit`, which the slider's grade calls,
// may write, and it first holds for GRADE_HOLD_MS as a reader grade does, so an
// Undo in that time spends nothing and stores nothing. The card and its AI
// meaning come from the same batch-grade the reader's preview card uses.
import type { WordProbe } from "@/lib/read/batch-grade";
import { famMap, type Fam, type WordRow } from "@/lib/read/reader-model";
import type { SwipeRating } from "@/lib/words/swipe";

export type WordKind = "new" | "due" | "learning" | "known";

export type HeardWord = {
  w: string;
  count: number;
  /** The reader's mark (`data-f`): the same underline as in the book. */
  fam: Fam;
  kind: WordKind;
  /** Has a card already: nothing to add. */
  carded: boolean;
};

const ORDER: Record<WordKind, number> = { new: 0, due: 1, learning: 2, known: 3 };

/** Is this card due now, by the probe? */
const isDue = (p: WordProbe | undefined, now: number) =>
  !!p?.due && (p.reps === 0 || Date.parse(p.due) <= now);

/**
 * The list: words with no card first (what there is to add), then due, learning
 * and known, each by how often it was heard. Names count as known, as in the
 * reader, so they suggest nothing.
 */
export function heardWords(
  rows: readonly WordRow[],
  probes: ReadonlyMap<string, WordProbe>,
  now: number,
): HeardWord[] {
  const fams = famMap(rows, () => false);
  const out: HeardWord[] = rows.map(([w, count, score]) => {
    const fam = fams.get(w) ?? "u";
    const carded = score >= 0;
    const kind: WordKind =
      !carded && fam !== "k"
        ? "new"
        : carded && isDue(probes.get(w), now)
          ? "due"
          : fam === "k"
            ? "known"
            : "learning";
    return { w, count, fam, kind, carded };
  });
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.count - a.count);
}

/** The words a due check is worth asking about: cards only, within the route's cap. */
export const PROBE_MAX = 400;
export const probeWords = (rows: readonly WordRow[]) =>
  rows
    .filter(([, , score]) => score >= 0)
    .slice(0, PROBE_MAX)
    .map(([w]) => ({ w }));

/** The line a word was first heard in, with that line's language. */
export function firstHeard<L extends { text: string; lang?: string }>(
  w: string,
  lines: readonly L[],
): L | null {
  const low = w.toLowerCase();
  return lines.find((l) => l.text.toLowerCase().includes(low)) ?? null;
}

export type Commit = { id: string; rating: SwipeRating; state: "held" | "sending" | "sent" };

export type CommitDeps = {
  post(body: Record<string, unknown>, keepalive: boolean): Promise<unknown>;
  holdMs: number;
  newId(): string;
  day(): string;
  /** A word's state changed (added, undone, failed). */
  onChange(): void;
  onFailed?(w: string): void;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

/** One held or sent card per word: the swipe's commit, its hold and its undo. */
export function createCommits(d: CommitDeps) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const entries = new Map<string, Commit & { timer?: unknown; body: Record<string, unknown> }>();
  const takeBack = (id: string, w: string) =>
    void d.post({ undo: id, day: d.day() }, false).catch(() => d.onFailed?.(w));

  const send = (w: string, keepalive = false) => {
    const e = entries.get(w);
    if (!e || e.state !== "held") return;
    clearTimer(e.timer);
    e.state = "sending";
    d.post(e.body, keepalive).then(
      () => {
        // Undone on its way: taken back now that there is something to take back.
        if (entries.get(w) === e) e.state = "sent";
        else takeBack(e.id, w);
        d.onChange();
      },
      () => {
        if (entries.get(w) === e) entries.delete(w);
        d.onFailed?.(w);
        d.onChange();
      },
    );
  };

  return {
    /** The slider's grade on a word with no card. Nothing leaves until the hold ends. */
    commit(w: string, ex: string | null, rating: SwipeRating) {
      if (entries.has(w)) return;
      const id = d.newId();
      const body = {
        clientId: id,
        rating,
        sentences: [],
        words: [{ w, ex }],
        day: d.day(),
        swipedAt: new Date().toISOString(),
      };
      const e: Commit & { timer?: unknown; body: typeof body } = {
        id,
        rating,
        state: "held",
        body,
      };
      e.timer = setTimer(() => send(w), d.holdMs);
      entries.set(w, e);
      d.onChange();
    },
    /** Take it back: while held nothing was sent; after, the server restores it. */
    undo(w: string) {
      const e = entries.get(w);
      if (!e) return;
      clearTimer(e.timer);
      entries.delete(w);
      d.onChange();
      if (e.state === "sent") takeBack(e.id, w);
    },
    /** Leaving the page: what he swiped is still his. */
    flush() {
      for (const w of [...entries.keys()]) send(w, true);
    },
    has: (w: string) => entries.has(w),
    state: (w: string) => entries.get(w)?.state ?? null,
    /** The words added here, newest last. */
    added: () => [...entries.keys()],
  };
}
