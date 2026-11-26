import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { hitRate, partnerTokens, tokenSeries, tokenUsers } from "@/lib/payments/cost-tokens";
import { costsGet } from "@/lib/payments/costs-route";
import { settleAi } from "@/lib/payments/ai-credits";

let d1: TestD1Database;
const NOW = new Date("2026-11-12T01:00:00Z");

beforeEach(() => {
  d1 = createTestD1(testSchema());
  for (const [id, name] of [
    ["u1", "Alice"],
    ["u2", "Bob"],
  ])
    d1.raw().exec(
      `INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES ('${id}', '${name}', '${id}@x.com', 'x', 'x')`,
    );
});

let seq = 0;
const charge = (
  userId: string,
  settledAt: string | null,
  t: { in?: number | null; cached?: number | null; out?: number | null } = {},
) =>
  d1
    .raw()
    .prepare(
      `INSERT INTO credit_ai_charge (key, userId, reserved, status, costMicro, charged, createdAt, settledAt, tokensIn, cachedIn, tokensOut)
       VALUES (?, ?, 1, ?, 10, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${userId}:m${++seq}`,
      userId,
      settledAt ? "settled" : "pending",
      settledAt ?? NOW.toISOString(),
      settledAt,
      t.in === undefined ? 1000 : t.in,
      t.cached === undefined ? 0 : t.cached,
      t.out === undefined ? 100 : t.out,
    );

describe("hitRate", () => {
  it("is null with no input tokens, never a division by zero", () => {
    expect(hitRate(0, 0)).toBeNull();
    expect(hitRate(0, 50)).toBeNull();
    expect(hitRate(-1, 0)).toBeNull();
  });
  it("is cached ÷ input, clamped to 0–1", () => {
    expect(hitRate(1000, 640)).toBeCloseTo(0.64);
    expect(hitRate(1000, 0)).toBe(0);
    expect(hitRate(100, 500)).toBe(1);
    expect(hitRate(100, -5)).toBe(0);
  });
});

describe("tokenSeries", () => {
  it("lists every bucket; an empty one has zeros and a null rate", () => {
    const s = tokenSeries(
      ["2026-11-10", "2026-11-11", "2026-11-12"],
      [
        { b: "2026-11-10", tin: 1000, cin: 250, tout: 80, n: 2 },
        { b: "2026-11-12", tin: 3000, cin: 2750, tout: 120, n: 3 },
        { b: "2026-11-09", tin: 9999, cin: 9999, tout: 9999, n: 9 }, // outside: dropped
      ],
    );
    expect(s.rows.map((r) => r.bucket)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(s.rows[0]).toMatchObject({ tokensIn: 1000, cachedIn: 250, tokensOut: 80, replies: 2 });
    expect(s.rows[0].hitRate).toBeCloseTo(0.25);
    expect(s.rows[1]).toEqual({
      bucket: "2026-11-11",
      tokensIn: 0,
      cachedIn: 0,
      tokensOut: 0,
      replies: 0,
      hitRate: null,
    });
    expect(s.totals).toMatchObject({ tokensIn: 4000, cachedIn: 3000, tokensOut: 200, replies: 5 });
    // The site rate weighs by tokens, not the mean of the days' rates.
    expect(s.totals.hitRate).toBeCloseTo(0.75);
  });
  it("null sums count as 0, and cached never exceeds input", () => {
    const s = tokenSeries(["d"], [{ b: "d", tin: 10, cin: 50, tout: null, n: 1 }]);
    expect(s.totals).toMatchObject({ tokensIn: 10, cachedIn: 10, tokensOut: 0, hitRate: 1 });
    expect(tokenSeries([], []).totals.hitRate).toBeNull();
  });
});

describe("tokenUsers", () => {
  it("sorts by input + output tokens, most first", () => {
    const u = tokenUsers([
      { b: "a", name: "A", tin: 100, cin: 0, tout: 10, n: 1 },
      { b: "b", name: null, tin: 500, cin: 400, tout: 50, n: 4 },
    ]);
    expect(u.map((x) => x.userId)).toEqual(["b", "a"]);
    expect(u[0]).toMatchObject({ name: null, hitRate: 0.8, replies: 4 });
    expect(u[1].hitRate).toBe(0);
  });
});

describe("partnerTokens (D1)", () => {
  beforeEach(() => {
    charge("u1", "2026-11-10T23:30:00Z", { in: 1000, cached: 600, out: 50 });
    charge("u1", "2026-11-11T00:30:00Z", { in: 2000, cached: 1800, out: 70 });
    charge("u2", "2026-11-11T05:00:00Z", { in: 500, cached: 0, out: 30 });
    // Left out: pending, and a row settled before the token columns (NULL).
    charge("u2", null);
    charge("u2", "2026-11-11T06:00:00Z", { in: null, cached: null, out: null });
  });

  it("buckets days in UTC by default, labelled UTC", async () => {
    const r = await partnerTokens(d1, { from: "2026-11-10", to: "2026-11-11" }, 0);
    expect(r.zone).toBe("UTC");
    expect(r.bucket).toBe("day");
    expect(r.rows.map((x) => [x.bucket, x.tokensIn, x.cachedIn, x.replies])).toEqual([
      ["2026-11-10", 1000, 600, 1],
      ["2026-11-11", 2500, 1800, 2],
    ]);
    expect(r.totals).toMatchObject({ tokensIn: 3500, cachedIn: 2400, tokensOut: 150, replies: 3 });
    expect(r.totals.hitRate).toBeCloseTo(2400 / 3500);
  });

  it("the viewer's zone moves the day boundary, and the label says so", async () => {
    const r = await partnerTokens(d1, { from: "2026-11-11", to: "2026-11-11" }, 540);
    expect(r.zone).toBe("UTC+9");
    // 23:30Z on the 10th is 08:30 on the 11th at UTC+9.
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ bucket: "2026-11-11", tokensIn: 3500, replies: 3 });
  });

  it("per account: id and display name, the most tokens first, no email", async () => {
    const r = await partnerTokens(d1, { from: "2026-11-10", to: "2026-11-11" }, 0);
    expect(r.users.map((u) => [u.userId, u.name, u.tokensIn + u.tokensOut])).toEqual([
      ["u1", "Alice", 3120],
      ["u2", "Bob", 530],
    ]);
    expect(r.users[1].hitRate).toBe(0);
    expect(JSON.stringify(r)).not.toContain("@x.com");
  });

  it("by hour over an hour window", async () => {
    const res = await costsGet(
      new Request(
        "https://x/api/dev/costs?from=2026-11-10&to=2026-11-11&view=tokens&by=hour&hours=48",
      ),
      true,
      d1,
      NOW,
    );
    const r = (await res.json()) as Awaited<ReturnType<typeof partnerTokens>>;
    expect(r.bucket).toBe("hour");
    expect(r.rows).toHaveLength(48);
    expect(r.rows.find((x) => x.bucket === "2026-11-11T00")).toMatchObject({ tokensIn: 2000 });
  });
});

