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
    className: `min-h-12 space-y-0.5 overflow-y-auto px-0 py-1.5 transition-[max-height] duration-150 ease-out motion-reduce:transition-none ${expanded ? "max-h-[30vh]" : "max-h-[4.1rem]"}`,
  };
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
