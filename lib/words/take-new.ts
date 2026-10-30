/**
 * New words for /words: walk a list's catalog from its stored cursor and take
 * the next `n` words that have no card yet.
 *
 * The cursor ("first catalog index not yet introduced") is only a shortcut.
 * Two rules keep it from losing words:
 *
 * - It moves past a checked slice only as far as the last word taken. Until
 *   2026-10-31 it jumped to the end of the slice (twice as many words as were
 *   taken), so the rest of every batch was skipped for good and saved to D1:
 *   the owner's JLPT N5 reached 710/710 with 200 words never shown, and the
 *   page said "every word learned".
 * - When it reaches the end, the words before where this session started are
 *   checked once more (the server's /known says which have cards), so words
 *   an older cursor skipped come back. Only when that check can run: offline,
 *   it would offer words that already have cards.
 */

/** Per list, for one study session. */
export type NewScan = {
  /** Next catalog index to check. */
  next: number;
  /** Where the session started (the stored cursor): the re-scan stops there. */
  start: number;
  /** In the re-scan of [0, start). */
  rescan: boolean;
  /** The re-scan ran to its end (or was not needed). */
  done: boolean;
};

export const newScan = (cursor: number): NewScan => ({
  next: cursor,
  start: cursor,
  rescan: false,
  done: cursor <= 0,
});

/** Which of these terms have a card; null when it cannot be checked (offline). */
export type CheckKnown = (terms: string[]) => Promise<Set<string> | null>;

/** The /known route takes at most 500 terms. */
export const MAX_CHECK = 500;

/**
 * Up to `n` catalog indices with no card yet, in catalog order (the re-scan's
 * come after the end is reached). Mutates `scan`.
 */
export async function takeNewIndices(
  terms: readonly string[],
  scan: NewScan,
  n: number,
  check: CheckKnown,
): Promise<number[]> {
  const out: number[] = [];
  while (out.length < n) {
    const stop = scan.rescan ? scan.start : terms.length;
    if (scan.next >= stop) {
      if (scan.rescan || scan.done) {
        scan.done = true;
        // Past the re-scan: carry on after the start (words the first pass
        // queued, or a catalog that grew).
        if (scan.rescan) {
          scan.rescan = false;
          scan.next = Math.max(scan.start, terms.length);
        }
        break;
      }
      scan.rescan = true;
      scan.next = 0;
      continue;
    }
    const from = scan.next;
    const slice = terms.slice(
      from,
      Math.min(stop, from + Math.min(MAX_CHECK, Math.max(n * 2, 40))),
    );
    const known = await check(slice);
    if (!known) {
      // Offline: the first pass trusts the cursor; the re-scan waits for the network.
      if (scan.rescan) break;
    }
    let next = from + slice.length;
    for (let i = 0; i < slice.length; i++) {
      if (known?.has(slice[i])) continue;
      out.push(from + i);
      if (out.length >= n) {
        // Stop right after the last word taken: the rest is checked next time.
        next = from + i + 1;
        break;
      }
    }
    scan.next = next;
  }
  return out;
}
