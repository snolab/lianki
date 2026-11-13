/**
 * The left rail's fold (docs/ui-state.md, "sidebar collapsed"; owner,
 * 2026-11-11: he wanted to fold the rail on his tablet and found no control).
 *
 * - Folded, the rail is gone: `--nav-w` is 0, so the content gets the whole
 *   width; a small "»" handle brings it back (AppShell).
 * - A device preference, localStorage `lk:pref:sidebar`: the rail stays as
 *   you left it in every tab on this device. The first shell's `lk:sidebar`
 *   ("1" / "0") is carried over once.
 */
import { type UiStore, createUiStore } from "@lianki/ui-state";

export type RailUi = { collapsed: boolean };

/** The first shell's key: "1" folded, "0" open. */
export const LEGACY_SIDEBAR_KEY = "lk:sidebar";

export const railUi: UiStore<RailUi> = createUiStore(
  "sidebar",
  1,
  { collapsed: false },
  { storage: "local" },
);

type KeyStore = Pick<Storage, "getItem" | "removeItem">;

/**
 * The legacy `lk:sidebar` value, removed once read: true / false, or null
 * when there is none (or storage throws, as in a private window).
 */
export function takeLegacyCollapsed(store: KeyStore | null | undefined): boolean | null {
  try {
    const v = store?.getItem(LEGACY_SIDEBAR_KEY);
    if (v !== "1" && v !== "0") return null;
    store?.removeItem(LEGACY_SIDEBAR_KEY);
    return v === "1";
  } catch {
    return null;
  }
}

/** Carries the legacy value into the store, once (AppShell, after mount). */
export function adoptLegacyCollapsed(store: KeyStore | null | undefined) {
  const legacy = takeLegacyCollapsed(store);
  if (legacy !== null) railUi.setState({ collapsed: legacy });
}

export const setRailCollapsed = (collapsed: boolean) => {
  if (railUi.getState().collapsed !== collapsed) railUi.setState({ collapsed });
};

export const toggleRail = () => setRailCollapsed(!railUi.getState().collapsed);
