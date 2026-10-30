"use client";

/**
 * Island `words.swipeFeel` (docs/swipe-core.md): a feel source. It renders
 * nothing; while mounted it publishes TUNE — token overrides per preset — to
 * the list's feel (lib/words/swipe-core.tsx).
 *
 * Built in, TUNE is empty: the presets in lib/words/swipe-feel.ts hold. With
 * hot islands on, edit TUNE here on the dev machine and save: the island
 * swaps on the phone and the new tokens apply to the next swipe, while the
 * list, the queue and a slip mid-drag keep their state.
 *
 *   const TUNE = { heavy: { damping: 56, friction: 5 } };
 */
import type { FeelPreset, FeelTweaks } from "@/lib/words/swipe-feel";
import { useFeelTune } from "@/lib/words/swipe-core";

const EXPECTS = 1;

const TUNE: Partial<Record<FeelPreset, FeelTweaks>> = {};

export function SwipeFeelSource() {
  useFeelTune(EXPECTS, "words.swipeFeel", TUNE);
  return null;
}
