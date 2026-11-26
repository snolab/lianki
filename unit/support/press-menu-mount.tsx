/**
 * Press, drag, release menus mounted (press-menu.ts; owner, 2026-11-27):
 * DebugChat in happy-dom. The + and the grip's right-press open their menu
 * at once; a slide and a release on a row picks it; released elsewhere it
 * closes; a plain tap keeps today's toggle; no menu press moves the window.
 * The grip menu's Dock right row docks the chat.
 *
 * happy-dom has no layout, so where the pointer "is" comes from a stubbed
 * elementFromPoint. Run by unit/press-menu.test.ts in its own `bun test`.
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
  const proto = (win as unknown as { HTMLElement: { prototype: Record<string, unknown> } })
    .HTMLElement.prototype;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  // Where the pointer is: set by the test before each move or release.
  let under: Element | null = null;
  (win.document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () =>
    under;
  return {
    win,
    point(el: Element | null) {
      under = el;
    },
    async close() {
      for (const [k, d] of saved)
        if (d) Object.defineProperty(g, k, d);
        else delete g[k];
      await win.happyDOM.close();
    },
  };
}

type P = Awaited<ReturnType<typeof page>>;
const ptr = (p: P, type: string, x: number, y: number, button = 0) =>
  new p.win.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
    buttons: button === 2 ? 2 : 1,
    pointerId: 1,
    pointerType: "mouse",
  }) as never;

async function mount(fullScreen = false) {
  const p = await page();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DebugChat } = await import("../../packages/debug-chat/src/DebugChat");
  const host = p.win.document.createElement("div");
  p.win.document.body.appendChild(host);
  const root = createRoot(host as never);
  p.win.localStorage.setItem("lk:debug-chat-open", "1");
  await act(() =>
    root.render(
      <DebugChat live listeners={1} messages={[]} onSend={() => true} fullScreen={fullScreen} />,
    ),
  );
  const q = <T extends Element = HTMLElement>(s: string) =>
    p.win.document.querySelector(s) as unknown as T | null;
  const frames = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  const fire = (el: Element | null, ev: never) => act(async () => void el!.dispatchEvent(ev));
  return { p, act, root, host, q, frames, fire };
}

describe("the + menu: press, drag, release", () => {
  it("the press opens it at once; sliding onto a row and letting go picks it", async () => {
    const m = await mount();
    try {
      const plus = m.q('[data-testid="debug-chat-attach"]');
      expect(plus).not.toBeNull();
      await m.fire(plus, ptr(m.p, "pointerdown", 100, 700));
      expect(m.q('[data-testid="debug-chat-attach-menu"]')).not.toBeNull();
      // The first row that can be picked (some wait for a page selection).
      const row = m.q('[data-testid="debug-chat-attach-menu"] [role^="menuitem"]:not([disabled])');
      expect(row).not.toBeNull();
      let picked = 0;
      row!.addEventListener("click", () => picked++);
      m.p.point(row);
      await m.fire(m.p.win as never, ptr(m.p, "pointermove", 140, 600));
      expect(row!.dataset.pressHot).toBe("");
      expect([row!.isConnected, !!m.q('[data-testid="debug-chat-attach-menu"]')]).toEqual([
        true,
        true,
      ]);
      await m.fire(m.p.win as never, ptr(m.p, "pointerup", 140, 600));
      expect(picked).toBe(1);
      // The click the browser sends next is not a second toggle or pick.
      await m.fire(plus, new m.p.win.MouseEvent("click", { bubbles: true, detail: 1 }) as never);
      expect(picked).toBe(1);
      // No window move from a menu press.
      expect(m.p.win.localStorage.getItem("lk:debug-chat-pos")).toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("released elsewhere after sliding: it closes, nothing picked", async () => {
    const m = await mount();
    try {
      const plus = m.q('[data-testid="debug-chat-attach"]');
      await m.fire(plus, ptr(m.p, "pointerdown", 100, 700));
      expect(m.q('[data-testid="debug-chat-attach-menu"]')).not.toBeNull();
      m.p.point(m.p.win.document.body as never);
      await m.fire(m.p.win as never, ptr(m.p, "pointermove", 500, 300));
      await m.fire(m.p.win as never, ptr(m.p, "pointerup", 500, 300));
      await m.frames();
      expect(m.q('[data-testid="debug-chat-attach-menu"]')).toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("a plain tap keeps today's toggle: open on the tap, closed on the next", async () => {
    const m = await mount();
    try {
      const plus = m.q('[data-testid="debug-chat-attach"]');
      m.p.point(plus);
      await m.fire(plus, ptr(m.p, "pointerdown", 100, 700));
      await m.fire(m.p.win as never, ptr(m.p, "pointerup", 100, 700));
      await m.fire(plus, new m.p.win.MouseEvent("click", { bubbles: true, detail: 1 }) as never);
      expect(m.q('[data-testid="debug-chat-attach-menu"]')).not.toBeNull();
      await m.fire(plus, ptr(m.p, "pointerdown", 100, 700));
      await m.fire(m.p.win as never, ptr(m.p, "pointerup", 100, 700));
      await m.fire(plus, new m.p.win.MouseEvent("click", { bubbles: true, detail: 1 }) as never);
      expect(m.q('[data-testid="debug-chat-attach-menu"]')).toBeNull();
      // The keyboard's click (detail 0) toggles as ever.
      await m.fire(plus, new m.p.win.MouseEvent("click", { bubbles: true, detail: 0 }) as never);
      expect(m.q('[data-testid="debug-chat-attach-menu"]')).not.toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);
});

describe("the grip menu: right-press, drag, release", () => {
  it("right-press opens it; letting go on Minimize minimizes; no window move", async () => {
    const m = await mount();
    try {
      const grip = m.q('[data-testid="debug-chat-pill-min"]');
      await m.fire(grip, ptr(m.p, "pointerdown", 20, 700, 2));
      await m.frames();
      const minimize = m.q('[data-testid="debug-menu-minimize"]');
      expect(minimize).not.toBeNull();
      // The contextmenu of the same press does not reopen or reposition it.
      await m.fire(
        grip,
        new m.p.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as never,
      );
      m.p.point(minimize);
      await m.fire(m.p.win as never, ptr(m.p, "pointermove", 60, 600, 2));
      await m.fire(m.p.win as never, ptr(m.p, "pointerup", 60, 600, 2));
      await m.frames();
      expect(m.host.querySelector('[data-testid="debug-chat-minimized"]')).not.toBeNull();
      expect(m.p.win.localStorage.getItem("lk:debug-chat-pos")).toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("right-click then a separate click still works", async () => {
    const m = await mount();
    try {
      const grip = m.q('[data-testid="debug-chat-pill-min"]');
      m.p.point(grip);
      await m.fire(grip, ptr(m.p, "pointerdown", 20, 700, 2));
      await m.fire(m.p.win as never, ptr(m.p, "pointerup", 20, 700, 2));
      await m.frames();
      const minimize = m.q('[data-testid="debug-menu-minimize"]');
      expect(minimize).not.toBeNull();
      await m.fire(
        minimize,
        new m.p.win.MouseEvent("click", { bubbles: true, detail: 1 }) as never,
      );
      await m.frames();
      expect(m.host.querySelector('[data-testid="debug-chat-minimized"]')).not.toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);

  it("the Dock right row docks the chat as the right sidebar (wide screens)", async () => {
    const m = await mount(true);
    try {
      const grip = m.q('[data-testid="debug-chat-pill-min"]');
      m.p.point(grip);
      await m.fire(grip, ptr(m.p, "pointerdown", 20, 700, 2));
      await m.fire(m.p.win as never, ptr(m.p, "pointerup", 20, 700, 2));
      await m.frames();
      const dock = m.q('[data-testid="debug-menu-dock-right"]');
      expect(dock).not.toBeNull();
      expect(dock!.getAttribute("aria-checked")).toBe("false");
      await m.fire(dock, new m.p.win.MouseEvent("click", { bubbles: true, detail: 1 }) as never);
      await m.frames();
      const { chatPrefs } = await import("../../packages/debug-chat/src/ui-store");
      expect(chatPrefs().getState()).toMatchObject({ full: true, fullMode: "side" });
      expect(m.host.querySelector("[data-fullscreen]")).not.toBeNull();
    } finally {
      await m.act(() => m.root.unmount());
      await m.p.close();
    }
  }, 20_000);
});
