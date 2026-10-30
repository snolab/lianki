/**
 * The chat log's display, shared by the log and the state tree: no box, just
 * text over the page (the box's halo keeps it legible), click-through except
 * for rows that opt in, fading out at its top edge once there is more than
 * fits. Compact (3 lines) at rest; open to 30vh while the input has focus or
 * the mic is on.
 */

/** Older lines dissolve at the top edge (only once there is more than fits). */
export const FADE = "linear-gradient(to bottom, transparent, black 2.5rem)";
/** The compact surface fades over less, so its 3 lines stay legible. */
export const FADE_SHORT = "linear-gradient(to bottom, transparent, black 0.9rem)";

/** Props for a log surface element: its classes and its fade mask. */
export function logSurface({ expanded, fade }: { expanded: boolean; fade: boolean }) {
  const mask = expanded ? FADE : FADE_SHORT;
  return {
    style: fade ? { maskImage: mask, WebkitMaskImage: mask } : undefined,
    className: `min-h-12 space-y-0.5 overflow-y-auto px-0 py-1.5 transition-[max-height] duration-150 ease-out motion-reduce:transition-none ${expanded ? "max-h-[30vh]" : "max-h-[4.4rem]"}`,
  };
}

/** Above the full-screen log's top: the visible top (notch, keyboard pan) plus this. */
export const FULL_LOG_GAP_PX = 8;

/**
 * The full-screen log (while a vertical drag on the bar scrolls it): how tall
 * it may grow, upward from where its bottom edge already is (just above the
 * bar, which stays put), to the visible top less the notch. Never shorter
 * than it is.
 */
export function fullLogHeight(d: {
  /** The log's rect now (layout px). */
  bottom: number;
  height: number;
  /** env(safe-area-inset-top), and visualViewport.offsetTop (a keyboard pan). */
  safeTop: number;
  vvTop?: number;
}): number {
  const top = Math.max(d.safeTop, d.vvTop ?? 0) + FULL_LOG_GAP_PX;
  return Math.round(Math.max(d.height, d.bottom - top));
}

/**
 * The scrollTop that keeps the same distance from the end (`gap`, px below
 * the view) after the log's height changed, so the lines at its bottom edge,
 * which does not move, stay where they were.
 */
export function keepEndGap(d: { scrollHeight: number; clientHeight: number; gap: number }): number {
  return Math.max(0, Math.round(d.scrollHeight - d.clientHeight - Math.max(0, d.gap)));
}

/**
 * A stronger halo for lines floating straight over the page (the minimized
 * chat's floating and frontier lines): text only, never a fill. Layers of
 * text-shadow in the page colour; where --background is missing the whole
 * declaration is dropped, so it can only fall back to no halo, never a box.
 */
export const LINE_HALO = [1, 2, 4, 8]
  .map((px) => `0 0 ${px}px var(--background)`)
  .join(", ");
