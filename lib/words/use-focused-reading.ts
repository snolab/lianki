"use client";

import { useEffect, useRef, type RefObject } from "react";

export type FocusedSpeech<P> = {
  once(parts: P[], force?: boolean, options?: { yieldToHold?: boolean }): void;
  loop(parts: P[], force?: boolean): (() => void) | void;
  stop(): void;
};

/** One focused reading owns both input modes; the desktop must never stop a touch reading. */
export function useFocusedReading<P>(d: {
  touch: boolean;
  active: boolean;
  focus: number;
  parts: P[];
  holding: boolean;
  quietFocus: RefObject<number | null>;
  speech: FocusedSpeech<P>;
}) {
  const { touch, active, focus, holding, quietFocus } = d;
  const { once, loop, stop } = d.speech;
  // Content, not the array or the speech facade: unrelated renders keep the
  // current utterance, while a new voice/reading callback can retry this row.
  const content = JSON.stringify(d.parts);
  const previousTouchFocus = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return stop();
    const parts = JSON.parse(content) as P[];
    if (!touch) return loop(parts);
    if (holding) return;
    const moved = previousTouchFocus.current !== focus;
    previousTouchFocus.current = focus;
    const alreadySaid = quietFocus.current === focus;
    quietFocus.current = null;
    if (moved && alreadySaid) return;
    once(parts, false, { yieldToHold: true });
    // A tap/hold uses this same sequencer. An effect cleanup here would cut
    // that gesture's reading before the new focus effect can suppress its echo.
  }, [touch, active, focus, content, holding, quietFocus, once, loop, stop]);

  useEffect(() => () => stop(), [stop]);
}
