/** Below this much room above the + button, prefer down only if it has more room. */
export const MIN_ROOM_ABOVE = 160;

/** Visible space around the button, never around its possibly screen-tall parent. */
export function attachMenuRoom(
  button: { top: number; bottom: number },
  viewport: { height: number; offsetTop?: number },
): { px: number; down: boolean } {
  const top = viewport.offsetTop ?? 0;
  const above = Math.max(0, Math.floor(button.top - top - 8));
  const below = Math.max(0, Math.floor(top + viewport.height - button.bottom - 8));
  const down = above < MIN_ROOM_ABOVE && below > above;
  return { px: down ? below : above, down };
}

/** Keep a viewport-wide menu's close button inside either screen edge. */
export function attachMenuShift(menu: { left: number; width: number }, viewport: { width: number; offsetLeft?: number }): number {
  const start = (viewport.offsetLeft ?? 0) + 8;
  const end = Math.max(start, (viewport.offsetLeft ?? 0) + viewport.width - menu.width - 8);
  return Math.max(start, Math.min(menu.left, end)) - menu.left;
}
