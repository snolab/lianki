/**
 * The drag overlay mounted (snap-targets.ts, SnapOverlay.tsx; owner,
 * 2026-11-27): DebugChat in happy-dom, its grip dragged with pointer events.
 * The zones show the moment the drag starts, the hovered zone's preview
 * appears, and the overlay goes on the drop, on Escape and on pointercancel
 * (the snapshot back, nothing saved).
 *
 * Run by unit/snap-targets.test.ts in its own `bun test` (from unit/support,
 * so the root bunfig's coverage gate does not count the whole widget).
 */
import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";

type VV = { offsetLeft: number; offsetTop: number; width: number; height: number; scale: number };

async function page(vvInit?: VV) {
  const win = new Window({ url: "https://lianki.com/en", width: 1024, height: 768 });
  // Every storage write, by key (codex review: none during a drag or a cancel).
  const writes: string[] = [];
  for (const s of [win.localStorage, win.sessionStorage]) {
    const set = s.setItem.bind(s);
    const del = s.removeItem.bind(s);
    s.setItem = (k: string, v: string) => {
      writes.push(k);
      set(k, v);
    };
    s.removeItem = (k: string) => {
      writes.push(k);
      del(k);
    };
  }
  // A visual viewport (pinch zoom, keyboard) when asked for; happy-dom has none.
  const vv = vvInit ? Object.assign(new win.EventTarget(), vvInit) : null;
  const g = globalThis as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  const own = [
    "window",
    "document",
    "navigator",
    "localStorage",
    "sessionStorage",
    "location",
    "Event",
    "CustomEvent",
  ];
  const keys = [
    ...own,
    ...Object.getOwnPropertyNames(win).filter((k) => !(k in g) && !own.includes(k)),
    ...("visualViewport" in g || "visualViewport" in w ? [] : ["visualViewport"]),
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  for (const k of keys)
    Object.defineProperty(g, k, {
      value: k === "IS_REACT_ACT_ENVIRONMENT" ? true : k === "visualViewport" ? vv : w[k],
      configurable: true,
      writable: true,
    });
  Object.defineProperty(win, "visualViewport", { value: vv, configurable: true });
  // happy-dom may lack pointer capture; the drag only needs the calls to exist.
  const proto = (win as unknown as { HTMLElement: { prototype: Record<string, unknown> } })
    .HTMLElement.prototype;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  return {
    win,
    vv,
    writes,
    async close() {
      for (const [k, d] of saved)
        if (d) Object.defineProperty(g, k, d);
        else delete g[k];
      await win.happyDOM.close();
    },
  };
}

type P = Awaited<ReturnType<typeof page>>;

const ptr = (p: P, type: string, x: number, y: number) =>
  new p.win.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
  }) as never;

/** The chat's own persisted keys: the view (full screen, its mode), the place, the dock width, the fold. */
const CHAT_KEYS = /chat-view|debug-chat-pos|chat-dock|chat-fold/;

async function mount(full?: "screen" | "side", vv?: VV, allow = !!full) {
  const p = await page(vv);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DebugChat } = await import("../../packages/debug-chat/src/DebugChat");
  const { chatPrefs } = await import("../../packages/debug-chat/src/ui-store");
  const host = p.win.document.createElement("div");
  p.win.document.body.appendChild(host);
  const root = createRoot(host as never);
  p.win.localStorage.setItem("lk:debug-chat-open", "1");
  chatPrefs().setState(full ? { full: true, fullMode: full } : { full: false });
  await act(() =>
    root.render(
      <DebugChat live listeners={1} messages={[]} onSend={() => true} fullScreen={allow} />,
    ),
  );
  const grip = host.querySelector('[data-testid="debug-chat-pill-min"]') as unknown as HTMLElement;
  const q = (s: string) => p.win.document.querySelector(s);
  const frames = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));
  return { p, act, root, host, grip, q, frames };
}

