"use client";

/**
 * Island `words.swipeCard` (docs/swipe-core.md): the slip the js swipe
 * moves. It renders the card slot the core hands it — the element the core
 * writes the transform to, and what goes inside — so its markup can change
 * live while the gesture, the physics and the grade stay in the core.
 */
import { useSwipeRow } from "@/lib/words/swipe-core";

/** The swipe core interface this island was written for. */
const EXPECTS = 1;

export function SwipeCard() {
  const { card, phase, feel } = useSwipeRow(EXPECTS);
  if (!card) return null;
  const { bind, index, className, style, children } = card;
  return (
    <div
      ref={bind.ref}
      role="listitem"
      data-i={index}
      // Raised over its neighbours while lifted, so the lift's shadow shows (globals.css).
      data-swipe-phase={feel.lift > 0 ? phase : undefined}
      className={className}
      style={style}
      onPointerDown={bind.onPointerDown}
      onPointerMove={bind.onPointerMove}
      onPointerUp={bind.onPointerUp}
      onPointerCancel={bind.onPointerCancel}
    >
      {children}
    </div>
  );
}
