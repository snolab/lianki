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
import { useEffect } from "react";
import { useFeelTune, useSwipeFeel } from "@/lib/words/swipe-core";

const EXPECTS = 1;

/**
 * Until the build without the tilt token is deployed, a hot-loaded copy of
 * this island turns the deployed core's tilt off (the owner, 2026-10-30:
 * translate only). Built in, or once deployed, cleanTweaks drops the unknown
 * key and this is a no-op.
 */
const NO_TILT = { rotatePerPx: 0 } as unknown as FeelTweaks;
const TUNE: Partial<Record<FeelPreset, FeelTweaks>> = { light: NO_TILT, heavy: NO_TILT };

export function SwipeFeelSource() {
  useFeelTune(EXPECTS, "words.swipeFeel", TUNE);
  // A tilt tweak stored on this device would win over TUNE on the deployed
  // core: drop it.
  const { prefs, setPrefs } = useSwipeFeel(EXPECTS);
  const stale = "rotatePerPx" in prefs.tweaks;
  useEffect(() => {
    if (!stale) return;
    const { rotatePerPx: _, ...tweaks } = prefs.tweaks as FeelTweaks & { rotatePerPx?: number };
    setPrefs({ ...prefs, tweaks });
  }, [stale, prefs, setPrefs]);
  return null;
}
