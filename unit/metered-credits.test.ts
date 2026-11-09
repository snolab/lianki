import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { reserveCredits, usdToMicroCredits } from "@/lib/payments/ai-credits";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import { getBalance, type D1WithBatch } from "@/lib/payments/credits-store";
import {
  HOLD_STALE_MS,
  TOP_UP_PATH,
  duplicateResponse,
  metered,
  noCreditsResponse,
  refusal,
} from "@/lib/payments/metered";
import {
  FALLBACK_TEXT_PRICE,
  FEATURES,
  MARGIN,
  aura2Usd,
  melottsUsd,
  speechHoldUsd,
  speechUsd,
  sttUsd,
  textHoldUsd,
  textUsd,
} from "@/lib/payments/prices";
import { walletDb } from "@/lib/payments/wallet-db";
import {
  CREDITS_HEADER,
  installNoCreditsWatch,
  isNoCredits,
} from "@/lib/payments/no-credits-watch";
import { useBackend, useD1 } from "./support/testMocks";

/** Every paid call: hold the most it can cost, run, settle, refund the rest. */
describe("metered: pre-authorisation + refund", () => {
  let d1: TestD1Database;
  const db = () => d1 as unknown as D1WithBatch;
  const NOW = new Date("2026-11-09T12:00:00Z");
  let logs: Record<string, unknown>[];
  const deps = () => ({
    d1: db(),
    now: () => NOW,
    log: (o: Record<string, unknown>) => void logs.push(o),
    admin: (e: string | null | undefined) => e === "admin@x.com",
  });
  const alice = { userId: "u_alice", email: "alice@x.com" };
  const setBalance = (n: number) =>
    d1
      .raw()
      .exec(
        `INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u_alice', ${n}, 'x') ON CONFLICT(userId) DO UPDATE SET balance = ${n}`,
      );
  const rows = () =>
    d1
      .raw()
      .prepare("SELECT amount, reason, refId, note FROM credit_ledger ORDER BY rowid")
      .all() as { amount: number; reason: string; refId: string; note: string | null }[];
  const bal = () => getBalance(db(), "u_alice");

  beforeEach(() => {
    logs = [];
    d1 = createTestD1(testSchema());
    d1.raw().exec(`INSERT INTO user (id, email, createdAt, updatedAt) VALUES
      ('u_alice', 'alice@x.com', 'x', 'x'), ('u_admin', 'admin@x.com', 'x', 'x')`);
  });

  it("holds the most first, then keeps the real cost and refunds the rest (settle lower)", async () => {
    setBalance(10);
    let seen = -1;
    const r = await metered(
      deps(),
      alice,
      { what: "read.gloss", holdUsd: 3 / CREDITS_PER_USD },
      async () => {
        seen = await bal(); // the hold is already taken while the provider works
        return { value: "ok", usd: 2.5 / CREDITS_PER_USD };
      },
    );
    expect(seen).toBe(7);
    expect(r).toEqual({ ok: true, value: "ok", charged: 2 });
    // 2.5 credits: 2 kept, the half carries; 1 back.
    expect(await bal()).toBe(8);
    const [hold, refund] = rows();
    expect(hold).toMatchObject({ amount: -3, reason: "ai", note: "read.gloss" });
    expect(hold.refId).toStartWith("ai:read.gloss:u_alice:");
    expect(refund).toMatchObject({ amount: 1, reason: "refund", refId: hold.refId });
  });

  it("settle equal: the whole hold is kept, nothing refunded", async () => {
    setBalance(5);
    const r = await metered(
      deps(),
      alice,
      { what: "words.tts", holdUsd: 2 / CREDITS_PER_USD },
      async () => ({
        value: 1,
        usd: 2 / CREDITS_PER_USD,
      }),
    );
    expect(r).toMatchObject({ ok: true, charged: 2 });
    expect(await bal()).toBe(3);
    expect(rows().map((x) => x.reason)).toEqual(["ai"]);
  });

  it("the provider fails: a full refund, and the error goes on", async () => {
    setBalance(5);
    const p = metered(
      deps(),
      alice,
      { what: "speech.stt", holdUsd: 1 / CREDITS_PER_USD },
      async () => {
        throw new Error("provider down");
      },
    );
    await expect(p).rejects.toThrow("provider down");
    expect(await bal()).toBe(5);
    expect(rows().map((x) => [x.reason, x.amount])).toEqual([
      ["ai", -1],
      ["refund", 1],
    ]);
  });

  it("not enough for the hold: refused before the provider is called", async () => {
    setBalance(1);
    let called = false;
    const r = await metered(
      deps(),
      alice,
      { what: "read.polish", holdUsd: 5 / CREDITS_PER_USD },
      async () => {
        called = true;
        return { value: 0, usd: 0 };
      },
    );
    expect(called).toBe(false);
    // Too little history: recommended = the hold × one call.
    expect(r).toEqual({ ok: false, reason: "no-credits", balance: 1, need: 5, recommended: 5 });
    expect(await bal()).toBe(1);
    expect(rows()).toEqual([]);
  });

  it("a user with no wallet row (0) is refused; an unknown user too", async () => {
    const run = async () => ({ value: 0, usd: 0 });
    expect(await metered(deps(), alice, { what: "tts", holdUsd: 0.0001 }, run)).toMatchObject({
      reason: "no-credits",
      balance: 0,
    });
    expect(
      await metered(deps(), { userId: "nobody" }, { what: "tts", holdUsd: 0.0001 }, run),
    ).toMatchObject({ reason: "no-credits", balance: 0 });
  });

  it("the same key again is a duplicate: no second call, no second charge (idempotent retry)", async () => {
    setBalance(5);
    let calls = 0;
    const run = async () => (calls++, { value: 0, usd: 1 / CREDITS_PER_USD });
    const call = { what: "ai-sentences" as const, holdUsd: 1 / CREDITS_PER_USD, key: "req-1" };
    expect(await metered(deps(), alice, call, run)).toMatchObject({ ok: true, charged: 1 });
    expect(await metered(deps(), alice, call, run)).toEqual({ ok: false, reason: "duplicate" });
    expect(calls).toBe(1);
    expect(await bal()).toBe(4);
  });

  it("an admin pays nothing: no hold, no ledger row", async () => {
    const r = await metered(
      deps(),
      { userId: "u_admin", email: "admin@x.com" },
      { what: "blog.translate", holdUsd: 1 },
      async () => ({ value: "x", usd: 0.5 }),
    );
    expect(r).toEqual({ ok: true, value: "x", charged: 0, free: "admin" });
    expect(rows()).toEqual([]);
    expect(logs[0]).toMatchObject({ event: "credits.free", why: "admin", what: "blog.translate" });
  });

  it("with no wallet in reach (Mongo backend, local dev) the call runs unmetered and says so", async () => {
    const r = await metered(
      { ...deps(), d1: null },
      alice,
      { what: "tts", holdUsd: 1 },
      async () => ({
        value: 1,
        usd: 0.1,
      }),
    );
    expect(r).toMatchObject({ ok: true, charged: 0, free: "unmetered" });
    expect(logs[0]).toMatchObject({ event: "credits.unmetered", what: "tts" });
  });

  it("the hold is a hard cap: a reported cost above it is logged and settled at the hold", async () => {
    setBalance(10);
    const r = await metered(
      deps(),
      alice,
      { what: "roadmap.generate", holdUsd: 2 / CREDITS_PER_USD },
      async () => ({
        value: 0,
        usd: 9 / CREDITS_PER_USD,
      }),
    );
    expect(r).toMatchObject({ ok: true, charged: 2 });
    expect(await bal()).toBe(8);
    expect(logs.find((l) => l.event === "credits.overage")).toMatchObject({
      what: "roadmap.generate",
    });
  });

  it("a stale hold (a crash mid-call) is released by the user's next paid request", async () => {
    setBalance(5);
    // A hold taken 11 minutes ago that never settled.
    const old = new Date(NOW.getTime() - HOLD_STALE_MS - 60_000);
    const { reserveAi } = await import("@/lib/payments/ai-credits");
    await reserveAi(
      db(),
      { userId: "u_alice", key: "tts:u_alice:crashed", reserved: 3, what: "tts" },
      old,
    );
    expect(await bal()).toBe(2);
    const r = await metered(
      deps(),
      alice,
      { what: "tts", holdUsd: 1 / CREDITS_PER_USD },
      async () => ({
        value: 0,
        usd: 0,
      }),
    );
    expect(r).toMatchObject({ ok: true, charged: 0 });
    expect(await bal()).toBe(5);
  });

  it("N parallel holds on a small balance never take it below zero", async () => {
    setBalance(3);
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        metered(
          deps(),
          alice,
          { what: "read.translate", holdUsd: 1 / CREDITS_PER_USD },
          async () => {
            calls++;
            expect(await bal()).toBeGreaterThanOrEqual(0);
            return { value: 0, usd: 1 / CREDITS_PER_USD };
          },
        ),
      ),
    );
    const ok = results.filter((r) => r.ok).length;
    expect(ok).toBe(3);
    expect(calls).toBe(3);
    expect(results.filter((r) => !r.ok && r.reason === "no-credits")).toHaveLength(7);
    expect(await bal()).toBe(0);
    const min = d1.raw().prepare("SELECT MIN(balance) AS m FROM credit_balance").get() as {
      m: number;
    };
    expect(min.m).toBeGreaterThanOrEqual(0);
  });

  it("the database refuses a negative balance whatever the code does", () => {
    setBalance(1);
    expect(() =>
      d1.raw().exec("UPDATE credit_balance SET balance = balance - 2 WHERE userId = 'u_alice'"),
    ).toThrow(/CHECK/);
  });

  it("refusals answer as the pages expect: 402 with the top-up path, 409 for a retry", async () => {
    const r = noCreditsResponse({ balance: 1, need: 3 });
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({
      error: "no-credits",
      balance: 1,
      have: 1,
      need: 3,
      recommended: 3,
      topUp: TOP_UP_PATH,
    });
    expect(r.headers.get("x-lianki-credits-need")).toBe("3");
    expect(r.headers.get("x-lianki-credits-have")).toBe("1");
    expect(r.headers.get("x-lianki-credits-recommended")).toBe("3");
    const two = noCreditsResponse({ balance: 1, need: 3, recommended: 9 });
    expect(two.headers.get("x-lianki-credits-recommended")).toBe("9");
    expect(duplicateResponse().status).toBe(409);
    expect(refusal({ ok: false, reason: "duplicate" }).status).toBe(409);
    expect(
      refusal({ ok: false, reason: "no-credits", balance: 0, need: 1, recommended: 1 }).status,
    ).toBe(402);
  });

  it("walletDb: D1 when that is the backend, else none", () => {
    useD1(d1);
    useBackend("d1");
    expect(walletDb()).not.toBeNull();
    useBackend("mongodb");
    expect(walletDb()).toBeNull();
    useBackend("d1");
  });
});

