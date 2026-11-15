import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins/email-otp";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { CONFIG } from "@/lib/config";
import { FLAGS } from "@/lib/flags";
import { flagOn } from "@/lib/flags-store";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import { getBalance, ledger } from "@/lib/payments/credits-store";
import {
  SIGNUP_BONUS_DEFAULTS,
  isSignupBonus,
  signupBonusCredits,
  signupBonusRefId,
  signupBonusSeqOf,
  utcDay,
} from "@/lib/payments/signup-bonus";
import {
  grantSignupBonus,
  runSignupBonus,
  signupBonusConfig,
  signupBonusHooks,
  type SignupBonusDb,
} from "@/lib/payments/signup-bonus-store";

/**
 * Sign-up bonus (docs/payments.md, "Sign-up bonus"): US$1 once per account,
 * the first 10 new accounts per UTC day; accounts older than the feature get
 * it once on their next sign-in or wallet read, outside the cap.
 */
const LAUNCH = "2026-11-15T04:00:00.000Z";
const NOW = new Date("2026-11-15T05:00:00Z");
const C = SIGNUP_BONUS_DEFAULTS;
const ONE_USD = CREDITS_PER_USD;

function setup() {
  const d1 = createTestD1(testSchema());
  const db = d1 as unknown as SignupBonusDb;
  d1.raw().prepare("UPDATE signup_bonus_launch SET at = ? WHERE id = 1").run(LAUNCH);
  const addUser = (id: string, createdAt: string | number = NOW.toISOString()) =>
    d1
      .raw()
      .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
      .run(id, `${id}@example.test`, createdAt, NOW.toISOString());
  const count = (sql: string) => (d1.raw().prepare(sql).get() as { n: number }).n;
  const bonuses = () =>
    count("SELECT COUNT(*) AS n FROM credit_ledger WHERE refId LIKE 'signup:%'");
  const audits = () =>
    count("SELECT COUNT(*) AS n FROM security_audit WHERE kind = 'credits.signup-bonus'");
  const dayCount = (day: string) =>
    (
      d1.raw().prepare("SELECT granted AS n FROM signup_bonus_day WHERE day = ?").get(day) as
        | { n: number }
        | undefined
    )?.n ?? 0;
  return { d1, db, addUser, bonuses, audits, dayCount };
}

describe("config, flag and rules", () => {
  test("defaults: $1, 10 a day, money keys; the flag is on for everyone", () => {
    expect(C).toEqual({ usd: 1, daily: 10 });
    expect(CONFIG["credits.signupBonusUsd"].money).toBe(true);
    expect(CONFIG["credits.signupBonusDaily"].money).toBe(true);
    expect(CONFIG["credits.signupBonusUsd"].schema.safeParse(0.5).success).toBe(true);
    expect(CONFIG["credits.signupBonusUsd"].schema.safeParse(11).success).toBe(false);
    expect(CONFIG["credits.signupBonusDaily"].schema.safeParse(1.5).success).toBe(false);
    expect(FLAGS["credits.signup-bonus"].default).toBe(true);
    expect("audience" in FLAGS["credits.signup-bonus"]).toBe(false);
  });
  test("refId, UTC day, credits", () => {
    expect(signupBonusRefId("u1")).toBe("signup:u1");
    expect(isSignupBonus("signup:u1")).toBe(true);
    expect(isSignupBonus("signup:")).toBe(false);
    expect(isSignupBonus("streak:u1:2026-11-15")).toBe(false);
    expect(isSignupBonus(null)).toBe(false);
    expect(signupBonusSeqOf("signup bonus 2026-11-15 #7")).toBe(7);
    expect(signupBonusSeqOf("signup bonus (existing account)")).toBeNull();
    // 08:59 JST is still the previous UTC day; 09:00 JST starts a new one.
    expect(utcDay(new Date("2026-11-15T23:59:59.999Z"))).toBe("2026-11-15");
    expect(utcDay(new Date("2026-11-16T00:00:00Z"))).toBe("2026-11-16");
    expect(signupBonusCredits(C)).toBe(ONE_USD);
    expect(signupBonusCredits({ usd: 0, daily: 10 })).toBe(0);
  });
  test("the live config reads the defaults when nothing is stored", async () => {
    expect(await signupBonusConfig()).toEqual(C);
  });
});

