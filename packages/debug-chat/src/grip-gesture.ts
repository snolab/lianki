import { createTapper } from "./tap-gesture";

export function createGripGesture(d: {
  onSingle: () => void;
  onDouble: () => void;
  /** `hold`: a touch hold opened it, the finger still down (press-menu.ts follows it). */
  onMenu: (via?: "hold" | "context") => void;
  onHoldCancelDrag: () => void;
  holdMs: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer =
    d.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const tapper = createTapper({ ...d, setTimer, clearTimer });
  let press: { x: number; y: number; id: number } | null = null;
  let hold: unknown = null;
  let suppressed = false;
  let held = false;
  const stopHold = () => {
    if (hold !== null) clearTimer(hold);
    hold = null;
  };
  const cancel = () => {
    stopHold();
    tapper.cancel();
    press = null;
    suppressed = true;
    held = false;
  };
  return {
    down(p: { pointerType: string; button: number; x: number; y: number; id: number }): boolean {
      if (p.button !== 0) return false;
      stopHold();
      press = { x: p.x, y: p.y, id: p.id };
      suppressed = false;
      held = false;
      if (p.pointerType === "touch" || p.pointerType === "pen") {
        const current = press;
        hold = setTimer(() => {
          if (press !== current || suppressed) return;
          hold = null;
          suppressed = true;
          held = true;
          tapper.cancel();
          d.onHoldCancelDrag();
          d.onMenu("hold");
        }, d.holdMs());
      }
      return true;
    },
    move(p: { x: number; y: number; id: number }) {
      if (!press || press.id !== p.id || Math.hypot(p.x - press.x, p.y - press.y) < 5) return;
      stopHold();
      tapper.cancel();
      suppressed = true;
    },
    up() {
      stopHold();
      press = null;
    },
    cancel,
    click(wasDrag: boolean) {
      if (wasDrag || suppressed) {
        tapper.cancel();
        return;
      }
      tapper.tap();
    },
    context() {
      const alreadyOpened = held;
      cancel();
      if (!alreadyOpened) {
        d.onHoldCancelDrag();
        d.onMenu("context");
      }
    },
  };
}

/** Fixed portal menu: above the grip when that side has more space, otherwise below. */
export function gripMenuPosition(
  rect: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number; top?: number; left?: number },
): { left: number; top: number; maxHeight: number; width: number; transform?: string } {
  const leftEdge = viewport.left ?? 0;
  const topEdge = viewport.top ?? 0;
  const padX = Math.min(8, Math.max(0, viewport.width / 2));
  const padY = Math.min(8, Math.max(0, viewport.height / 2));
  const width = Math.max(0, Math.min(192, viewport.width - 2 * padX));
  const height = Math.max(0, viewport.height - 2 * padY);
  const left = Math.max(
    leftEdge + padX,
    Math.min(rect.left, leftEdge + viewport.width - padX - width),
  );
  const above = Math.max(0, Math.min(height, rect.top - topEdge - 4 - padY));
  const below = Math.max(0, Math.min(height, topEdge + viewport.height - rect.bottom - 4 - padY));
  const anchor = (y: number) =>
    Math.max(topEdge + padY, Math.min(y, topEdge + viewport.height - padY));
  // Its own height determines the above edge, not the maximum available height.
  if (above > below)
    return {
      left,
      top: anchor(rect.top - 4),
      transform: "translateY(-100%)",
      maxHeight: above,
      width,
    };
  return { left, top: anchor(rect.bottom + 4), maxHeight: below, width };
}
