import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import {
  HUMAN_REACTION_MS,
  capDays,
  levelFor,
  localDay,
  paidSince,
  qualifies,
  recentStudyDays,
  recordStudy,
  recordStudySafe,
  requestTimeZone,
  studyDaysSince,
  userLevel,
  userLevelOf,
  type StudyDayHooks,
} from "@/lib/study-days";
import { STREAK_DEFAULTS, stepCredits } from "@/lib/payments/login-streak";
import { recordLoginStreak } from "@/lib/payments/login-streak-store";
import { getBalance, type D1WithBatch } from "@/lib/payments/credits-store";

const DAY = 86_400_000;
const T0 = new Date("2026-01-01T03:00:00Z"); // first paid day, 12:00 JST

async function seed() {
  const d1 = createTestD1(testSchema()) as unknown as D1Like;
  await d1.exec(`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, proEndsAt)
      VALUES ('u1', 'Ann', 'ann@x.com', 1, '2025-01-01', '2025-01-01', '2099-01-01T00:00:00Z'),
             ('u2', 'Bob', 'bob@x.com', 1, '2025-01-01', '2025-01-01', NULL);
    INSERT INTO payment (id, userId, passId, days, amount, currency, proEndsAt, createdAt, testMode)
      VALUES ('p-test', 'u1', 'pass', 30, 500, 'jpy', '2025-12-01', '2025-06-01T00:00:00Z', 1),
             ('p1', 'u1', 'pass', 365, 5000, 'jpy', '2027-01-01', '${T0.toISOString()}', 0);
  `);
  return d1;
}

/** Record one qualifying review `days` after T0 (+ `h` hours), server clock. */
const study = (d1: D1Like, days: number, h = 0, tz = "Asia/Tokyo", email = "ann@x.com") =>
  recordStudy(d1, email, 1, new Date(T0.getTime() + days * DAY + h * 3_600_000), tz);

describe("what counts as a read", () => {
  test("on screen at least human reaction time; unmeasured does not count", () => {
    expect(qualifies(HUMAN_REACTION_MS)).toBe(true);
    expect(qualifies(4200)).toBe(true);
    expect(qualifies(HUMAN_REACTION_MS - 1)).toBe(false);
    expect(qualifies(80)).toBe(false); // a mass tap
    expect(qualifies(null)).toBe(false);
    expect(qualifies(undefined)).toBe(false);
  });

  test("the day is local to the zone, UTC when the zone is unknown or bogus", () => {
    const at = new Date("2026-03-01T20:00:00Z");
    expect(localDay(at, "Asia/Tokyo")).toEqual({ day: "2026-03-02", tz: "Asia/Tokyo" });
    expect(localDay(at, "America/New_York").day).toBe("2026-03-01");
    expect(localDay(at, undefined)).toEqual({ day: "2026-03-01", tz: "UTC" });
    expect(localDay(at, "Not/AZone")).toEqual({ day: "2026-03-01", tz: "UTC" });
  });
});

