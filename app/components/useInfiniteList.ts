"use client";

/**
 * The data side of <VirtualList>: batches from a server cursor (or offset),
 * appended as the list asks for more, deduplicated by key. No pages: the
 * batch size is the config key `lists.batchSize` (lib/config.ts), never a
 * number the user sees.
 *
 *   const l = useInfiniteList({ fetchBatch, getKey, deps: [q] });
 *   <VirtualList items={l.items} hasMore={l.hasMore} loading={l.loading}
 *     error={l.error} onReachEnd={l.loadMore} … />
 *
 * A change in `deps` (a search, a filter, a sort) starts over from the first
 * batch; an answer to an older start is dropped.
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { publicCfg } from "@/lib/config-client";
import { mergeBatch } from "@/lib/virtual-list";

export type Batch<T, C> = { items: T[]; next: C | null; total?: number | null };

export type InfiniteList<T> = {
  items: T[];
  setItems: Dispatch<SetStateAction<T[]>>;
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  total: number | null;
  /** The next batch (no-op while one is loading or when there is no more). */
  loadMore: () => void;
  /** From the first batch again. */
  reload: () => void;
};

export function useInfiniteList<T, C>({
  fetchBatch,
  getKey,
  deps,
  enabled = true,
}: {
  fetchBatch: (cursor: C | null, size: number) => Promise<Batch<T, C>>;
  getKey: (item: T) => string;
  deps: readonly unknown[];
  /** False: no request (e.g. still deciding signed in or not). */
  enabled?: boolean;
}): InfiniteList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [gen, setGen] = useState(0);
  const cursor = useRef<C | null>(null);
  const busy = useRef(false);
  /** The last batch said there is no more. */
  const done = useRef(false);
  const run = useRef(0);
  const fetchRef = useRef(fetchBatch);
  fetchRef.current = fetchBatch;
  const keyRef = useRef(getKey);
  keyRef.current = getKey;

  const load = useCallback(async (first: boolean) => {
    if (busy.current && !first) return;
    const mine = first ? ++run.current : run.current;
    busy.current = true;
    setLoading(true);
    setError(false);
    try {
      const b = await fetchRef.current(first ? null : cursor.current, publicCfg("lists.batchSize"));
      if (mine !== run.current) return;
      cursor.current = b.next;
      setItems((prev) => (first ? b.items : mergeBatch(prev, b.items, keyRef.current)));
      done.current = b.next === null;
      setHasMore(!done.current);
      if (b.total !== undefined) setTotal(b.total);
    } catch {
      if (mine === run.current) setError(true);
    } finally {
      if (mine === run.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    cursor.current = null;
    done.current = false;
    setHasMore(true);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, gen, load, ...deps]);

  const loadMore = useCallback(() => {
    if (!enabled) return;
    // After a failed first batch the cursor is still null: that batch again.
    if (!done.current) void load(false);
  }, [enabled, load]);
  const reload = useCallback(() => setGen((g) => g + 1), []);

  return { items, setItems, hasMore, loading, error, total, loadMore, reload };
}
