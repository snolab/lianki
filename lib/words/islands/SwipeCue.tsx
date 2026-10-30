"use client";

/**
 * Island `words.swipeCue` (docs/swipe-core.md): the lift a slip gets while
 * it is pressed or dragged — a shadow under it that rises and falls. Nothing
 * on the light feel (lift 0). A press that turns into a scroll within the
 * delay never shows it, so scrolling the list doesn't flicker.
 */
import { useSwipeRow } from "@/lib/words/swipe-core";

const EXPECTS = 1;
/** A press lifts only after this long: a scroll decides sooner. */
const PRESS_DELAY_MS = 70;

export function SwipeCue() {
  const { phase, feel, reducedMotion } = useSwipeRow(EXPECTS);
  const lift = feel.lift;
  if (lift <= 0) return null;
  const up = phase === "pressed" || phase === "dragging";
  const delay = phase === "pressed" ? PRESS_DELAY_MS : 0;
  return (
    <span
      aria-hidden
      data-swipe-cue={up ? "up" : "down"}
      className="pointer-events-none absolute inset-0"
      style={{
        borderRadius: "inherit",
        boxShadow: `0 ${3 + 5 * lift}px ${8 + 12 * lift}px -4px oklch(0.2 0.03 50 / ${(0.45 * lift).toFixed(2)}), 0 1px 2px oklch(0.2 0.03 50 / ${(0.2 * lift).toFixed(2)})`,
        opacity: up ? 1 : 0,
        transition: reducedMotion ? "none" : `opacity ${feel.liftMs}ms ease-out ${delay}ms`,
      }}
    />
  );
}
