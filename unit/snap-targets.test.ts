import { describe, expect, it } from "bun:test";
import {
  SNAP_DEFAULTS,
  SNAP_PRIORITY,
  defaultDockWidth,
  snapshotMode,
  fullModeFor,
  pointerOffScreen,
  sidebarNow,
  snapAt,
  snapTargets,
  type SnapOptions,
  type SnapViewport,
} from "../packages/debug-chat/src/snap-targets";
import {
  growFrom,
  labelAt,
  labelStyle,
  previewStyle,
  zoneStyle,
} from "../packages/debug-chat/src/snap-overlay";

const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };
const desktop: SnapViewport = { x: 0, y: 0, w: 1280, h: 800, safe: noSafe, wide: true };
const phone: SnapViewport = {
  x: 0,
  y: 0,
  w: 390,
  h: 844,
  safe: { top: 47, right: 0, bottom: 34, left: 0 },
  wide: false,
};
const opts = (o: Partial<SnapOptions> = {}): SnapOptions => ({
  fullAllowed: true,
  dockAllowed: true,
  open: true,
  dockWidth: 360,
  pill: { w: 120, h: 44 },
  home: { right: 1272, bottom: 792 },
  ...o,
});
const ids = (vp: SnapViewport, o?: Partial<SnapOptions>) =>
  snapTargets(vp, opts(o)).map((t) => t.id);
const hit = (vp: SnapViewport, x: number, y: number, o?: Partial<SnapOptions>) =>
  snapAt(snapTargets(vp, opts(o)), x, y)?.id ?? null;

