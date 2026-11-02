/**
 * The study toolbar's "{new} unseen": words in the lists being studied that
 * have never been shown, i.e. still have no card.
 *
 * /words is an endless scroll with no daily new-word quota (owner, 2026-10-31),
 * so the count is not "new words left today" and not the size of the loaded
 * batch (that was 80 at the start of every session: two batches of 40). It is
 * what the scroll still holds: each list's size minus its cards when the
 * session started, minus the new words graded since. It only goes down as you
 * grade new words, and reaches 0 when every word in scope has been seen.
 */

/** One list in scope: its size (0 = unknown, e.g. a group row) and its cards at session start. */
export type ScopeList = { total: number; cards: number };

export function unseenLeft(lists: readonly ScopeList[], gradedNew: number): number {
  let left = 0;
  for (const l of lists) left += Math.max(0, l.total - l.cards);
  return Math.max(0, left - gradedNew);
}

/**
 * New words graded this session, each counted once: a re-grade, or the same
 * word met again after a miss (it comes back as "again"), is not a second
 * new word.
 */
export function countGradedNew(
  queue: readonly { kind: string; listId: string; term: string }[],
  graded: Iterable<number>,
): number {
  const seen = new Set<string>();
  for (const i of graded) {
    const it = queue[i];
    if (it?.kind === "new") seen.add(`${it.listId}\u0000${it.term}`);
  }
  return seen.size;
}
