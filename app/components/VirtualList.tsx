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
  keyTarget,
  offsetFor,
  restoreStep,
  setSize,
  shouldLoadMore,
} from "@/lib/virtual-list";

const store = safeStorage("session");
const storeKey = (name: string) => uiKey(anchorStoreName(name), "session");

export type VirtualListProps<T> = {
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
  /** Imperative calls: bring a row (by key) into view, e.g. for an in-page link. */
  handle?: RefObject<VirtualListHandle | null>;
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
  hasMore,
  loading,
  error = false,
  onReachEnd,
  name,
  total,
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
}: VirtualListProps<T>) {
  const t = useIntlayer("virtual-list");
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const keys = items.map(getKey);
  const isWindow = !scrollRef;

  const v = useVirtualizer<Element, HTMLElement>({
    count: items.length,
    getScrollElement: () =>
      (scrollRef
        ? scrollRef.current
        : typeof window === "undefined"
          ? null
          : window) as Element | null,
    estimateSize: () => estimateSize,
    getItemKey: (i) => keys[i] ?? i,
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
  const anchor = useRef<{ id: string; delta: number } | null>(null);
  /** The item count the last batch was asked for at (one ask per length). */
  const asked = useRef<number | null>(null);
  const restoring = useRef<{ id: string; batches: number } | null>(null);
  const restored = useRef(!name);
  if (!restored.current && restoring.current === null && name) {
    const id = store.getItem(storeKey(name));
    if (typeof id === "string" && id) restoring.current = { id, batches: 0 };
    else restored.current = true;
  }

  const readCentre = useCallback(() => {
    const offset = v.scrollOffset ?? 0;
    const placed = v.getVirtualItems();
    const i = centreIndex(placed, offset, viewport());
    if (i === null) return null;
    const row = placed.find((r) => r.index === i)!;
    return { id: String(row.key), delta: centreDelta(row, offset, viewport()) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  const write = useCallback(() => {
    if (!name || !restored.current) return;
    const a = anchor.current;
    if (a) store.setItem(storeKey(name), a.id);
    else store.removeItem(storeKey(name));
  }, [name]);

  // Each scroll updates the centre; the store is written 200 ms after it stops
  // (docs/ui-state.md, "Event-driven"), and at once on Back, hide or leave.
  const writeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const offset = v.scrollOffset;
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
  useEffect(() => {
    const r = restoring.current;
    if (!r || restored.current) return;
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
  }, [keyStr, hasMore, loading, error]);

  // Rows inserted or removed above the centre row: keep it where it was.
  const prevKeys = useRef<readonly string[]>(keys);
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
    if (!restored.current) return;
    if (
      shouldLoadMore({
        lastIndex,
        count: items.length,
        hasMore,
        loading,
        error,
        asked: asked.current,
      })
    ) {
      asked.current = items.length;
      onReachEnd();
    }
  }, [lastIndex, items.length, hasMore, loading, error, onReachEnd]);

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
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-index]");
    if (!row || !listRef.current?.contains(row)) return;
    // Only from the row itself or a link in it: buttons and fields keep their keys (menus, text).
    if (target !== row && target.tagName !== "A") return;
    const from = Number(row.dataset.index);
    const page = Math.max(1, Math.floor(viewport() / estimateSize));
    const to = keyTarget(e.key, from, items.length, page);
    if (to === null || to === from) return;
    e.preventDefault();
    focusRow(to);
  };

  const size = setSize(items.length, hasMore, total);
  const first = rows[0]?.start ?? 0;

  if (!items.length && !hasMore && !loading && !error) return <>{empty ?? null}</>;

  return (
    <div className={className} data-testid={testId}>
      <div
        ref={listRef}
        role="list"
        aria-label={label}
        aria-busy={loading || undefined}
        onKeyDown={onKeyDown}
        style={{ height: v.getTotalSize(), position: "relative", width: "100%" }}
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
            if (item === undefined) return null;
            return (
              <div
                key={r.key}
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
              onClick={onReachEnd}
              data-testid="vlist-retry"
              className="min-h-10 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
            >
              {t.retry}
            </button>
          </span>
        ) : loading ? (
          <span className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400">
            <span
              aria-hidden
              className="inline-block size-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent motion-reduce:animate-none dark:border-blue-300 dark:border-t-transparent"
            />
            {items.length ? t.loadingMore : t.loading}
          </span>
        ) : !hasMore && items.length ? (
          <span className="text-gray-500 dark:text-gray-400" data-testid="vlist-end">
            {t.end}
          </span>
        ) : null}
      </div>
    </div>
  );
}