describe("snapTargets: the zones (owner, 2026-11-27)", () => {
  it("desktop: minimize corner, bottom full screen, right sidebar", () => {
    expect(ids(desktop).sort()).toEqual(["dock-right", "fullscreen", "minimize"]);
  });

  it("bottom strip → full screen: the whole visible area", () => {
    const e = SNAP_DEFAULTS.edgePx;
    expect(hit(desktop, 640, 799)).toBe("fullscreen");
    expect(hit(desktop, 0, 800 - e + 1)).toBe("fullscreen");
    const t = snapTargets(desktop, opts()).find((t) => t.id === "fullscreen")!;
    expect(t.result).toEqual({ x: 0, y: 0, w: 1280, h: 800 });
  });

  it("right strip → the right sidebar, full height, at the dock width", () => {
    expect(hit(desktop, 1279, 300)).toBe("dock-right");
    expect(hit(desktop, 1279, 0)).toBe("dock-right");
    const t = snapTargets(desktop, opts()).find((t) => t.id === "dock-right")!;
    expect(t.result).toEqual({ x: 1280 - 360, y: 0, w: 360, h: 800 });
  });

  it("bottom-right corner → minimize, the pill at its home corner; the corner wins where strips meet", () => {
    expect(hit(desktop, 1279, 799)).toBe("minimize");
    expect(hit(desktop, 1280 - SNAP_DEFAULTS.cornerPx + 1, 800 - 2)).toBe("minimize");
    const t = snapTargets(desktop, opts()).find((t) => t.id === "minimize")!;
    expect(t.result).toEqual({ x: 1272 - 120, y: 792 - 44, w: 120, h: 44 });
  });

  it("the other corners and the top edge are free moves", () => {
    expect(hit(desktop, 0, 0)).toBeNull();
    expect(hit(desktop, 640, 0)).toBeNull();
    expect(hit(desktop, 0, 400)).toBeNull();
    expect(hit(desktop, 640, 400)).toBeNull();
    // Just short of each strip.
    expect(hit(desktop, 640, 800 - SNAP_DEFAULTS.edgePx - 1)).toBeNull();
    expect(hit(desktop, 1280 - SNAP_DEFAULTS.edgePx - 1, 300)).toBeNull();
  });

  it("zones never overlap", () => {
    for (const vp of [desktop, phone]) {
      const ts = snapTargets(vp, opts());
      for (const a of ts)
        for (const b of ts) {
          if (a === b) continue;
          const ox =
            Math.min(a.zone.x + a.zone.w, b.zone.x + b.zone.w) - Math.max(a.zone.x, b.zone.x);
          const oy =
            Math.min(a.zone.y + a.zone.h, b.zone.y + b.zone.h) - Math.max(a.zone.y, b.zone.y);
          expect(ox > 0 && oy > 0).toBe(false);
        }
    }
  });

  it("narrow screens have no sidebar; the bottom and the corner stay", () => {
    expect(ids(phone).sort()).toEqual(["fullscreen", "minimize"]);
    expect(hit(phone, 389, 300)).toBeNull();
  });

  it("another site (no full screen): only Minimize", () => {
    expect(ids(desktop, { fullAllowed: false })).toEqual(["minimize"]);
    expect(hit(desktop, 640, 799, { fullAllowed: false })).toBeNull();
  });

  it("a minimized pill only moves: no zones (spec: every zone needs !minimized)", () => {
    expect(ids(desktop, { open: false })).toEqual([]);
    expect(hit(desktop, 1279, 799, { open: false })).toBeNull();
  });

  it("in full screen there is no Full screen zone; the corner and the sidebar stay", () => {
    expect(ids(desktop, { full: true }).sort()).toEqual(["dock-right", "minimize"]);
    expect(hit(desktop, 640, 799, { full: true })).toBeNull();
  });

  it("where zones touch: minimize > dock-right > fullscreen", () => {
    expect(SNAP_PRIORITY).toEqual(["minimize", "dock-right", "fullscreen"]);
    // Hand-made overlapping zones: the order decides, not the list's order.
    const r = { x: 0, y: 0, w: 10, h: 10 };
    const all = [
      { id: "fullscreen" as const, zone: r, result: r },
      { id: "dock-right" as const, zone: r, result: r },
      { id: "minimize" as const, zone: r, result: r },
    ];
    expect(snapAt(all, 5, 5)?.id).toBe("minimize");
    expect(snapAt(all.slice(0, 2), 5, 5)?.id).toBe("dock-right");
    expect(snapAt(all.slice(0, 1), 5, 5)?.id).toBe("fullscreen");
  });

  it("visual-viewport offsets (pinch zoom, keyboard) move the zones with what is visible", () => {
    const zoomed: SnapViewport = {
      x: 100,
      y: 50,
      w: 400,
      h: 300,
      scale: 2,
      safe: noSafe,
      wide: true,
    };
    const ts = snapTargets(zoomed, opts({ home: { right: 492, bottom: 342 } }));
    expect(ts.find((t) => t.id === "fullscreen")!.result).toEqual({
      x: 100,
      y: 50,
      w: 400,
      h: 300,
    });
    expect(snapAt(ts, 499, 349)?.id).toBe("minimize");
    expect(snapAt(ts, 200, 345)?.id).toBe("fullscreen");
    expect(snapAt(ts, 200, 395)).toBeNull();
  });

  it("dockAllowed off: no sidebar even when wide", () => {
    expect(ids(desktop, { dockAllowed: false })).not.toContain("dock-right");
  });

  it("small viewports shrink the zones so the free area stays the bulk", () => {
    const tiny: SnapViewport = { x: 0, y: 0, w: 200, h: 160, safe: noSafe, wide: false };
    const ts = snapTargets(tiny, opts({ home: { right: 192, bottom: 152 } }));
    const full = ts.find((t) => t.id === "fullscreen")!;
    const min = ts.find((t) => t.id === "minimize")!;
    expect(full.zone.h).toBeLessThanOrEqual(160 / 4);
    expect(min.zone.w).toBeLessThanOrEqual(160 / 3);
    expect(hit(tiny, 100, 60, { home: { right: 192, bottom: 152 } })).toBeNull();
    // Results stay on screen.
    for (const t of ts) {
      expect(t.result.x).toBeGreaterThanOrEqual(0);
      expect(t.result.x + t.result.w).toBeLessThanOrEqual(200);
    }
  });

  it("a zero or broken viewport has no zones", () => {
    expect(snapTargets({ ...desktop, w: 0 }, opts())).toEqual([]);
    expect(snapTargets({ ...desktop, h: Number.NaN }, opts())).toEqual([]);
    expect(snapAt(snapTargets(desktop, opts()), Number.NaN, 5)).toBeNull();
  });

  it("the keyboard's visual viewport: zones follow the visible area's bottom", () => {
    const kb: SnapViewport = { ...phone, y: 0, h: 500 };
    expect(hit(kb, 200, 499)).toBe("fullscreen");
    expect(hit(kb, 200, 840)).toBeNull();
    expect(snapTargets(kb, opts()).find((t) => t.id === "fullscreen")!.result.h).toBe(500);
  });

  it("the sidebar is never wider than the screen", () => {
    const t = snapTargets(desktop, opts({ dockWidth: 5000 })).find((t) => t.id === "dock-right")!;
    expect(t.result).toEqual({ x: 0, y: 0, w: 1280, h: 800 });
  });
});

