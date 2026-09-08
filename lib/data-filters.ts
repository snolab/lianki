/**
 * URL <-> filter state for the /data page.
 *
 * Pure on purpose: the React glue in DataClient is three lines, and everything
 * with an edge case (defaults, clamping, preserving unrelated params) is here
 * where it can be tested without a DOM.
 */

import type { StoreId } from "@/app/(app)/data/types";

export type DataFilters = {
  store: StoreId;
  q: string;
  /** FSRS card state (0-3), or null for "any". */
  state: number | null;
  onlyDue: boolean;
  sort: string;
  order: "asc" | "desc";
  /** Zero-based internally; one-based in the URL, where humans read it. */
  page: number;
};

export const SORT_KEYS = ["due", "url", "title", "reps", "lapses", "state", "created"] as const;

export function defaultFilters(isLoggedIn: boolean): DataFilters {
  return {
    store: isLoggedIn ? "cloud" : "local",
    q: "",
    state: null,
    onlyDue: false,
    sort: "due",
    order: "asc",
    page: 0,
  };
}

/**
 * Params that belong to the app, not to this page. `lang` in particular drives
 * the whole UI locale (lib/app-locale.ts) — dropping it while rewriting the
 * query would silently switch the page back to English mid-session.
 */
const isForeignParam = (key: string) =>
  !["store", "q", "state", "due", "sort", "order", "page"].includes(key);

export function parseDataFilters(
  params: URLSearchParams | null | undefined,
  defaults: DataFilters,
): DataFilters {
  if (!params) return defaults;

  const store = params.get("store");
  const sort = params.get("sort");
  const order = params.get("order");

  const rawState = params.get("state");
  const stateNum = rawState === null || rawState === "" ? NaN : Number(rawState);

  const rawPage = Number(params.get("page"));

  return {
    // Unknown values fall back rather than throwing: these come from whatever a
    // user pasted into the address bar.
    store: store === "cloud" || store === "local" ? store : defaults.store,
    q: params.get("q") ?? defaults.q,
    state: Number.isInteger(stateNum) && stateNum >= 0 && stateNum <= 3 ? stateNum : defaults.state,
    onlyDue: params.has("due") ? params.get("due") !== "0" : defaults.onlyDue,
    sort: (SORT_KEYS as readonly string[]).includes(sort ?? "") ? sort! : defaults.sort,
    order: order === "asc" || order === "desc" ? order : defaults.order,
    page: Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) - 1 : defaults.page,
  };
}

/**
 * Serialize to a query string, writing only what differs from the defaults —
 * so an untouched page keeps the bare `/data?lang=ja` it started with, and a
 * shared link carries exactly the filters that were actually set.
 */
export function dataFiltersToQuery(
  filters: DataFilters,
  defaults: DataFilters,
  current?: URLSearchParams | null,
): string {
  const next = new URLSearchParams();

  // Foreign params first, so they survive and keep a stable position.
  if (current) {
    for (const [k, v] of current.entries()) if (isForeignParam(k)) next.append(k, v);
  }

  if (filters.store !== defaults.store) next.set("store", filters.store);
  if (filters.q !== defaults.q && filters.q !== "") next.set("q", filters.q);
  if (filters.state !== defaults.state && filters.state !== null)
    next.set("state", String(filters.state));
  if (filters.onlyDue !== defaults.onlyDue) next.set("due", filters.onlyDue ? "1" : "0");
  if (filters.sort !== defaults.sort) next.set("sort", filters.sort);
  if (filters.order !== defaults.order) next.set("order", filters.order);
  if (filters.page !== defaults.page && filters.page > 0)
    next.set("page", String(filters.page + 1));

  return next.toString();
}
