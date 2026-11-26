/**
 * How the drag overlay looks (snap-targets.ts): plain style objects and
 * icon paths, shared by DebugChat's SnapOverlay.tsx and 随身Li's frame shell
 * (src/partner-frame.ts, plain DOM), so both draw the same thing.
 *
 * - every zone, faint, from the drag's start, with an icon and a label;
 * - the hovered zone stronger, seal red;
 * - the result's rect as translucent glass, growing from the window's own
 *   rect (transform only: no layout per frame), seal-red hairline.
 *
 * Seal red is the brand, not danger (docs/design-principles.md). Colours are
 * oklch only; var(--background)/var(--foreground) where the page has them,
 * paper and ink otherwise (another site).
 */
import type { Rect, SnapId, SnapTarget, SnapViewport } from "./snap-targets";

const SEAL = (a: number) => `oklch(0.53 0.207 22.3 / ${a})`;
const PAPER = "var(--background, oklch(0.98 0.01 82))";
const INK = "var(--foreground, oklch(0.25 0.02 65))";

/** The overlay sits just under the chat (its z-index less one) and never takes a touch. */
export const OVERLAY_Z = "calc(var(--lk-z-chat, 80) - 1)";

type Style = Record<string, string | number>;

export function zoneStyle(t: SnapTarget, d: { hot: boolean; shown: boolean; ms: number; reduce: boolean }): Style {
  return {
    position: "fixed",
    left: `${t.zone.x}px`,
    top: `${t.zone.y}px`,
    width: `${t.zone.w}px`,
    height: `${t.zone.h}px`,
    boxSizing: "border-box",
    pointerEvents: "none",
    zIndex: OVERLAY_Z,
    borderRadius: t.id === "minimize" ? "18px 0 0 0" : "0",
    border: `1px dashed ${SEAL(d.hot ? 0.75 : 0.35)}`,
    background: SEAL(d.hot ? 0.14 : 0.05),
    opacity: d.shown ? 1 : 0,
    transition: d.reduce ? "none" : `opacity ${d.ms}ms ease-out, background ${d.ms}ms ease-out`,
  };
}

/** Labels sit over the chat (they name what is under it), still never taking a touch. */
export const LABEL_Z = "calc(var(--lk-z-chat, 80) + 1)";

/**
 * Where a zone's label sits, clear of the safe areas (the home indicator, a
 * notch) and never off-screen: the strips' labels in their middle; the
 * corner's label right-aligned just above the corner square (it is wider
 * than the corner). `end`: the point is the label's bottom-right corner.
 */
export function labelAt(t: SnapTarget, vp: SnapViewport): { x: number; y: number; end?: boolean } {
  const z = t.zone;
  const s = vp.safe;
  if (t.id === "fullscreen") return { x: z.x + z.w / 2, y: z.y + (z.h - s.bottom) / 2 };
  if (t.id === "dock-right") return { x: z.x + (z.w - s.right) / 2, y: z.y + z.h / 2 };
  return { x: z.x + z.w - s.right - 6, y: z.y - 6, end: true };
}

export function labelStyle(
  at: { x: number; y: number; end?: boolean },
  d: { hot: boolean; vertical: boolean; ms: number; reduce: boolean },
): Style {
  const shift = at.end ? "translate(-100%, -100%)" : "translate(-50%, -50%)";
  return {
    position: "fixed",
    left: `${at.x}px`,
    top: `${at.y}px`,
    transformOrigin: at.end ? "100% 100%" : "50% 50%",
    transform: `${shift} scale(${d.hot ? 1.06 : 1})`,
    pointerEvents: "none",
    zIndex: LABEL_Z,
    display: "flex",
    flexDirection: d.vertical ? "column" : "row",
    alignItems: "center",
    gap: "4px",
    padding: d.vertical ? "6px 4px" : "4px 10px",
    maxWidth: d.vertical ? "56px" : "none",
    borderRadius: "999px",
    font: "600 12px/16px system-ui, sans-serif",
    textAlign: "center",
    whiteSpace: d.vertical ? "normal" : "nowrap",
    color: d.hot ? "oklch(0.99 0.005 82)" : INK,
    background: d.hot ? SEAL(0.92) : `color-mix(in oklch, ${PAPER} 78%, transparent)`,
    border: `1px solid ${SEAL(d.hot ? 0.9 : 0.35)}`,
    backdropFilter: "blur(8px) saturate(1.4)",
    WebkitBackdropFilter: "blur(8px) saturate(1.4)",
    transition: d.reduce
      ? "none"
      : `transform ${d.ms}ms ease-out, background ${d.ms}ms ease-out, opacity ${d.ms}ms ease-out`,
  };
}

/** The result preview at rest (where it ends): glass over the target rect. */
export function previewStyle(r: Rect, d: { alpha: number }): Style {
  return {
    position: "fixed",
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.w}px`,
    height: `${r.h}px`,
    boxSizing: "border-box",
    pointerEvents: "none",
    zIndex: OVERLAY_Z,
    transformOrigin: "0 0",
    borderRadius: r.w < 160 || r.h < 160 ? "999px" : "12px",
    background: `color-mix(in oklch, ${PAPER} 50%, ${SEAL(0.12)})`,
    border: `2px solid ${SEAL(0.85)}`,
    boxShadow: `0 0 0 1px ${SEAL(0.2)}, 0 12px 32px ${SEAL(0.18)}`,
    backdropFilter: "blur(10px) saturate(1.4)",
    WebkitBackdropFilter: "blur(10px) saturate(1.4)",
    opacity: Math.max(0, Math.min(1, d.alpha)),
  };
}

/**
 * The FLIP start: the transform that puts the preview (laid out at `to`) over
 * `from` (the window's rect when the zone was entered). Animating it to
 * `none` grows the window into its result, as Windows Snap's preview does.
 */
export function growFrom(from: Rect | null, to: Rect): string {
  if (!from || !(to.w > 0) || !(to.h > 0)) return "none";
  const sx = Math.max(0.01, from.w / to.w);
  const sy = Math.max(0.01, from.h / to.h);
  return `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${sx}, ${sy})`;
}

/** 18×18 stroke icons (viewBox 0 0 18 18), one per zone. */
export const SNAP_ICON: Record<SnapId, string> = {
  // Four corners pushed out: fill the screen.
  fullscreen: "M2 6V2h4M12 2h4v4M16 12v4h-4M6 16H2v-4",
  // A screen with its right part filled: the sidebar.
  "dock-right": "M2 3h14v12H2zM11 3v12M12.5 6h2M12.5 9h2",
  // A bar folding down to a short one: minimize.
  minimize: "M3 13h12M6 9.5l3 3 3-3M9 3v9",
};

export function iconSvg(doc: Document, id: SnapId): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const p = doc.createElementNS(ns, "path");
  p.setAttribute("d", SNAP_ICON[id]);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.6");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
}
