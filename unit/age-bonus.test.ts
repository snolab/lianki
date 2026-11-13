import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { CONFIG } from "@/lib/config";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import {
  AGE_BONUS_DEFAULTS,
  ageBonusRefId,
  ageBonusTier,
  createdAtMs,
  tiersOwed,
  usdToCredits,
} from "@/lib/payments/age-bonus";
import { applyAgeBonus, grantAgeBonus, previewAgeBonus } from "@/lib/payments/age-bonus-store";
import { handleAgeBonus } from "@/lib/payments/age-bonus-api";
import { getBalance, ledger, type D1WithBatch } from "@/lib/payments/credits-store";

/**
 * Account-age bonus (docs/payments.md, "Account-age bonus"): $1 at 1 day, $2
 * more at 7 days, each once per account, through the credit ledger.
 */
const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-11-14T00:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();
const C = AGE_BONUS_DEFAULTS;
const D1_CREDITS = 1 * CREDITS_PER_USD;
const D7_CREDITS = 2 * CREDITS_PER_USD;

function setup() {
  const d1 = createTestD1(testSchema());
  const db = d1 as unknown as D1WithBatch;
  const addUser = (id: string, createdAt: string) =>
    d1
      .raw()
      .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
      .run(id, `${id}@example.test`, createdAt, createdAt);
  const rows = () =>
    (
      d1.raw().prepare("SELECT COUNT(*) AS n FROM credit_ledger").get() as {
        n: number;
      }
    ).n;
  return { d1, db, addUser, rows };
}

describe("tier decision", () => {
  const tiers = (h: number, granted: ("d1" | "d7")[] = []) =>
    tiersOwed(ago(h), NOW, C, granted).map((t) => t.tier);

  test("0h and 23h owe nothing", () => {
    expect(tiers(0)).toEqual([]);
    expect(tiers(23)).toEqual([]);
    expect(tiers(23.99)).toEqual([]);
  });
  test("24h owes the 1-day tier", () => {
    expect(tiers(24)).toEqual(["d1"]);
  });
  test("6 days still only the 1-day tier", () => {
    expect(tiers(6 * 24)).toEqual(["d1"]);
    expect(tiers(167)).toEqual(["d1"]);
  });
  test("7 days owes both", () => {
    expect(tiers(7 * 24)).toEqual(["d1", "d7"]);
  });
  test("already granted tiers are not owed again", () => {
    expect(tiers(7 * 24, ["d1"])).toEqual(["d7"]);
    expect(tiers(7 * 24, ["d1", "d7"])).toEqual([]);
    expect(tiers(30, ["d1"])).toEqual([]);
  });
  test("a zero amount owes nothing; unreadable createdAt owes nothing", () => {
    expect(tiersOwed(ago(200), NOW, { ...C, day7Usd: 0 }, []).map((t) => t.tier)).toEqual(["d1"]);
    expect(tiersOwed("not a date", NOW, C)).toEqual([]);
    expect(tiersOwed(null, NOW, C)).toEqual([]);
  });
  test("ages follow config", () => {
    expect(tiersOwed(ago(2), NOW, { ...C, day1Hours: 1 }).map((t) => t.tier)).toEqual(["d1"]);
  });
  test("createdAt as ISO text or epoch ms", () => {
    expect(createdAtMs(ago(5))).toBe(NOW.getTime() - 5 * HOUR);
    expect(createdAtMs(NOW.getTime())).toBe(NOW.getTime());
    expect(createdAtMs(String(NOW.getTime()))).toBe(NOW.getTime());
  });
});

describe("conversion", () => {
  test("USD → whole credits via CREDITS_PER_USD", () => {
    expect(usdToCredits(1)).toBe(CREDITS_PER_USD);
    expect(usdToCredits(2)).toBe(2 * CREDITS_PER_USD);
    expect(usdToCredits(0.333)).toBe(Math.round(0.333 * CREDITS_PER_USD));
    expect(Number.isInteger(usdToCredits(0.333))).toBe(true);
    expect(usdToCredits(0)).toBe(0);
    expect(usdToCredits(-1)).toBe(0);
  });
  test("config defaults are $1 / $2 at 24h / 168h", () => {
    expect(CONFIG["credits.ageBonus.day1Usd"].default).toBe(C.day1Usd);
    expect(CONFIG["credits.ageBonus.day7Usd"].default).toBe(C.day7Usd);
    expect(CONFIG["credits.ageBonus.day1Hours"].default).toBe(C.day1Hours);
    expect(CONFIG["credits.ageBonus.day7Hours"].default).toBe(C.day7Hours);
  });
  test("refId and its tier", () => {
    expect(ageBonusRefId("d1", "u1")).toBe("agebonus:d1:u1");
    expect(ageBonusTier("agebonus:d7:u1")).toBe("d7");
    expect(ageBonusTier("CODE:u1")).toBeNull();
  });
});

