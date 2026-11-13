"use client";

/**
 * The one list component (owner, 2026-11-10: no pagination anywhere). A
 * windowed list — only the rows near the viewport are in the DOM — that asks
 * for more as the reader nears the end (`onReachEnd`), with no page controls.
 *
 * - Window scrolling by default; pass `scrollRef` to scroll inside an element.
 * - Rows may be any height: each is measured (`measureElement`).
 * - Position: the id of the row at the viewport's CENTRE is kept per tab
 *   (sessionStorage `lk:ui:list:<name>`) and brought back to the centre on
 *   return, loading batches until it appears. While the page is open, rows
 *   inserted or removed above it keep that row where it was.
 * - role list / listitem with aria-setsize / aria-posinset; ↑ ↓ PgUp PgDn
 *   Home End move between rows when a row (or a link in it) has focus.
 * - Random access (`sparse`, from useSparseList): for a source that can fetch
 *   any page and knows its total. The list is laid out at its full length at
 *   once, rows not loaded yet are light placeholders, and only the pages under
 *   the viewport (± about a page) are fetched — once the wanted pages have
 *   held still RANGE_SETTLE_MS while moving, at once at rest. A fling far down
 *   loads where it lands and skips everything in between. The centre row is
 *   remembered by id AND index, so a return jumps straight to its page.
 *
 * The decisions are pure functions in lib/virtual-list.ts (unit-tested); this
 * file is the glue, driven in a browser by scripts/qa/qa-virtual-list.mjs.
 */
import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  observeWindowOffset,
  observeWindowRect,
  useVirtualizer,
  type Virtualizer,
  windowScroll,
} from "@tanstack/react-virtual";
import { useIntlayer } from "next-intlayer";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { safeStorage, uiKey } from "@lianki/ui-state";
import { onPageLeave } from "@/lib/page-leave";
import {
  anchorMoved,
  anchorStoreName,
  centreDelta,
  centreIndex,
  anchorIndexStoreName,
  isPlaceholderKey,
  keyTarget,
  loadDelay,
  missingPages,
  OVERSCAN_PAGES,
  offsetFor,
  pageOf,
  placeholderKey,
  reserveBelow,
  restoreStep,
  setSize,
  shouldLoadMore,
  sparseRestoreStep,
} from "@/lib/virtual-list";
import type { SparseSource } from "./useSparseList";

const store = safeStorage("session");
const storeKey = (name: string) => uiKey(anchorStoreName(name), "session");
const indexKey = (name: string) => uiKey(anchorIndexStoreName(name), "session");

export type VirtualListProps<T> = {
  /** The rows; with `sparse`, by absolute index with holes where a row is not loaded yet. */
  items: readonly T[];
  /** A stable id per row: React key, and what the scroll position remembers. */
  getKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** More rows exist on the server. */
  hasMore: boolean;
  /** A batch is on its way. */
  loading: boolean;
  /** The last batch failed: shows the notice and Try again. */
  error?: boolean;
  /** Ask for the next batch (also what Try again calls). */
  onReachEnd: () => void;
  /** Per-tab scroll memory under this name; none without it. */
  name?: string;
  /** The total when the server knows it (aria-setsize); else -1 while more may load. */
  total?: number | null;
  /** The scrolling element; the window when absent. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** First guess of a row's height, px, before it is measured. */
  estimateSize?: number;
  /** Space between rows, px. */
  gap?: number;
  overscan?: number;
  /** Shown when there are no rows and nothing more is coming. */
  empty?: ReactNode;
  /** Accessible name of the list. */
  label?: string;
  className?: string;
  /** Classes of each row's wrapper (role listitem). */
  rowClassName?: string;
  testId?: string;
  /**
   * Render as a table: `head` is the <thead>, each `renderItem` returns the
   * row's <td> cells, and the rows are <tr> in one <tbody> (spacer rows above
   * and below stand in for the rows out of view). For data tables (/data).
   */
  table?: {
    head: ReactNode;
    className?: string;
    label?: string;
    /** Columns per row: what a placeholder row (random access) spans. */
    columns?: number;
  };
  /** Imperative calls: bring a row (by key) into view, e.g. for an in-page link. */
  handle?: RefObject<VirtualListHandle | null>;
  /**
   * Random access (useSparseList's `sparse`): the list is `sparse.total` rows
   * long from the start and fetches only the pages in view. Pass
   * `hasMore={false}`; `onReachEnd` is then unused (Try again is `sparse.retry`).
   */
  sparse?: SparseSource;
};

