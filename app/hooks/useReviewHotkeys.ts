"use client";

import { useEffect } from "react";

type ReviewHotkeysOptions = {
  onRate: (rating: 1 | 2 | 3 | 4) => void;
  onDelete?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  enabled?: boolean;
};

/**
 * Keyboard shortcuts for the review flow.
 *
 * Rating:
 *   1 / d / l  = Again (1)
 *   2 / s / j  = Hard  (2)
 *   3          = Good  (3)
 *   4 / a / h  = Easy  (4)
 *
 * Delete: 5 / m / t
 * Navigate: ArrowUp/i (prev), ArrowDown/k (next)
 */
export function useReviewHotkeys({
  onRate,
  onDelete,
  onNext,
  onPrev,
  enabled = true,
}: ReviewHotkeysOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

      // Rating: 1-4
      if (e.code === "Digit1" || e.code === "KeyD" || e.code === "KeyL") {
        e.preventDefault();
        onRate(1);
        return;
      }
      if (e.code === "Digit2" || e.code === "KeyS" || e.code === "KeyJ") {
        e.preventDefault();
        onRate(2);
        return;
      }
      if (e.code === "Digit3") {
        e.preventDefault();
        onRate(3);
        return;
      }
      if (e.code === "Digit4" || e.code === "KeyA" || e.code === "KeyH") {
        e.preventDefault();
        onRate(4);
        return;
      }

      // Delete
      if (onDelete) {
        if (e.code === "Digit5" || e.code === "KeyM" || e.code === "KeyT") {
          e.preventDefault();
          onDelete();
          return;
        }
      }

      // Navigation
      if (onPrev && (e.code === "ArrowUp" || e.code === "KeyI")) {
        e.preventDefault();
        onPrev();
        return;
      }
      if (onNext && (e.code === "ArrowDown" || e.code === "KeyK")) {
        e.preventDefault();
        onNext();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onRate, onDelete, onNext, onPrev, enabled]);
}