describe("grantAgeBonus (sign-in / wallet read)", () => {
  test("young account: nothing", async () => {
    const { db, addUser, rows } = setup();
    addUser("u", ago(3));
    expect(await grantAgeBonus(db, "u", NOW, C)).toEqual({ granted: [], credits: 0 });
    expect(rows()).toBe(0);
  });
  test("day 1, then day 7, each once", async () => {
    const { db, addUser } = setup();
    addUser("u", ago(30));
    expect(await grantAgeBonus(db, "u", NOW, C)).toEqual({ granted: ["d1"], credits: D1_CREDITS });
    expect(await grantAgeBonus(db, "u", NOW, C)).toEqual({ granted: [], credits: 0 });
    const later = new Date(NOW.getTime() + 7 * 24 * HOUR);
    expect(await grantAgeBonus(db, "u", later, C)).toEqual({
      granted: ["d7"],
      credits: D7_CREDITS,
    });
    expect(await getBalance(db, "u")).toBe(D1_CREDITS + D7_CREDITS);
    const entries = await ledger(db, "u");
    expect(entries.map((e) => [e.reason, e.refId]).sort()).toEqual([
      ["gift", "agebonus:d1:u"],
      ["gift", "agebonus:d7:u"],
    ]);
  });
  test("concurrent grants give once", async () => {
    const { db, addUser } = setup();
    addUser("u", ago(200));
    const rs = await Promise.all([1, 2, 3].map(() => grantAgeBonus(db, "u", NOW, C)));
    expect(rs.reduce((s, r) => s + r.credits, 0)).toBe(D1_CREDITS + D7_CREDITS);
    expect(await getBalance(db, "u")).toBe(D1_CREDITS + D7_CREDITS);
  });
  test("adds to an existing balance", async () => {
    const { d1, db, addUser } = setup();
    addUser("u", ago(30));
    d1.raw()
      .prepare("INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u', 500, ?)")
      .run(NOW.toISOString());
    await grantAgeBonus(db, "u", NOW, C);
    expect(await getBalance(db, "u")).toBe(500 + D1_CREDITS);
  });
  test("unknown user: nothing", async () => {
    const { db } = setup();
    expect((await grantAgeBonus(db, "ghost", NOW, C)).granted).toEqual([]);
  });
});

describe("backfill", () => {
  function seeded() {
    const s = setup();
    s.addUser("new", ago(2));
    s.addUser("day2", ago(48));
    s.addUser("week", ago(24 * 10));
    s.addUser("old", ago(24 * 400));
    return s;
  }

  test("preview counts and writes nothing", async () => {
    const { db, rows } = seeded();
    expect(await previewAgeBonus(db, NOW, C)).toEqual({
      usersD1: 3,
      usersD7: 2,
      users: 3,
      credits: 3 * D1_CREDITS + 2 * D7_CREDITS,
    });
    expect(rows()).toBe(0);
  });
  test("apply grants once; a second apply grants nothing", async () => {
    const { db, rows } = seeded();
    const first = await applyAgeBonus(db, NOW, C, 2);
    expect(first).toEqual({
      usersD1: 3,
      usersD7: 2,
      users: 3,
      credits: 3 * D1_CREDITS + 2 * D7_CREDITS,
      failed: 0,
    });
    expect(rows()).toBe(5);
    const second = await applyAgeBonus(db, NOW, C, 2);
    expect(second).toEqual({ usersD1: 0, usersD7: 0, users: 0, credits: 0, failed: 0 });
    expect(rows()).toBe(5);
    expect(await getBalance(db, "week")).toBe(D1_CREDITS + D7_CREDITS);
    expect(await getBalance(db, "day2")).toBe(D1_CREDITS);
    expect(await getBalance(db, "new")).toBe(0);
    expect((await previewAgeBonus(db, NOW, C)).users).toBe(0);
  });
  test("a tier granted on sign-in is skipped by the backfill", async () => {
    const { db } = seeded();
    await grantAgeBonus(db, "week", NOW, C);
    const r = await applyAgeBonus(db, NOW, C);
    expect(r.usersD1).toBe(2);
    expect(r.usersD7).toBe(1);
    expect(await getBalance(db, "week")).toBe(D1_CREDITS + D7_CREDITS);
  });
});

describe("POST /api/dev/credits/age-bonus", () => {
  const req = (action: string) =>
    new Request("https://lianki.test/api/dev/credits/age-bonus", {
      method: "POST",
      body: JSON.stringify({ action }),
    });

  test("non-admin gets 404 and nothing is written", async () => {
    const { db, addUser, rows } = setup();
    addUser("u", ago(200));
    const r = await handleAgeBonus(req("apply"), {
      admin: async () => null,
      db: () => db,
      conf: C,
      now: () => NOW,
    });
    expect(r.status).toBe(404);
    expect(rows()).toBe(0);
  });
  test("not on D1: 404", async () => {
    const r = await handleAgeBonus(req("preview"), {
      admin: async () => "admin@example.test",
      db: () => null,
      conf: C,
    });
    expect(r.status).toBe(404);
  });
  test("admin: preview writes nothing, apply grants, bad action 400", async () => {
    const { db, addUser, rows } = setup();
    addUser("u", ago(200));
    const deps = {
      admin: async () => "admin@example.test",
      db: () => db,
      conf: C,
      now: () => NOW,
    };
    const p = await handleAgeBonus(req("preview"), deps);
    expect(p.status).toBe(200);
    expect(((await p.json()) as { users: number }).users).toBe(1);
    expect(rows()).toBe(0);
    const a = await handleAgeBonus(req("apply"), deps);
    expect(((await a.json()) as { credits: number }).credits).toBe(D1_CREDITS + D7_CREDITS);
    expect(rows()).toBe(2);
    expect((await handleAgeBonus(req("nope"), deps)).status).toBe(400);
  });
});
