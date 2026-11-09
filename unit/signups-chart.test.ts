import { describe, expect, test } from "bun:test";
import {
  addMonths,
  barText,
  CHART,
  chartModel,
  daysInMonth,
  forecastMonth,
  jstMonth,
  monthSeries,
  niceMax,
} from "@/lib/signups-chart";

describe("JST month bucketing", () => {
  test("an instant belongs to its Japan-time month", () => {
    // 2026-10-31 15:00 UTC is 2026-11-01 00:00 JST.
    expect(jstMonth("2026-10-31T14:59:59Z")).toBe("2026-10");
    expect(jstMonth("2026-10-31T15:00:00Z")).toBe("2026-11");
    expect(jstMonth(Date.UTC(2026, 11, 31, 15))).toBe("2027-01");
    expect(jstMonth(new Date("2026-03-01"))).toBe("2026-03");
  });

  test("days in month, leap Februaries", () => {
    expect(daysInMonth("2026-01")).toBe(31);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2100-02")).toBe(28);
    expect(daysInMonth("2000-02")).toBe(29);
    expect(daysInMonth("2026-11")).toBe(30);
  });

  test("addMonths crosses years both ways", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11", -23)).toBe("2024-12");
  });
});

describe("forecast", () => {
  test("first day of the month: so far × days in month", () => {
    // 2026-11-01 00:30 JST.
    const f = forecastMonth(3, Date.parse("2026-10-31T15:30:00Z"));
    expect(f).toEqual({ month: "2026-11", elapsed: 1, days: 30, forecast: 90 });
  });

  test("last day: the count so far", () => {
    const f = forecastMonth(41, Date.parse("2026-11-30T14:00:00Z"));
    expect(f).toEqual({ month: "2026-11", elapsed: 30, days: 30, forecast: 41 });
  });

  test("leap February uses 29 days; rounds to a whole account", () => {
    const f = forecastMonth(10, Date.parse("2028-02-07T03:00:00Z"));
    expect(f).toEqual({ month: "2028-02", elapsed: 7, days: 29, forecast: 41 });
    expect(forecastMonth(10, Date.parse("2026-02-07T03:00:00Z")).forecast).toBe(40);
  });

  test("zero so far forecasts zero", () => {
    expect(forecastMonth(0, Date.parse("2026-11-09T06:00:00Z")).forecast).toBe(0);
  });
});

describe("monthSeries", () => {
  const now = Date.parse("2026-11-09T06:00:00Z"); // 2026-11-09 15:00 JST

  test("fills empty months from the first sign-up to now, forecast on the last", () => {
    const s = monthSeries(
      [
        { month: "2026-08", n: 4 },
        { month: "2026-10", n: 12 },
        { month: "2026-11", n: 6 },
      ],
      now,
    );
    expect(s.map((b) => b.month)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(s.map((b) => b.n)).toEqual([4, 0, 12, 6]);
    expect(s[3].forecast).toBe(20); // 6 × 30 ÷ 9
    expect(s[2].forecast).toBeUndefined();
  });

  test("keeps at most `span` months and drops rows outside the window", () => {
    const s = monthSeries(
      [
        { month: "2020-01", n: 99 },
        { month: "2026-11", n: 1 },
        { month: "2027-01", n: 5 },
      ],
      now,
      24,
    );
    expect(s).toHaveLength(24);
    expect(s[0].month).toBe("2024-12");
    expect(s.reduce((a, b) => a + b.n, 0)).toBe(1);
  });

  test("no sign-ups at all: just the current month at zero", () => {
    expect(monthSeries([], now)).toEqual([{ month: "2026-11", n: 0, forecast: 0 }]);
  });
});

describe("chart model", () => {
  test("niceMax rounds up to 1, 2, 5 × 10^k", () => {
    expect([0, 1, 2, 3, 7, 10, 11, 21, 60, 101].map(niceMax)).toEqual([
      1, 1, 2, 5, 10, 10, 20, 50, 100, 200,
    ]);
  });

  test("bars stand on the baseline; the current month has a hatched part to its forecast", () => {
    const m = chartModel([
      { month: "2026-10", n: 10 },
      { month: "2026-11", n: 5, forecast: 20 },
    ]);
    const plot = CHART.height - CHART.top - CHART.bottom;
    expect(m.max).toBe(20);
    expect(m.base).toBe(CHART.top + plot);
    const [oct, nov] = m.bars;
    expect(oct.y + oct.h).toBe(m.base);
    expect(oct.h).toBeCloseTo(plot / 2);
    expect(oct.fh).toBeUndefined();
    expect(nov.h).toBeCloseTo(plot / 4);
    expect(nov.fy).toBe(CHART.top); // the forecast reaches the axis top
    expect(nov.fy! + nov.fh!).toBeCloseTo(nov.y);
    expect(nov.x - oct.x).toBe(CHART.slot);
    expect(m.width).toBe(CHART.left + 2 * CHART.slot + 4);
    expect(m.ticks.map((t) => t.v)).toEqual([0, 10, 20]);
  });

  test("labels: month number, year on January; no year on a first bar right before it", () => {
    const m = chartModel(monthSeries([{ month: "2025-11", n: 1 }], Date.parse("2026-02-10Z")));
    expect(m.bars.map((b) => [b.label, b.year])).toEqual([
      ["11", undefined],
      ["12", undefined],
      ["01", "2026"],
      ["02", undefined],
    ]);
  });

  test("the first bar carries its year when no January is close", () => {
    const m = chartModel(monthSeries([{ month: "2026-08", n: 1 }], Date.parse("2026-11-10Z")));
    expect(m.bars[0].year).toBe("2026");
  });

  test("a forecast equal to the count draws no hatched part; odd max has two ticks", () => {
    const m = chartModel([{ month: "2026-11", n: 1, forecast: 1 }]);
    expect(m.bars[0].fh).toBeUndefined();
    expect(m.ticks.map((t) => t.v)).toEqual([0, 1]);
    expect(chartModel([{ month: "2026-11", n: 0, forecast: 0 }]).bars[0].h).toBe(0);
  });
});

describe("readout", () => {
  const c = {
    barDone: "{month}: {count} sign-ups",
    barCurrent: "{month}: so far {count} · forecast ≈ {forecast}",
  };
  test("finished and current months", () => {
    expect(barText({ month: "2026-10", n: 12 }, c)).toBe("2026-10: 12 sign-ups");
    expect(barText({ month: "2026-11", n: 6, forecast: 20 }, c)).toBe(
      "2026-11: so far 6 · forecast ≈ 20",
    );
  });
});
