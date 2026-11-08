/**
 * The reader's word scan (BookScan in app/(app)/reader/BookWords.tsx): a book's
 * distinct words sorted into mastered, learning, new, names and unrecognised.
 * Pure, so the panel's numbers are tested (unit/read-scan-buckets.test.ts).
 *
 * - **Mastered / learning**: the reader has a card (score ≥ 0); mastered as the
 *   server marks it, else learning.
 * - **New**: no card, but studiable: in his own deck, marked as in the
 *   language's dictionary by the server, or in one of Lianki's word lists
 *   (directly or through a headword).
 * - **Names**: none of those, and the server marks it a proper name.
 * - **Unrecognised**: the rest, in the order the rows came (most frequent first).
 */

/** /api/read/[id]/words rows; the last two only for words without a card. */
export type WordRow = [
  word: string,
  count: number,
  score: number,
  mastered: 0 | 1,
  ownDeck: 0 | 1,
  name: 0 | 1,
  inDictionary?: 0 | 1,
  heads?: string[],
];

export type ScanBuckets = {
  mastered: number;
  learning: number;
  fresh: number;
  names: number;
  unrecognised: string[];
};

/**
 * `lists.word(w)`: is the word, in any form, in one of Lianki's word lists for
 * the book's language (lib/read/words.ts inKeys)? `lists.head(h)`: is this
 * headword a list key as it is?
 */
export function scanBuckets(
  rows: readonly WordRow[],
  lists: { word: (w: string) => boolean; head: (h: string) => boolean },
): ScanBuckets {
  const out: ScanBuckets = { mastered: 0, learning: 0, fresh: 0, names: 0, unrecognised: [] };
  for (const [w, , score, mastered, ownDeck, name, inDictionary, heads] of rows) {
    if (score >= 0) {
      if (mastered) out.mastered++;
      else out.learning++;
    } else if (ownDeck || inDictionary || lists.word(w) || heads?.some(lists.head)) out.fresh++;
    else if (name) out.names++;
    else out.unrecognised.push(w);
  }
  return out;
}

/**
 * Whether the reader's scan panel shows its details on this device
 * (docs/prefs-sync.md: device, a matter of screen room). "1" / "0"; absent,
 * open on a wide screen and folded on a phone, where the book comes first.
 */
export const SCAN_OPEN_KEY = "lk:read-scan-open";

export function scanOpenAtStart(stored: string | null, wide: boolean): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  return wide;
}
