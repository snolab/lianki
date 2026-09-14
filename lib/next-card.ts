/**
 * Which card to review next, out of a deck the page can see for itself.
 *
 * The rule matches the server's `NEXT_DUE_SORT` (`{"card.due": -1}` over cards
 * that are already due): among everything due, take the one that came due most
 * recently. Not the oldest — that buries you in a backlog you will never see the
 * end of, and the most recently due card is the one you last decided was worth
 * remembering.
 *
 * On top of that, cards on the host you are already on come first. Reviewing is
 * a chain of page loads, and a same-host hop is a cheap one: warm caches, a live
 * session, no context switch for the reader either. FSRS does not care what
 * order due cards are cleared in, so grouping them costs nothing. It is a
 * PREFERENCE, never a filter — once the host is drained the pick falls through
 * to the plain rule, so you cannot get trapped on one site.
 *
 * Kept pure and separate from the IndexedDB read so the choice can be tested
 * without a browser, and so the local deck and the cloud cannot drift apart on
 * what "next" means.
 */

export type DueCandidate = { url: string; title?: string; card: { due: string | Date } };

/** The host of a url, or null when it will not parse. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function pickNextDue<T extends DueCandidate>(
  cards: T[],
  now = Date.now(),
  preferHost: string | null = null,
): T | null {
  let best: T | null = null;
  let bestDue = -Infinity;
  let bestSameHost = false;
  for (const c of cards) {
    const due = new Date(c.card.due).getTime();
    // NaN from a malformed date fails every comparison, so such a card is
    // skipped rather than being treated as due at the epoch and served forever.
    if (!(due <= now)) continue;
    const sameHost = preferHost !== null && hostOf(c.url) === preferHost;
    // Same host beats a later due date; among equals, the later due date wins.
    if (sameHost !== bestSameHost ? sameHost : due > bestDue) {
      best = c;
      bestDue = due;
      bestSameHost = sameHost;
    }
  }
  return best;
}
