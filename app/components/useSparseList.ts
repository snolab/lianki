"use client";

/**
 * The data side of a random-access <VirtualList> (its `sparse` prop): for a
 * source that can fetch any page and knows its total. The rows are a sparse
 * array by absolute index — holes are rows not loaded yet — filled page by
 * page as the list asks for the pages under its viewport. Pages flung past are
 * never fetched (owner, 2026-11-14: "中间的数据就跳过").
 *
 *   const l = useSparseList({ fetchPage, deps: [q, sort] });
 *   <VirtualList items={l.items} sparse={l.sparse} hasMore={false}
 *     loading={l.loading} error={l.error} onReachEnd={l.retry} … />
 *
 * - A page is never requested twice while one request for it is in flight.
 * - A request whose page the reader has left far behind is aborted.
 * - A change in `deps` (search, filter, sort) drops every row and answer and
 *   starts again (a new `epoch`); an answer to an older epoch is ignored.
 *
 * The decisions are pure functions in lib/virtual-list.ts (unit-tested).
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { publicCfg } from "@/lib/config-client";
import { pagesToFetch, putPage, removeWhere, stalePages } from "@/lib/virtual-list";

export type SparsePage<T> = { rows: T[]; total: number };

/** What <VirtualList sparse={…}> needs from its source. */
export type SparseSource = {
  /** Rows in the whole list; null until the first page answers. */
  total: number | null;
  /** Rows per page. */
  pageSize: number;
  /** Bumped when the list starts over (a filter or sort changed). */
  epoch: number;
  /** Fetch these pages (those not in flight); abort in-flight pages outside `keep` (pages, inclusive). */
  loadPages: (pages: number[], keep: { from: number; to: number }) => void;
  /** After a failure: ask for the missing pages again. */
  retry: () => void;
};

export type SparseList<T> = {
  /** Sparse: `items[i]` is undefined until its page is in. */
  items: T[];
  setItems: Dispatch<SetStateAction<T[]>>;
  total: number | null;
  loading: boolean;
  error: boolean;
  /** Remove rows here (after a delete on the server): later rows move up, the total drops. */
  remove: (drop: (item: T) => boolean) => void;
  /** Empty the list and start over. */
  reset: () => void;
  retry: () => void;
  sparse: SparseSource;
};

export function useSparseList<T>({
  fetchPage,
  deps,
  enabled = true,
}: {
  fetchPage: (page: number, size: number, signal: AbortSignal) => Promise<SparsePage<T>>;
  deps: readonly unknown[];
  enabled?: boolean;
}): SparseList<T> {
  const pageSize = publicCfg("lists.batchSize");
  // Rows and total in one state, so a delete moves both at once.
  const [list, setList] = useState<{ items: T[]; total: number | null }>({
    items: [],
    total: null,
  });
  const { items, total } = list;
  const setItems: Dispatch<SetStateAction<T[]>> = useCallback(
    (next) => setList((s) => ({ ...s, items: typeof next === "function" ? next(s.items) : next })),
    [],
  );
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [gen, setGen] = useState(0);
  const inFlight = useRef(new Map<number, AbortController>());
  const epochRef = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Start over: a new epoch, nothing loaded, every request in flight aborted.
  useEffect(() => {
    epochRef.current++;
    for (const c of inFlight.current.values()) c.abort();
    inFlight.current.clear();
    setBusy(0);
    setList({ items: [], total: null });
    setError(false);
    setEpoch(epochRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, gen, ...deps]);
  useEffect(
    () => () => {
      for (const c of inFlight.current.values()) c.abort();
    },
    [],
  );

  const loadPages = useCallback(
    (pages: number[], keep: { from: number; to: number }) => {
      if (!enabledRef.current) return;
      for (const p of stalePages(inFlight.current.keys(), keep)) {
        inFlight.current.get(p)?.abort();
        inFlight.current.delete(p);
      }
      setBusy(inFlight.current.size);
      const mine = epochRef.current;
      for (const p of pagesToFetch(pages, new Set(inFlight.current.keys()))) {
        const ctl = new AbortController();
        inFlight.current.set(p, ctl);
        setBusy(inFlight.current.size);
        fetchRef
          .current(p, pageSize, ctl.signal)
          .then((page) => {
            if (mine !== epochRef.current || ctl.signal.aborted) return;
            setList((s) => ({
              items: putPage(s.items, p, pageSize, page.rows),
              total: page.total,
            }));
          })
          .catch(() => {
            if (mine === epochRef.current && !ctl.signal.aborted) setError(true);
          })
          .finally(() => {
            if (inFlight.current.get(p) === ctl) inFlight.current.delete(p);
            setBusy(inFlight.current.size);
          });
      }
    },
    [pageSize],
  );

  const retry = useCallback(() => setError(false), []);
  const reset = useCallback(() => setGen((g) => g + 1), []);
  const remove = useCallback((drop: (item: T) => boolean) => {
    setList((s) => {
      const r = removeWhere(s.items, drop);
      return { items: r.rows, total: s.total === null ? null : Math.max(0, s.total - r.removed) };
    });
  }, []);

  const sparse = useMemo<SparseSource>(
    () => ({ total, pageSize, epoch, loadPages, retry }),
    [total, pageSize, epoch, loadPages, retry],
  );

  return {
    items,
    setItems,
    total,
    loading: busy > 0,
    error,
    remove,
    reset,
    retry,
    sparse,
  };
}
