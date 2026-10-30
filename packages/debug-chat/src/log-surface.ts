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

/**
 * Size-snapping for the full-screen log (no device or orientation checks):
 * each axis snaps to the screen's edges when the screen is smaller than
 * that axis's threshold, else keeps its own size. Like CSS
 * `max(keep, min(screen, (threshold − screen) · ∞))`.
 */
export function snapAxis(screen: number, keep: number, threshold: number): number {
  return Math.max(keep, Math.min(screen, (threshold - screen) * 1e9));
}
/** Below this viewport width the log snaps to the full width (a phone held upright). */
export const LOG_SNAP_W_PX = 640;
/** Below this viewport height it snaps to the full height (every phone and tablet). */
export const LOG_SNAP_H_PX = 1600;

/**
 * The full-screen log's box (viewport px) when a drag on the empty input
 * opened it. Each axis snaps by itself (snapAxis): the width to the screen
 * less the side gutters and safe areas, the height to the visible area (the
 * notch, the keyboard). Once the width has snapped, the log spans the screen
 * and the bar is hidden, so it goes down to the visible bottom too;
 * otherwise it stops above the bar, as the mic's drag does.
 */
export function fullLogBox(d: {
  vw: number;
  vh: number;
  /** The visible area: visualViewport offsetTop and offsetTop + height (else 0 and vh). */
  visibleTop: number;
  visibleBottom: number;
  safe: { top: number; right: number; bottom: number; left: number };
  /** The log's rect now. */
  log: { left: number; width: number; bottom: number; height: number };
  gap?: number;
}): { left: number; width: number; top: number; bottom: number; hideBar: boolean } {
  const g = d.gap ?? FULL_LOG_GAP_PX;
  const fullW = d.vw - d.safe.left - d.safe.right - 2 * g;
  const width = Math.round(snapAxis(fullW, d.log.width, LOG_SNAP_W_PX - (d.vw - fullW)));
  // It spans the screen (snapped, or already as wide): the bar would only cover it.
  const hideBar = width >= Math.round(fullW);
  const left = Math.round(hideBar ? d.safe.left + g : d.log.left);
  const top = Math.max(d.safe.top, d.visibleTop) + g;
  const screenBottom = Math.min(d.visibleBottom, d.vh - d.safe.bottom) - g;
  const fullH = (hideBar ? screenBottom : d.log.bottom) - top;
  const height = Math.round(snapAxis(fullH, d.log.height, LOG_SNAP_H_PX - (d.vh - fullH)));
  const bottom = hideBar ? Math.round(screenBottom) : Math.round(d.log.bottom);
  return { left, width, top: bottom - height, bottom, hideBar };
}
