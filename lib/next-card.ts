/**
 * Which card to review next, out of a deck the page can see for itself.
 *
 * The rule matches the server's `NEXT_DUE_SORT` (`{"card.due": -1}` over cards
 * that are already due): among everything due, take the one that came due most
 * recently. Not the oldest — that buries you in a backlog you will never see the
 * end of, and the most recently due card is the one you last decided was worth
 * remembering.
 *
 * Kept pure and separate from the IndexedDB read so the choice can be tested
 * without a browser, and so the local deck and the cloud cannot drift apart on
 * what "next" means.
 */

export type DueCandidate = { url: string; title?: string; card: { due: string | Date } };

export function pickNextDue<T extends DueCandidate>(cards: T[], now = Date.now()): T | null {
  let best: T | null = null;
  let bestDue = -Infinity;
  for (const c of cards) {
    const due = new Date(c.card.due).getTime();
    // NaN from a malformed date fails every comparison, so such a card is
    // skipped rather than being treated as due at the epoch and served forever.
    if (!(due <= now)) continue;
    if (due > bestDue) {
      best = c;
      bestDue = due;
    }
  }
  return best;
}
