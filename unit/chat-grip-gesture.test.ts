import { expect, test } from "bun:test";
import { createGripGesture, gripMenuPosition } from "../packages/debug-chat/src/grip-gesture";
import { DOUBLE_TAP_MS } from "../packages/debug-chat/src/tap-gesture";

function fixture() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  const events: string[] = [];
  let holdMs = 500;
  const setTimer = (f: () => void, ms: number) => {
    const id = ++nextId;
    timers.set(id, { f, at: now + ms });
    return id;
  };
  const clearTimer = (id: unknown) => {
    timers.delete(id as number);
  };
  const deps = {
    onSingle: () => events.push("single"),
    onDouble: () => events.push("double"),
    onMenu: () => events.push("menu"),
    onHoldCancelDrag: () => events.push("cancel-drag"),
    holdMs: () => holdMs,
    setTimer,
    clearTimer,
  };
  return {
    events,
    timers,
    deps,
    setHold: (ms: number) => {
      holdMs = ms;
    },
    advance(ms: number) {
      now += ms;
      const due = new Map(timers);
      for (const [id, t] of due)
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.f();
        }
    },
  };
}
const pointer = (pointerType = "mouse", button = 0, id = 1) => ({
  pointerType,
  button,
  x: 10,
  y: 10,
  id,
});

test("primary dragging starts immediately; mouse single/double clicks reuse tapper", () => {
  const f = fixture();
  const g = createGripGesture(f.deps);
  expect(g.down(pointer("mouse", 2))).toBe(false);
  expect(f.timers.size).toBe(0);
  expect(g.down(pointer())).toBe(true);
  expect(f.timers.size).toBe(0);
  g.up();
  g.click(false);
  f.advance(DOUBLE_TAP_MS - 1);
  expect(f.events).toEqual([]);
  f.advance(1);
  expect(f.events).toEqual(["single"]);
  g.down(pointer());
  g.up();
  g.click(false);
  g.down(pointer());
  g.up();
  g.click(false);
  f.advance(DOUBLE_TAP_MS);
  expect(f.events).toEqual(["single", "double"]);
  g.click(false);
  g.click(true);
  f.advance(DOUBLE_TAP_MS);
  expect(f.events).toEqual(["single", "double"]);
  g.cancel();
});

test("touch and pen hold cancel drag before menu; finish click and native context do not toggle", () => {
  const f = fixture();
  const g = createGripGesture(f.deps);
  g.down(pointer("touch"));
  f.advance(499);
  expect(f.events).toEqual([]);
  f.advance(1);
  expect(f.events).toEqual(["cancel-drag", "menu"]);
  g.up();
  g.click(false);
  g.context();
  f.advance(DOUBLE_TAP_MS);
  expect(f.events).toEqual(["cancel-drag", "menu"]);
  g.click(false);
  f.advance(DOUBLE_TAP_MS);
  expect(f.events).toHaveLength(2);
  // A later independent context opens again, even without a left-button press.
  g.context();
  expect(f.events).toEqual(["cancel-drag", "menu", "cancel-drag", "menu"]);
  f.setHold(100);
  g.down(pointer("pen"));
  f.advance(100);
  expect(f.events.slice(-2)).toEqual(["cancel-drag", "menu"]);
  g.down(pointer());
  g.up();
  g.click(false);
  f.advance(DOUBLE_TAP_MS);
  expect(f.events.at(-1)).toBe("single");
  g.cancel();
});

test("movement threshold, wrong pointer, replacement, cancel and up clear the right timers", () => {
  const f = fixture();
  const g = createGripGesture(f.deps);
  g.move({ x: 99, y: 99, id: 1 });
  g.down(pointer("touch"));
  g.move({ x: 99, y: 99, id: 2 });
  g.move({ x: 13, y: 13, id: 1 });
  expect(f.timers.size).toBe(1);
  g.move({ x: 13, y: 14, id: 1 });
  expect(f.timers.size).toBe(0);
  g.up();
  g.click(false);
  f.advance(1000);
  expect(f.events).toEqual([]);
  g.down(pointer());
  g.up();
  g.click(false); // pending single must be cancelled by movement.
  g.down(pointer("touch"));
  g.move({ x: 15, y: 10, id: 1 });
  expect(f.timers.size).toBe(0);
  f.advance(1000);
  expect(f.events).toEqual([]);
  g.down(pointer("touch"));
  const stale = [...f.timers.values()][0]!.f;
  g.down(pointer("pen", 0, 2));
  stale();
  expect(f.timers.size).toBe(1);
  g.up();
  expect(f.timers.size).toBe(0);
  g.down(pointer("touch"));
  g.up();
  g.click(false);
  g.down(pointer("touch"));
  expect(f.timers.size).toBe(2);
  g.cancel();
  expect(f.timers.size).toBe(0);
  g.click(false);
  f.advance(1000);
  expect(f.events).toEqual([]);
  g.down(pointer("touch"));
  const movedCallback = [...f.timers.values()][0]!.f;
  g.move({ x: 15, y: 10, id: 1 });
  movedCallback();
  expect(f.events).toEqual([]);
});

test("right context cancels both pending timers and suppresses its finishing click", () => {
  const f = fixture();
  const g = createGripGesture(f.deps);
  g.down(pointer());
  g.up();
  g.click(false);
  g.down(pointer("touch"));
  g.context();
  g.click(false);
  f.advance(1000);
  expect(f.events).toEqual(["cancel-drag", "menu"]);
  expect(f.timers.size).toBe(0);
});

test("default timer adapters use platform timers and cancel them", () => {
  const f = fixture();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  try {
    globalThis.setTimeout = f.deps.setTimer as typeof setTimeout;
    globalThis.clearTimeout = f.deps.clearTimer as typeof clearTimeout;
    const { setTimer: _set, clearTimer: _clear, ...deps } = f.deps;
    const g = createGripGesture(deps);
    g.down(pointer("touch"));
    g.up();
    g.down(pointer());
    g.up();
    g.click(false);
    f.advance(DOUBLE_TAP_MS);
    expect(f.events).toEqual(["single"]);
    g.cancel();
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

test("portal menu anchors above or below with viewport padding and constrained size", () => {
  expect(
    gripMenuPosition({ left: 290, top: 500, bottom: 520 }, { width: 320, height: 600 }),
  ).toEqual({ left: 120, top: 496, transform: "translateY(-100%)", maxHeight: 488, width: 192 });
  expect(gripMenuPosition({ left: -10, top: 10, bottom: 30 }, { width: 320, height: 600 })).toEqual(
    { left: 8, top: 34, maxHeight: 558, width: 192 },
  );
  expect(
    gripMenuPosition(
      { left: 10, top: 210, bottom: 230 },
      { width: 100, height: 300, left: 50, top: 200 },
    ),
  ).toEqual({ left: 58, top: 234, maxHeight: 258, width: 84 });
  expect(gripMenuPosition({ left: 999, top: 999, bottom: 999 }, { width: 4, height: 4 })).toEqual({
    left: 2,
    top: 2,
    maxHeight: 0,
    width: 0,
  });
  expect(gripMenuPosition({ left: -20, top: -20, bottom: -10 }, { width: 0, height: 0 })).toEqual({
    left: 0,
    top: 0,
    maxHeight: 0,
    width: 0,
  });
});