describe("study days", () => {
  test("many reviews in one day are one day", async () => {
    const d1 = await seed();
    for (let i = 0; i < 50; i++)
      await recordStudy(d1, "ann@x.com", 3, new Date(T0.getTime() + i * 60_000), "Asia/Tokyo");
    expect(await studyDaysSince(d1, "ann@x.com", T0, new Date(T0.getTime() + 10 * DAY))).toBe(1);
    const [row] = await recentStudyDays(d1, "ann@x.com");
    expect(row).toMatchObject({ day: "2026-01-01", tz: "Asia/Tokyo", reviews: 150 });
    expect(row.first_at).toBe(T0.toISOString());
  });

  test("not a streak: gaps don't reset, each day counts once", async () => {
    const d1 = await seed();
    for (const d of [0, 1, 2, 10, 11, 40]) await study(d1, d);
    expect(await studyDaysSince(d1, "ann@x.com", T0, new Date(T0.getTime() + 41 * DAY))).toBe(6);
  });

  test("0 qualifying reviews (all mass-tapped) record nothing", async () => {
    const d1 = await seed();
    await recordStudy(d1, "ann@x.com", 0, T0, "Asia/Tokyo");
    expect(await recentStudyDays(d1, "ann@x.com")).toEqual([]);
  });

  test("a back-dated client time cannot add a day: only the server clock picks it", async () => {
    // The route passes the server's `now`, never the review's reviewedAt: a
    // device claiming last week still lands on today's single row.
    const d1 = await seed();
    const now = new Date(T0.getTime() + 5 * DAY);
    for (let back = 0; back < 7; back++) await recordStudy(d1, "ann@x.com", 1, now, "Asia/Tokyo");
    expect(await studyDaysSince(d1, "ann@x.com", T0, now)).toBe(1);
  });

  test("days before the first paid day, or after now, do not count", async () => {
    const d1 = await seed();
    await study(d1, -3);
    await study(d1, 0);
    await study(d1, 2);
    expect(await studyDaysSince(d1, "ann@x.com", T0, new Date(T0.getTime() + 1 * DAY))).toBe(1);
  });

  test("never more days than have passed: zone hopping can't double a day", async () => {
    expect(capDays(5, T0, new Date(T0.getTime() + 2 * DAY))).toBe(3);
    expect(capDays(2, T0, new Date(T0.getTime() + 30 * DAY))).toBe(2);
    expect(capDays(4, T0, new Date(T0.getTime() - DAY))).toBe(0);
    const d1 = await seed();
    // Same hour, three zones on both sides of midnight → up to three local days.
    await study(d1, 0, 14, "Pacific/Kiritimati");
    await study(d1, 0, 14, "Asia/Tokyo");
    await study(d1, 0, 14, "Pacific/Pago_Pago");
    expect(await studyDaysSince(d1, "ann@x.com", T0, new Date(T0.getTime() + 15 * 3_600_000))).toBe(
      1,
    );
  });

  test("the home zone cuts every day: hopping zones later splits nothing", async () => {
    const d1 = await seed();
    await study(d1, 0, 0, "Asia/Tokyo"); // home: Tokyo
    // Day 5, 14:30 UTC: 23:30 Tokyo. Claimed from both sides of the date line.
    await study(d1, 5, 11.5, "Pacific/Kiritimati");
    await study(d1, 5, 11.5, "Pacific/Pago_Pago");
    const rows = await recentStudyDays(d1, "ann@x.com");
    expect(rows.map((r) => [r.day, r.tz])).toEqual([
      ["2026-01-06", "Asia/Tokyo"],
      ["2026-01-01", "Asia/Tokyo"],
    ]);
    expect(rows[0].reviews).toBe(2);
  });

  test("tied to the account: another user's days are not counted", async () => {
    const d1 = await seed();
    await study(d1, 0, 0, "Asia/Tokyo", "bob@x.com");
    await study(d1, 1, 0, "Asia/Tokyo", "bob@x.com");
    expect(await studyDaysSince(d1, "ann@x.com", T0, new Date(T0.getTime() + 5 * DAY))).toBe(0);
  });
});

describe("level", () => {
  test("guest, free, paid; then 100 / 365 / 1000 study days", () => {
    expect(levelFor({ signedIn: false, paid: false, studyDays: 999 }).id).toBe("lv1");
    expect(levelFor({ signedIn: true, paid: false, studyDays: 999 }).id).toBe("lv2");
    expect(levelFor({ signedIn: true, paid: true, studyDays: 99 }).id).toBe("lv3");
    expect(levelFor({ signedIn: true, paid: true, studyDays: 100 }).id).toBe("lv4");
    expect(levelFor({ signedIn: true, paid: true, studyDays: 364 }).id).toBe("lv4");
    expect(levelFor({ signedIn: true, paid: true, studyDays: 365 }).id).toBe("lv5");
    expect(levelFor({ signedIn: true, paid: true, studyDays: 1000 }).id).toBe("lv6");
  });

  test("first paid day: the earliest live payment, never a test one", async () => {
    const d1 = await seed();
    expect((await paidSince(d1, "u1"))?.toISOString()).toBe(T0.toISOString());
    expect(await paidSince(d1, "u2")).toBeNull();
  });

  test("from D1: a guest, a free account, a paying learner with 100 days", async () => {
    const d1 = await seed();
    for (let d = 0; d < 100; d++) await study(d1, d);
    const now = new Date(T0.getTime() + 120 * DAY);
    expect((await userLevelOf(d1, null, now)).level).toBe("lv1");
    expect(await userLevelOf(d1, "bob@x.com", now)).toMatchObject({ level: "lv2", tier: "free" });
    expect(await userLevelOf(d1, "Ann@X.com", now)).toEqual({
      level: "lv4",
      tier: "paid",
      paidSince: T0.toISOString(),
      studyDays: 100,
      next: { level: "lv5", studyDays: 365 },
    });
  });

  test("Pro lapsed: back to a free account, the days are kept for later", async () => {
    const d1 = await seed();
    await study(d1, 0);
    const now = new Date(T0.getTime() + 3 * DAY);
    const lapsed = await userLevel(d1, { id: "u1", email: "ann@x.com", proEndsAt: T0 }, now);
    expect(lapsed).toMatchObject({ level: "lv2", tier: "free", studyDays: 1, next: null });
  });
});

