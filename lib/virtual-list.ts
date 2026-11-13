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
 * Empty space kept below the last row while more may come: the scroll never
 * hits a hard end mid-load, however fast he flings (owner, 2026-11-14: "每秒钟能
 * 滚到几十个屏幕 … 非常非常大 … 加载完所有东西之后再弹回来都可以"). With the
 * total known it is the height the missing rows will take; without it,
 * RESERVE_SCREENS screens. Once the list is complete it goes, and the page
 * settles back.
 */
export const RESERVE_SCREENS = 50;

/** The empty space (px) to keep below the rows: the rest of the list while more may load, none at the end. */
export function reserveBelow(s: {
  hasMore: boolean;
  viewport: number;
  count: number;
  total?: number | null;
  rowPx: number;
}): number {
  if (!s.hasMore) return 0;
  if (typeof s.total === "number" && s.total > s.count) return (s.total - s.count) * s.rowPx;
  return s.viewport > 0 ? Math.round(s.viewport * RESERVE_SCREENS) : 0;
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
  keys: readonly (string | undefined)[];
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
  prevKeys: readonly (string | undefined)[],
  keys: readonly (string | undefined)[],
  id: string,
): number | null {
  const before = prevKeys.indexOf(id);
  const now = keys.indexOf(id);
  return before >= 0 && now >= 0 && before !== now ? now : null;
}

// ── Random access (owner, 2026-11-14: "我滚得非常快…突然滚到很远的地方，就从
// 那一页开始加载，中间的数据就跳过"). A list whose source can fetch any page and
// knows its total is laid out at its full length from the start; rows not
// loaded yet are placeholders, and only the pages under the viewport (plus
// about one page around it) are fetched, once the scroll settles. The pages
// flung past are never asked for.
//
// The rows are a sparse array by absolute index (holes = not loaded), so a
// delete is a splice that shifts the later rows down exactly as the server's
// offsets shift.

/** Wait this long (ms) after the wanted pages last changed before asking, while the list is moving. */
export const RANGE_SETTLE_MS = 120;

/** Pages fetched around the visible range: about one page above and below. */
export const OVERSCAN_PAGES = 1;

/** The key of a row not loaded yet (by index: a placeholder has no id). */
export const PLACEHOLDER_PREFIX = "\u0000ph:";
export const placeholderKey = (index: number) => `${PLACEHOLDER_PREFIX}${index}`;
export const isPlaceholderKey = (key: string) => key.startsWith(PLACEHOLDER_PREFIX);

/** The page that holds row `index`. */
export function pageOf(index: number, size: number): number {
  return size > 0 ? Math.floor(Math.max(0, index) / size) : 0;
}

/** sessionStorage key name of a random-access list's centre index (beside its id). */
export const anchorIndexStoreName = (name: string) => `${anchorStoreName(name)}:at`;

/**
 * The pages to ask for so rows `from`..`to` (inclusive) and about
 * `overscanPages` pages around them are loaded: each page with at least one
 * row missing (`has` false), in order from the visible rows outwards — the
 * pages the reader sees first.
 */
export function missingPages(s: {
  from: number;
  to: number;
  size: number;
  total: number;
  has: (index: number) => boolean;
  overscanPages?: number;
}): number[] {
  if (s.size <= 0 || s.total <= 0 || s.to < s.from) return [];
  const last = pageOf(s.total - 1, s.size);
  const over = s.overscanPages ?? OVERSCAN_PAGES;
  const seenFrom = Math.min(pageOf(s.from, s.size), last);
  const seenTo = Math.min(pageOf(s.to, s.size), last);
  const lo = Math.max(0, seenFrom - over);
  const hi = Math.min(last, seenTo + over);
  const wanted = (p: number) => {
    const end = Math.min(s.total, (p + 1) * s.size);
    for (let i = p * s.size; i < end; i++) if (!s.has(i)) return true;
    return false;
  };
  const out: number[] = [];
  for (let p = seenFrom; p <= seenTo; p++) if (wanted(p)) out.push(p);
  for (let d = 1; seenFrom - d >= lo || seenTo + d <= hi; d++) {
    if (seenTo + d <= hi && wanted(seenTo + d)) out.push(seenTo + d);
    if (seenFrom - d >= lo && wanted(seenFrom - d)) out.push(seenFrom - d);
  }
  return out;
}

/** How long to wait before asking for the wanted pages: none at rest, RANGE_SETTLE_MS while moving. */
export function loadDelay(scrolling: boolean): number {
  return scrolling ? RANGE_SETTLE_MS : 0;
}

/**
 * Requests in flight that no longer matter: their page is outside `keep`
 * (pages, inclusive) — the reader flung past them. They are cancelled.
 */
export function stalePages(
  inFlight: Iterable<number>,
  keep: { from: number; to: number },
): number[] {
  const out: number[] = [];
  for (const p of inFlight) if (p < keep.from || p > keep.to) out.push(p);
  return out;
}

/** Of `pages`, the ones to fetch now: not already in flight, each once. */
export function pagesToFetch(pages: readonly number[], inFlight: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const p of pages) if (p >= 0 && !inFlight.has(p) && !out.includes(p)) out.push(p);
  return out;
}

/** The sparse rows with page `page` (of `size`) put in place; a new array, holes kept. */
export function putPage<T>(
  rows: readonly T[],
  page: number,
  size: number,
  items: readonly T[],
): T[] {
  const out = rows.slice();
  const at = page * size;
  for (let i = 0; i < items.length; i++) out[at + i] = items[i];
  return out;
}

/**
 * The sparse rows without those `drop` matches, later rows moved up (as the
 * server's offsets move after a delete); holes stay holes. `removed` is how
 * many went.
 */
export function removeWhere<T>(
  rows: readonly T[],
  drop: (item: T) => boolean,
): { rows: T[]; removed: number } {
  const out: T[] = [];
  let removed = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!(i in rows)) {
      out.length++;
      continue;
    }
    const item = rows[i];
    if (drop(item)) removed++;
    else out[out.length] = item;
  }
  return { rows: out, removed };
}

/** How many rows of a sparse array are loaded (holes not counted). */
export function loadedCount(rows: readonly unknown[]): number {
  let n = 0;
  for (let i = 0; i < rows.length; i++) if (i in rows) n++;
  return n;
}

export type SparseRestoreStep =
  | { do: "scroll"; index: number; done: boolean }
  | { do: "wait" }
  | { do: "give-up" };

/**
 * Bringing the remembered row back in a random-access list: the id when it is
 * loaded; else jump straight to the remembered index (its page loads there,
 * nothing before it) and look again once that page is in.
 */
export function sparseRestoreStep(s: {
  keys: readonly (string | undefined)[];
  id: string | null;
  at: number | null;
  total: number | null;
  /** Row `at` is loaded. */
  loadedAt: boolean;
  /** Already scrolled to `at` once. */
  jumped: boolean;
  error: boolean;
}): SparseRestoreStep {
  const found = s.id ? s.keys.indexOf(s.id) : -1;
  if (found >= 0) return { do: "scroll", index: found, done: true };
  if (s.error) return { do: "give-up" };
  if (s.total === null) return { do: "wait" };
  if (s.at === null || s.at < 0 || s.total === 0) return { do: "give-up" };
  const at = Math.min(s.at, s.total - 1);
  // Its page is in and the id is not on it (deleted, re-sorted): stay at the index.
  if (s.loadedAt) return { do: "scroll", index: at, done: true };
  if (s.jumped) return { do: "wait" };
  return { do: "scroll", index: at, done: false };
}
