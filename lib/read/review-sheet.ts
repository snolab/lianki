// The reader's word review as a bottom sheet (owner, 2026-11-09 00:51 JST:
// "the review list must not be full screen" — it slides up from the bottom
// and leaves a gap at the top, so the reading text behind stays visible;
// dragging its top edge resizes it and drags it away). Pure, so the snaps
// and the release rule are unit-tested (unit/read-review-sheet.test.ts);
// reader-word-review.tsx draws it.
//
// Heights are shares of the visible viewport, never fixed pixel sizes
// (design-principles.md, "No fixed numbers"): a compact sheet over half the
// screen, the default leaving about a quarter of the text visible above, and
// the tallest leaving only the reserve (the notch plus a strip of text).

/** The sheet's resting heights, shortest first, as shares of the viewport. */
export const SNAP_SHARES = [0.5, 0.75] as const;
/** The sheet goes away when let go under this share of its shortest snap. */
export const CLOSE_SHARE = 0.7;
/** A downward fling this fast (px/ms) closes it from any height. */
export const FLING_V = 0.6;

/**
 * The resting heights for a viewport `vh` px tall, shortest first. `reserve`:
 * what always stays visible above the tallest sheet (the notch and a strip of
 * the text), px.
 */
export function sheetSnaps(vh: number, reserve: number): number[] {
  const max = Math.max(0, vh - reserve);
  const out = SNAP_SHARES.map((s) => Math.min(max, Math.round(vh * s)));
  out.push(Math.round(max));
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The height while dragged: the finger's, never past the tallest snap, never under 0. */
export function dragHeight(h0: number, dy: number, snaps: readonly number[]): number {
  const max = snaps[snaps.length - 1] ?? h0;
  return Math.max(0, Math.min(max, h0 - dy));
}

/**
 * Where a drag ends: closed, or a resting height — the nearest to where the
 * finger let go, or after a quick flick the next one in its direction (a
 * flick down past the shortest closes). `v`: release velocity, px/ms,
 * positive downward.
 */
export function sheetRelease(
  h0: number,
  dy: number,
  v: number,
  snaps: readonly number[],
): { close: true } | { close: false; h: number } {
  if (!snaps.length) return { close: true };
  const h = dragHeight(h0, dy, snaps);
  if (h < snaps[0] * CLOSE_SHARE) return { close: true };
  if (v >= FLING_V && dy > 0) {
    const below = snaps.filter((s) => s < h - 1);
    return below.length ? { close: false, h: below[below.length - 1] } : { close: true };
  }
  if (v <= -FLING_V && dy < 0) {
    const above = snaps.find((s) => s > h + 1);
    return { close: false, h: above ?? snaps[snaps.length - 1] };
  }
  let best = snaps[0];
  for (const s of snaps) if (Math.abs(s - h) < Math.abs(best - h)) best = s;
  return { close: false, h: best };
}
