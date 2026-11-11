import { describe, expect, it } from "bun:test";
import { DAY, HOUR, MIN, MONTH, WEEK, YEAR, axisLabel, compactSpan } from "@snomiao/rgui/gantt";
import { compactTime, isLate } from "@lianki/debug-chat/eta";

describe("compact units by magnitude: Y, Mo, W, D, H, M (owner, 2026-11-10)", () => {
  it("each boundary takes the larger unit; just under it, the smaller", () => {
    expect(compactSpan(59 * MIN)).toBe("59M");
    expect(compactSpan(HOUR)).toBe("1H");
    expect(compactSpan(DAY - 1.5 * HOUR)).toBe("22.5H");
    expect(compactSpan(DAY)).toBe("1D");
    expect(compactSpan(6 * DAY)).toBe("6D");
    expect(compactSpan(WEEK)).toBe("1W");
    expect(compactSpan(3 * WEEK)).toBe("3W");
    expect(compactSpan(MONTH)).toBe("1Mo");
    expect(compactSpan(6 * MONTH)).toBe("6Mo");
    expect(compactSpan(YEAR)).toBe("1Y");
    expect(compactSpan(2.5 * YEAR)).toBe("2.5Y");
    // Over a year is never days (it was "400D").
    expect(compactSpan(400 * DAY)).toBe("1.1Y");
  });

  it("a value that rounds up to the next unit moves up", () => {
    expect(compactSpan(DAY - 60_000)).toBe("1D");
    expect(compactSpan(WEEK - HOUR)).toBe("1W");
    expect(compactSpan(YEAR - HOUR)).toBe("1Y");
    expect(compactSpan(59.8 * MIN)).toBe("1H");
  });

  it("the axis labels and the ETA labels share it", () => {
    expect(axisLabel(0)).toBe("Now");
    expect(axisLabel(-2 * YEAR)).toBe("-2Y");
    expect(axisLabel(3 * MONTH)).toBe("3Mo");
    expect(compactTime(2 * WEEK)).toBe("2W");
    expect(compactTime(-400 * DAY)).toBe("-1.1Y");
    expect(isLate(-400 * DAY)).toBe(true);
    // The ETA keeps rounding minutes up.
    expect(compactTime(4 * MIN + 1)).toBe("5M");
  });
});