describe("new accounts: the daily cap", () => {
  test("the first 10 of a UTC day claim, number 11 gets nothing and no error", async () => {
    const { db, addUser, bonuses, dayCount, audits } = setup();
    for (let i = 1; i <= 11; i++) addUser(`n${i}`);
    for (let i = 1; i <= 10; i++) {
      const r = await grantSignupBonus(db, `n${i}`, "new", C, NOW);
      expect(r).toEqual({ status: "granted", credits: ONE_USD, day: "2026-11-15", seq: i });
      expect(await getBalance(db, `n${i}`)).toBe(ONE_USD);
    }
    expect(await grantSignupBonus(db, "n11", "new", C, NOW)).toEqual({ status: "not eligible" });
    expect(await getBalance(db, "n11")).toBe(0);
    expect(bonuses()).toBe(10);
    expect(dayCount("2026-11-15")).toBe(10);
    expect(audits()).toBe(10);
  });
  test("concurrent sign-ups never overshoot the cap", async () => {
    const { db, addUser, bonuses, dayCount } = setup();
    const ids = Array.from({ length: 25 }, (_, i) => `c${i}`);
    ids.forEach((id) => addUser(id));
    const rs = await Promise.all(ids.map((id) => grantSignupBonus(db, id, "new", C, NOW)));
    expect(rs.filter((r) => r.status === "granted")).toHaveLength(10);
    expect(bonuses()).toBe(10);
    expect(dayCount("2026-11-15")).toBe(10);
    const seqs = rs.flatMap((r) => (r.status === "granted" ? [r.seq] : [])).sort((a, b) => a! - b!);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  test("a new UTC day opens 10 new slots", async () => {
    const { db, addUser, dayCount } = setup();
    for (let i = 0; i < 11; i++) addUser(`a${i}`);
    const late = new Date("2026-11-15T23:59:59Z");
    const next = new Date("2026-11-16T00:00:00Z");
    for (let i = 0; i < 10; i++) await grantSignupBonus(db, `a${i}`, "new", C, late);
    expect((await grantSignupBonus(db, "a10", "new", C, next)).status).toBe("granted");
    expect(dayCount("2026-11-15")).toBe(10);
    expect(dayCount("2026-11-16")).toBe(1);
  });
  test("idempotent per account: a retry pays nothing and takes no slot", async () => {
    const { db, addUser, bonuses, dayCount } = setup();
    addUser("u1");
    expect((await grantSignupBonus(db, "u1", "new", C, NOW)).status).toBe("granted");
    expect(await grantSignupBonus(db, "u1", "new", C, NOW)).toEqual({ status: "already" });
    const both = await Promise.all([
      grantSignupBonus(db, "u1", "new", C, NOW),
      grantSignupBonus(db, "u1", "backfill", C, NOW),
    ]);
    expect(both.every((r) => r.status === "already")).toBe(true);
    expect(bonuses()).toBe(1);
    expect(dayCount("2026-11-15")).toBe(1);
    expect(await getBalance(db, "u1")).toBe(ONE_USD);
  });
  test("a racing duplicate of the same account counts once", async () => {
    const { db, addUser, bonuses, dayCount } = setup();
    addUser("r1");
    const rs = await Promise.all([1, 2, 3].map(() => grantSignupBonus(db, "r1", "new", C, NOW)));
    expect(rs.filter((r) => r.status === "granted")).toHaveLength(1);
    expect(bonuses()).toBe(1);
    expect(dayCount("2026-11-15")).toBe(1);
  });
  test("amount and cap come from the config; 0 grants nothing", async () => {
    const { db, addUser, bonuses } = setup();
    ["x1", "x2", "x3"].forEach((id) => addUser(id));
    const conf = { usd: 0.5, daily: 2 };
    expect(await grantSignupBonus(db, "x1", "new", conf, NOW)).toMatchObject({ credits: 75 });
    expect((await grantSignupBonus(db, "x2", "new", conf, NOW)).status).toBe("granted");
    expect((await grantSignupBonus(db, "x3", "new", conf, NOW)).status).toBe("not eligible");
    expect(await grantSignupBonus(db, "x3", "new", { usd: 0, daily: 10 }, NOW)).toEqual({
      status: "zero",
    });
    expect(await grantSignupBonus(db, "x3", "new", { usd: 1, daily: 0 }, NOW)).toEqual({
      status: "zero",
    });
    expect(bonuses()).toBe(2);
  });
  test("no such user: nothing written, no slot taken", async () => {
    const { db, bonuses, dayCount } = setup();
    expect((await grantSignupBonus(db, "ghost", "new", C, NOW)).status).toBe("not eligible");
    expect(bonuses()).toBe(0);
    expect(dayCount("2026-11-15")).toBe(0);
  });
  test("the ledger row reads as a gift with the sign-up refId", async () => {
    const { db, addUser } = setup();
    addUser("l1");
    await grantSignupBonus(db, "l1", "new", C, NOW);
    const [e] = await ledger(db, "l1");
    expect(e).toMatchObject({
      amount: ONE_USD,
      reason: "gift",
      refId: "signup:l1",
      note: "signup bonus 2026-11-15 #1",
    });
  });
});

describe("existing accounts: the lazy backfill", () => {
  test("an account older than the feature gets it once, outside the cap", async () => {
    const { db, addUser, bonuses, dayCount } = setup();
    addUser("old", "2025-01-01T00:00:00.000Z");
    const conf = { usd: 1, daily: 0 }; // a full cap does not matter here
    expect(await grantSignupBonus(db, "old", "backfill", conf, NOW)).toEqual({
      status: "granted",
      credits: ONE_USD,
      day: "2026-11-15",
      seq: null,
    });
    expect(await grantSignupBonus(db, "old", "backfill", conf, NOW)).toEqual({
      status: "already",
    });
    expect(bonuses()).toBe(1);
    expect(dayCount("2026-11-15")).toBe(0);
    const [e] = await ledger(db, "old");
    expect(e?.note).toBe("signup bonus (existing account)");
  });
  test("an epoch-ms createdAt is read as a time too", async () => {
    const { db, addUser } = setup();
    addUser("oldms", Date.parse("2025-06-01T00:00:00Z"));
    addUser("newms", Date.parse("2026-11-15T04:30:00Z"));
    expect((await grantSignupBonus(db, "oldms", "backfill", C, NOW)).status).toBe("granted");
    expect((await grantSignupBonus(db, "newms", "backfill", C, NOW)).status).toBe("not eligible");
  });
  test("an account made after launch never qualifies, so missing the cap stays missed", async () => {
    const { db, addUser, bonuses } = setup();
    addUser("late"); // NOW, after LAUNCH
    expect(await grantSignupBonus(db, "late", "backfill", C, NOW)).toEqual({
      status: "not eligible",
    });
    expect(bonuses()).toBe(0);
  });
});

describe("the hook entry and the sign-up wiring", () => {
  const on = async () => true;
  const off = async () => false;
  test("flag off: nothing on either path", async () => {
    const { db, addUser, bonuses } = setup();
    addUser("f1");
    addUser("f2", "2025-01-01T00:00:00.000Z");
    expect(await runSignupBonus(db, "f1", "new", { enabled: off })).toEqual({ status: "off" });
    expect(await runSignupBonus(db, "f2", "backfill", { enabled: off })).toEqual({
      status: "off",
    });
    expect(bonuses()).toBe(0);
  });
  test("flag on: live config by default; a failing store is logged, never thrown", async () => {
    const { db, addUser } = setup();
    addUser("h1");
    expect(await runSignupBonus(db, "h1", "new", { enabled: on, now: NOW })).toMatchObject({
      status: "granted",
      credits: ONE_USD,
    });
    const broken = {
      prepare: () => {
        throw new Error("D1 down");
      },
    } as unknown as SignupBonusDb;
    const err = console.error;
    console.error = () => {};
    try {
      expect(await runSignupBonus(broken, "h1", "new", { enabled: on, conf: async () => C })).toBe(
        null,
      );
    } finally {
      console.error = err;
    }
  });
  test("by default the live flag decides", async () => {
    const { db, addUser, bonuses } = setup();
    addUser("d1");
    const live = await flagOn("credits.signup-bonus");
    const r = await runSignupBonus(db, "d1", "new", { now: NOW, conf: async () => C });
    expect(r?.status).toBe(live ? "granted" : "off");
    expect(bonuses()).toBe(live ? 1 : 0);
  });
  test("better-auth: a sign-up claims once; later sign-ins pay nothing more", async () => {
    const { db, d1, bonuses } = setup();
    const hooks = signupBonusHooks(() => db, { enabled: on, now: NOW, conf: async () => C });
    const otps = new Map<string, string>();
    const auth = betterAuth({
      secret: "a-test-secret-a-test-secret-a-test-secret",
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      databaseHooks: {
        user: {
          create: {
            after: async (user: { id: string; email: string }) => {
              // Mirror the account into the test D1, as the D1 adapter would have.
              d1.raw()
                .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
                .run(user.id, user.email, NOW.toISOString(), NOW.toISOString());
              await hooks.userCreated(user);
            },
          },
        },
        session: { create: { after: hooks.sessionCreated } },
      },
      plugins: [
        emailOTP({
          otpLength: 6,
          expiresIn: 900,
          sendVerificationOTP: async ({ email, otp }) => void otps.set(email, otp),
        }),
      ],
    });
    const headers = new Headers();
    const signIn = async (email: string) => {
      await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers });
      return auth.api.signInEmailOTP({ body: { email, otp: otps.get(email)! }, headers });
    };
    const first = await signIn("new@example.test");
    await signIn("new@example.test");
    await signIn("new@example.test");
    expect(bonuses()).toBe(1);
    expect(await getBalance(db, first.user.id)).toBe(ONE_USD);
    // Off D1 the hooks do nothing.
    const none = signupBonusHooks(() => null, { enabled: on });
    await none.userCreated({ id: first.user.id });
    await none.sessionCreated({ userId: first.user.id });
    expect(bonuses()).toBe(1);
  });
});
