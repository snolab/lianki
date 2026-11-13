import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { CONFIG } from "@/lib/config";
import { FLAGS } from "@/lib/flags";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import {
  STREAK_DEFAULTS,
  currentStreak,
  cycleStep,
  daysBetween,
  nextStreak,
  parseUsdByDay,
  stepCredits,
  streakDayOf,
  streakRefId,
  streakStepOf,
  usdToCredits,
} from "@/lib/payments/login-streak";
import { loginStreakView, recordLoginStreak } from "@/lib/payments/login-streak-store";
import { getBalance, ledger, type D1WithBatch } from "@/lib/payments/credits-store";

/**
 * Login-streak bonus (docs/payments.md, "Login-streak bonus"): credits for
 * consecutive days of real learning, a 7-day cycle, a missed day costs
 * `missCostDays` (never a full reset), once per local day, idempotent.
 */
const NOW = new Date("2026-11-14T03:00:00Z");
const C = STREAK_DEFAULTS;
const cr = (step: number) => stepCredits(step, C);

function setup() {
  const d1 = createTestD1(testSchema());
  const db = d1 as unknown as D1WithBatch;
  const addUser = (id: string) =>
    d1
      .raw()
      .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
      .run(id, `${id}@example.test`, NOW.toISOString(), NOW.toISOString());
  const rows = () =>
    (d1.raw().prepare("SELECT COUNT(*) AS n FROM credit_ledger").get() as { n: number }).n;
  return { d1, db, addUser, rows };
}

describe("config and flag", () => {
  test("defaults: 7 steps summing to $0.50, a miss costs 2 days, the flag is on for everyone", () => {
    expect(C.usdByDay).toHaveLength(7);
    expect(C.usdByDay.reduce((s, n) => s + n, 0)).toBeCloseTo(0.5, 6);
    expect(C.missCostDays).toBe(2);
    expect(CONFIG["credits.loginStreak.usdByDay"].money).toBe(true);
    expect(CONFIG["credits.loginStreak.missCostDays"].money).toBe(true);
    expect(FLAGS["credits.login-streak"].default).toBe(true);
    expect("audience" in FLAGS["credits.login-streak"]).toBe(false);
  });
  test("the text key parses; a bad entry reads as 0; empty reads as one free step", () => {
    expect(parseUsdByDay(" 0.1, 0.2 ,0.3 ")).toEqual([0.1, 0.2, 0.3]);
    expect(parseUsdByDay("0.1,x,-1")).toEqual([0.1, 0, 0]);
    expect(parseUsdByDay("")).toEqual([0]);
    const schema = CONFIG["credits.loginStreak.usdByDay"].schema;
    expect(schema.safeParse("0.02,0.02,0.05").success).toBe(true);
    expect(schema.safeParse("0.02;0.02").success).toBe(false);
    expect(schema.safeParse("11").success).toBe(false);
  });
  test("USD → whole credits", () => {
    expect(usdToCredits(1)).toBe(CREDITS_PER_USD);
    expect(usdToCredits(0.05)).toBe(Math.round(0.05 * CREDITS_PER_USD));
    expect(usdToCredits(0)).toBe(0);
    expect(usdToCredits(-1)).toBe(0);
    expect(cr(7)).toBe(Math.round(0.2 * CREDITS_PER_USD));
  });
  test("refId and note carry the day and the step", () => {
    expect(streakRefId("u1", "2026-11-14")).toBe("streak:u1:2026-11-14");
    expect(streakDayOf("streak:u1:2026-11-14")).toBe("2026-11-14");
    expect(streakDayOf("agebonus:d1:u1")).toBeNull();
    expect(streakStepOf("login streak day 3 (10)")).toBe(3);
    expect(streakStepOf("age bonus d1")).toBeNull();
  });
});

