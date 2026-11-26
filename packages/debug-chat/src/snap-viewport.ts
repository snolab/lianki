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
import { fullScreenBox } from "./full-screen";
import type { SnapViewport } from "./snap-targets";

type Win = Pick<Window, "innerWidth" | "innerHeight" | "getComputedStyle" | "matchMedia"> & {
  visualViewport?: { offsetTop: number; height: number; scale?: number } | null;
  document: Document;
};

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

/** The viewport now, in the snap contract's terms. `wideQuery`: SIDEBAR_QUERY. */
export function measureSnapViewport(win: Win, wideQuery: string): SnapViewport {
  const box = fullScreenBox({ innerHeight: win.innerHeight, vv: win.visualViewport ?? null });
  let wide = false;
  try {
    wide = win.matchMedia(wideQuery).matches;
  } catch {}
  return {
    x: 0,
    y: box.top,
    w: win.innerWidth,
    h: box.height,
    safe: safeInsets(win.document, win),
    wide,
  };
}
