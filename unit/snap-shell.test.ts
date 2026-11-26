/**
 * 随身Li's frame shell drag (src/partner-frame.ts) with the shared drop zones
 * (snap-targets.ts), the viewport contract (snap-viewport.ts) and the
 * overlay's icons (snap-overlay.ts), in happy-dom (docs/chat-drag-ux.md).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { frameShell } from "../src/partner-frame";
import { iconSvg, SNAP_ICON } from "../packages/debug-chat/src/snap-overlay";
import {
  measureSnapViewport,
  safeInsets,
  sidebarWidth,
  snapLanding,
} from "../packages/debug-chat/src/snap-viewport";
import { snapTargets } from "../packages/debug-chat/src/snap-targets";
import { fullScreenBox } from "../packages/debug-chat/src/full-screen";
import { dockViewport } from "../packages/debug-chat/src/dock-resize";

const ORIGIN = "https://lianki.com";
let open: Window[] = [];
afterEach(async () => {
  for (const w of open) await w.happyDOM.close();
  open = [];
});

function page() {
  const win = new Window({ url: "https://news.example/a", width: 1024, height: 768 });
  open.push(win);
  // The shell's root is closed; open it here so the test can reach the grip.
  // Per element of this window's document only: never a shared prototype,
  // which other suites (closed-root checks) would see.
  const doc = win.document as unknown as { createElement: (t: string) => HTMLElement };
  const create = doc.createElement.bind(doc);
  doc.createElement = (t: string) => {
    const el = create(t);
    const attach = el.attachShadow.bind(el);
    el.attachShadow = () => attach({ mode: "open" });
    return el;
  };
  return win;
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function shell(win: Window) {
  const saved: { x: number; y: number }[] = [];
  const s = frameShell({
    doc: win.document as unknown as Document,
    win: win as unknown as Window & typeof globalThis,
    origin: ORIGIN,
    label: "news.example/a",
    ticket: async () => "TK",
    gripLabel: "grip",
    minimizeLabel: "Collapse",
    pos: { get: () => ({ x: 0, y: 0 }), set: (p) => void saved.push(p) },
    readyMs: 30,
    capMs: 5000,
  });
  const root = (s.host as unknown as { shadowRoot: ShadowRoot }).shadowRoot;
  const box = root.children[0] as HTMLElement;
  const grip = box.children[0] as HTMLElement;
  const iframe = box.children[1] as HTMLIFrameElement;
  const overlay = root.children[1] as HTMLElement;
  const ptr = (type: string, x?: number, y?: number) =>
    grip.dispatchEvent(
      new win.PointerEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
      }) as never,
    );
  return { s, saved, grip, iframe, overlay, ptr };
}

describe("the frame shell's drag on the host page", () => {
  it("shows the Minimize zone from the drag's start, previews it, and folds into the corner on release", async () => {
    const win = page();
    const t = shell(win);
    t.ptr("pointerdown", 500, 400);
    t.ptr("pointermove", 520, 410);
    expect(t.overlay.children.length).toBeGreaterThan(0);
    expect(t.overlay.textContent).toContain("Collapse");
    expect(t.overlay.querySelector("[data-lk-snap-preview]")).toBeNull();
    t.ptr("pointermove", 1020, 765);
    await tick();
    expect(t.overlay.querySelector("[data-lk-snap-preview]")).not.toBeNull();
    t.ptr("pointerup", 1020, 765);
    expect(t.iframe.style.getPropertyValue("display")).toBe("none");
    expect(t.saved.at(-1)).toEqual({ x: 0, y: 0 });
    expect(t.overlay.children.length).toBe(0);
    // A tap on the minimized grip brings it back (touch has no double-click).
    t.ptr("pointerdown", 1000, 750);
    t.ptr("pointerup", 1000, 750);
    expect(t.iframe.style.getPropertyValue("display")).toBe("block");
    t.s.destroy();
  });

  it("Escape, a resize, or a release off-screen put it back, unsaved", async () => {
    const win = page();
    const t = shell(win);
    const right = (t.s.host as HTMLElement).style.getPropertyValue("right");
    for (const end of ["escape", "resize", "off"] as const) {
      t.ptr("pointerdown", 500, 400);
      t.ptr("pointermove", 700, 500);
      await tick();
      expect((t.s.host as HTMLElement).style.getPropertyValue("right")).not.toBe(right);
      if (end === "escape")
        win.dispatchEvent(
          new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never,
        );
      else if (end === "resize") win.dispatchEvent(new win.Event("resize") as never);
      else t.ptr("pointerup", 2000, 500);
      expect((t.s.host as HTMLElement).style.getPropertyValue("right")).toBe(right);
      expect(t.overlay.children.length).toBe(0);
      t.ptr("pointerup", 700, 500);
    }
    expect(t.saved).toEqual([]);
    t.s.destroy();
  });

  it("the host's visual viewport moving mid-drag (keyboard pan, pinch) cancels it, unsaved", async () => {
    const win = page();
    const vv = Object.assign(new win.EventTarget(), {
      offsetLeft: 0,
      offsetTop: 0,
      width: 1024,
      height: 768,
      scale: 1,
    });
    Object.defineProperty(win, "visualViewport", { value: vv, configurable: true });
    const t = shell(win);
    const right = (t.s.host as HTMLElement).style.getPropertyValue("right");
    for (const type of ["scroll", "resize"]) {
      t.ptr("pointerdown", 500, 400);
      t.ptr("pointermove", 700, 500);
      await tick();
      expect((t.s.host as HTMLElement).style.getPropertyValue("right")).not.toBe(right);
      vv.dispatchEvent(new win.Event(type) as never);
      expect((t.s.host as HTMLElement).style.getPropertyValue("right")).toBe(right);
      expect(t.overlay.children.length).toBe(0);
      t.ptr("pointerup", 700, 500);
    }
    expect(t.saved).toEqual([]);
    t.s.destroy();
  });

  it("a free drop is kept", async () => {
    const win = page();
    const t = shell(win);
    t.ptr("pointerdown", 500, 400);
    t.ptr("pointermove", 400, 380);
    t.ptr("pointerup", 400, 380);
    expect(t.saved.length).toBe(1);
    expect(t.iframe.style.getPropertyValue("display")).not.toBe("none");
    t.s.destroy();
  });
});

describe("the viewport contract (snap-viewport.ts)", () => {
  it("the visible area, the safe areas and the width query, from the window", () => {
    const win = page();
    const vp = measureSnapViewport(win as never, "(min-width: 35em)");
    expect(vp).toMatchObject({ x: 0, y: 0, w: 1024, h: 768, wide: true });
    expect(vp.safe).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(safeInsets(win.document as never, win as never).top).toBe(0);
    // The probe never stays in the page.
    expect(win.document.body.children.length).toBe(0);
  });
  it("with a visual viewport: its offsets, size and scale (client px)", () => {
    const win = page();
    const w = Object.assign(Object.create(win as object), {
      document: win.document,
      innerWidth: 390,
      innerHeight: 844,
      getComputedStyle: win.getComputedStyle.bind(win),
      matchMedia: () => ({ matches: false }),
      visualViewport: { offsetLeft: 20, offsetTop: 30, width: 195, height: 400, scale: 2 },
    });
    expect(measureSnapViewport(w, "(min-width: 35em)")).toMatchObject({
      x: 20,
      y: 30,
      w: 195,
      h: 400,
      scale: 2,
      wide: false,
    });
  });
  it("the preview is the landing rect, at pinch zoom (scale 2) and with the keyboard up (codex review)", () => {
    const win = page();
    const at = (vv: {
      offsetLeft: number;
      offsetTop: number;
      width: number;
      height: number;
      scale: number;
    }) => {
      const w = Object.assign(Object.create(win as object), {
        document: win.document,
        innerWidth: 390,
        innerHeight: 844,
        getComputedStyle: win.getComputedStyle.bind(win),
        matchMedia: () => ({ matches: true }),
        visualViewport: vv,
      });
      const vp = measureSnapViewport(w, "(min-width: 35em)");
      const ts = snapTargets(vp, {
        fullAllowed: true,
        dockAllowed: true,
        open: true,
        dockWidth: 120,
        pill: { w: 60, h: 30 },
        home: { right: vp.x + vp.w - 8, bottom: vp.y + vp.h - 8 },
      });
      return { vv, ts };
    };
    for (const { vv, ts } of [
      at({ offsetLeft: 20, offsetTop: 30, width: 195, height: 400, scale: 2 }),
      at({ offsetLeft: 0, offsetTop: 0, width: 390, height: 500, scale: 1 }),
    ]) {
      // What full screen's own style lands on (FULL_SCREEN_STYLE: left 0 to the
      // layout width, top and height from fullScreenBox) and the sidebar's right edge.
      const box = fullScreenBox({ innerHeight: 844, vv });
      const landFull = { x: 0, y: box.top, w: 390, h: box.height };
      const dockRight = 390 - dockViewport(390, vv).right;
      expect(snapLanding(390, 844, vv)).toEqual({ full: landFull, right: dockRight });
      const full = ts.find((t) => t.id === "fullscreen")!;
      const dock = ts.find((t) => t.id === "dock-right")!;
      expect(full.result).toEqual(landFull);
      expect(dock.result.x + dock.result.w).toBe(dockRight);
      expect({ y: dock.result.y, h: dock.result.h }).toEqual({ y: landFull.y, h: landFull.h });
    }
  });
  it("the sidebar's width: one function for preview and landing (codex's zoom repro)", () => {
    const vv = { offsetLeft: 80, offsetTop: 0, width: 640, height: 400, scale: 2 };
    // Default: clamp(20rem, 32vw of the LAYOUT width, 28rem), capped by the visible width.
    expect(sidebarWidth(1280, vv, null, 16)).toBeCloseTo(409.6, 5);
    // Its right edge (snapLanding) minus it: where it lands, 310.4 in the repro.
    expect(snapLanding(1280, 800, vv).right - sidebarWidth(1280, vv, null, 16)).toBeCloseTo(
      310.4,
      5,
    );
    // Saved: clamped to [20rem, the visible width].
    expect(sidebarWidth(1280, vv, 900, 16)).toBe(640);
    expect(sidebarWidth(1280, vv, 100, 16)).toBe(320);
    // No visual viewport: the layout width.
    expect(sidebarWidth(1280, null, null, 16)).toBeCloseTo(409.6, 5);
  });
  it("a matchMedia that throws reads as narrow", () => {
    const win = page();
    const w = Object.assign(Object.create(win as object), {
      document: win.document,
      innerWidth: 390,
      innerHeight: 844,
      getComputedStyle: win.getComputedStyle.bind(win),
      matchMedia: () => {
        throw new Error("no");
      },
    });
    expect(measureSnapViewport(w, "(min-width: 35em)")).toMatchObject({
      w: 390,
      h: 844,
      wide: false,
    });
  });
});

describe("overlay icons", () => {
  it("one stroke icon per zone", () => {
    const win = page();
    for (const id of ["fullscreen", "dock-right", "minimize"] as const) {
      const svg = iconSvg(win.document as never, id);
      expect(svg.getAttribute("viewBox")).toBe("0 0 18 18");
      expect(svg.firstElementChild?.getAttribute("d")).toBe(SNAP_ICON[id]);
    }
  });
});
