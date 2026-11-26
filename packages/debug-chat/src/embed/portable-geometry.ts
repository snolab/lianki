/**
 * A read-only geometry hint for real-browser QA of 随身Li (the shadow root is
 * closed, so a native test cannot reach the grip): on <html>,
 *
 *   data-lk-portable-grip="x,y,w,h"   the grip's viewport rect, CSS px, rounded
 *   data-lk-portable-rect="x,y,w,h"   the chat window's rect
 *
 * kept current on mount, drag end, resize, minimize and restore (any change
 * inside the root, window resize, pointerup). Nothing else is exposed: no
 * text, no API on window, and the look and behavior are untouched.
 */
export const GRIP_ATTR = "data-lk-portable-grip";
export const RECT_ATTR = "data-lk-portable-rect";

const fmt = (r: { x: number; y: number; width: number; height: number }) =>
  [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(",");

export function publishGeometry(
  root: ShadowRoot,
  doc: Document,
  win: Pick<Window, "addEventListener" | "removeEventListener" | "requestAnimationFrame" | "cancelAnimationFrame">,
): () => void {
  const html = doc.documentElement;
  const write = () => {
    const grip = root.querySelector<HTMLElement>('[data-testid="debug-chat-grip"]');
    const box = root.querySelector<HTMLElement>("[data-debug-chat]");
    if (grip) html.setAttribute(GRIP_ATTR, fmt(grip.getBoundingClientRect()));
    else html.removeAttribute(GRIP_ATTR);
    if (box) html.setAttribute(RECT_ATTR, fmt(box.getBoundingClientRect()));
    else html.removeAttribute(RECT_ATTR);
  };
  let queued = 0;
  const soon = () => {
    if (queued) return;
    queued = win.requestAnimationFrame(() => {
      queued = 0;
      write();
    });
  };
  // Any change in the chat's tree: mount, minimize / restore, the drag's style updates.
  const MO = (doc.defaultView as (Window & typeof globalThis) | null)?.MutationObserver ?? MutationObserver;
  const mo = new MO(soon);
  mo.observe(root, { childList: true, subtree: true, attributes: true });
  // Drag end (pointer capture keeps the up event on the grip, inside the root).
  root.addEventListener("pointerup", soon, true);
  win.addEventListener("resize", soon);
  write();
  return () => {
    mo.disconnect();
    root.removeEventListener("pointerup", soon, true);
    win.removeEventListener("resize", soon);
    if (queued) win.cancelAnimationFrame(queued);
    html.removeAttribute(GRIP_ATTR);
    html.removeAttribute(RECT_ATTR);
  };
}
