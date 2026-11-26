/**
 * The viewport contract (snap-targets.ts SnapViewport) measured in a real
 * window: the one place that reads it, for DebugChat (main site and the
 * bundled 随身Li, which run in the host page's window) and 随身Li's frame shell
 * (src/partner-frame.ts, in the host page too, never inside the iframe).
 *
 * Measured once per drag start (a probe for the safe-area insets, the
 * visual viewport for the visible area). A resize or rotation during a drag
 * cancels that drag (snapshot restored; docs/chat-drag-ux.md); at rest the
 * results follow the viewport through CSS (full-screen.ts).
 */
import { dockViewport } from "./dock-resize";
import { fullScreenBox } from "./full-screen";
import type { SnapViewport } from "./snap-targets";

type Win = Pick<Window, "innerWidth" | "innerHeight" | "getComputedStyle" | "matchMedia"> & {
  visualViewport?: {
    offsetTop: number;
    offsetLeft?: number;
    width?: number;
    height: number;
    scale?: number;
  } | null;
  document: Document;
};

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** env(safe-area-inset-*) in px, through one hidden probe. */
export function safeInsets(doc: Document, win: Pick<Window, "getComputedStyle">) {
  const probe = doc.createElement("div");
  probe.style.cssText =
    "position:fixed!important;visibility:hidden!important;pointer-events:none!important;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)!important";
  (doc.body ?? doc.documentElement).append(probe);
  const cs = win.getComputedStyle(probe);
  const n = (v: string) => Number.parseFloat(v) || 0;
  const out = {
    top: n(cs.paddingTop),
    right: n(cs.paddingRight),
    bottom: n(cs.paddingBottom),
    left: n(cs.paddingLeft),
  };
  probe.remove();
  return out;
}

/**
 * The viewport now, in the snap contract's terms (docs/chat-drag-ux.md,
 * "Viewport Geometry Contract"): the visual viewport in client px
 * (offsetLeft, offsetTop, width, height, scale), so an open keyboard or a
 * pinch zoom moves the zones with what is visible; innerWidth × innerHeight
 * with 0 offsets without one. `wideQuery`: SIDEBAR_QUERY.
 */
export function measureSnapViewport(win: Win, wideQuery: string): SnapViewport {
  const vv = win.visualViewport ?? null;
  let wide = false;
  try {
    wide = win.matchMedia(wideQuery).matches;
  } catch {}
  const safe = safeInsets(win.document, win);
  const land = snapLanding(win.innerWidth, win.innerHeight, vv);
  if (!vv || !(num(vv.height, 0) > 0) || !(num(vv.width, 0) > 0)) {
    const box = fullScreenBox({ innerHeight: win.innerHeight, vv: null });
    return { x: 0, y: box.top, w: win.innerWidth, h: box.height, scale: 1, safe, wide, land };
  }
  return {
    x: num(vv.offsetLeft, 0),
    y: num(vv.offsetTop, 0),
    w: num(vv.width, win.innerWidth),
    h: num(vv.height, win.innerHeight),
    scale: num(vv.scale, 1),
    safe,
    wide,
    land,
  };
}

/**
 * Where full screen and the sidebar land, client px, computed by the very
 * functions that place them: fullScreenBox (FULL_SCREEN_STYLE's top and
 * height, left 0 to the layout width) and dockViewport (the sidebar's right
 * inset). At any zoom the preview drawn from snapTargets() is this rect.
 */
export function snapLanding(
  innerWidth: number,
  innerHeight: number,
  vv: { offsetTop: number; offsetLeft?: number; width?: number; height: number; scale?: number } | null,
): { full: { x: number; y: number; w: number; h: number }; right: number } {
  const box = fullScreenBox({ innerHeight, vv });
  const dv = dockViewport(innerWidth, vv && vv.width ? { width: vv.width, offsetLeft: vv.offsetLeft, scale: vv.scale } : null);
  return { full: { x: 0, y: box.top, w: innerWidth, h: box.height }, right: innerWidth - dv.right };
}
