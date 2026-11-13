/**
 * The logic behind <VirtualList> (app/components/VirtualList.tsx): every list
 * of ours is windowed and loads more as you scroll, with no pages (owner,
 * 2026-11-10: "所有列表去掉分页，改虚拟列表").
 *
 * Pure functions only, so they are unit-tested here; the component is the
 * React and DOM glue around them (covered by scripts/qa/qa-virtual-list.mjs).
 *
 * Scroll position (owner, 2026-11-10 22:42 JST): remembered by the row at the
 * CENTRE of the viewport — its stable id, never a pixel offset or an index —
 * and restored by scrolling that id back to the centre. An id survives rows
 * inserted above it and rows loaded below it; an offset or an index does not.
 */

/** A laid-out row: what the virtualizer reports (start/end in scroll space). */
export type Placed = { index: number; start: number; end: number };

/** sessionStorage key name of a list's centre id (`lk:ui:list:<name>`, docs/ui-state.md). */
export const anchorStoreName = (name: string) => `list:${name}`;

/** At most this many batches are loaded to bring a remembered row back. */
export const RESTORE_MAX_BATCHES = 20;

/** Rows from the end at which the next batch is asked for. */
export const PREFETCH_ROWS = 5;

/**
 * Screens of list still below the viewport at which the next batch is asked
 * for, so it arrives before the reader gets there, even after a long fling (owner, 2026-11-14: "滚到下面
 * 再加载的时候会卡一下").
 */
export const PREFETCH_SCREENS = 5;

/**
 * Empty space kept below the last row while more may come, in screens: the
 * scroll never hits a hard end mid-load; once the list is known to be complete
 * it goes and the page settles back (owner: "哪怕滚完了再被弹回来都可以").
 */
export const RESERVE_SCREENS = 3;

/** The empty space (px) to keep below the rows: some while more may load, none at the end. */
export function reserveBelow(hasMore: boolean, viewport: number): number {
  return hasMore && viewport > 0 ? Math.round(viewport * RESERVE_SCREENS) : 0;
}

/**
 * The row under the viewport's centre line, as an index into the items, or
 * null when the centre is above the list (the list starts lower on the page:
 * nothing to remember) or there are no rows. Past the last row: the last row.
 * `rows` must be in index order (they are, from the virtualizer).
 */
export function centreIndex(rows: Placed[], offset: number, viewport: number): number | null {
  if (!rows.length) return null;
  const centre = offset + viewport / 2;
  if (centre < rows[0].start) return null;
  for (const r of rows) if (centre < r.end) return r.index;
  return rows[rows.length - 1].index;
}

/** How far the centre line sits below the row's top, in px (kept across inserts). */
export function centreDelta(row: Placed, offset: number, viewport: number): number {
  return offset + viewport / 2 - row.start;
}

/** The scroll offset that puts `delta` px below a row starting at `start` on the centre line. */
export function offsetFor(start: number, delta: number, viewport: number): number {
  return Math.max(0, start + delta - viewport / 2);
}

/** Whether to ask for the next batch now. `asked` is the item count the last ask was made at. */
export function shouldLoadMore(s: {
  lastIndex: number | null;
  count: number;
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  asked: number | null;
  prefetch?: number;
  /** Px of rows still below the viewport's bottom, and the viewport's height (both or neither). */
  belowPx?: number;
  viewportPx?: number;
}): boolean {
  if (!s.hasMore || s.loading || s.error) return false;
  if (s.asked === s.count) return false;
  if (s.count === 0) return true;
  if (s.lastIndex === null) return false;
  if (
    s.belowPx !== undefined &&
    s.viewportPx !== undefined &&
    s.viewportPx > 0 &&
    s.belowPx <= s.viewportPx * PREFETCH_SCREENS
  )
    return true;
  return s.lastIndex >= s.count - 1 - (s.prefetch ?? PREFETCH_ROWS);
}

export type RestoreStep =
  | { do: "scroll"; index: number }
  | { do: "load" }
  | { do: "wait" }
  | { do: "give-up" };

/** What to do toward bringing the remembered id back. */
export function restoreStep(s: {
  keys: readonly string[];
  id: string;
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  batches: number;
}): RestoreStep {
  const index = s.keys.indexOf(s.id);
  if (index >= 0) return { do: "scroll", index };
  if (s.loading) return { do: "wait" };
  if (!s.hasMore || s.error || s.batches >= RESTORE_MAX_BATCHES) return { do: "give-up" };
  return { do: "load" };
}

/**
 * Where a key moves the focus among `count` rows from row `from`, or null when
 * the key is not one of ours. `page` is how many rows fill the viewport.
 */
export function keyTarget(key: string, from: number, count: number, page: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const step = Math.max(1, page - 1);
  const to =
    key === "ArrowDown"
      ? from + 1
      : key === "ArrowUp"
        ? from - 1
        : key === "PageDown"
          ? from + step
          : key === "PageUp"
            ? from - step
            : key === "Home"
              ? 0
              : key === "End"
                ? last
                : null;
  return to === null ? null : Math.max(0, Math.min(last, to));
}

/** `aria-setsize`: the known total; -1 (unknown) while more may load. */
export function setSize(count: number, hasMore: boolean, total?: number | null): number {
  if (typeof total === "number" && total >= count) return total;
  return hasMore ? -1 : count;
}

/** The items of `next` not already in `prev` (by key), appended: a batch from an offset can overlap. */
export function mergeBatch<T>(
  prev: readonly T[],
  next: readonly T[],
  keyOf: (t: T) => string,
): T[] {
  const seen = new Set(prev.map(keyOf));
  const out = prev.slice();
  for (const t of next) {
    const k = keyOf(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Whether the anchor row moved to another index (rows inserted or removed above it). */
export function anchorMoved(
  prevKeys: readonly string[],
  keys: readonly string[],
  id: string,
): number | null {
  const before = prevKeys.indexOf(id);
  const now = keys.indexOf(id);
  return before >= 0 && now >= 0 && before !== now ? now : null;
}
