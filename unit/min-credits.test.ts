/**
 * "Not enough credits" with numbers (docs/payments.md): the minimum to start
 * (the first hold), the recommended balance to finish (P95 of past real costs
 * × the calls left; too little history → the hold × the calls), the balance;
 * carried by every 402 in its body and headers; the page-wide notice's line;
 * the resume cache of "Words with AI".
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1WithBatch } from "@/lib/payments/credits-store";
import { reserveCredits } from "@/lib/payments/ai-credits";
import { noCreditsResponse, takeHold } from "@/lib/payments/metered";
import {
  MIN_SAMPLES,
  RECOMMEND_PERCENTILE,
  pastCosts,
  percentile,
  recommendFor,
} from "@/lib/payments/recommend";
import {
  creditsNumbers,
  installNoCreditsWatch,
  needText,
  type CreditsNumbers,
} from "@/lib/payments/no-credits-watch";
import { chunkHash, d1ChunkCache, dropChunks } from "@/lib/import/chunk-cache";
import type { D1Like } from "@/lib/d1/types";

let d1: TestD1Database;
const db = () => d1 as unknown as D1WithBatch;
beforeEach(() => {
  d1 = createTestD1(testSchema());
  d1.raw().exec(
    "INSERT INTO user (id, email, createdAt, updatedAt) VALUES ('u1', 'u1@x.com', 'x', 'x')",
  );
});

/** `n` settled calls of `feature` that each really cost `credits`. */
function history(feature: string, costs: number[]) {
  costs.forEach((c, i) =>
    d1
      .raw()
      .exec(
        `INSERT INTO credit_ai_charge (key, userId, reserved, status, createdAt, costMicro, settledAt) VALUES ('${feature}:u1:${i}', 'u1', 10, 'settled', 'x', ${Math.round(c * 1e6)}, '2026-11-10T00:00:${String(i % 60).padStart(2, "0")}Z')`,
      ),
  );
}

describe("recommended to finish", () => {
  it("percentile: nearest rank; none is 0", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([5], 0.95)).toBe(5);
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(95);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(RECOMMEND_PERCENTILE).toBe(0.95);
  });

  it("with enough history: P95 of past real costs × the calls left (never below the need)", async () => {
    // 19 cheap calls and one dear one: P95 of 20 is the 19th — 1 credit.
    history("words.import-ai", [...Array(MIN_SAMPLES - 1).fill(1), 9]);
    expect((await pastCosts(db(), "words.import-ai")).length).toBe(MIN_SAMPLES);
    const r = await recommendFor(db(), {
      feature: "words.import-ai",
      units: 4,
      unitHoldUsd: 1,
      need: 2,
    });
    expect(r).toEqual({ recommended: 4, basis: "history", samples: MIN_SAMPLES });
    // P99 as the owner also named: the dear one counts.
    const p99 = await recommendFor(
      db(),
      { feature: "words.import-ai", units: 4, unitHoldUsd: 1, need: 2 },
      { percentile: 0.99 },
    );
    expect(p99.recommended).toBe(36);
    // Never below the need.
    expect(
      (await recommendFor(db(), { feature: "words.import-ai", units: 1, unitHoldUsd: 1, need: 7 }))
        .recommended,
    ).toBe(7);
  });

  it("with too little history: the hold × the calls left", async () => {
    history("words.import-ai", Array(MIN_SAMPLES - 1).fill(1));
    const hold = 0.02;
    const r = await recommendFor(db(), {
      feature: "words.import-ai",
      units: 3,
      unitHoldUsd: hold,
      need: 1,
    });
    expect(r).toEqual({
      recommended: reserveCredits(hold) * 3,
      basis: "hold",
      samples: MIN_SAMPLES - 1,
    });
    // No wallet at all: the same fallback.
    expect(
      (await recommendFor(null, { feature: "read.polish", units: 2, unitHoldUsd: hold, need: 1 }))
        .recommended,
    ).toBe(reserveCredits(hold) * 2);
  });

  it("other features' history is not mixed in; an unreadable ledger is no history", async () => {
    history("read.polish", Array(30).fill(5));
    expect(await pastCosts(db(), "words.import-ai")).toEqual([]);
    const broken = {
      prepare: () => {
        throw new Error("down");
      },
    } as unknown as D1WithBatch;
    expect(await pastCosts(broken, "read.polish")).toEqual([]);
  });

  it("a refusal from takeHold carries need, recommended (for the whole action) and the balance", async () => {
    d1.raw().exec("INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u1', 1, 'x')");
    const r = await takeHold(
      { d1: db(), admin: () => false },
      { userId: "u1", email: "u1@x.com" },
      { what: "words.import-ai", holdUsd: 0.03, action: { units: 5, unitHoldUsd: 0.03 } },
    );
    expect(r).toEqual({
      ok: false,
      reason: "no-credits",
      balance: 1,
      need: reserveCredits(0.03),
      recommended: reserveCredits(0.03) * 5,
    });
  });
});

