"use client";

import { useEffect, useRef, useState } from "react";
import type { EtaTask } from "./eta";
import {
  ETA_TICKER_KEEP,
  ETA_TICKER_SEC,
  TICKER_EMPTY,
  type TickerConfig,
  type TickerItem,
  type TickerState,
  etaChanges,
  lateCrossings,
  tickerNextWake,
  tickerPush,
  tickerShown,
} from "./eta-ticker";

/**
 * The page's ticker: `tasks` null until the tree has loaded (so loading is
 * not news), `now` the page's ETA clock (eta.ts etaClock; it ticks when an
 * ETA is reached, which is how "late" shows). Returns the item shown and the
 * pass it belongs to (`since`: the bar flashes when it changes).
 */
export function useEtaTicker(
  tasks: readonly EtaTask[] | null,
  now: number,
  cfg: TickerConfig = { sec: ETA_TICKER_SEC, keep: ETA_TICKER_KEEP },
): { item: TickerItem; since: number } | null {
  const secMs = cfg.sec * 1000;
  const prev = useRef<readonly EtaTask[] | null>(null);
  const prevNow = useRef(now);
  const [state, setState] = useState<TickerState>(TICKER_EMPTY);
  const [clock, setClock] = useState(() => Date.now());
  const keep = cfg.keep;
  useEffect(() => {
    if (!tasks) return;
    const t = Date.now();
    const items = etaChanges(prev.current, tasks, t);
    prev.current = tasks;
    if (items.length) {
      setState((s) => tickerPush(s, items, t, keep));
      setClock(t);
    }
  }, [tasks, keep]);
  useEffect(() => {
    const from = prevNow.current;
    prevNow.current = now;
    if (!tasks || now <= from) return;
    const items = lateCrossings(tasks, from, now);
    if (items.length) {
      const t = Date.now();
      setState((s) => tickerPush(s, items, t, keep));
      setClock(t);
    }
    // Only the clock's moves: a new snapshot is etaChanges' (above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  useEffect(() => {
    const wake = tickerNextWake(state, clock, secMs);
    if (wake === null) return;
    const id = setTimeout(() => setClock(Date.now()), Math.max(0, wake - Date.now()));
    return () => clearTimeout(id);
  }, [state, clock, secMs]);
  const item = tickerShown(state, clock, secMs);
  return item && state.since !== null ? { item, since: state.since } : null;
}