describe("the rule", () => {
  test("days between local dates, across months and leap days", () => {
    expect(daysBetween("2026-11-13", "2026-11-14")).toBe(1);
    expect(daysBetween("2026-10-31", "2026-11-01")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-11-14", "2026-11-13")).toBe(-1);
    expect(daysBetween("nope", "2026-11-13")).toBeNaN();
  });
  test("first day: streak 1, step 1", () => {
    expect(nextStreak(null, "2026-11-14", C)).toEqual({
      streak: 1,
      step: 1,
      credits: cr(1),
      missed: 0,
    });
  });
  test("consecutive days climb; the 7-day cycle repeats from step 1", () => {
    let s = nextStreak(null, "2026-11-01", C)!;
    for (let d = 2; d <= 9; d++) {
      s = nextStreak(
        { day: `2026-11-0${d - 1}`.slice(0, 10), streak: s.streak },
        `2026-11-${String(d).padStart(2, "0")}`,
        C,
      )!;
    }
    expect(s.streak).toBe(9);
    expect(s.step).toBe(2);
    expect(cycleStep(7, C)).toBe(7);
    expect(cycleStep(8, C)).toBe(1);
    expect(cycleStep(14, C)).toBe(7);
    expect(cycleStep(15, C)).toBe(1);
  });
  test("a missed day costs missCostDays, never a full reset", () => {
    // 7 days, skip one: 7 − 2 + 1 = 6 → step 6.
    expect(nextStreak({ day: "2026-11-07", streak: 7 }, "2026-11-09", C)).toEqual({
      streak: 6,
      step: 6,
      credits: cr(6),
      missed: 1,
    });
    // Two missed days: 7 − 4 + 1 = 4.
    expect(nextStreak({ day: "2026-11-07", streak: 7 }, "2026-11-10", C)!.streak).toBe(4);
    // A long gap floors at 0, then today counts as day 1.
    expect(nextStreak({ day: "2026-10-01", streak: 7 }, "2026-11-10", C)!.streak).toBe(1);
  });
  test("the miss rule follows config: free misses, or a de-facto reset", () => {
    const free = { ...C, missCostDays: 0 };
    expect(nextStreak({ day: "2026-11-01", streak: 5 }, "2026-11-10", free)!.streak).toBe(6);
    const reset = { ...C, missCostDays: 1000 };
    expect(nextStreak({ day: "2026-11-07", streak: 300 }, "2026-11-09", reset)!.streak).toBe(1);
  });
  test("the same day, an earlier day or an unreadable day does nothing", () => {
    expect(nextStreak({ day: "2026-11-14", streak: 3 }, "2026-11-14", C)).toBeNull();
    expect(nextStreak({ day: "2026-11-14", streak: 3 }, "2026-11-13", C)).toBeNull();
    expect(nextStreak(null, "yesterday", C)).toBeNull();
  });
  test("a zero-amount step pays nothing but still counts", () => {
    const conf = { ...C, usdByDay: [0, 0.1] };
    expect(nextStreak(null, "2026-11-14", conf)).toEqual({
      streak: 1,
      step: 1,
      credits: 0,
      missed: 0,
    });
  });
  test("the streak held today: unchanged while yesterday counted, decayed after a gap", () => {
    expect(currentStreak(null, "2026-11-14", C)).toBe(0);
    expect(currentStreak({ day: "2026-11-14", streak: 4 }, "2026-11-14", C)).toBe(4);
    expect(currentStreak({ day: "2026-11-13", streak: 4 }, "2026-11-14", C)).toBe(4);
    expect(currentStreak({ day: "2026-11-11", streak: 4 }, "2026-11-14", C)).toBe(0);
    expect(currentStreak({ day: "2026-11-12", streak: 7 }, "2026-11-14", C)).toBe(5);
  });
});

describe("recordLoginStreak (D1)", () => {
  test("day 1 pays step 1 once; the same day again pays nothing", async () => {
    const { db, addUser, rows } = setup();
    addUser("u");
    expect(await recordLoginStreak(db, "u", "2026-11-14", "Asia/Tokyo", NOW, C)).toEqual({
      streak: 1,
      step: 1,
      credits: cr(1),
      missed: 0,
    });
    expect(await recordLoginStreak(db, "u", "2026-11-14", "Asia/Tokyo", NOW, C)).toEqual({
      streak: 0,
      step: 0,
      credits: 0,
      missed: 0,
    });
    expect(rows()).toBe(1);
    expect(await getBalance(db, "u")).toBe(cr(1));
    const [e] = await ledger(db, "u");
    expect([e!.reason, e!.refId, e!.note]).toEqual([
      "gift",
      "streak:u:2026-11-14",
      "login streak day 1 (1)",
    ]);
  });
  test("seven days in a row pay the whole cycle; day 8 is step 1 again", async () => {
    const { db, addUser } = setup();
    addUser("u");
    let total = 0;
    for (let d = 1; d <= 8; d++) {
      const r = await recordLoginStreak(
        db,
        "u",
        `2026-11-${String(d).padStart(2, "0")}`,
        "Asia/Tokyo",
        NOW,
        C,
      );
      expect(r.streak).toBe(d);
      expect(r.step).toBe(((d - 1) % 7) + 1);
      total += r.credits;
    }
    expect(total).toBe(C.usdByDay.reduce((s, usd) => s + usdToCredits(usd), 0) + cr(1));
    expect(await getBalance(db, "u")).toBe(total);
  });
  test("a missed day drops two steps and goes on", async () => {
    const { db, addUser } = setup();
    addUser("u");
    for (let d = 1; d <= 7; d++)
      await recordLoginStreak(db, "u", `2026-11-0${d}`, "Asia/Tokyo", NOW, C);
    const r = await recordLoginStreak(db, "u", "2026-11-09", "Asia/Tokyo", NOW, C);
    expect(r).toEqual({ streak: 6, step: 6, credits: cr(6), missed: 1 });
  });
  test("concurrent first reviews of a day pay once and agree on the streak", async () => {
    const { db, addUser, rows } = setup();
    addUser("u");
    await recordLoginStreak(db, "u", "2026-11-13", "Asia/Tokyo", NOW, C);
    const rs = await Promise.all(
      [1, 2, 3].map(() => recordLoginStreak(db, "u", "2026-11-14", "Asia/Tokyo", NOW, C)),
    );
    expect(rs.reduce((s, r) => s + r.credits, 0)).toBe(cr(2));
    expect(rows()).toBe(2);
    expect(await getBalance(db, "u")).toBe(cr(1) + cr(2));
    expect((await loginStreakView(db, "u", "2026-11-14", C)).days).toBe(2);
  });
  test("an earlier day arriving late changes nothing", async () => {
    const { db, addUser, rows } = setup();
    addUser("u");
    await recordLoginStreak(db, "u", "2026-11-14", "Asia/Tokyo", NOW, C);
    expect((await recordLoginStreak(db, "u", "2026-11-13", "Asia/Tokyo", NOW, C)).credits).toBe(0);
    expect(rows()).toBe(1);
    expect((await loginStreakView(db, "u", "2026-11-14", C)).days).toBe(1);
  });
  test("a zero-amount step writes the streak but no ledger row", async () => {
    const { db, addUser, rows } = setup();
    addUser("u");
    const conf = { ...C, usdByDay: [0, 0.1] };
    expect((await recordLoginStreak(db, "u", "2026-11-14", "UTC", NOW, conf)).streak).toBe(1);
    expect(rows()).toBe(0);
    expect((await recordLoginStreak(db, "u", "2026-11-15", "UTC", NOW, conf)).credits).toBe(
      usdToCredits(0.1),
    );
  });
  test("adds to an existing balance", async () => {
    const { d1, db, addUser } = setup();
    addUser("u");
    d1.raw()
      .prepare("INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u', 500, ?)")
      .run(NOW.toISOString());
    await recordLoginStreak(db, "u", "2026-11-14", "UTC", NOW, C);
    expect(await getBalance(db, "u")).toBe(500 + cr(1));
  });
  test("unknown user: nothing written", async () => {
    const { db, rows } = setup();
    expect(await recordLoginStreak(db, "ghost", "2026-11-14", "UTC", NOW, C)).toEqual({
      streak: 0,
      step: 0,
      credits: 0,
      missed: 0,
    });
    expect(rows()).toBe(0);
  });
});

describe("loginStreakView (the wallet line)", () => {
  test("nothing yet: 0 days, today open, step 1's credits ahead", async () => {
    const { db, addUser } = setup();
    addUser("u");
    expect(await loginStreakView(db, "u", "2026-11-14", C)).toEqual({
      days: 0,
      today: false,
      credits: cr(1),
      step: 1,
      cycle: 7,
    });
  });
  test("today counted: the streak and what it paid", async () => {
    const { db, addUser } = setup();
    addUser("u");
    await recordLoginStreak(db, "u", "2026-11-13", "UTC", NOW, C);
    await recordLoginStreak(db, "u", "2026-11-14", "UTC", NOW, C);
    expect(await loginStreakView(db, "u", "2026-11-14", C)).toEqual({
      days: 2,
      today: true,
      credits: cr(2),
      step: 2,
      cycle: 7,
    });
  });
  test("yesterday counted: the streak held, today's step ahead", async () => {
    const { db, addUser } = setup();
    addUser("u");
    await recordLoginStreak(db, "u", "2026-11-13", "UTC", NOW, C);
    expect(await loginStreakView(db, "u", "2026-11-14", C)).toMatchObject({
      days: 1,
      today: false,
      credits: cr(2),
      step: 2,
    });
  });
  test("after a gap: what the miss rule leaves, and the step the next day lands on", async () => {
    const { db, addUser } = setup();
    addUser("u");
    for (let d = 1; d <= 7; d++) await recordLoginStreak(db, "u", `2026-11-0${d}`, "UTC", NOW, C);
    expect(await loginStreakView(db, "u", "2026-11-09", C)).toMatchObject({
      days: 5,
      today: false,
      credits: cr(6),
      step: 6,
    });
  });
});
