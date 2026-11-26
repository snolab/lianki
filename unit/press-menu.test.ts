/**
 * Press, drag, release menus (packages/debug-chat/src/press-menu.ts; owner,
 * 2026-11-27): the release rule, and the follow in happy-dom — slide over an
 * item, let go to pick it; elsewhere cancels; no slide is a plain tap.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import {
  PRESS_HOT_BG,
  itemAt,
  pressMenu,
  releaseAction,
} from "../packages/debug-chat/src/press-menu";

describe("releaseAction", () => {
  const at = (o: Partial<Parameters<typeof releaseAction>[0]>) =>
    releaseAction({ moved: true, onItem: false, onOpener: false, inMenu: false, ...o });
  it("slid onto an item: it is picked", () => {
    expect(at({ onItem: true, inMenu: true })).toBe("trigger");
  });
  it("no slide: a plain tap or right-click, the menu stays (no item picked by accident)", () => {
    expect(at({ moved: false })).toBe("keep");
    expect(at({ moved: false, onItem: true, inMenu: true })).toBe("keep");
  });
  it("back on the opener, or on the menu's padding: it stays", () => {
    expect(at({ onOpener: true })).toBe("keep");
    expect(at({ inMenu: true })).toBe("keep");
  });
  it("anywhere else after sliding: cancelled", () => {
    expect(at({})).toBe("cancel");
  });
});

describe("mounted in DebugChat", () => {
  // In its own process, outside the coverage gate (unit/support/press-menu-mount.tsx).
  it("the +, the grip's right-press and Dock right (unit/support/press-menu-mount.tsx)", () => {
    const r = Bun.spawnSync(["bun", "test", "./press-menu-mount.tsx"], {
      cwd: `${import.meta.dir}/support`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    if (r.exitCode !== 0) console.error(out);
    expect(r.exitCode).toBe(0);
    expect(out).toMatch(/\b6 pass\b/);
    expect(out).toMatch(/\b0 fail\b/);
  }, 90_000);
});

let wins: Window[] = [];
afterEach(async () => {
  for (const w of wins) await w.happyDOM.close();
  wins = [];
});

/** A page with an opener and a menu of two items; elementFromPoint is ours (no layout in happy-dom). */
function page() {
  const win = new Window({ url: "https://lianki.com/en", width: 800, height: 600 });
  wins.push(win);
  const doc = win.document;
  doc.body.innerHTML = `
    <button id="opener">+</button>
    <div id="menu" role="menu">
      <button id="a" role="menuitem">A</button>
      <span id="pad">padding</span>
      <button id="b" role="menuitem">B</button>
    </div>
    <p id="out">elsewhere</p>`;
  const byId = (id: string) => doc.getElementById(id) as unknown as HTMLElement;
  // Where each point "is": x picks the element.
  const map: Record<number, string> = { 10: "opener", 100: "a", 150: "pad", 200: "b", 400: "out" };
  (doc as unknown as { elementFromPoint: (x: number) => Element | null }).elementFromPoint = (
    x: number,
  ) => (map[x] ? (byId(map[x]) as unknown as Element) : null);
  const clicks: string[] = [];
  for (const id of ["a", "b", "opener", "out"])
    byId(id).addEventListener("click", () => clicks.push(id));
  let closed = 0;
  const ptr = (type: string, x: number) =>
    win.dispatchEvent(
      new win.PointerEvent(type, { clientX: x, clientY: 5, pointerId: 1, bubbles: true }) as never,
    );
  const follow = () =>
    pressMenu({
      win: win as never,
      menu: () => byId("menu"),
      opener: () => byId("opener"),
      start: { x: 10, y: 5, pointerId: 1 },
      close: () => void closed++,
    });
  return { win, byId, clicks, ptr, follow, closed: () => closed };
}

describe("pressMenu in a page", () => {
  it("slide over items highlights them; release on one picks it, once", () => {
    const p = page();
    p.follow();
    p.ptr("pointermove", 100);
    expect(p.byId("a").dataset.pressHot).toBe("");
    p.ptr("pointermove", 200);
    expect(p.byId("a").dataset.pressHot).toBeUndefined();
    expect(p.byId("b").dataset.pressHot).toBe("");
    p.ptr("pointerup", 200);
    expect(p.clicks).toEqual(["b"]);
    expect(p.byId("b").dataset.pressHot).toBeUndefined();
    // The browser's own click after the release is swallowed.
    p.byId("out").click();
    expect(p.clicks).toEqual(["b"]);
    expect(p.closed()).toBe(0);
  });

  it("only that one click is swallowed: later clicks go through", async () => {
    const p = page();
    p.follow();
    p.ptr("pointermove", 100);
    p.ptr("pointerup", 400);
    await new Promise((r) => setTimeout(r, 350));
    p.byId("out").click();
    expect(p.clicks).toEqual(["out"]);
  });

  it("other keys do nothing", () => {
    const p = page();
    p.follow();
    p.win.dispatchEvent(new p.win.KeyboardEvent("keydown", { key: "a" }) as never);
    p.ptr("pointermove", 100);
    p.ptr("pointerup", 100);
    expect(p.clicks).toEqual(["a"]);
    expect(p.closed()).toBe(0);
  });

  it("released elsewhere after sliding: cancelled (closed), nothing picked", () => {
    const p = page();
    p.follow();
    p.ptr("pointermove", 100);
    p.ptr("pointerup", 400);
    expect(p.clicks).toEqual([]);
    expect(p.closed()).toBe(1);
  });

  it("a plain tap (no slide) leaves the menu open for a separate click", () => {
    const p = page();
    p.follow();
    p.ptr("pointermove", 12);
    p.ptr("pointerup", 10);
    expect(p.closed()).toBe(0);
    p.byId("a").click();
    expect(p.clicks).toEqual(["a"]);
  });

  it("Escape cancels; pointercancel only stops following", () => {
    const p = page();
    p.follow();
    p.ptr("pointermove", 100);
    p.win.dispatchEvent(new p.win.KeyboardEvent("keydown", { key: "Escape" }) as never);
    expect(p.closed()).toBe(1);
    p.ptr("pointerup", 200);
    expect(p.clicks).toEqual([]);
    const q = page();
    q.follow();
    q.ptr("pointermove", 100);
    q.ptr("pointercancel", 100);
    q.ptr("pointerup", 200);
    expect(q.closed()).toBe(0);
    expect(q.clicks).toEqual([]);
  });

  it("another pointer is not followed; end() stops it", () => {
    const p = page();
    const f = p.follow();
    p.win.dispatchEvent(
      new p.win.PointerEvent("pointermove", { clientX: 100, clientY: 5, pointerId: 2 }) as never,
    );
    expect(p.byId("a").dataset.pressHot).toBeUndefined();
    f.end();
    p.ptr("pointermove", 100);
    p.ptr("pointerup", 100);
    expect(p.clicks).toEqual([]);
  });

  it("itemAt finds only items inside the menu", () => {
    const p = page();
    expect(itemAt(p.byId("menu"), { x: 100, y: 5 })?.id).toBe("a");
    expect(itemAt(p.byId("menu"), { x: 10, y: 5 })).toBeNull();
    expect(itemAt(null, { x: 100, y: 5 })).toBeNull();
    expect(PRESS_HOT_BG).toMatch(/^oklch\(/);
  });
});
