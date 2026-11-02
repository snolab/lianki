/** Text size (lib/text-size.ts) for React. */
import { useSyncExternalStore } from "react";
import { effectiveScale, type TextArea, type TextSizes, textSizeStore } from "@/lib/text-size";

const DEFAULTS: TextSizes = { ui: 1, chat: 1, cards: 1 };
const subscribe = (l: () => void) => textSizeStore.subscribe(l);

/** The three choices. SSR and hydration: the defaults. */
export function useTextSizes(): TextSizes {
  return useSyncExternalStore(
    subscribe,
    () => textSizeStore.getState(),
    () => DEFAULTS,
  );
}

/** The factor in effect in an area, for code that measures text in px. */
export function useTextScale(area: TextArea): number {
  return useSyncExternalStore(
    subscribe,
    () => effectiveScale(textSizeStore.getState(), area),
    () => 1,
  );
}
