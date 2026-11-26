/**
 * Where a dragged chat window can be dropped for a special result, and what
 * that result is (docs/chat-drag-ux.md; owner, 2026-11-27: "show every region
 * that would trigger a special behaviour, the moment the drag starts").
 *
 * One pure function, `snapTargets`, used by the main site's DebugChat, the
 * bundled 随身Li (the same DebugChat, `embedded`) and 随身Li's frame shell
 * (src/partner-frame.ts): the overlay draws exactly these zones and previews,
 * and a drop applies exactly these results, so the visuals and the behaviour
 * cannot drift apart.
 *
 * Zones are hit by the POINTER (clientX, clientY), as Windows Snap does, never
 * by where the clamped window happens to rest.
 *
 * | id           | zone (pointer)                         | result                         |
 * | ------------ | -------------------------------------- | ------------------------------ |
 * | `minimize`   | bottom-right corner, corner × corner   | the pill at its home corner    |
 * | `fullscreen` | bottom strip, left of the corner       | the whole visible area         |
 * | `dock-right` | right strip, above the corner          | a full-height right sidebar    |
 * | (none)       | anywhere else, the top edge included   | a free move                    |
 *
 * The top edge deliberately has none (owner, 2026-11-09 18:26 JST: it would
 * hide the history).
 */

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * The viewport contract (codex review, 2026-11-27): ONE definition of "the
 * screen" for zones, previews and results. Layout-viewport CSS px, as
 * clientX/clientY are. `y`/`h` are the visible area (the visual viewport, so
 * an open iOS keyboard shrinks it, as full screen does: full-screen.ts
 * fullScreenBox); `x`/`w` the layout width. `safe` are the safe-area insets.
 * 随身Li measures the HOST page's window (the shell and the bundled window run
 * in it), never an iframe's.
 */
export type SnapViewport = {
  /** visualViewport.offsetLeft / offsetTop / width / height (client px); innerWidth × innerHeight and 0 offsets without one. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** visualViewport.scale (pinch zoom), 1 without one. */
  scale?: number;
  safe: { top: number; right: number; bottom: number; left: number };
  /** Wider than SIDEBAR_QUERY (35em): a right sidebar leaves the page usable. */
  wide: boolean;
};

export type SnapId = "minimize" | "fullscreen" | "dock-right";

export type SnapTarget = {
  id: SnapId;
  /** Where the pointer must be. */
  zone: Rect;
  /** The window's rect after the drop: what the preview draws. */
  result: Rect;
};

/** Defaults for the live config keys (lib/config.ts `chat.snap*`, `chat.drag*`): the code holds only these. */
export const SNAP_DEFAULTS = {
  /** chat.dragThresholdPx: a press that moves less is a tap. */
  dragThresholdPx: 5,
  /** chat.fullLeavePx: how far up a drag in full screen or the sidebar goes before it leaves. */
  fullLeavePx: 48,
  /** chat.snapZoneEdgePx: the bottom and right strips' thickness. */
  edgePx: 64,
  /** chat.snapZoneCornerPx: the bottom-right corner square. */
  cornerPx: 88,
  /** chat.snapHintMs: the zones' fade and the preview's growth (≤ 200: the 0.2 s feedback floor). */
  hintMs: 160,
  /** chat.snapHapticMs: the tick on entering a zone (Android; iOS has none). */
  hapticMs: 10,
  /** chat.snapPreviewPct: the preview's opacity, percent. */
  previewPct: 70,
} as const;

export type SnapOptions = {
  /** Full screen may be entered here (full-screen.ts fullScreenAllowed: never on another site). */
  fullAllowed: boolean;
  /** The right sidebar may be docked here (full screen allowed and a wide viewport). */
  dockAllowed: boolean;
  /** The window is open: every zone needs it (a pill only moves; docs/chat-drag-ux.md). */
  open: boolean;
  /** Full screen is on now (no Full screen zone then; the right zone may still turn it into the sidebar). */
  full?: boolean;
  /** The sidebar's width, px, already clamped (dockWidth). */
  dockWidth: number;
  /** The pill's size after minimizing, px. */
  pill: { w: number; h: number };
  /** The pill's home: its right and bottom edges, px (the chat's resting corner). */
  home: { right: number; bottom: number };
  edgePx?: number;
  cornerPx?: number;
};

const fin = (n: number, d = 0) => (Number.isFinite(n) ? n : d);

/**
 * Every zone available now, with its result. Small viewports shrink the
 * zones so they never cover more than a quarter of a side (the strips) or a
 * third of the short side (the corner): the free-move area stays the bulk of
 * the screen.
 */
