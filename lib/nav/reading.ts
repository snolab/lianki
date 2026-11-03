/**
 * A page in reading mode tells the bottom island so (docs/design-principles.md,
 * "Chrome steps back while you read"; owner decision 2026-11-03 19:40: the
 * bottom nav shrinks to its capsule while reading). Memory only, one per page
 * (globalThis via @lianki/ui-state), so a hot-swapped island shares it.
 *
 * - `on`: a reader is mounted (the /read reader v2). While on, the island
 *   ignores its own scroll rule: it shows the capsule unless `island` is true.
 * - `island`: he tapped the capsule; the island is full until his next own
 *   scroll toward content (the reader sets it false again).
 */
import { type UiStore, createUiStore } from "@lianki/ui-state";

export type Reading = { on: boolean; island: boolean };

export const readingUi: UiStore<Reading> = createUiStore(
  "reading",
  1,
  { on: false, island: false },
  // Nothing is written (keys: []): reading mode is the mounted page's, never restored.
  { storage: "session", keys: [] },
);

export const setReading = (patch: Partial<Reading>) => {
  const s = readingUi.getState();
  if (Object.entries(patch).some(([k, v]) => s[k as keyof Reading] !== v))
    readingUi.setState(patch);
};