describe("the drag overlay", () => {
  for (const mode of ["screen", "side"] as const)
    it(`${mode}: the first restored frame keeps the grabbed control under the pointer`, async () => {
      const m = await mount(mode);
      try {
        const box = m.host.querySelector('[data-testid="debug-chat"]') as unknown as HTMLElement;
        const row = box.querySelector("[data-debug-chat-row]") as HTMLElement;
        // happy-dom has no layout: give the actual mounted hook different
        // full and floating origins, like the production failure.
        const full = () => !!m.host.querySelector("[data-fullscreen]");
        const offset = () => {
          const match = /translate(?:3d)?\(([-\d.]+)px, (?:calc\()?([-\d.]+)px/.exec(
            box.style.transform,
          );
          return { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0) };
        };
        const rect = (kind: "box" | "row" | "grip") => {
          const f = full();
          const at = f ? { x: 0, y: 0 } : offset();
          const x = (f ? (mode === "side" ? 600 : 0) : 700) + at.x;
          const y = (kind === "box" ? (f ? 0 : 300) : f ? 720 : 660) + at.y;
          const width = kind === "grip" ? 44 : f ? (mode === "side" ? 424 : 1024) : 300;
          return new m.p.win.DOMRect(
            x,
            y,
            width,
            kind === "box" ? (f ? 768 : 404) : 44,
          ) as unknown as DOMRect;
        };
        box.getBoundingClientRect = () => rect("box");
        row.getBoundingClientRect = () => rect("row");
        m.grip.getBoundingClientRect = () => rect("grip");
        const start = m.grip.getBoundingClientRect();
        m.p.writes.length = 0;
        await m.act(
          async () =>
            void m.grip.dispatchEvent(ptr(m.p, "pointerdown", start.left + 7, start.top + 11)),
        );
        await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 500, 600)));
        await m.frames();
        expect(full()).toBe(false);
        expect(m.grip.getBoundingClientRect().left + 7).toBeCloseTo(500);
        expect(m.grip.getBoundingClientRect().top + 11).toBeCloseTo(600);
        await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 400, 550)));
        await m.frames();
        expect(m.grip.getBoundingClientRect().left + 7).toBeCloseTo(400);
        expect(m.grip.getBoundingClientRect().top + 11).toBeCloseTo(550);
        await m.act(
          async () =>
            void m.p.win.dispatchEvent(
              new m.p.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
            ),
        );
        await m.frames();
        expect(full()).toBe(true);
        expect(m.p.writes.filter((key) => CHAT_KEYS.test(key))).toEqual([]);
      } finally {
        await m.act(() => m.root.unmount());
        await m.p.close();
      }
    }, 20_000);

  it("shows every zone from the drag's start, previews the hovered one, and goes on the drop", async () => {
    const m = await mount();
    try {
      expect(m.grip).toBeTruthy();
      expect(m.q('[data-testid="debug-chat-snap"]')).toBeNull();
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerdown", 900, 740)));
      // Under the threshold: still a tap, nothing shows.
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 902, 740)));
      expect(m.q('[data-testid="debug-chat-snap"]')).toBeNull();
      // Past it, in the middle of the screen: every zone, no preview yet.
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 500, 400)));
      await m.frames();
      expect(m.q('[data-testid="debug-chat-snap"]')).not.toBeNull();
      const zones = [
        ...m.p.win.document.querySelectorAll('[data-testid="debug-chat-snap-zone"]'),
      ].map((z) => (z as unknown as HTMLElement).dataset.zone);
      expect(zones).toContain("minimize");
      expect(
        m.p.win.document.querySelectorAll('[data-testid="debug-chat-snap-label"]').length,
      ).toBe(zones.length);
      expect(m.q('[data-testid="debug-chat-snap-preview"]')).toBeNull();
      // Over the bottom-right corner: the minimize preview.
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 1020, 765)));
      await m.frames();
      const pv = m.q('[data-testid="debug-chat-snap-preview"]') as unknown as HTMLElement | null;
      expect(pv?.dataset.zone).toBe("minimize");
      // Dropped there: the overlay goes, the chat folds to its pill.
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerup", 1020, 765)));
      await m.frames();
      expect(m.q('[data-testid="debug-chat-snap"]')).toBeNull();
      expect(m.host.querySelector('[data-testid="debug-chat-minimized"]')).not.toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("Escape cancels: the overlay goes, the chat stays open, nothing is saved", async () => {
    const m = await mount();
    try {
      m.p.win.localStorage.removeItem("lk:debug-chat-pos");
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerdown", 900, 740)));
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 600, 500)));
      await m.frames();
      expect(m.q('[data-testid="debug-chat-snap"]')).not.toBeNull();
      await m.act(
        async () =>
          void m.p.win.dispatchEvent(
            new m.p.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never,
          ),
      );
      await m.frames();
      expect(m.q('[data-testid="debug-chat-snap"]')).toBeNull();
      // The release after the Escape is no drop.
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerup", 600, 500)));
      expect(m.host.querySelector('[data-testid="debug-chat"]')).not.toBeNull();
      expect(m.p.win.localStorage.getItem("lk:debug-chat-pos")).toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("pointercancel cancels the same way", async () => {
    const m = await mount();
    try {
      m.p.win.localStorage.removeItem("lk:debug-chat-pos");
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerdown", 900, 740)));
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 600, 500)));
      await m.frames();
      expect(m.q('[data-testid="debug-chat-snap"]')).not.toBeNull();
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointercancel", 600, 500)));
      await m.frames();
      expect(m.q('[data-testid="debug-chat-snap"]')).toBeNull();
      expect(m.p.win.localStorage.getItem("lk:debug-chat-pos")).toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  // docs/chat-drag-ux.md, "Named regressions".
  it("dragged out of full screen, then Escape: full screen comes back, nothing saved", async () => {
    const m = await mount("screen");
    try {
      m.p.win.localStorage.removeItem("lk:debug-chat-pos");
      expect(m.host.querySelector("[data-fullscreen]")).not.toBeNull();
      // From here on: no write to the chat's keys, during the drag or the cancel.
      m.p.writes.length = 0;
      const b = m.grip.getBoundingClientRect();
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerdown", b.left + 5, 700)));
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", b.left + 5, 600)));
      await m.frames();
      // Past chat.fullLeavePx up: it left full screen and follows the pointer.
      expect(m.host.querySelector("[data-fullscreen]")).toBeNull();
      expect(m.q('[data-testid="debug-chat-snap"]')).not.toBeNull();
      // Only transiently (codex review): nothing persisted while the drag lasts.
      const { chatPrefs } = await import("../../packages/debug-chat/src/ui-store");
      expect(chatPrefs().getState().full).toBe(true);
      expect(m.p.writes.filter((k) => CHAT_KEYS.test(k))).toEqual([]);
      // A resize mid-drag measures the zones again; the drag goes on.
      await m.act(async () => void m.p.win.dispatchEvent(new m.p.win.Event("resize") as never));
      await m.frames();
      expect(m.q('[data-testid="debug-chat-snap"]')).not.toBeNull();
      await m.act(
        async () =>
          void m.p.win.dispatchEvent(
            new m.p.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never,
          ),
      );
      await m.frames();
      expect(m.host.querySelector("[data-fullscreen]")).not.toBeNull();
      expect(m.q('[data-testid="debug-chat-snap"]')).toBeNull();
      expect(m.p.win.localStorage.getItem("lk:debug-chat-pos")).toBeNull();
      // Not one write to the view, the place, the dock or the fold, drag and cancel together.
      expect(m.p.writes.filter((k) => CHAT_KEYS.test(k))).toEqual([]);
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("dragged out of the sidebar, then pointercancel: the sidebar and the page's padding come back", async () => {
    const m = await mount("side");
    try {
      const html = m.p.win.document.documentElement;
      await m.frames();
      const padding = html.style.paddingRight;
      expect(padding).not.toBe("");
      m.p.writes.length = 0;
      const b = m.grip.getBoundingClientRect();
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerdown", b.left + 5, 700)));
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", b.left + 5, 600)));
      await m.frames();
      expect(m.host.querySelector("[data-fullscreen]")).toBeNull();
      await m.act(
        async () => void m.grip.dispatchEvent(ptr(m.p, "pointercancel", b.left + 5, 600)),
      );
      await m.frames();
      expect(m.host.querySelector("[data-fullscreen]")).not.toBeNull();
      expect(html.style.paddingRight).toBe(padding);
      expect(m.p.win.localStorage.getItem("lk:debug-chat-pos")).toBeNull();
      expect(m.p.writes.filter((k) => CHAT_KEYS.test(k))).toEqual([]);
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  // codex review: one zoom policy for the preview and the landing.
  it("pinch zoom (scale 2): the full-screen preview is exactly where full screen lands", async () => {
    const vv = { offsetLeft: 80, offsetTop: 100, width: 512, height: 384, scale: 2 };
    const m = await mount(undefined, vv, true);
    try {
      const { snapLanding } = await import("../../packages/debug-chat/src/snap-viewport");
      const land = snapLanding(1024, 768, vv).full;
      const b = m.grip.getBoundingClientRect();
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerdown", b.left + 5, 300)));
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 300, 250)));
      // The bottom of what is visible: the zone follows the visual viewport.
      await m.act(
        async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 300, 100 + 384 - 4)),
      );
      await m.frames();
      const pv = m.q('[data-testid="debug-chat-snap-preview"]') as unknown as HTMLElement | null;
      expect(pv?.dataset.zone).toBe("fullscreen");
      const px = (v: string) => Number.parseFloat(v);
      const preview = {
        x: px(pv!.style.left),
        y: px(pv!.style.top),
        w: px(pv!.style.width),
        h: px(pv!.style.height),
      };
      // Zoomed in, full screen is the layout viewport (fullScreenBox): so is the preview.
      expect(preview).toEqual(land);
      expect(land).toEqual({ x: 0, y: 0, w: 1024, h: 768 });
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerup", 300, 100 + 384 - 4)));
      await m.frames();
      // Landed: full screen, its box from the same function (the section's own variables).
      const section = m.host.querySelector("[data-fullscreen]") as unknown as HTMLElement | null;
      expect(section).not.toBeNull();
      const top = section!.style.getPropertyValue("--lk-full-top");
      const h = section!.style.getPropertyValue("--lk-full-h");
      if (top) expect(px(top)).toBe(land.y);
      if (h) expect(px(h)).toBe(land.h);
      // FULL_SCREEN_STYLE: left 0, right 0, i.e. the layout width.
      expect(section!.style.left).toBe("0px");
      expect(section!.style.right).toBe("0px");
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("pinch zoom (scale 2): the sidebar preview is exactly where the sidebar lands (default width)", async () => {
    const vv = { offsetLeft: 80, offsetTop: 0, width: 640, height: 384, scale: 2 };
    const m = await mount(undefined, vv, true);
    try {
      const b = m.grip.getBoundingClientRect();
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerdown", b.left + 5, 300)));
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 400, 200)));
      // The right edge of what is visible.
      await m.act(
        async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 80 + 640 - 4, 150)),
      );
      await m.frames();
      const pv = m.q('[data-testid="debug-chat-snap-preview"]') as unknown as HTMLElement | null;
      expect(pv?.dataset.zone).toBe("dock-right");
      const px = (v: string) => Number.parseFloat(v);
      const preview = { x: px(pv!.style.left), w: px(pv!.style.width) };
      // codex's repro shape: the default is clamp(20rem, 32vw of the LAYOUT width, 28rem), capped by the visible width.
      expect(preview.w).toBeCloseTo(Math.min(640, Math.max(320, Math.min(0.32 * 1024, 448))), 5);
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerup", 80 + 640 - 4, 150)));
      await m.frames();
      const section = m.host.querySelector("[data-fullscreen]") as unknown as HTMLElement | null;
      expect(section).not.toBeNull();
      // Landed: the width and right inset liftRef applied, from the same function.
      const width = px(section!.style.getPropertyValue("--lk-chat-dock-width"));
      const right = px(section!.style.getPropertyValue("--lk-chat-dock-right"));
      expect(width).toBeCloseTo(preview.w, 5);
      expect(1024 - right - width).toBeCloseTo(preview.x, 5);
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("a free drop in the middle saves the move and shows no overlay after", async () => {
    const m = await mount();
    try {
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerdown", 900, 740)));
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointermove", 600, 500)));
      await m.frames();
      await m.act(async () => void m.grip.dispatchEvent(ptr(m.p, "pointerup", 600, 500)));
      await m.frames();
      expect(m.q('[data-testid="debug-chat-snap"]')).toBeNull();
      expect(m.p.win.localStorage.getItem("lk:debug-chat-pos")).not.toBeNull();
      expect(m.host.querySelector('[data-testid="debug-chat"]')).not.toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);
});
