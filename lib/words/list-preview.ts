/**
 * Previewing a built-in list from the "Add a list" tree (owner, 2026-11-03
 * 20:14 JST: "每一个词表的那个添加列表的按钮，能不能加一个预览？").
 *
 * A preview shows one list — a word list, a phrase deck — or a coverage band
 * (the union of its frequency lists), every entry in the list's own order.
 * Nothing loads until the preview opens; a band's lists then load one at a
 * time, as the reader scrolls toward the end of what is loaded. The sheet
 * renders only the rows near the view (`windowOf`), so a list of any size
 * opens at once and is never cut to a "first N".
 */

/** A list to preview: its catalog id, its stated size, where its entries are. */
export type PreviewSource = { id: string; count: number; path: string };

/** What a preview row needs from a catalog entry. */
export type PreviewEntry = {
  term: string;
  reading?: string;
  back: string;
  ex?: string;
  exTr?: string;
  note?: string;
};

/**
 * The preview's size before everything is loaded: the lists' stated counts.
 * A band's lists are disjoint rank ranges, so the sum is its size.
 */
export const previewSize = (sources: readonly PreviewSource[]) =>
  sources.reduce((n, s) => n + (s.count || 0), 0);

export type PreviewState<E extends PreviewEntry> = {
  rows: (E & { listId: string })[];
  /** Lists loaded so far (a prefix of the sources). */
  loaded: number;
  done: boolean;
  /** The last load's failure; the next `more()` tries the same list again. */
  error?: string;
};

/**
 * A lazy loader over the sources, in order. `more()` loads the next list and
 * appends its entries (a term already shown by an earlier list is left out,
 * so a band reads as one list). Calls while a load is running share it.
 */
export function previewLoader<E extends PreviewEntry>(
  sources: readonly PreviewSource[],
  fetchEntries: (path: string) => Promise<E[]>,
) {
  const seen = new Set<string>();
  let state: PreviewState<E> = { rows: [], loaded: 0, done: sources.length === 0 };
  let running: Promise<PreviewState<E>> | null = null;
  const more = (): Promise<PreviewState<E>> => {
    if (state.done) return Promise.resolve(state);
    if (running) return running;
    const src = sources[state.loaded];
    running = fetchEntries(src.path)
      .then((entries) => {
        const add: (E & { listId: string })[] = [];
        for (const e of entries ?? []) {
          if (!e?.term || seen.has(e.term)) continue;
          seen.add(e.term);
          add.push({ ...e, listId: src.id });
        }
        const loaded = state.loaded + 1;
        state = { rows: [...state.rows, ...add], loaded, done: loaded >= sources.length };
        return state;
      })
      .catch((err: unknown) => {
        state = { ...state, error: err instanceof Error ? err.message : String(err) };
        return state;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  return {
    get state() {
      return state;
    },
    more,
  };
}

/**
 * The rows to render for a scroll position: rows of measured height (`heights`,
 * missing ones at `estimate`), the window `[top, top + view)` widened by
 * `overscan` on both sides. `before` and `after` are the heights of the rows
 * left out, kept as space so the scrollbar stays true.
 */
export function windowOf(
  count: number,
  heights: ArrayLike<number | undefined>,
  estimate: number,
  top: number,
  view: number,
  overscan: number,
) {
  const h = (i: number) => heights[i] || estimate;
  let y = 0;
  let start = 0;
  while (start < count && y + h(start) <= top - overscan) y += h(start++);
  const before = y;
  let end = start;
  while (end < count && y < top + view + overscan) y += h(end++);
  let after = 0;
  for (let i = end; i < count; i++) after += h(i);
  return { start, end, before, after };
}
