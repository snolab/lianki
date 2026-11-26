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

async function page() {
  const win = new Window({ url: "https://lianki.com/en", width: 1024, height: 768 });
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
      value: k === "IS_REACT_ACT_ENVIRONMENT" ? true : k === "visualViewport" ? null : w[k],
      configurable: true,
      writable: true,
    });
  // happy-dom may lack pointer capture; the drag only needs the calls to exist.
  const proto = (win as unknown as { HTMLElement: { prototype: Record<string, unknown> } })
    .HTMLElement.prototype;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  return {
    win,
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

async function mount() {
  const p = await page();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DebugChat } = await import("../../packages/debug-chat/src/DebugChat");
  const host = p.win.document.createElement("div");
  p.win.document.body.appendChild(host);
  const root = createRoot(host as never);
  p.win.localStorage.setItem("lk:debug-chat-open", "1");
  await act(() => root.render(<DebugChat live listeners={1} messages={[]} onSend={() => true} />));
  const grip = host.querySelector('[data-testid="debug-chat-pill-min"]') as unknown as HTMLElement;
  const q = (s: string) => p.win.document.querySelector(s);
  const frames = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));
  return { p, act, root, host, grip, q, frames };
}

describe("the drag overlay", () => {
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
