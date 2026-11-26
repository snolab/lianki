/**
 * 随身Li's frame shell drag (src/partner-frame.ts) with the shared drop zones
 * (snap-targets.ts), the viewport contract (snap-viewport.ts) and the
 * overlay's icons (snap-overlay.ts), in happy-dom (docs/chat-drag-ux.md).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { frameShell } from "../src/partner-frame";
import { iconSvg, SNAP_ICON } from "../packages/debug-chat/src/snap-overlay";
import { measureSnapViewport, safeInsets } from "../packages/debug-chat/src/snap-viewport";

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
  const proto = (
    win as unknown as {
      HTMLElement: { prototype: { attachShadow: (o: ShadowRootInit) => ShadowRoot } };
    }
  ).HTMLElement.prototype;
  const attach = proto.attachShadow;
  proto.attachShadow = function (this: HTMLElement) {
    return attach.call(this, { mode: "open" });
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