describe("GET /api/dev/costs?view=tokens", () => {
  it("404 for a non-admin", async () => {
    const res = await costsGet(new Request("https://x/api/dev/costs?view=tokens"), false, d1, NOW);
    expect(res.status).toBe(404);
  });
  it("admin: the token summary", async () => {
    charge("u1", "2026-11-11T12:00:00Z", { in: 800, cached: 200, out: 40 });
    const res = await costsGet(
      new Request("https://x/api/dev/costs?from=2026-11-11&to=2026-11-11&view=tokens"),
      true,
      d1,
      NOW,
    );
    expect(res.status).toBe(200);
    const r = (await res.json()) as Awaited<ReturnType<typeof partnerTokens>>;
    expect(r.totals).toMatchObject({ tokensIn: 800, cachedIn: 200, tokensOut: 40, hitRate: 0.25 });
  });
});

describe("settleAi keeps a reply's token counts", () => {
  it("writes tokensIn, cachedIn (≤ input) and tokensOut once", async () => {
    charge("u1", null, { in: null, cached: null, out: null });
    const key = `u1:m${seq}`;
    const s = await settleAi(
      d1,
      key,
      5,
      NOW,
      { push: null },
      {
        tokensIn: 1200,
        cachedIn: 900,
        tokensOut: 64,
      },
    );
    expect(s).not.toBeNull();
    const row = d1
      .raw()
      .prepare("SELECT status, tokensIn, cachedIn, tokensOut FROM credit_ai_charge WHERE key = ?")
      .get(key);
    expect(row).toEqual({ status: "settled", tokensIn: 1200, cachedIn: 900, tokensOut: 64 });
  });
  it("without tokens the columns stay NULL", async () => {
    charge("u1", null, { in: null, cached: null, out: null });
    const key = `u1:m${seq}`;
    await settleAi(d1, key, 5, NOW, { push: null });
    const row = d1
      .raw()
      .prepare("SELECT tokensIn, cachedIn, tokensOut FROM credit_ai_charge WHERE key = ?")
      .get(key);
    expect(row).toEqual({ tokensIn: null, cachedIn: null, tokensOut: null });
  });
});
