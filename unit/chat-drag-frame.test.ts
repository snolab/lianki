import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createFrameWriter,
  createGapMeter,
  dragStep,
  dragTransform,
  type DragGeom,
} from "@lianki/debug-chat/drag-frame";

/** A hand-cranked animation frame clock. */
function fakeClock() {
  let next = 1;
  let t = 0;
  const cbs = new Map<number, (t: number) => void>();
  return {
    request: (cb: (t: number) => void) => {
      cbs.set(next, cb);
      return next++;
    },
    cancel: (id: number) => void cbs.delete(id),
    now: () => t,
    tick(ms = 16) {
      t += ms;
      const run = [...cbs.values()];
      cbs.clear();
      for (const cb of run) cb(t);
    },
    queued: () => cbs.size,
  };
}

describe("one write per frame (owner, 2026-11-14: the drag felt janky)", () => {
  it("many moves in a frame apply once, with the latest point", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const w = createFrameWriter<number>((v) => seen.push(v), clock);
    w.push(1);
    w.push(2);
    w.push(3);
    expect(clock.queued()).toBe(1);
    expect(seen).toEqual([]);
    clock.tick();
    expect(seen).toEqual([3]);
    clock.tick();
    expect(seen).toEqual([3]);
    w.push(4);
    clock.tick();
    expect(seen).toEqual([3, 4]);
  });
  it("flush on pointerup writes the last point now and leaves no frame behind", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const w = createFrameWriter<number>((v) => seen.push(v), clock);
    w.push(7);
    w.flush();
    expect(seen).toEqual([7]);
    expect(clock.queued()).toBe(0);
    expect(w.pending()).toBe(false);
    w.flush();
    expect(seen).toEqual([7]);
  });
  it("cancel drops a pending point", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const w = createFrameWriter<number>((v) => seen.push(v), clock);
    w.push(1);
    w.cancel();
    clock.tick();
    expect(seen).toEqual([]);
  });
});

describe("dragStep: geometry measured once, the bar kept on screen", () => {
  const g: DragGeom = {
    left: 100,
    top: 700,
    width: 200,
    height: 44,
    boxLeft: 80,
    boxRight: 320,
    vw: 390,
    vh: 844,
    safeTop: 47,
  };
  it("follows the pointer from the start offset", () => {
    const s = dragStep(g, { x: -10, y: -20 }, -30, -100);
    expect(s).toEqual({
      x: -40,
      y: -120,
      span: { left: 70, right: 270, boxLeft: 50, boxRight: 290, bottom: 644 },
    });
  });
  it("stops at the screen's edges and under the notch", () => {
    expect(dragStep(g, { x: 0, y: 0 }, -500, 0).span.left).toBe(0);
    expect(dragStep(g, { x: 0, y: 0 }, 500, 0).span.right).toBe(390);
    expect(dragStep(g, { x: 0, y: 0 }, 0, 500).span.bottom).toBe(844);
    const up = dragStep(g, { x: 0, y: 0 }, 0, -2000);
    expect(up.span.bottom - g.height).toBe(47);
    expect(up.y).toBe(47 - 700);
  });
  it("writes a compositor transform that keeps the keyboard lift", () => {
    expect(dragTransform(3, -4, "--lk-kb-lift")).toBe(
      "translate3d(3px, calc(-4px - var(--lk-kb-lift, 0px)), 0)",
    );
  });
});

describe("the debug perf log: frame gaps", () => {
  it("reports the max and p95 gap", () => {
    const m = createGapMeter();
    expect(m.report()).toEqual({ frames: 0, max: 0, p95: 0 });
    let t = 0;
    for (let i = 0; i < 40; i++) m.frame((t += i === 10 ? 50 : 16));
    expect(m.report()).toEqual({ frames: 40, max: 50, p95: 16 });
  });
});

describe("the chat's drag commits once (DebugChat.tsx useDrag)", () => {
  const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
  const body = (name: string) => {
    const at = src.indexOf(`  const ${name} = (`);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n  };\n", at));
  };
  it("a move only queues the point: no state, no layout read", () => {
    const move = body("moveTo");
    expect(move).toContain("frame.current!.push(");
    expect(move).not.toContain("setPos");
    expect(move).not.toContain("getBoundingClientRect");
    expect(move).not.toContain("safeTop(");
  });
  it("the release flushes the last frame and sets the position once", () => {
    const settle = body("settle");
    expect(settle).toContain("frame.current!.flush()");
    expect(settle.match(/setPos\(/g)?.length).toBe(1);
    expect(body("end")).toContain("settle(d, true)");
  });
  it("will-change only while dragging", () => {
    expect(src).toContain('box.style.willChange = "transform"');
    expect(body("settle")).toContain('d.box.style.willChange = ""');
  });
});
