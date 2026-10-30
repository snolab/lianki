/**
 * Pure rules for the offline op queue (see lib/words/idb.ts `pending`).
 * Kept free of IndexedDB so they can be unit-tested.
 */
import type { PendingOp } from "./idb";

const key = (listId: string, term: string) => `${listId}\u0000${term}`;

/** Words with a review waiting to be sent: hide them from a cached session. */
export function pendingReviewed(ops: PendingOp[]): Set<string> {
  const s = new Set<string>();
  for (const o of ops) {
    if (o.op === "review") s.add(key(o.listId, o.term));
    else if (o.op === "undo") s.delete(key(o.listId, o.term));
  }
  return s;
}

/**
 * Lists as the learner last named them: a rename still waiting in the queue
 * wins over the (older) name the server or the offline copy holds, so a
 * refresh before it is sent does not flash the old name back.
 */
export function withPendingRenames<T extends { id: string; name: string }>(
  lists: T[],
  ops: PendingOp[],
): T[] {
  const names = new Map<string, string>();
  for (const o of sendOrder(ops))
    if (o.op === "rename" && typeof o.body.name === "string") names.set(o.listId, o.body.name);
  if (!names.size) return lists;
  return lists.map((l) => (names.has(l.id) ? { ...l, name: names.get(l.id)! } : l));
}

export const reviewedKey = key;

/**
 * Undoing a word whose review has not been sent yet just drops that op —
 * the server never needs to hear of it. Returns the op id to drop, or null
 * when the review already went out (then an undo op must be queued).
 */
export function undoTarget(ops: PendingOp[], listId: string, term: string): number | null {
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.op === "rename" || o.listId !== listId || o.term !== term) continue;
    return o.op === "review" && o.id != null ? o.id : null;
  }
  return null;
}

/** Ops in the order they must be sent: by id, i.e. the order they were made. */
export function sendOrder(ops: PendingOp[]): PendingOp[] {
  return [...ops].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

/**
 * What to do after sending an op: a network failure keeps it for the next try;
 * a request the server refuses (4xx) is dropped so it cannot block the queue.
 */
export function afterSend(status: number | "network"): "done" | "retry" | "drop" {
  if (status === "network") return "retry";
  if (status >= 200 && status < 300) return "done";
  if (status >= 500 || status === 401 || status === 429) return "retry";
  return "drop";
}

/** Wait before the next retry: doubling from 2 s, at most a minute. */
export function backoff(attempt: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, attempt));
}
