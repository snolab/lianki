/** Right-docked chat geometry. Bounds are measured from the current visual
 * viewport and the composer's established minimum width, in CSS pixels.
 */
export type DockBounds = { min: number; max: number };
export function dockBounds(viewportWidth: number, minWidth: number): DockBounds {
  const max = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const min = Number.isFinite(minWidth) ? Math.min(max, Math.max(0, minWidth)) : 0;
  return { min, max };
}
export function clampDockWidth(width: number, bounds: DockBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Number.isFinite(width) ? width : bounds.min));
}
/** Moving the inner/left border left widens the box, without moving its right edge. */
export function resizeDockWidth(
  startWidth: number,
  startX: number,
  x: number,
  bounds: DockBounds,
): number {
  const delta = Number.isFinite(startX) && Number.isFinite(x) ? startX - x : 0;
  return clampDockWidth(startWidth + delta, bounds);
}
/** Width and horizontal pan of the visible viewport, including zoom. */
export function dockViewport(
  innerWidth: number,
  vv?: { width: number; offsetLeft?: number; scale?: number } | null,
) {
  const layout = Number.isFinite(innerWidth) ? Math.max(0, innerWidth) : 0;
  if (!vv || !(vv.width > 0)) return { width: layout, right: 0 };
  const left = Math.min(layout, Math.max(0, Number.isFinite(vv.offsetLeft) ? vv.offsetLeft! : 0));
  const width = Math.min(layout - left, vv.width);
  return { width, right: Math.max(0, layout - left - width) };
}
export const DOCK_WIDTH_VAR = "--lk-chat-dock-width";
export const DOCK_RIGHT_VAR = "--lk-chat-dock-right";
