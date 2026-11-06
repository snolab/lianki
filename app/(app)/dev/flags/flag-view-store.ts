import { createUiStore } from "@lianki/ui-state";
import type { StateFilter } from "./flag-view";

export type FlagViewPrefs = {
  state: StateFilter;
  recent: boolean;
  /** Sections the owner opened or folded; the rest keep their default. */
  open: Record<string, boolean>;
};

const INITIAL: FlagViewPrefs = { state: "all", recent: false, open: {} };

/** What came out of storage, keeping only what still makes sense. */
export function cleanFlagViewPrefs(stored: unknown): Partial<FlagViewPrefs> {
  if (!stored || typeof stored !== "object") return {};
  const s = stored as Record<string, unknown>;
  const out: Partial<FlagViewPrefs> = {};
  if (s.state === "all" || s.state === "on" || s.state === "off") out.state = s.state;
  if (typeof s.recent === "boolean") out.recent = s.recent;
  if (s.open && typeof s.open === "object" && !Array.isArray(s.open))
    out.open = Object.fromEntries(
      Object.entries(s.open).filter(([, v]) => typeof v === "boolean"),
    ) as Record<string, boolean>;
  return out;
}

/** /dev/flags filters and folded sections: this device (docs/ui-state.md). */
export const flagViewPrefs = createUiStore("flags-view", 1, INITIAL, {
  storage: "local",
  clean: cleanFlagViewPrefs,
});
