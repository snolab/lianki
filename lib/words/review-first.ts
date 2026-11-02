/**
 * Reviews before new words on /words (owner, 2026-11-03): every due card is
 * shown before the next new word, so a day spent only on new words can never
 * leave old cards waiting for good.
 *
 * Pure, no I/O. The study view (`Study` in WordsClient.tsx) asks the server
 * for due cards each time it needs more rows, and takes new words only when
 * no due card is left that is not already in the queue.
 */
import { fsrs } from "ts-fsrs";
import { parseCard } from "./schedule";

const scheduler = fsrs();

/** The chance this card is still remembered now (0..1); 0 when it cannot be read. */
export function retrievability(cardJson: string | null | undefined, now: Date): number {
  const card = parseCard(cardJson);
  if (!card) return 0;
  try {
    const r = scheduler.get_retrievability(card, now, false);
    return Number.isFinite(r) ? r : 0;
  } catch {
    return 0;
  }
}

/**
 * Due cards in study order: highest forgetting probability (lowest
 * retrievability) first, then the most overdue. Lists are mixed by that
 * order, not taken in turns. Stable for equal keys.
 */
export function orderDue<T extends { card: string; due: string }>(
  cards: readonly T[],
  now: Date,
): T[] {
  return cards
    .map((c, i) => ({ c, i, r: retrievability(c.card, now), d: Date.parse(c.due) || 0 }))
    .sort((a, b) => a.r - b.r || a.d - b.d || a.i - b.i)
    .map((x) => x.c);
}

/** The session route returns at most this many due cards per request. */
export const MAX_DUE_FETCH = 1000;

/**
 * How many due cards to ask for so that `page` of them are not in the queue
 * yet. The server orders by due date with no offset, and the cards already
 * queued (`queuedDue`) come back among them.
 */
export const dueFetchLimit = (queuedDue: number, page: number) =>
  Math.min(MAX_DUE_FETCH, queuedDue + page);

/**
 * What the next batch of rows is: due cards not in the queue yet (in study
 * order) when there are any, otherwise new words. `fresh` is called only
 * when no due card is waiting.
 */
export async function nextBatch<D, N>(o: {
  due: readonly D[];
  fresh: () => Promise<N[]>;
}): Promise<{ kind: "due"; items: D[] } | { kind: "new"; items: N[] }> {
  if (o.due.length) return { kind: "due", items: [...o.due] };
  return { kind: "new", items: await o.fresh() };
}
