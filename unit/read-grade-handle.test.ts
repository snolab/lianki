/**
 * The selection card's grade handle gesture (lib/read/grade-handle.ts): a tap
 * never grades, the axis locks on the first movement, sideways grades by the
 * /words swipe levels, a release short of the first level cancels, up past
 * UNDO_PX undoes only when there is a batch to undo, and a press inside the
 * opening tap is ignored.
 */
import { describe, expect, test } from "bun:test";
import {
  handleMove,
  handleRelease,
  openingPress,
  OPENING_MS,
  relTime,
  UNDO_PX,
} from "@/lib/read/grade-handle";
import { SWIPE_ROW_PX } from "@/lib/words/swipe";

const a = SWIPE_ROW_PX;
const release = (dx: number, dy: number, canUndo = false, v = 0) => {
  const m = handleMove(dx, dy, null, 0, a);
  // Walk the finger out so the level's hysteresis is the swipe's.
  let held = m.level;
  if (m.axis === "h")
    for (let x = 0; Math.abs(x) <= Math.abs(dx); x += Math.sign(dx) * 2)
      held = handleMove(x, 0, "h", held, a).level;
  return handleRelease({ axis: m.axis, dx, dy, v, held, canUndo, a });
};

describe("the handle's gesture", () => {
  test("a tap (no travel) never grades nor undoes", () => {
    expect(release(0, 0, true)).toEqual({ kind: "none" });
    expect(release(4, 3, true)).toEqual({ kind: "none" });
  });

  test("sideways: the swipe's levels (right Good / Easy, left Hard / Again)", () => {
    expect(release(a * 1.0, 0)).toEqual({ kind: "grade", raw: 3 });
    expect(release(a * 2.2, 0)).toEqual({ kind: "grade", raw: 4 });
    expect(release(-a * 1.0, 0)).toEqual({ kind: "grade", raw: 2 });
    expect(release(-a * 2.2, 0)).toEqual({ kind: "grade", raw: 1 });
  });

  test("released before the first level: cancelled", () => {
    expect(release(a * 0.3, 0)).toEqual({ kind: "none" });
  });

  test("the axis locks: a steep drag never grades, however far sideways later", () => {
    const m = handleMove(2, -30, null, 0, a);
    expect(m.axis).toBe("v");
    expect(handleMove(200, -30, m.axis, 0, a).level).toBe(0);
    expect(handleRelease({ axis: "v", dx: 200, dy: -10, v: 0, held: 0, canUndo: true, a })).toEqual(
      { kind: "none" },
    );
  });

  test("up past UNDO_PX undoes, only with a batch to undo", () => {
    expect(release(0, -(UNDO_PX + 4), true)).toEqual({ kind: "undo" });
    expect(release(0, -(UNDO_PX + 4), false)).toEqual({ kind: "none" });
    expect(release(0, -(UNDO_PX - 10), true)).toEqual({ kind: "none" });
    expect(release(0, UNDO_PX + 20, true)).toEqual({ kind: "none" });
    expect(handleMove(0, -(UNDO_PX + 1), null, 0, a).undo).toBe(true);
  });

  test("a press inside the gesture that opened the card is ignored", () => {
    expect(openingPress(1000, 1000 + OPENING_MS - 1)).toBe(true);
    expect(openingPress(1000, 1000 + OPENING_MS + 1)).toBe(false);
  });

  test("a due as a relative time in his language", () => {
    const now = Date.parse("2026-11-05T00:00:00Z");
    expect(relTime("2026-11-08T00:00:00Z", "en", now)).toBe("in 3 days");
    expect(relTime("2026-11-06T00:00:00Z", "en", now)).toBe("tomorrow");
    expect(relTime("2026-11-05T00:10:00Z", "en", now)).toBe("in 10 minutes");
    expect(relTime("2026-11-08T00:00:00Z", "zh", now)).toBe("3天后");
  });
});
