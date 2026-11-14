/** Read watermarks are observations, never delivery/history acknowledgments. */
export const validReadSeq = (seq: unknown): seq is number =>
  typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0;

export type ReadWatermark = { seen: number; sent: number; at: number | null };
export function advanceRead(
  state: ReadWatermark,
  seq: number,
  now: number,
  visible: boolean,
  throttleMs: number,
): { state: ReadWatermark; emit?: number; wait?: number } {
  if (!visible) return { state };
  const seen = validReadSeq(seq) ? Math.max(state.seen, seq) : state.seen;
  const next = { ...state, seen };
  if (seen <= state.sent) return { state: next };
  const throttle = Number.isFinite(throttleMs) ? Math.max(2000, throttleMs) : 2000;
  const wait = state.at === null ? 0 : Math.max(0, state.at + throttle - now);
  if (wait) return { state: next, wait };
  return { state: { seen, sent: seen, at: now }, emit: seen };
}

type Rect = { top: number; bottom: number; left: number; right: number };
/** Inline fragments can wrap: count actual text rectangles, not their empty bounding box. */
export function intersectsReadRect(rects: readonly Rect[], clip: Rect): boolean {
  return rects.some(
    (r) =>
      r.bottom > r.top &&
      r.right > r.left &&
      Math.min(r.bottom, clip.bottom) > Math.max(r.top, clip.top) &&
      Math.min(r.right, clip.right) > Math.max(r.left, clip.left),
  );
}

/** One dot per participant, using the largest cursor if old/new presence entries overlap. */
export function readersFor<T extends { key: string; lastReadSeq?: number; self?: true }>(
  seq: unknown,
  participants: readonly T[],
  ownerThread: boolean,
): T[] {
  if (!ownerThread || !validReadSeq(seq)) return [];
  const byKey = new Map<string, T>();
  for (const p of participants) {
    if (p.self || !validReadSeq(p.lastReadSeq)) continue;
    const old = byKey.get(p.key);
    if (!old || p.lastReadSeq > old.lastReadSeq!) byKey.set(p.key, p);
  }
  return [...byKey.values()].filter((p) => p.lastReadSeq! >= seq);
}
