import { describe, expect, it } from "bun:test";
import {
  DBLTAP,
  DBLTAP_IDLE,
  type DbltapPointer,
  type DbltapState,
  dbltapCancel,
  dbltapDown,
  dbltapFactor,
  dbltapHolds,
  dbltapMove,
  dbltapPointer,
  dbltapUp,
} from "@lianki/debug-chat/gantt-dbltap";

const P = (id: number, x: number, y: number, t: number, type = "touch"): DbltapPointer => ({
  id,
  type,
  x,
  y,
  t,
});

/** A tap at (100, 200) from t=0 to t=80: armed. */
function armed(type = "touch"): DbltapState {
  let s = dbltapDown(DBLTAP_IDLE, P(1, 100, 200, 0, type)).state;
  s = dbltapMove(s, P(1, 102, 201, 40, type)).state;
  s = dbltapUp(s, P(1, 102, 201, 80, type)).state;
  return s;
}

describe("double-tap, then drag to zoom (owner, 2026-11-15)", () => {
  it("touch and pen take part; a mouse never does", () => {
    expect(dbltapPointer("touch")).toBe(true);
    expect(dbltapPointer("pen")).toBe(true);
    expect(dbltapPointer("mouse")).toBe(false);
    expect(dbltapPointer("")).toBe(false);
  });

  it("tap → second down near it → drag: start, then the factor, down = in", () => {
    let s = armed();
    expect(s.kind).toBe("armed");
    s = dbltapDown(s, P(2, 110, 210, 250)).state;
    expect(s.kind).toBe("second");
    // A few px: still a plain tap.
    let r = dbltapMove(s, P(2, 112, 213, 260));
    expect(r.state.kind).toBe("second");
    expect(r.out).toBeUndefined();
    r = dbltapMove(r.state, P(2, 110, 220, 270));
    expect(r.state.kind).toBe("zoom");
    expect(r.out).toEqual({ type: "start", x: 110, y: 210 });
    r = dbltapMove(r.state, P(2, 115, 310, 290));
    expect(r.out?.type).toBe("zoom");
    if (r.out?.type !== "zoom") throw new Error("zoom expected");
    expect(r.out.factor).toBeCloseTo(Math.exp(100 * DBLTAP.zoomPerPx), 9);
    expect(r.out.factor).toBeGreaterThan(1);
    expect(r.out.x).toBe(115);
    // Up from the start: zoom out; back at the start: factor 1 (absolute, no drift).
    const up = dbltapMove(r.state, P(2, 110, 110, 300)).out;
    expect(up?.type === "zoom" && up.factor < 1).toBe(true);
    const back = dbltapMove(r.state, P(2, 110, 210, 310)).out;
    expect(back?.type === "zoom" && back.factor).toBe(1);
    // Release ends it.
    const end = dbltapUp(r.state, P(2, 110, 210, 320));
    expect(end).toEqual({ state: DBLTAP_IDLE, out: { type: "end" } });
  });

  it("pen works the same", () => {
    let s = dbltapDown(armed("pen"), P(5, 100, 200, 200, "pen")).state;
    const r = dbltapMove(s, P(5, 100, 240, 220, "pen"));
    expect(r.state.kind).toBe("zoom");
    s = dbltapMove(r.state, P(5, 100, 260, 230, "pen")).state;
    expect(s.kind).toBe("zoom");
  });

  it("a second tap without movement stays a plain tap: no zoom out, back to idle", () => {
    let s = dbltapDown(armed(), P(2, 100, 200, 200)).state;
    const r = dbltapUp(s, P(2, 100, 200, 260));
    expect(r).toEqual({ state: DBLTAP_IDLE });
    s = r.state;
    expect(s.kind).toBe("idle");
  });

  it("timing: a second down after gapMs starts over; a slow first press is no tap", () => {
    const late = dbltapDown(armed(), P(2, 100, 200, 80 + DBLTAP.gapMs + 1)).state;
    expect(late.kind).toBe("first");
    const onTime = dbltapDown(armed(), P(2, 100, 200, 80 + DBLTAP.gapMs)).state;
    expect(onTime.kind).toBe("second");
    let s = dbltapDown(DBLTAP_IDLE, P(1, 100, 200, 0)).state;
    s = dbltapUp(s, P(1, 100, 200, DBLTAP.tapMs + 1)).state;
    expect(s.kind).toBe("idle");
  });

  it("distance: a second down far from the tap starts over; a moved first press is a pan", () => {
    const far = dbltapDown(armed(), P(2, 100 + DBLTAP.slopPx + 1, 200, 150)).state;
    expect(far.kind).toBe("first");
    let s = dbltapDown(DBLTAP_IDLE, P(1, 100, 200, 0)).state;
    s = dbltapMove(s, P(1, 100, 200 + DBLTAP.tapMovePx + 1, 30)).state;
    expect(s.kind).toBe("idle");
    // Up off where it went down (no move event seen): not a tap either.
    s = dbltapDown(DBLTAP_IDLE, P(1, 100, 200, 0)).state;
    s = dbltapUp(s, P(1, 140, 200, 50)).state;
    expect(s.kind).toBe("idle");
  });

  it("a mouse leaves the state as it is, at every step", () => {
    const s = armed();
    expect(dbltapDown(s, P(9, 100, 200, 100, "mouse")).state).toBe(s);
    expect(dbltapMove(s, P(9, 100, 300, 120, "mouse")).state).toBe(s);
    expect(dbltapUp(s, P(9, 100, 300, 140, "mouse")).state).toBe(s);
    // A mouse double-click never arms it.
    let m = dbltapDown(DBLTAP_IDLE, P(9, 100, 200, 0, "mouse")).state;
    m = dbltapUp(m, P(9, 100, 200, 50, "mouse")).state;
    m = dbltapDown(m, P(9, 100, 200, 120, "mouse")).state;
    expect(m.kind).toBe("idle");
  });

  it("pinch precedence: a second pointer cancels it in every held state", () => {
    const first = dbltapDown(DBLTAP_IDLE, P(1, 100, 200, 0)).state;
    expect(dbltapDown(first, P(2, 200, 200, 10))).toEqual({ state: DBLTAP_IDLE });
    const second = dbltapDown(armed(), P(2, 100, 200, 150)).state;
    expect(dbltapDown(second, P(3, 200, 200, 160))).toEqual({ state: DBLTAP_IDLE });
    const zoom = dbltapMove(second, P(2, 100, 260, 170)).state;
    expect(zoom.kind).toBe("zoom");
    expect(dbltapDown(zoom, P(3, 200, 200, 180))).toEqual({
      state: DBLTAP_IDLE,
      out: { type: "end" },
    });
  });

  it("cancellation: pointercancel ends a live zoom, drops anything else", () => {
    const second = dbltapDown(armed(), P(2, 100, 200, 150)).state;
    const zoom = dbltapMove(second, P(2, 100, 260, 170)).state;
    expect(dbltapCancel(zoom)).toEqual({ state: DBLTAP_IDLE, out: { type: "end" } });
    expect(dbltapCancel(second)).toEqual({ state: DBLTAP_IDLE });
    expect(dbltapCancel(armed())).toEqual({ state: DBLTAP_IDLE });
  });

  it("events from other pointers are ignored", () => {
    const second = dbltapDown(armed(), P(2, 100, 200, 150)).state;
    expect(dbltapMove(second, P(7, 100, 300, 160)).state).toBe(second);
    expect(dbltapUp(second, P(7, 100, 300, 160)).state).toBe(second);
    const zoom = dbltapMove(second, P(2, 100, 260, 170)).state;
    expect(dbltapMove(zoom, P(7, 100, 300, 180))).toEqual({ state: zoom });
    const first = dbltapDown(DBLTAP_IDLE, P(1, 100, 200, 0)).state;
    expect(dbltapMove(first, P(7, 300, 300, 5)).state).toBe(first);
    expect(dbltapMove(DBLTAP_IDLE, P(1, 1, 1, 1)).state).toBe(DBLTAP_IDLE);
    expect(dbltapUp(DBLTAP_IDLE, P(1, 1, 1, 1)).state).toBe(DBLTAP_IDLE);
  });

  it("holds the pointer from the browser only while armed in time or held", () => {
    const a = armed();
    expect(dbltapHolds(DBLTAP_IDLE, 0)).toBe(false);
    expect(dbltapHolds(a, 80 + DBLTAP.gapMs)).toBe(true);
    expect(dbltapHolds(a, 80 + DBLTAP.gapMs + 1)).toBe(false);
    const second = dbltapDown(a, P(2, 100, 200, 150)).state;
    expect(dbltapHolds(second, 1e9)).toBe(true);
    expect(dbltapHolds(dbltapMove(second, P(2, 100, 260, 170)).state, 1e9)).toBe(true);
    expect(dbltapHolds(dbltapDown(DBLTAP_IDLE, P(1, 0, 0, 0)).state, 0)).toBe(false);
  });

  it("thresholds are data: a custom config changes them", () => {
    const cfg = { ...DBLTAP, zoomPerPx: 0.02, gapMs: 50 };
    expect(dbltapFactor(50, cfg)).toBeCloseTo(Math.exp(1), 9);
    expect(dbltapFactor(-50)).toBeCloseTo(Math.exp(-50 * DBLTAP.zoomPerPx), 9);
    expect(dbltapDown(armed(), P(2, 100, 200, 200), cfg).state.kind).toBe("first");
  });
});
