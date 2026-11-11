// /dev/costs day and hour matrices (lib/payments/cost-buckets.ts; docs/payments.md,
// "Cost ledger"): JST buckets, the window caps, the aggregation, the API views.
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { bookCost } from "@/lib/payments/cost-ledger";
import {
  COSTS_MAX_HOURS,
  costDayMatrix,
  costHour,
  costHourMatrix,
  costMatrix,
  dayBuckets,
  hourStartMs,
  hourWindow,
} from "@/lib/payments/cost-buckets";
import { costsGet } from "@/lib/payments/costs-route";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import { MARGIN } from "@/lib/payments/prices";
import { HEAT_LEVELS, heatLevel, heatVars } from "@/app/(app)/dev/costs/heat";
import { contrast, oklchToHex } from "@/lib/mail-templates/color";

const NOW = new Date("2026-11-11T01:30:00Z"); // 10:30 JST, 2026-11-11

describe("JST buckets", () => {
  it("an hour is the JST hour, across the day boundary", () => {
    expect(costHour(new Date("2026-11-10T14:59:59.999Z"))).toBe("2026-11-10T23");
    expect(costHour(new Date("2026-11-10T15:00:00Z"))).toBe("2026-11-11T00");
    expect(hourStartMs("2026-11-11T00")).toBe(Date.parse("2026-11-10T15:00:00Z"));
  });

  it("no daylight saving: March and October hours are 1 h apart all the way", () => {
    for (const day of ["2026-03-08", "2026-03-29", "2026-10-25", "2026-11-01"]) {
      const w = hourWindow(24, { from: day, to: day }, new Date("2027-01-01T00:00:00Z"));
      expect(w.hours).toHaveLength(24);
      expect(w.hours[0]).toBe(`${day}T00`);
      expect(w.hours[23]).toBe(`${day}T23`);
      expect(Date.parse(w.endIso) - Date.parse(w.startIso)).toBe(24 * 3600_000);
    }
  });

  it("days are listed inclusively, oldest first, across a month end", () => {
    expect(dayBuckets({ from: "2026-10-30", to: "2026-11-02" })).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("the hour window: the last N hours up to now, capped, clipped to the range", () => {
    const range = { from: "2026-11-01", to: "2026-11-11" };
    const w = hourWindow(48, range, NOW);
    expect(w.hours).toHaveLength(48);
    expect(w.hours.at(-1)).toBe("2026-11-11T10");
    expect(w.hours[0]).toBe("2026-11-09T11");
    expect(w.startIso).toBe("2026-11-09T02:00:00.000Z");
    expect(w.endIso).toBe("2026-11-11T02:00:00.000Z");
    expect([w.fromDay, w.toDay]).toEqual(["2026-11-09", "2026-11-11"]);
    expect(hourWindow(10_000, range, NOW).hours).toHaveLength(COSTS_MAX_HOURS);
    // A past range ends with its last day's 23:00; a one-day range has 24 hours at most.
    const past = hourWindow(48, { from: "2026-11-05", to: "2026-11-05" }, NOW);
    expect(past.hours).toHaveLength(24);
    expect(past.hours.at(-1)).toBe("2026-11-05T23");
  });
});

describe("costMatrix", () => {
  it("sums cells, rows and columns; keeps empty buckets; drops groups outside", () => {
    const m = costMatrix(
      ["d1", "d2", "d3"],
      [
        { b: "d1", feature: "words.tts", micro: 10, n: 2 },
        { b: "d1", feature: "speech.stt", micro: 5, n: 1 },
        { b: "d3", feature: "words.tts", micro: 1, n: 1 },
        { b: "elsewhere", feature: "words.tts", micro: 999, n: 9 },
      ],
      [
        { b: "d1", prefix: "read.gloss", cm: 3_000_000, n: 1 },
        { b: "d3", prefix: "", cm: 1_000_000, n: 2 },
      ],
    );
    expect(m.rows.map((r) => r.bucket)).toEqual(["d1", "d2", "d3"]);
    expect(m.rows[1].total.freeMicro + m.rows[1].total.paidMicro).toBe(0);
    expect(m.rows[0].cells["words.tts"]).toMatchObject({ freeMicro: 10, freeCalls: 2 });
    const paid = 3_000_000 / CREDITS_PER_USD / MARGIN;
    expect(m.rows[0].cells["read.gloss"].paidMicro).toBeCloseTo(paid, 9);
    expect(m.rows[0].cells["read.gloss"].paidCredits).toBe(3);
    expect(m.rows[2].cells["partner.reply"]).toMatchObject({ paidCredits: 1, paidCalls: 2 });
    expect(m.rows[0].total.freeMicro).toBe(15);
    expect(m.totals.freeMicro).toBe(16);
    expect(m.totals.freeCalls).toBe(4);
    const col = Object.fromEntries(m.features.map((f) => [f.feature, f]));
    expect(col["words.tts"].freeMicro).toBe(11);
    // Column sums add up to the grand total; the dearest feature comes first.
    const sum = m.features.reduce((s, f) => s + f.freeMicro + f.paidMicro, 0);
    expect(sum).toBeCloseTo(m.totals.freeMicro + m.totals.paidMicro, 9);
    const costs = m.features.map((f) => f.freeMicro + f.paidMicro);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
  });
});

describe("from D1", () => {
  let d1: TestD1Database;
  beforeEach(() => {
    d1 = createTestD1(testSchema());
    d1.raw().exec(
      "INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES ('u1', 'A', 'u1@x.com', 'x', 'x')",
    );
  });
  const paid = (key: string, cm: number, settledAt: string) =>
    d1
      .raw()
      .exec(
        `INSERT INTO credit_ai_charge (key, userId, reserved, status, costMicro, charged, createdAt, settledAt) VALUES ('${key}', 'u1', 1, 'settled', ${cm}, 0, '${settledAt}', '${settledAt}')`,
      );

  it("books land in their JST hour and day, both sides", async () => {
    // 23:59 JST on the 10th and 00:00 JST on the 11th: different days and hours.
    await bookCost(
      d1,
      { userId: "u1", feature: "words.tts", usd: 1 },
      new Date("2026-11-10T14:59:00Z"),
    );
    await bookCost(
      d1,
      { userId: "u1", feature: "words.tts", usd: 2 },
      new Date("2026-11-10T15:00:00Z"),
    );
    await bookCost(
      d1,
      { userId: "u2", feature: "speech.stt", usd: 4 },
      new Date("2026-11-10T15:40:00Z"),
    );
    paid("read.gloss:u1:x", 6_000_000, "2026-11-10T15:10:00.000Z");
    paid("read.gloss:u1:y", 6_000_000, "2026-11-08T00:00:00.000Z"); // outside the hours

    const days = await costDayMatrix(d1, { from: "2026-11-10", to: "2026-11-11" });
    expect(days.rows.map((r) => [r.bucket, r.total.freeMicro])).toEqual([
      ["2026-11-10", 1e6],
      ["2026-11-11", 6e6],
    ]);
    expect(days.rows[1].cells["read.gloss"].paidCredits).toBe(6);

    const range = { from: "2026-11-01", to: "2026-11-11" };
    const hours = await costHourMatrix(d1, hourWindow(48, range, NOW));
    const by = Object.fromEntries(hours.rows.map((r) => [r.bucket, r]));
    expect(by["2026-11-10T23"].total.freeMicro).toBe(1e6);
    expect(by["2026-11-11T00"].cells["words.tts"].freeMicro).toBe(2e6);
    expect(by["2026-11-11T00"].cells["speech.stt"].freeMicro).toBe(4e6);
    expect(by["2026-11-11T00"].cells["read.gloss"].paidCredits).toBe(6);
    expect(hours.totals.paidCredits).toBe(6);
    expect(hours.window).toEqual({ hours: 48, from: "2026-11-09T11", to: "2026-11-11T10" });
  });

  it("the API serves both views to an admin, 404 to anyone else", async () => {
    const days = await costsGet(
      new Request("https://x/api/dev/costs?from=2026-11-10&to=2026-11-11&view=days"),
      true,
      d1,
      NOW,
    );
    expect(days.status).toBe(200);
    expect(((await days.json()) as { rows: unknown[] }).rows).toHaveLength(2);
    const hours = await costsGet(
      new Request("https://x/api/dev/costs?view=hours&hours=9999"),
      true,
      d1,
      NOW,
    );
    expect(((await hours.json()) as { rows: unknown[] }).rows).toHaveLength(COSTS_MAX_HOURS);
    for (const view of ["days", "hours"]) {
      const r = await costsGet(new Request(`https://x/api/dev/costs?view=${view}`), false, d1, NOW);
      expect(r.status).toBe(404);
    }
  });
});

describe("heat scale", () => {
  it("levels rise with the value; 0 only for nothing", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(0.0001, 100)).toBe(1);
    expect(heatLevel(100, 100)).toBe(HEAT_LEVELS.length - 1);
    expect(heatLevel(5, 0)).toBe(0);
  });

  it("every level's text is AA (4.5:1) on its cell, light and dark", () => {
    for (const lv of HEAT_LEVELS.slice(1)) {
      for (const [bg, fg] of [
        [lv.light, lv.lightText],
        [lv.dark, lv.darkText],
      ]) {
        expect(contrast(oklchToHex(bg)!, oklchToHex(fg)!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("heat cell variables", () => {
  it("maps a level to its light and dark colours", () => {
    const top = HEAT_LEVELS[HEAT_LEVELS.length - 1];
    expect(heatVars(HEAT_LEVELS.length - 1)).toEqual({
      "--heat-l": top.light,
      "--heat-lt": top.lightText,
      "--heat-d": top.dark,
      "--heat-dt": top.darkText,
    });
  });
  it("falls back to level 0 for an unknown level", () => {
    expect(heatVars(99)).toEqual(heatVars(0));
    expect(heatVars(0)["--heat-l"]).toBe("transparent");
  });
});
