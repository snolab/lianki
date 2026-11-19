/** Keep the message being read in place when the log's viewport changes size.
 * Content-only changes leave the reader alone; bottom following belongs to
 * scroll-follow.ts. No state is persisted or sent through React renders.
 */
export function createLogResizeAnchor(d: {
  box: () => HTMLElement | null;
  following: { current: boolean };
}) {
  let size: { width: number; height: number } | null = null;
  let anchor: { row: HTMLElement; offset: number } | null = null;
  return {
    reset() {
      size = null;
      anchor = null;
    },
    remember() {
      anchor = null;
      const box = d.box();
      if (!box || box.hidden || d.following.current) return;
      const view = box.getBoundingClientRect();
      const focus = (view.top + view.bottom) / 2;
      let nearest = Infinity;
      for (const row of box.querySelectorAll<HTMLElement>('[data-testid="debug-chat-line"]')) {
        const rect = row.getBoundingClientRect();
        const distance = Math.max(rect.top - focus, focus - rect.bottom, 0);
        if (distance < nearest) {
          nearest = distance;
          anchor = { row, offset: rect.top - view.top };
        }
      }
    },
    resize() {
      const box = d.box();
      if (!box || box.hidden) {
        this.reset();
        return;
      }
      const before = size;
      size = { width: box.clientWidth, height: box.clientHeight };
      if (!before || (before.width === size.width && before.height === size.height)) return;
      if (d.following.current || !anchor || !box.contains(anchor.row)) return;
      const shift =
        anchor.row.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.offset;
      // Keep a long message's clipped offset, including a top above the view.
      box.scrollTop = Math.max(
        0,
        Math.min(box.scrollHeight - box.clientHeight, box.scrollTop + shift),
      );
    },
  };
}