describe("the 402 and the page-wide notice", () => {
  it("headers carry the numbers; the watch reads them (never the body)", async () => {
    const res = noCreditsResponse(
      { balance: 2, need: 5, recommended: 12 },
      { completed: 1, total: 3 },
    );
    expect(await res.clone().json()).toMatchObject({
      need: 5,
      recommended: 12,
      have: 2,
      completed: 1,
      total: 3,
    });
    expect(creditsNumbers(res)).toEqual({ need: 5, have: 2, recommended: 12 });
    expect(creditsNumbers(new Response(null))).toBeNull();
    const seen: [string, CreditsNumbers | null][] = [];
    const win = { fetch: async () => res };
    installNoCreditsWatch(win, (k, n) => seen.push([k, n]));
    await win.fetch();
    expect(seen).toEqual([["needed", { need: 5, have: 2, recommended: 12 }]]);
  });

  it("the line: two numbers when finishing needs more than starting, else the shortfall", () => {
    const s = {
      needLine: "start {need}, finish {recommended} (have {have})",
      needShort: "at least {need} ({short} more)",
    };
    expect(needText(s, { need: 5, have: 2, recommended: 12 })).toBe("start 5, finish 12 (have 2)");
    expect(needText(s, { need: 5, have: 2, recommended: 5 })).toBe("at least 5 (3 more)");
    expect(needText(s, null)).toBeNull();
    expect(needText({}, { need: 5, have: 2, recommended: 5 })).toBeNull();
  });
});

describe("the resume cache", () => {
  const SCHEMA =
    "CREATE TABLE ai_chunk_cache (user_id TEXT NOT NULL, file_id TEXT NOT NULL, chunk_hash TEXT NOT NULL, rows_json TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY (user_id, file_id, chunk_hash));";

  it("keeps a chunk's rows per user and file; a delete drops them; failures are misses", async () => {
    const t = createTestD1(SCHEMA);
    const c = d1ChunkCache(t as unknown as D1Like, () => 1);
    const h = await chunkHash({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await chunkHash({ a: 1 })).toBe(h);
    expect(await c.get("u1", "f1", h)).toBeNull();
    await c.put("u1", "f1", h, [{ word: "w", meaning: "m", example: "" }]);
    await c.put("u1", "f1", h, [{ word: "w2", meaning: "m", example: "" }]);
    expect(await c.get("u1", "f1", h)).toEqual([{ word: "w2", meaning: "m", example: "" }]);
    expect(await c.get("u2", "f1", h)).toBeNull();
    t.raw().exec("INSERT INTO ai_chunk_cache VALUES ('u1', 'f1', 'bad', 'not json', 1)");
    expect(await c.get("u1", "f1", "bad")).toBeNull();
    t.raw().exec("INSERT INTO ai_chunk_cache VALUES ('u1', 'f1', 'obj', '{}', 1)");
    expect(await c.get("u1", "f1", "obj")).toBeNull();
    await dropChunks(t as unknown as D1Like, "u1", "f1");
    expect(await c.get("u1", "f1", h)).toBeNull();
    const broken = {
      prepare: () => {
        throw new Error("down");
      },
    } as unknown as D1Like;
    const b = d1ChunkCache(broken);
    expect(await b.get("u1", "f1", h)).toBeNull();
    await b.put("u1", "f1", h, []);
    await dropChunks(broken, "u1", "f1");
  });
});