describe("recording from a route", () => {
  test("outside a Worker request there is no zone: the day is cut in UTC", async () => {
    expect(requestTimeZone()).toBeUndefined();
    const d1 = await seed();
    await recordStudySafe(d1, "ann@x.com", 2, new Date("2026-03-01T20:00:00Z"));
    await recordStudySafe(d1, null, 2, T0);
    await recordStudySafe(d1, "ann@x.com", 0, T0);
    expect(await recentStudyDays(d1, "ann@x.com")).toMatchObject([
      { day: "2026-03-01", tz: "UTC", reviews: 2 },
    ]);
  });

  test("recordStudy says which write opened the day", async () => {
    const d1 = await seed();
    expect(await recordStudy(d1, "ann@x.com", 1, T0, "Asia/Tokyo")).toEqual({
      day: "2026-01-01",
      tz: "Asia/Tokyo",
      first: true,
    });
    expect(
      await recordStudy(d1, "ann@x.com", 2, new Date(T0.getTime() + 60_000), "Asia/Tokyo"),
    ).toEqual({
      day: "2026-01-01",
      tz: "Asia/Tokyo",
      first: false,
    });
    expect(await recordStudy(d1, "ann@x.com", 0, T0, "Asia/Tokyo")).toBeNull();
  });

  test("the login streak counts on the day's first qualifying action only, and only while its flag is on", async () => {
    const d1 = await seed();
    const calls: string[] = [];
    let on = true;
    const hooks: StudyDayHooks = {
      streakOn: async () => on,
      streak: async (_d1, email, day, tz) => {
        calls.push(`${email} ${day} ${tz}`);
      },
    };
    await recordStudySafe(d1, "ann@x.com", 2, T0, hooks);
    await recordStudySafe(d1, "ann@x.com", 3, new Date(T0.getTime() + 3_600_000), hooks);
    await recordStudySafe(d1, "ann@x.com", 0, new Date(T0.getTime() + DAY), hooks);
    await recordStudySafe(d1, "ann@x.com", 1, new Date(T0.getTime() + DAY), hooks);
    on = false;
    await recordStudySafe(d1, "ann@x.com", 1, new Date(T0.getTime() + 2 * DAY), hooks);
    expect(calls).toEqual(["ann@x.com 2026-01-01 UTC", "ann@x.com 2026-01-02 UTC"]);
    expect(await recentStudyDays(d1, "ann@x.com")).toHaveLength(3);
  });

  test("end to end: the review route's write pays the streak into the wallet, once a day", async () => {
    const d1 = await seed();
    const hooks: StudyDayHooks = {
      streakOn: async () => true,
      streak: async (db, email, day, tz, now) => {
        const u = await db
          .prepare("SELECT id FROM user WHERE lower(email) = lower(?)")
          .bind(email)
          .first<{ id: string }>();
        await recordLoginStreak(db as D1WithBatch, u!.id, day, tz, now, STREAK_DEFAULTS);
      },
    };
    await recordStudySafe(d1, "ann@x.com", 2, T0, hooks);
    await recordStudySafe(d1, "ann@x.com", 2, new Date(T0.getTime() + 1000), hooks);
    await recordStudySafe(d1, "ann@x.com", 2, new Date(T0.getTime() + DAY), hooks);
    const c = (n: number) => stepCredits(n, STREAK_DEFAULTS);
    expect(await getBalance(d1 as D1WithBatch, "u1")).toBe(c(1) + c(2));
  });

  test("a failing streak hook never fails the review either", async () => {
    const d1 = await seed();
    const err = console.error;
    console.error = () => {};
    try {
      await expect(
        recordStudySafe(d1, "ann@x.com", 1, T0, {
          streakOn: async () => true,
          streak: async () => {
            throw new Error("wallet down");
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      console.error = err;
    }
    expect(await recentStudyDays(d1, "ann@x.com")).toHaveLength(1);
  });

  test("a failed write never fails the review it follows", async () => {
    const broken = {
      prepare() {
        throw new Error("D1 down");
      },
    } as unknown as D1Like;
    const err = console.error;
    console.error = () => {};
    try {
      await expect(recordStudySafe(broken, "ann@x.com", 1, T0)).resolves.toBeUndefined();
    } finally {
      console.error = err;
    }
  });
});