export function snapTargets(vp: SnapViewport, o: SnapOptions): SnapTarget[] {
  const w = Math.max(0, fin(vp.w));
  const h = Math.max(0, fin(vp.h));
  if (!w || !h) return [];
  const x0 = fin(vp.x);
  const y0 = fin(vp.y);
  const edge = Math.max(0, Math.min(fin(o.edgePx ?? SNAP_DEFAULTS.edgePx), w / 4, h / 4));
  const corner = Math.max(
    0,
    Math.min(fin(o.cornerPx ?? SNAP_DEFAULTS.cornerPx), Math.min(w, h) / 3),
  );
  const right = x0 + w;
  const bottom = y0 + h;
  const out: SnapTarget[] = [];
  // A minimized pill only moves (the spec's `!minimized` on every zone).
  if (!o.open) return out;
  if (corner > 0) {
    const pw = Math.max(0, Math.min(fin(o.pill.w), w));
    const ph = Math.max(0, Math.min(fin(o.pill.h), h));
    const hr = Math.min(right, fin(o.home.right, right));
    const hb = Math.min(bottom, fin(o.home.bottom, bottom));
    out.push({
      id: "minimize",
      zone: { x: right - corner, y: bottom - corner, w: corner, h: corner },
      result: { x: Math.max(x0, hr - pw), y: Math.max(y0, hb - ph), w: pw, h: ph },
    });
  }
  // Without a Minimize corner (a pill), the bottom strip runs to the corner.
  const gap = out.length ? corner : 0;
  if (o.fullAllowed && !o.full && edge > 0)
    out.push({
      id: "fullscreen",
      zone: { x: x0, y: bottom - edge, w: Math.max(0, w - gap), h: edge },
      result: { x: x0, y: y0, w, h },
    });
  if (o.fullAllowed && o.dockAllowed && vp.wide && edge > 0) {
    const dw = Math.max(0, Math.min(fin(o.dockWidth), w));
    out.push({
      id: "dock-right",
      // Above the corner, or above the bottom strip when there is no corner.
      zone: { x: right - edge, y: y0, w: edge, h: Math.max(0, h - (gap || edge)) },
      result: { x: right - dw, y: y0, w: dw, h },
    });
  }
  return out;
}

const inside = (r: Rect, x: number, y: number) =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && r.w > 0 && r.h > 0;

/** Where zones touch, the first of these wins (docs/chat-drag-ux.md, "Boundary priority"). */
export const SNAP_PRIORITY: readonly SnapId[] = ["minimize", "dock-right", "fullscreen"];

/** The zone under the pointer, or null for a free move: minimize > dock-right > fullscreen. */
export function snapAt(targets: SnapTarget[], x: number, y: number): SnapTarget | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const id of SNAP_PRIORITY) {
    const t = targets.find((t) => t.id === id && inside(t.zone, x, y));
    if (t) return t;
  }
  return null;
}

/** The pointer left the screen altogether (released outside the window): the drop is a cancel. */
export function pointerOffScreen(vp: SnapViewport, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return x < vp.x - 1 || y < 0 - 1 || x > vp.x + vp.w + 1 || y > vp.y + vp.h + 1;
}

/** The sidebar's default width before a saved one: clamp(20rem, 32vw, 28rem) (full-screen.ts SIDEBAR_W), in px. */
export function defaultDockWidth(vw: number, remPx: number): number {
  const rem = remPx > 0 ? remPx : 16;
  return Math.min(vw, Math.max(20 * rem, Math.min(0.32 * vw, 28 * rem)));
}

/**
 * The state a drag started from (codex review, 2026-11-27): Escape,
 * pointercancel or a release off-screen puts back exactly this, whatever the
 * drag changed on the way (a drag up out of full screen included).
 */
export type DragSnapshot = {
  /** What the window was (docs/chat-drag-ux.md, "Cancel-Snapshot Contract"). */
  mode: "free" | "fullscreen" | "dock-right" | "minimized";
  /** Its rect on screen. */
  rect: Rect;
  /** Its free offset (lk:debug-chat-pos), kept for leaving full screen too. */
  pos: { x: number; y: number };
  /** The edge it keeps to (fold.ts). */
  edge: "left" | "right";
  /** The saved sidebar width (lk:pref:chat-dock), null for the default. */
  dockWidth: number | null;
  /** The page root's own right padding (the sidebar's reserve). */
  pagePadding: string;
  /** How full screen was drawn (FullMode), so `auto` comes back as `auto`. */
  fullMode: FullMode;
};

/** The snapshot's mode from the window's state. */
export function snapshotMode(d: { open: boolean; full: boolean; sidebar: boolean }): DragSnapshot["mode"] {
  if (!d.open) return "minimized";
  if (d.full) return d.sidebar ? "dock-right" : "fullscreen";
  return "free";
}

/**
 * How full screen is drawn: `auto` (the menu and the double tap, as before:
 * a sidebar when wide, the whole screen when narrow), `screen` (the bottom
 * zone: the whole visible area at every width), `side` (the right zone: the
 * right sidebar).
 */
export type FullMode = "auto" | "screen" | "side";

/** Full screen is drawn as the right sidebar. */
export function sidebarNow(d: { full: boolean; mode: FullMode | undefined; wide: boolean }) {
  if (!d.full) return false;
  if (d.mode === "side") return true;
  if (d.mode === "screen") return false;
  return d.wide;
}

/** What a drop in a zone does to the full-screen state: on, in this mode. */
export function fullModeFor(id: SnapId): FullMode | null {
  return id === "fullscreen" ? "screen" : id === "dock-right" ? "side" : null;
}
