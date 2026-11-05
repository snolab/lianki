import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { partnerReply, type PartnerDb } from "@/lib/partner-ai";
import {
  CHARGE_STALE_MS,
  MAX_OUTPUT_TOKENS,
  PARTNER_AI_FLAG,
  costUsd,
  reserveInTokens,
} from "@/lib/partner-ai-config";
import {
  aiRefId,
  reserveAi,
  reserveCredits,
  settleAi,
  sweepStaleAi,
  usdToMicroCredits,
} from "@/lib/payments/ai-credits";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import { getBalance, ledger, type D1WithBatch } from "@/lib/payments/credits-store";

/** Learning Partner AI replies paid from the credit wallet: reserve first, settle after. */
describe("partner AI: credits", () => {
  let d1: TestD1Database;
  const NOW = Date.parse("2026-11-05T04:00:00Z");
  const db = () => d1 as unknown as D1WithBatch;
  const env = () => ({
    DB: d1 as unknown as PartnerDb,
    OWNER_EMAILS: "owner@x.com",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_AI_TOKEN: "tok",
  });
  const setBalance = (n: number) =>
    d1
      .raw()
      .exec(
        `INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u_alice', ${n}, 'x') ON CONFLICT(userId) DO UPDATE SET balance = ${n}`,
      );
  const carry = () =>
    Number(
      (
        d1.raw().prepare("SELECT micro FROM credit_ai_carry WHERE userId = 'u_alice'").get() as {
          micro: number;
        } | null
      )?.micro ?? 0,
    );
  const rows = () =>
    d1.raw().prepare("SELECT amount, reason, refId FROM credit_ledger ORDER BY rowid").all() as {
      amount: number;
      reason: string;
      refId: string;
    }[];
  beforeEach(() => {
    d1 = createTestD1(testSchema());
    d1.raw().exec(`INSERT INTO user (id, email, createdAt, updatedAt) VALUES
      ('u_alice', 'alice@x.com', 'x', 'x'), ('u_owner', 'owner@x.com', 'x', 'x')`);
    d1.raw().exec(
      `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('${PARTNER_AI_FLAG}', 1, 0, 'owner')`,
    );
  });

  // 8,000 in + 300 out: $0.00276, under half a credit at the current rate.
  const USAGE = { prompt_tokens: 8000, completion_tokens: 300 };
  const REAL = usdToMicroCredits(costUsd(8000, 300));
  const answer = (usage: unknown = USAGE) => ({
    choices: [{ message: { content: "Bonjour!" } }],
    usage,
  });
  const fakeFetch = (calls: { n: number }, body: unknown = answer(), status = 200, wait = 0) =>
    (async () => {
      calls.n++;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const ask = (msgId: string, f: typeof fetch, now = NOW) =>
    partnerReply(
      env(),
      { userId: "u_alice", msgId, history: [{ role: "user", text: "hi" }] },
      { fetch: f, now: () => now },
    );
  // What "hi" reserves: its worst case (every prompt character, every output token).
  const RESERVED = reserveCredits(costUsd(reserveInTokens(2), MAX_OUTPUT_TOKENS));

  it("the conversion lives in one place and rounds up", () => {
    expect(usdToMicroCredits(1)).toBe(CREDITS_PER_USD * 1_000_000);
    expect(usdToMicroCredits(0)).toBe(0);
    expect(reserveCredits(0.000001)).toBe(1);
    expect(RESERVED).toBeGreaterThan(0);
  });

  it("no balance for the worst case: the model is never called, nothing is debited", async () => {
    const calls = { n: 0 };
    expect(await ask("m1", fakeFetch(calls))).toEqual({ ok: false, error: "no-credits" });
    setBalance(RESERVED - 1);
    expect(await ask("m2", fakeFetch(calls))).toEqual({ ok: false, error: "no-credits" });
    expect(calls.n).toBe(0);
    expect(rows()).toEqual([]);
    expect(await getBalance(db(), "u_alice")).toBe(RESERVED - 1);
  });

  it("debits the real cost: whole credits kept as the carry crosses them, the rest refunded", async () => {
    setBalance(100);
    const calls = { n: 0 };
    let charged = 0;
    for (const id of ["a", "b", "c"]) {
      const res = await ask(id, fakeFetch(calls));
      expect(res.ok).toBe(true);
      charged += res.ok ? (res.charged ?? 0) : 0;
    }
    const balance = await getBalance(db(), "u_alice");
    // Every millionth accounted for: what left the balance plus what is carried = 3 replies' cost.
    expect((100 - balance) * 1_000_000 + carry()).toBe(3 * REAL);
    expect(100 - balance).toBe(charged);
    expect(carry()).toBeLessThan(1_000_000);
    // Each reply: one reservation, one refund of what it did not keep, same refId.
    for (const id of ["a", "b", "c"])
      expect(rows().filter((r) => r.refId === aiRefId(`u_alice:${id}`)).length).toBeGreaterThan(0);
    expect(rows().reduce((n, r) => n + r.amount, 0)).toBe(-(100 - balance) + 0);
    // The history shows only replies that kept something, as one row each.
    const shown = await ledger(db(), "u_alice");
    expect(shown.every((e) => e.reason === "ai" && e.amount < 0)).toBe(true);
    expect(shown.reduce((n, e) => n + e.amount, 0)).toBe(-(100 - balance));
  });

  it("a retried line is charged once and answered once", async () => {
    setBalance(100);
    const calls = { n: 0 };
    expect((await ask("same", fakeFetch(calls))).ok).toBe(true);
    expect(await ask("same", fakeFetch(calls))).toEqual({ ok: false, error: "duplicate" });
    expect(calls.n).toBe(1);
    const mine = rows().filter((r) => r.refId === aiRefId("u_alice:same"));
    expect(mine.map((r) => r.reason).sort()).toEqual(["ai", "refund"]);
    // Settling again is a no-op.
    expect(await settleAi(db(), "u_alice:same", 5_000_000)).toBeNull();
    expect((100 - (await getBalance(db(), "u_alice"))) * 1_000_000 + carry()).toBe(REAL);
  });

  it("concurrent replies cannot overdraw: the second finds the credits reserved", async () => {
    setBalance(RESERVED);
    const calls = { n: 0 };
    const [a, b] = await Promise.all([
      ask("x", fakeFetch(calls, answer(), 200, 20)),
      ask("y", fakeFetch(calls, answer(), 200, 20)),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: "no-credits" });
    expect(calls.n).toBe(1);
    expect(await getBalance(db(), "u_alice")).toBeGreaterThanOrEqual(0);
  });

  it("a balance can never go below zero, even reserving by hand", async () => {
    setBalance(1);
    expect(await reserveAi(db(), { userId: "u_alice", key: "u_alice:k", reserved: 2 })).toEqual({
      status: "insufficient",
      balance: 1,
    });
    expect(rows()).toEqual([]);
  });

  it("a failed call is refunded except what Workers AI billed", async () => {
    setBalance(100);
    const calls = { n: 0 };
    // An error status: nothing billed, all back.
    expect(await ask("e1", fakeFetch(calls, { error: "x" }, 500))).toMatchObject({
      ok: false,
      error: "model-failed",
    });
    expect(await getBalance(db(), "u_alice")).toBe(100);
    expect(carry()).toBe(0);
    // A network error: billing unknown and uncounted, all back (logged).
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect((await ask("e2", down)).ok).toBe(false);
    expect(await getBalance(db(), "u_alice")).toBe(100);
    expect(carry()).toBe(0);
    // It answered with usage but no text: that usage is what it billed.
    expect(
      (await ask("e3", fakeFetch(calls, { choices: [{ message: { content: "" } }], usage: USAGE })))
        .ok,
    ).toBe(false);
    expect((100 - (await getBalance(db(), "u_alice"))) * 1_000_000 + carry()).toBe(REAL);
    // No reservation is left pending.
    const pending = d1
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM credit_ai_charge WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it("a reservation left pending by a crash is refunded by the next reply's sweep", async () => {
    setBalance(10);
    const old = new Date(NOW - CHARGE_STALE_MS - 1000);
    expect(
      await reserveAi(db(), { userId: "u_alice", key: "u_alice:crashed", reserved: 3 }, old),
    ).toMatchObject({ status: "reserved", balance: 7 });
    // A fresh pending one is not touched by a sweep.
    expect(await sweepStaleAi(db(), CHARGE_STALE_MS, new Date(old.getTime() + 1000))).toBe(0);
    const calls = { n: 0 };
    expect((await ask("next", fakeFetch(calls))).ok).toBe(true);
    const crashed = rows().filter((r) => r.refId === aiRefId("u_alice:crashed"));
    expect(crashed.map((r) => r.amount).sort()).toEqual([-3, 3]);
    expect((10 - (await getBalance(db(), "u_alice"))) * 1_000_000 + carry()).toBe(REAL);
  });

  it("a sweep or settle that fails leaves the reply answered and the row pending, refunded later", async () => {
    setBalance(10);
    const real = d1;
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            if (
              sql.includes("status = 'pending' AND createdAt <") ||
              sql.startsWith("SELECT userId FROM credit_ai_charge")
            )
              throw new Error("D1 down");
            return target.prepare(sql);
          };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const calls = { n: 0 };
    const res = await partnerReply(
      { ...env(), DB: flaky as unknown as PartnerDb },
      { userId: "u_alice", msgId: "flaky", history: [{ role: "user", text: "hi" }] },
      { fetch: fakeFetch(calls), now: () => NOW },
    );
    expect(res.ok).toBe(true);
    expect(await getBalance(db(), "u_alice")).toBe(10 - RESERVED);
    // The next request, past the stale time, refunds it in full.
    expect((await ask("later", fakeFetch(calls), NOW + CHARGE_STALE_MS + 1000)).ok).toBe(true);
    const flakyRows = rows().filter((r) => r.refId === aiRefId("u_alice:flaky"));
    expect(flakyRows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([-RESERVED, RESERVED]);
  });

  it("an empty answer without usage is refunded in full; a broken study plan is skipped", async () => {
    setBalance(10);
    d1.raw().exec(
      `INSERT INTO roadmap_goals (id, email, topic, nodes, created_at, updated_at) VALUES ('g', 'alice@x.com', 'Plan', 'not json', 'x', 'x')`,
    );
    const calls = { n: 0 };
    expect(await ask("empty", fakeFetch(calls, { choices: [] }))).toMatchObject({
      ok: false,
      error: "model-failed",
      billed: "unknown",
    });
    expect(await getBalance(db(), "u_alice")).toBe(10);
  });

  it("the page text counts toward the worst case", async () => {
    setBalance(100);
    const calls = { n: 0 };
    const screen = "x".repeat(3000);
    const res = await partnerReply(
      env(),
      {
        userId: "u_alice",
        msgId: "page",
        history: [{ role: "user", text: "hi" }],
        page: { path: "/words", screen },
      },
      { fetch: fakeFetch(calls), now: () => NOW },
    );
    expect(res.ok).toBe(true);
    const r = d1
      .raw()
      .prepare("SELECT reserved FROM credit_ai_charge WHERE key = 'u_alice:page'")
      .get() as { reserved: number };
    expect(r.reserved).toBe(
      reserveCredits(costUsd(reserveInTokens(2 + "/words".length + 3000), MAX_OUTPUT_TOKENS)),
    );
  });

  it("the owner is refused before any reservation", async () => {
    setBalance(100);
    const calls = { n: 0 };
    const res = await partnerReply(
      env(),
      { userId: "u_owner", msgId: "o", history: [{ role: "user", text: "hi" }] },
      { fetch: fakeFetch(calls), now: () => NOW },
    );
    expect(res).toEqual({ ok: false, error: "owner" });
    expect(rows()).toEqual([]);
  });
});
