/**
 * The app navigation's UI state (docs/ui-state.md, docs/bottom-nav.md).
 *
 * - `navUi` (sessionStorage `lk:ui:nav`, this tab): whether the drawer is
 *   open (memory only — a drawer is an overlay and never reopens on a
 *   refresh) and the pages visited recently in this tab.
 * - `navPins` (localStorage `lk:pref:nav-pins`, this device): pinned pages.
 *
 * Both hold paths only, never page content. The shell (AppShell) and the
 * nav islands (nav.bottom, nav.drawer) read and write the same stores: one
 * instance per page, kept on globalThis by @lianki/ui-state, so a hot-swapped
 * island shares them too.
 */
import { type UiStore, createUiStore } from "@lianki/ui-state";

export type NavUi = {
  drawerOpen: boolean;
  /** App paths visited in this tab, newest first. */
  recent: string[];
};

export type NavPins = {
  /** Pinned app paths, in the order they were pinned. */
  pinned: string[];
};

export const MAX_RECENT = 8;
export const MAX_PINS = 12;

/** An app path we keep: starts with one slash, no protocol, short. */
export const isAppPath = (p: unknown): p is string =>
  typeof p === "string" && p.length <= 300 && /^\/(?!\/)/.test(p);

const paths = (v: unknown, max: number): string[] | undefined =>
  Array.isArray(v) ? [...new Set(v.filter(isAppPath))].slice(0, max) : undefined;

export function cleanNavUi(raw: unknown): Partial<NavUi> {
  if (!raw || typeof raw !== "object") return {};
  const recent = paths((raw as Record<string, unknown>).recent, MAX_RECENT);
  return recent ? { recent } : {};
}

export function cleanNavPins(raw: unknown): Partial<NavPins> {
  if (!raw || typeof raw !== "object") return {};
  const pinned = paths((raw as Record<string, unknown>).pinned, MAX_PINS);
  return pinned ? { pinned } : {};
}

export const navUi: UiStore<NavUi> = createUiStore(
  "nav",
  1,
  { drawerOpen: false, recent: [] },
  { storage: "session", clean: cleanNavUi, keys: ["recent"] },
);

export const navPins: UiStore<NavPins> = createUiStore(
  "nav-pins",
  1,
  { pinned: [] },
  { storage: "local", clean: cleanNavPins },
);

/** The first-visit /words tip above the island (local `lk:pref:nav-tip`): shown once, until dismissed. */
export const navTip: UiStore<{ dismissed: boolean }> = createUiStore(
  "nav-tip",
  1,
  { dismissed: false },
  { storage: "local" },
);

export const setDrawerOpen = (open: boolean) => {
  if (navUi.getState().drawerOpen !== open) navUi.setState({ drawerOpen: open });
};

/** `recent` with `path` moved to the front, deduplicated, capped. */
export function withRecent(recent: readonly string[], path: string, max = MAX_RECENT): string[] {
  if (!isAppPath(path)) return [...recent];
  return [path, ...recent.filter((p) => p !== path)].slice(0, max);
}

export function noteVisit(path: string) {
  const { recent } = navUi.getState();
  if (recent[0] === path) return;
  navUi.setState({ recent: withRecent(recent, path) });
}

/** Pin `path`, or unpin it when it is pinned already. */
export function togglePin(path: string) {
  if (!isAppPath(path)) return;
  const { pinned } = navPins.getState();
  navPins.setState({
    pinned: pinned.includes(path)
      ? pinned.filter((p) => p !== path)
      : [...pinned, path].slice(-MAX_PINS),
  });
}