export type VirtualListHandle = {
  /** Scroll the row with this key to the centre; false when it is not loaded. */
  scrollToKey: (key: string) => boolean;
};

type AnyVirtualizer = Virtualizer<Element | Window, HTMLElement>;

export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  hasMore: hasMoreProp,
  loading,
  error = false,
  onReachEnd,
  name,
  total: totalProp,
  scrollRef,
  estimateSize = 72,
  gap = 0,
  overscan = 6,
  empty,
  label,
  className,
  rowClassName,
  testId,
  handle,
  table,
  sparse,
}: VirtualListProps<T>) {
  const t = useIntlayer("virtual-list");
  const listRef = useRef<HTMLElement | null>(null);
  const setListRef = (el: HTMLElement | null) => {
    listRef.current = el;
  };
  const [margin, setMargin] = useState(0);
  // Holes (rows not loaded) stay holes: `map` skips them.
  const keys: (string | undefined)[] = items.map(getKey);
  const isWindow = !scrollRef;
  const isSparse = !!sparse;
  /** Rows the list is laid out for: the whole total with `sparse`, else those loaded. */
  const count = sparse ? (sparse.total ?? 0) : items.length;
  // Random access: the list is already its full length; nothing to append.
  const hasMore = sparse ? false : hasMoreProp;
  const total = sparse ? sparse.total : totalProp;

  const v = useVirtualizer<Element, HTMLElement>({
    count,
    getScrollElement: () =>
      (scrollRef
        ? scrollRef.current
        : typeof window === "undefined"
          ? null
          : window) as Element | null,
    estimateSize: () => estimateSize,
    getItemKey: (i) => keys[i] ?? placeholderKey(i),
    overscan,
    gap,
    scrollMargin: margin,
    observeElementRect: (isWindow ? observeWindowRect : observeElementRect) as never,
    observeElementOffset: (isWindow ? observeWindowOffset : observeElementOffset) as never,
    scrollToFn: (isWindow ? windowScroll : elementScroll) as never,
  }) as unknown as AnyVirtualizer;

  // Where the list starts inside its scroller: content above it (a form that
  // opens, a banner) moves it, so it is measured after every render and when
  // the page resizes.
  const measureMargin = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const sc = scrollRef?.current;
    const m = sc ? top - sc.getBoundingClientRect().top + sc.scrollTop : top + window.scrollY;
    setMargin((old) => (Math.abs(old - m) > 0.5 ? m : old));
  }, [scrollRef]);
  useLayoutEffect(measureMargin);
  useEffect(() => {
    const ro = new ResizeObserver(measureMargin);
    ro.observe(scrollRef?.current ?? document.body);
    return () => ro.disconnect();
  }, [measureMargin, scrollRef]);

  const rows = v.getVirtualItems();
  const viewport = () => v.scrollRect?.height ?? (isWindow ? window.innerHeight : 0);

  // ── The centre row: remembered while scrolling, written per tab. ──
  const anchor = useRef<{ id: string; delta: number; index: number } | null>(null);
  /** The item count the last batch was asked for at (one ask per length). */
  const asked = useRef<number | null>(null);
  const restoring = useRef<{
    id: string | null;
    batches: number;
    /** The remembered index (random access only). */
    at: number | null;
    jumped: boolean;
  } | null>(null);
  const restored = useRef(!name);
  if (!restored.current && restoring.current === null && name) {
    const raw = store.getItem(storeKey(name));
    const id = typeof raw === "string" && raw ? raw : null;
    const atRaw = sparse ? store.getItem(indexKey(name)) : null;
    const at = typeof atRaw === "string" && /^\d+$/.test(atRaw) ? Number(atRaw) : null;
    if (id !== null || at !== null) restoring.current = { id, batches: 0, at, jumped: false };
    else restored.current = true;
  }

  const readCentre = useCallback(() => {
    const offset = v.scrollOffset ?? 0;
    const placed = v.getVirtualItems();
    const i = centreIndex(placed, offset, viewport());
    if (i === null) return null;
    const row = placed.find((r) => r.index === i)!;
    return { id: String(row.key), delta: centreDelta(row, offset, viewport()), index: i };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  const write = useCallback(() => {
    if (!name || !restored.current) return;
    const a = anchor.current;
    // A placeholder has no id: only its index is kept.
    if (a && !isPlaceholderKey(a.id)) store.setItem(storeKey(name), a.id);
    else store.removeItem(storeKey(name));
    if (a && isSparse) store.setItem(indexKey(name), String(a.index));
    else store.removeItem(indexKey(name));
  }, [name, isSparse]);

  // Each scroll updates the centre; the store is written 200 ms after it stops
  // (docs/ui-state.md, "Event-driven"), and at once on Back, hide or leave.
  const writeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const offset = v.scrollOffset;
  // Where the list starts can move without a render or a body resize (a font
  // swapping in above it, a sibling's own state): re-measure as the page scrolls,
  // so the rows near the end are never left out by a stale offset.
  useEffect(measureMargin, [offset, measureMargin]);
  useEffect(() => {
    if (!restored.current) return;
    anchor.current = readCentre();
    clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(write, 200);
  }, [offset, readCentre, write]);
  useEffect(() => {
    const off = onPageLeave(() => {
      clearTimeout(writeTimer.current);
      write();
    });
    return () => {
      off();
      clearTimeout(writeTimer.current);
      write();
    };
  }, [write]);

  // The reader's own scroll ends a restore still loading its way down.
  useEffect(() => {
    if (restored.current) return;
    const stop = () => {
      restored.current = true;
      restoring.current = null;
    };
    const target: EventTarget = scrollRef?.current ?? window;
    const opts = { passive: true, once: true } as const;
    for (const e of ["wheel", "touchstart", "keydown"]) target.addEventListener(e, stop, opts);
    return () => {
      for (const e of ["wheel", "touchstart", "keydown"]) target.removeEventListener(e, stop);
    };
  }, [scrollRef]);

  // Bring the remembered row back to the centre, loading batches until it shows.
  const keyStr = keys.join("\n");
  const sparseTotal = sparse ? sparse.total : null;
  useEffect(() => {
    const r = restoring.current;
    if (!r || restored.current) return;
    if (isSparse) {
      // Random access: straight to the remembered index (only its page loads),
      // then onto the id once that page is in.
      const at = r.at === null || !sparseTotal ? null : Math.min(r.at, sparseTotal - 1);
      const s = sparseRestoreStep({
        keys,
        id: r.id,
        at: r.at,
        total: sparseTotal,
        loadedAt: at !== null && items[at] !== undefined,
        jumped: r.jumped,
        error,
      });
      if (s.do === "scroll") {
        v.scrollToIndex(s.index, { align: "center" });
        r.jumped = true;
        if (s.done) {
          restored.current = true;
          restoring.current = null;
          requestAnimationFrame(() => (anchor.current = readCentre()));
        }
      } else if (s.do === "give-up") {
        restored.current = true;
        restoring.current = null;
      }
      return;
    }
    if (r.id === null) {
      restored.current = true;
      restoring.current = null;
      return;
    }
    const step = restoreStep({ keys, id: r.id, hasMore, loading, error, batches: r.batches });
    if (step.do === "scroll") {
      v.scrollToIndex(step.index, { align: "center" });
      restored.current = true;
      restoring.current = null;
      requestAnimationFrame(() => (anchor.current = readCentre()));
    } else if (step.do === "load") {
      r.batches++;
      asked.current = items.length;
      onReachEnd();
    } else if (step.do === "give-up") {
      restored.current = true;
      restoring.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr, hasMore, loading, error, sparseTotal]);

  // Rows inserted or removed above the centre row: keep it where it was.
  const prevKeys = useRef<readonly (string | undefined)[]>(keys);
  useLayoutEffect(() => {
    const before = prevKeys.current;
    prevKeys.current = keys;
    const a = anchor.current;
    if (!a || !restored.current || v.isScrolling) return;
    const now = anchorMoved(before, keys, a.id);
    if (now === null) return;
    v.getVirtualItems();
    const start = v.measurementsCache[now]?.start;
    if (start === undefined) return;
    v.scrollToOffset(offsetFor(start, a.delta, viewport()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr]);

  // ── More as the end comes into view. ──
  const lastIndex = rows.length ? rows[rows.length - 1].index : null;
  useEffect(() => {
    if (!restored.current || isSparse) return;
    if (
      shouldLoadMore({
        lastIndex,
        count: items.length,
        hasMore,
        loading,
        error,
        asked: asked.current,
        belowPx: Math.max(
          0,
          v.getTotalSize() - ((v.scrollOffset ?? 0) - v.options.scrollMargin + viewport()),
        ),
        viewportPx: viewport(),
      })
    ) {
      asked.current = items.length;
      onReachEnd();
    }
  }, [lastIndex, items.length, hasMore, loading, error, onReachEnd, isSparse]);

  // ── Random access: the pages in view, once the scroll settles. ──
  const firstIndex = rows.length ? rows[0].index : null;
  const pageSize = sparse?.pageSize ?? 1;
  const epoch = sparse?.epoch;
  const want =
    sparse && sparseTotal && firstIndex !== null && lastIndex !== null
      ? missingPages({
          from: firstIndex,
          to: lastIndex,
          size: pageSize,
          total: sparseTotal,
          has: (i) => items[i] !== undefined,
        })
      : [];
  const wantKey = want.join(",");
  /** Requests for pages further than this from the view are cancelled. */
  const keep = {
    from: pageOf(firstIndex ?? 0, pageSize) - OVERSCAN_PAGES - 1,
    to: pageOf(lastIndex ?? 0, pageSize) + OVERSCAN_PAGES + 1,
  };
  const wantRef = useRef({ want, keep });
  wantRef.current = { want, keep };
  // The timer restarts each time the wanted pages change: a fling through
  // hundreds of rows asks for nothing until it stops.
  useEffect(() => {
    if (!sparse || !wantKey || error) return;
    const go = () => sparse.loadPages(wantRef.current.want, wantRef.current.keep);
    const ms = loadDelay(v.isScrolling);
    if (!ms) return go();
    const id = setTimeout(go, ms);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey, error, epoch]);
  // The total is not known yet: the first page to ask for is the remembered
  // row's (a return lands there at once), else the top.
  const totalUnknown = !!sparse && sparseTotal === null;
  useEffect(() => {
    if (!sparse || !totalUnknown || error) return;
    const p = pageOf(restoring.current?.at ?? 0, pageSize);
    sparse.loadPages([p], { from: p - OVERSCAN_PAGES - 1, to: p + OVERSCAN_PAGES + 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalUnknown, error, epoch]);
  // A new filter or sort starts over: back to the top of the list.
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (lastEpoch.current === epoch) return;
    lastEpoch.current = epoch;
    if (restoring.current) return;
    if ((v.scrollOffset ?? 0) > v.options.scrollMargin) v.scrollToOffset(v.options.scrollMargin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  // ── Keyboard: between rows. ──
  if (handle)
    handle.current = {
      scrollToKey: (key) => {
        const i = keys.indexOf(key);
        if (i < 0) return false;
        v.scrollToIndex(i, { align: "center" });
        return true;
      },
    };

  const focusRow = (i: number) => {
    v.scrollToIndex(i, { align: "auto" });
    const tryFocus = (n: number) => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
      if (el) el.focus({ preventScroll: true });
      else if (n > 0) requestAnimationFrame(() => tryFocus(n - 1));
    };
    requestAnimationFrame(() => tryFocus(5));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-index]");
    if (!row || !listRef.current?.contains(row)) return;
    // Only from the row itself or a link in it: buttons and fields keep their keys (menus, text).
    if (target !== row && target.tagName !== "A") return;
    const from = Number(row.dataset.index);
    const page = Math.max(1, Math.floor(viewport() / estimateSize));
    const to = keyTarget(e.key, from, count, page);
    if (to === null || to === from) return;
    e.preventDefault();
    focusRow(to);
  };

  const size = setSize(count, hasMore, total);
  const first = rows[0]?.start ?? 0;
  const retry = sparse ? sparse.retry : onReachEnd;
  // Random access: one element per index, so a placeholder that turns into its
  // row is the same element (a row focused by End keeps the focus when it loads).
  const reactKey = (r: { index: number; key: unknown }) =>
    isSparse ? `i${r.index}` : String(r.key);

  if (!count && !hasMore && !loading && !error && !totalUnknown) return <>{empty ?? null}</>;

  /** Random access: the whole list is in once its last row is. */
  const complete = sparse ? count > 0 && items[count - 1] !== undefined : !hasMore && count > 0;
  /** A row not loaded yet: a light bar at the estimated height; no pulse with reduced motion. */
  const skeleton = (
    <span
      aria-hidden
      className="block h-3 w-2/3 rounded bg-gray-200 motion-safe:animate-pulse dark:bg-gray-700"
    />
  );

  const status = (
    <div
      role="status"
      aria-live="polite"
      className="py-4 text-center text-sm"
      data-testid="vlist-status"
    >
      {error ? (
        <span className="inline-flex flex-wrap items-center justify-center gap-3">
          <span className="text-gray-700 dark:text-gray-300">
            <span aria-hidden className="me-1">
              ⚠︎
            </span>
            {t.loadFailed}
          </span>
          <button
            type="button"
            onClick={retry}
            data-testid="vlist-retry"
            className="min-h-10 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
          >
            {t.retry}
          </button>
        </span>
      ) : loading && (!sparse || totalUnknown) ? (
        <span className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400">
          <span
            aria-hidden
            className="inline-block size-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent motion-reduce:animate-none dark:border-blue-300 dark:border-t-transparent"
          />
          {items.length ? t.loadingMore : t.loading}
        </span>
      ) : complete ? (
        <span className="text-gray-500 dark:text-gray-400" data-testid="vlist-end">
          {t.end}
        </span>
      ) : null}
    </div>
  );

  if (table) {
    const last = rows[rows.length - 1];
    const padTop = rows.length ? first - v.options.scrollMargin : 0;
    const padBottom =
      (last ? Math.max(0, v.getTotalSize() - (last.end - v.options.scrollMargin)) : 0) +
      reserveBelow({
        hasMore,
        viewport: viewport(),
        count: items.length,
        total,
        rowPx: estimateSize,
      });
    return (
      <div className={className} data-testid={testId}>
        <table
          className={table.className}
          aria-label={table.label ?? label}
          aria-rowcount={size === -1 ? -1 : size + 1}
          aria-busy={loading || undefined}
          data-sparse={isSparse || undefined}
        >
          {table.head}
          <tbody ref={setListRef} onKeyDown={onKeyDown}>
            {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
            {rows.map((r) => {
              const item = items[r.index];
              if (item === undefined)
                return sparse ? (
                  <tr
                    key={reactKey(r)}
                    ref={v.measureElement}
                    data-index={r.index}
                    data-placeholder=""
                    aria-rowindex={r.index + 2}
                    aria-busy
                    tabIndex={-1}
                    className={rowClassName}
                    style={{ height: estimateSize }}
                  >
                    <td colSpan={table.columns ?? 1} className="px-3 py-2 align-middle">
                      <span className="sr-only">{t.loading}</span>
                      {skeleton}
                    </td>
                  </tr>
                ) : null;
              return (
                <tr
                  key={reactKey(r)}
                  ref={v.measureElement}
                  data-index={r.index}
                  data-key={String(r.key)}
                  aria-rowindex={r.index + 2}
                  tabIndex={-1}
                  className={rowClassName}
                >
                  {renderItem(item, r.index)}
                </tr>
              );
            })}
            {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
          </tbody>
        </table>
        {status}
      </div>
    );
  }

  return (
    <div className={className} data-testid={testId}>
      <div
        ref={setListRef}
        role="list"
        aria-label={label}
        aria-busy={loading || undefined}
        onKeyDown={onKeyDown}
        style={{
          height:
            v.getTotalSize() +
            reserveBelow({
              hasMore,
              viewport: viewport(),
              count: items.length,
              total,
              rowPx: estimateSize,
            }),
          position: "relative",
          width: "100%",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${first - v.options.scrollMargin}px)`,
          }}
        >
          {rows.map((r) => {
            const item = items[r.index];
            if (item === undefined)
              return sparse ? (
                <div
                  key={reactKey(r)}
                  ref={v.measureElement}
                  data-index={r.index}
                  data-placeholder=""
                  role="listitem"
                  aria-setsize={size}
                  aria-posinset={r.index + 1}
                  aria-busy
                  tabIndex={-1}
                  className={rowClassName}
                  style={{ height: estimateSize, marginBottom: gap || undefined }}
                >
                  <span className="sr-only">{t.loading}</span>
                  <span className="flex h-full items-center px-3">{skeleton}</span>
                </div>
              ) : null;
            return (
              <div
                key={reactKey(r)}
                ref={v.measureElement}
                data-index={r.index}
                data-key={String(r.key)}
                role="listitem"
                aria-setsize={size}
                aria-posinset={r.index + 1}
                tabIndex={-1}
                className={rowClassName}
                style={gap ? { marginBottom: gap } : undefined}
              >
                {renderItem(item, r.index)}
              </div>
            );
          })}
        </div>
      </div>
      {status}
    </div>
  );
}