describe("prices: one table", () => {
  it("prices text by model, with the margin; an unknown model at the dearest", () => {
    expect(textUsd("@cf/openai/gpt-oss-120b", 1e6, 1e6)).toBeCloseTo((0.35 + 0.75) * MARGIN);
    expect(textUsd("@cf/x/unknown", 1e6, 0)).toBeCloseTo(FALLBACK_TEXT_PRICE.inPerM * MARGIN);
    expect(textUsd("@cf/openai/gpt-oss-120b", -5, -5)).toBe(0);
  });

  it("a hold covers 2 tokens a character, every output token, and images", () => {
    const m = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
    expect(textHoldUsd(m, 1000, 500)).toBeCloseTo(textUsd(m, 2000, 500));
    expect(textHoldUsd(m, 0, 0, 2)).toBeCloseTo(textUsd(m, 8000, 0));
    expect(textHoldUsd(m, -1, 0)).toBe(0);
  });

  it("speech and transcription", () => {
    expect(melottsUsd(60)).toBeCloseTo(0.0002 * MARGIN);
    expect(aura2Usd(1000)).toBeCloseTo(0.03 * MARGIN);
    expect(speechHoldUsd(60)).toBeGreaterThanOrEqual(speechUsd(60));
    expect(speechHoldUsd(100, true)).toBe(speechUsd(100, true));
    expect(sttUsd(120_000)).toBeCloseTo(0.000513 * MARGIN);
    expect(melottsUsd(-1) + sttUsd(-1) + aura2Usd(-1)).toBe(0);
  });

  it("every feature is named once; a tiny cost still holds one whole credit", () => {
    expect(new Set(FEATURES).size).toBe(FEATURES.length);
    expect(reserveCredits(1e-9)).toBe(1);
    expect(usdToMicroCredits(1 / CREDITS_PER_USD)).toBe(1_000_000);
  });
});

describe("the page hears a credit refusal", () => {
  it("runs its listener on a 402 with the header, never otherwise; the Response is unchanged", async () => {
    const answers = [
      noCreditsResponse({ balance: 0, need: 1 }),
      new Response("x", { status: 402 }),
      new Response("ok"),
    ];
    const win = { fetch: async (_i: RequestInfo | URL, _o?: RequestInit) => answers.shift()! };
    let heard = 0;
    const undo = installNoCreditsWatch(win, () => heard++);
    // A second install wraps once.
    let heard2 = 0;
    installNoCreditsWatch(win, () => heard2++);
    const r = await win.fetch("/api/x");
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "no-credits" });
    await win.fetch("/api/y");
    await win.fetch("/api/z");
    expect([heard, heard2]).toEqual([1, 1]);
    undo();
    answers.push(noCreditsResponse({ balance: 0, need: 1 }));
    await win.fetch("/api/x");
    expect([heard, heard2]).toEqual([1, 2]);
    const bare = new Response(null, { status: 402, headers: { [CREDITS_HEADER]: "needed" } });
    expect(isNoCredits(bare)).toBe(true);
  });
});
