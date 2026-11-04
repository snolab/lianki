/**
 * A miss comes back (/words learning steps): grading a word due again within
 * the session queues a copy of it, which joins the list further down once
 * due. Until then the graded slip counts down; from then on it reads
 * "↓ back" (words-page `back`) and is **retired**: the copy below is the one
 * to answer. A retired slip is frozen — no swipe, no grade, no undo — or it
 * would grade the word a second time beside its copy (the owner,
 * 2026-11-03: "回来了" slips could still be swiped).
 *
 * Before it is due the copy is only waiting, so a re-grade or an undo of the
 * slip takes it back (`withdraw`): an undone word must not come back as a
 * ghost, and a re-grade queues a copy from its own new card or none.
 *
 * Pure: indices are queue positions; the page keeps the state in refs.
 */

export type Waiting<T> = { item: T; due: number; from: number };

export type Requeue<T> = {
  /** Slips whose copy is waiting or already in the list. */
  requeued: ReadonlySet<number>;
  /** Copies not yet in the list, each with the slip it came from. */
  later: readonly Waiting<T>[];
};

export const emptyRequeue = <T>(): Requeue<T> => ({ requeued: new Set(), later: [] });

/**
 * The slip reads "↓ back": its copy is due (in the list, or about to join it
 * when the hand rests). `due`: when the slip's own grade comes back, ms.
 */
export function isRetired(
  q: Requeue<unknown>,
  i: number,
  due: number | undefined,
  now: number,
): boolean {
  return q.requeued.has(i) && due !== undefined && due <= now;
}

/** Take back slip i's copy while it is still waiting (re-grade or undo before due). */
export function withdraw<T>(q: Requeue<T>, i: number): Requeue<T> {
  if (!q.requeued.has(i)) return q;
  const requeued = new Set(q.requeued);
  requeued.delete(i);
  return { requeued, later: q.later.filter((w) => w.from !== i) };
}

/**
 * Slip i was just graded, its card due again at `due`: queue its copy when
 * that is within `windowMs`. Any copy from an earlier grade of the same slip
 * is withdrawn first, so a slip has at most one.
 */
export function afterGrade<T>(
  q: Requeue<T>,
  i: number,
  copy: T,
  due: number,
  now: number,
  windowMs: number,
): Requeue<T> {
  const base = withdraw(q, i);
  if (due - now >= windowMs) return base;
  return {
    requeued: new Set(base.requeued).add(i),
    later: [...base.later, { item: copy, due, from: i }],
  };
}

/**
 * The copies due by `now`, to insert at queue position `at`, and the state
 * after: every index at or past `at` moves down by the number inserted.
 */
export function takeDue<T>(
  q: Requeue<T>,
  now: number,
  at: number,
): { ready: T[]; next: Requeue<T>; shift: (i: number) => number } {
  const ready = q.later.filter((w) => w.due <= now);
  const n = ready.length;
  const shift = (i: number) => (i >= at ? i + n : i);
  if (!n) return { ready: [], next: q, shift };
  return {
    ready: ready.map((w) => w.item),
    shift,
    next: {
      requeued: new Set([...q.requeued].map(shift)),
      later: q.later.filter((w) => w.due > now).map((w) => ({ ...w, from: shift(w.from) })),
    },
  };
}

/**
 * What Z (or the touch Undo) undoes: the focused slip's grade if it has one,
 * else the latest grade in `log` — never a retired slip; the walk goes past
 * them. -1: nothing to undo.
 */
export function undoPick(
  log: readonly number[],
  at: number,
  focusedOnly: boolean,
  graded: (i: number) => boolean,
  retired: (i: number) => boolean,
): number {
  if (graded(at) && !retired(at)) return at;
  if (focusedOnly) return -1;
  for (let k = log.length - 1; k >= 0; k--) if (!retired(log[k])) return log[k];
  return -1;
}

/** Where a list edge `y` lies against the viewport (content coordinates). */
export type Where = "above" | "on" | "below";

/**
 * The viewport test for a scroller at `scrollTop`, `height` tall: an edge on
 * either border is off it (a row starting at the bottom border is not seen).
 */
export const viewport =
  (scrollTop: number, height: number) =>
  (y: number): Where =>
    y <= scrollTop ? "above" : y >= scrollTop + height ? "below" : "on";

/**
 * Where due copies join the list: **never into the viewport** (the owner,
 * 2026-11-05: a card appearing on screen after a review made the list jump).
 * Slot `at` is the edge above row `at` (`edge(at)`; `at` = `len` is the
 * tail), and only slots from `min` on — ahead of the focus — count. The
 * nearest one below the viewport, else the nearest above it (`above`: the
 * caller keeps the visible rows still by scrolling down by what it inserts).
 * null: no slot is off screen right now — the copies wait until a scroll, a
 * resize or the list growing makes one.
 */
export function offscreenSlot(
  min: number,
  len: number,
  edge: (at: number) => number,
  where: (y: number) => Where,
): { at: number; above: boolean } | null {
  let above = -1;
  for (let at = Math.max(0, min); at <= len; at++) {
    const w = where(edge(at));
    if (w === "below") return { at, above: false };
    if (w === "above") above = at;
  }
  return above < 0 ? null : { at: above, above: true };
}

/**
 * When to look again for a slot (ms from `now`): 0 when a copy is due now,
 * the wait for the next one otherwise, null with none waiting. One timer to
 * a known moment, not a poll.
 */
export function nextDueIn(q: Requeue<unknown>, now: number): number | null {
  if (!q.later.length) return null;
  return Math.max(0, Math.min(...q.later.map((w) => w.due)) - now);
}