describe("drop helpers", () => {
  it("a release off-screen is a cancel", () => {
    expect(pointerOffScreen(desktop, 640, 400)).toBe(false);
    expect(pointerOffScreen(desktop, -20, 400)).toBe(true);
    expect(pointerOffScreen(desktop, 640, 900)).toBe(true);
    expect(pointerOffScreen(desktop, Number.NaN, 0)).toBe(true);
  });
  it("zones pick the full-screen mode; minimize picks none", () => {
    expect(fullModeFor("fullscreen")).toBe("screen");
    expect(fullModeFor("dock-right")).toBe("side");
    expect(fullModeFor("minimize")).toBeNull();
  });
  it("the sidebar is drawn for side, never for screen, by width for auto", () => {
    expect(sidebarNow({ full: true, mode: "side", wide: false })).toBe(true);
    expect(sidebarNow({ full: true, mode: "screen", wide: true })).toBe(false);
    expect(sidebarNow({ full: true, mode: "auto", wide: true })).toBe(true);
    expect(sidebarNow({ full: true, mode: undefined, wide: false })).toBe(false);
    expect(sidebarNow({ full: false, mode: "side", wide: true })).toBe(false);
  });
  it("default dock width: clamp(20rem, 32vw, 28rem), never past the screen", () => {
    expect(defaultDockWidth(1280, 1280, 16)).toBe(409.6);
    expect(defaultDockWidth(3000, 3000, 16)).toBe(448);
    expect(defaultDockWidth(600, 600, 16)).toBe(320);
    expect(defaultDockWidth(300, 300, 16)).toBe(300);
    // Zoomed: `vw` is the layout width (32vw of 1280), capped by the visible 640.
    expect(defaultDockWidth(1280, 640, 16)).toBe(409.6);
    expect(defaultDockWidth(1280, 300, 16)).toBe(300);
    expect(defaultDockWidth(Number.NaN, Number.NaN, 0)).toBe(0);
  });
  it("the snapshot's mode", () => {
    expect(snapshotMode({ open: false, full: true, sidebar: true })).toBe("minimized");
    expect(snapshotMode({ open: true, full: true, sidebar: true })).toBe("dock-right");
    expect(snapshotMode({ open: true, full: true, sidebar: false })).toBe("fullscreen");
    expect(snapshotMode({ open: true, full: false, sidebar: true })).toBe("free");
  });
  it("defaults keep feedback under 0.2 s", () => {
    expect(SNAP_DEFAULTS.hintMs).toBeLessThanOrEqual(200);
  });
});

describe("the overlay mounted in DebugChat", () => {
  // In its own process, outside the coverage gate (see unit/support/snap-drag-mount.tsx).
  it("appears on drag start, previews the hovered zone, goes on drop, Escape and pointercancel", () => {
    const r = Bun.spawnSync(["bun", "test", "./snap-drag-mount.tsx"], {
      cwd: `${import.meta.dir}/support`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    if (r.exitCode !== 0) console.error(out);
    expect(r.exitCode).toBe(0);
    expect(out).toMatch(/\b10 pass\b/);
    expect(out).toMatch(/\b0 fail\b/);
  }, 90_000);
});

describe("overlay looks (snap-overlay.ts)", () => {
  const t = snapTargets(desktop, opts()).find((t) => t.id === "fullscreen")!;
  it("never takes a touch; zones and preview under the chat, labels over it; oklch only", () => {
    const label = labelStyle(
      { x: 1, y: 2 },
      { hot: false, vertical: false, ms: 160, reduce: false },
    );
    expect(String(label.zIndex)).toContain("+ 1");
    for (const s of [
      zoneStyle(t, { hot: true, shown: true, ms: 160, reduce: false }),
      label,
      previewStyle(t.result, { alpha: 0.7 }),
    ]) {
      expect(s.pointerEvents).toBe("none");
      if (s !== label) expect(String(s.zIndex)).toContain("- 1");
      expect(JSON.stringify(s)).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(|hsl\(/i);
    }
  });
  it("reduced motion: no transitions", () => {
    expect(zoneStyle(t, { hot: false, shown: true, ms: 160, reduce: true }).transition).toBe(
      "none",
    );
    expect(
      labelStyle({ x: 0, y: 0 }, { hot: false, vertical: true, ms: 160, reduce: true }).transition,
    ).toBe("none");
  });
  it("labels sit clear of the home indicator", () => {
    const pt = snapTargets(phone, opts({ home: { right: 382, bottom: 802 } })).find(
      (x) => x.id === "fullscreen",
    )!;
    const at = labelAt(pt, phone);
    expect(at.y).toBeLessThan(844 - 34);
    // The corner's label is right-aligned inside the screen, above the corner square.
    const corner = snapTargets(phone, opts({ home: { right: 382, bottom: 802 } })).find(
      (x) => x.id === "minimize",
    )!;
    const c = labelAt(corner, phone);
    expect(c.end).toBe(true);
    expect(c.x).toBeLessThanOrEqual(390);
    expect(c.y).toBeLessThan(corner.zone.y);
  });
  it("the preview grows from the window's rect (FLIP)", () => {
    expect(growFrom(null, t.result)).toBe("none");
    expect(growFrom({ x: 640, y: 400, w: 320, h: 400 }, t.result)).toBe(
      "translate(640px, 400px) scale(0.25, 0.5)",
    );
  });
});
