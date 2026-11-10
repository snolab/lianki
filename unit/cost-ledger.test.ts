import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import {
  LOCAL_STT_FEATURE,
  LOCAL_STT_MAX_AUDIO_MS,
  bookCost,
  costDay,
  costSummary,
  costUsers,
  handleLocalSttCost,
  localSttUsd,
  paidFeature,
  providerUsd,
} from "@/lib/payments/cost-ledger";
import { costsGet, rangeOf } from "@/lib/payments/costs-route";
import { freeCall } from "@/lib/payments/paid-calls";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import { MARGIN } from "@/lib/payments/prices";
import { CONFIG } from "@/lib/config";

let d1: TestD1Database;
const NOW = new Date("2026-11-11T01:00:00Z"); // 10:00 JST, 2026-11-11

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

const rows = () =>
  d1
    .raw()
    .prepare("SELECT user_id, feature, usd_micro, units, day FROM cost_ledger ORDER BY id")
    .all() as { user_id: string; feature: string; usd_micro: number; units: number; day: string }[];

const broken: D1Like = {
  prepare: () => {
    throw new Error("D1 down");
  },
  exec: async () => {
    throw new Error("D1 down");
  },
};

describe("booking", () => {
  it("days are JST", () => {
    expect(costDay(new Date("2026-11-10T14:59:59Z"))).toBe("2026-11-10");
    expect(costDay(new Date("2026-11-10T15:00:00Z"))).toBe("2026-11-11");
  });

  it("freeCall books the provider cost to the payer, nothing charged", async () => {
    const logs: Record<string, unknown>[] = [];
    const r = await freeCall(
      "speech.stt",
      0.0015,
      async () => "heard",
      { userId: "u1", db: d1, units: 12, defer: () => false, now: () => NOW },
      (o) => void logs.push(o),
    );
    expect(r).toEqual({ ok: true, value: "heard", charged: 0, free: "feature" });
    expect(rows()).toEqual([
      {
        user_id: "u1",
        feature: "speech.stt",
        usd_micro: expect.closeTo((0.0015 / MARGIN) * 1e6, 6) as unknown as number,
        units: 12,
        day: "2026-11-11",
      },
    ]);
    expect(logs[0]).toMatchObject({ event: "credits.free", what: "speech.stt" });
  });

  it("a guest's call is booked under ''", async () => {
    await freeCall("words.tts", 0.00001, async () => 1, {
      userId: null,
      db: d1,
      defer: () => false,
    });
    expect(rows()[0]).toMatchObject({ user_id: "", feature: "words.tts" });
  });

  it("a ledger failure never breaks or fails the user's call", async () => {
    const logs: Record<string, unknown>[] = [];
    const r = await freeCall(
      "tts",
      0.01,
      async () => "audio",
      { userId: "u1", db: broken, defer: () => false },
      (o) => void logs.push(o),
    );
    expect(r).toMatchObject({ ok: true, value: "audio", charged: 0 });
    expect(logs.map((l) => l.event)).toEqual(["credits.free", "cost.book.failed"]);
    // No user text or email in the failure line: the feature and the error only.
    expect(Object.keys(logs[1]).sort()).toEqual(["error", "event", "what"]);
    expect(await bookCost(broken, { userId: "u1", feature: "tts", usd: 1 })).toBe(false);
  });

  it("a throwing defer still books (awaited instead)", async () => {
    await freeCall("tts", 0.01, async () => 1, {
      userId: "u2",
      db: d1,
      defer: () => {
        throw new Error("no ctx");
      },
    });
    expect(rows()).toHaveLength(1);
  });

  it("with a deferred booking, the call does not wait for the write", async () => {
    let held: Promise<unknown> | null = null;
    const r = await freeCall("tts", 0.01, async () => 1, {
      userId: "u1",
      db: d1,
      defer: (p) => ((held = p), true),
    });
    expect(r.ok).toBe(true);
    await held;
    expect(rows()).toHaveLength(1);
  });

  it("no D1, nothing booked; the call still runs", async () => {
    const r = await freeCall("tts", 0.01, async () => 7, { userId: "u1", db: null });
    expect(r).toMatchObject({ ok: true, value: 7 });
  });

  it("the routes pass the payer and D1 to freeCall", async () => {
    for (const p of [
      "app/api/words/tts/route.ts",
      "app/api/debug/stt/route.ts",
      "app/api/tts/route.ts",
    ]) {
      const src = await Bun.file(p).text();
      expect(src).toMatch(
        /freeCall\([\s\S]*userId:[\s\S]*db: dbBackend\(\) === "d1" \? getD1\(\) : null/,
      );
    }
  });
});

describe("Lianki's speech server, booked as a cloud service", () => {
  const rate = CONFIG["stt.local.costPerMinUsd"].default;
  it("defaults to Workers AI whisper turbo's list price", () => {
    expect(rate).toBe(0.000513);
    expect(localSttUsd(60_000, rate)).toBeCloseTo(rate * (LOCAL_STT_MAX_AUDIO_MS / 60_000), 12);
    expect(localSttUsd(15_000, rate)).toBeCloseTo(rate / 4, 12);
  });

  const post = (body: unknown) =>
    new Request("https://lianki.com/api/debug/stt/local", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  const deps = (over = {}) => ({
    user: { id: "u1" },
    db: d1 as D1Like,
    perMinUsd: async () => rate,
    limit: () => ({ allowed: true }),
    now: () => NOW,
    ...over,
  });

  it("books one utterance at the configured rate", async () => {
    const res = await handleLocalSttCost(post({ audioMs: 15_000 }), deps());
    expect(res.status).toBe(204);
    expect(rows()).toEqual([
      {
        user_id: "u1",
        feature: LOCAL_STT_FEATURE,
        usd_micro: expect.closeTo((rate / 4) * 1e6, 6) as unknown as number,
        units: 15,
        day: "2026-11-11",
      },
    ]);
  });

  it("follows a changed rate (config store)", async () => {
    await handleLocalSttCost(post({ audioMs: 30_000 }), deps({ perMinUsd: async () => 0.006 }));
    expect(rows()[0].usd_micro).toBeCloseTo(3000, 6);
  });

  it("clamps to one utterance; refuses guests, junk and floods", async () => {
    await handleLocalSttCost(post({ audioMs: 10 * 60_000 }), deps());
    expect(rows()[0].units).toBe(LOCAL_STT_MAX_AUDIO_MS / 1000);
    expect((await handleLocalSttCost(post({ audioMs: 1000 }), deps({ user: null }))).status).toBe(
      401,
    );
    expect((await handleLocalSttCost(post({ audioMs: "x" }), deps())).status).toBe(400);
    expect((await handleLocalSttCost(post({ audioMs: -1 }), deps())).status).toBe(400);
    expect(
      (
        await handleLocalSttCost(
          post({ audioMs: 1000 }),
          deps({ limit: () => ({ allowed: false }) }),
        )
      ).status,
    ).toBe(429);
    expect(rows()).toHaveLength(1);
  });

  it("a failed booking still answers 204", async () => {
    const res = await handleLocalSttCost(
      post({ audioMs: 1000 }),
      deps({ db: broken, log: () => {} }),
    );
    expect(res.status).toBe(204);
  });

  it("the mic and /vibe report what the speech server served", async () => {
    const mic = await Bun.file("packages/debug-chat/src/MicButton.tsx").text();
    expect(mic).toContain("reportLocalStt(durationMs");
    const vibe = await Bun.file("lib/vibe/browser.ts").text();
    expect(vibe).toContain("reportLocalStt(ms)");
  });
});

describe("aggregation", () => {
  const charge = (key: string, userId: string, costMicro: number, settledAt: string) =>
    d1
      .raw()
      .exec(
        `INSERT INTO credit_ai_charge (key, userId, reserved, status, costMicro, charged, createdAt, settledAt) VALUES ('${key}', '${userId}', 1, 'settled', ${costMicro}, 0, '${settledAt}', '${settledAt}')`,
      );

  beforeEach(async () => {
    const at = (iso: string) => new Date(iso);
    await bookCost(
      d1,
      { userId: "u1", feature: "speech.stt", usd: 0.002 },
      at("2026-11-10T03:00:00Z"),
    );
    await bookCost(
      d1,
      { userId: "u1", feature: "words.tts", usd: 0.001 },
      at("2026-11-11T00:00:00Z"),
    );
    await bookCost(
      d1,
      { userId: "u2", feature: "speech.stt", usd: 0.0005 },
      at("2026-11-11T00:00:00Z"),
    );
    await bookCost(
      d1,
      { userId: "", feature: "words.tts", usd: 0.0001 },
      at("2026-11-11T00:00:00Z"),
    );
    // Out of range: 2026-11-01 JST.
    await bookCost(d1, { userId: "u2", feature: "speech.stt", usd: 9 }, at("2026-11-01T00:00:00Z"));
    // Paid: u2 spent 1.5 credits on read.gloss (= 0.01 USD at our price → provider cost 0.01/1.5).
    charge("read.gloss:u2:abc", "u2", 1_500_000, "2026-11-11T02:00:00.000Z");
    // A Learning Partner reply (key without a feature) — 15:30 UTC is the next JST day.
    charge("u1:msg1", "u1", 150_000, "2026-11-10T15:30:00.000Z");
    // A pending hold is not spent.
    d1.raw().exec(
      `INSERT INTO credit_ai_charge (key, userId, reserved, status, createdAt) VALUES ('read.gloss:u1:p', 'u1', 5, 'pending', '2026-11-11T00:00:00.000Z')`,
    );
  });

  const range = { from: "2026-11-10", to: "2026-11-11" };

  it("by day and feature, free and paid side by side", async () => {
    const s = await costSummary(d1, range);
    expect(s.totals.freeCalls).toBe(4);
    expect(s.totals.freeMicro).toBeCloseTo(3600, 6);
    expect(s.totals.paidCalls).toBe(2);
    expect(s.totals.paidCredits).toBeCloseTo(1.65, 9);
    expect(s.totals.paidMicro).toBeCloseTo((1.65 / CREDITS_PER_USD / MARGIN) * 1e6, 6);
    expect(s.byDay.map((d) => d.day)).toEqual(["2026-11-11", "2026-11-10"]);
    expect(s.byDay[0]).toMatchObject({ freeCalls: 3, paidCalls: 2 });
    expect(s.byDay[1]).toMatchObject({ freeCalls: 1, paidCalls: 0 });
    const f = Object.fromEntries(s.byFeature.map((x) => [x.feature, x]));
    expect(f["speech.stt"].freeMicro).toBeCloseTo(2500, 6);
    expect(f["read.gloss"].paidCredits).toBeCloseTo(1.5, 9);
    expect(f["partner.reply"].paidCredits).toBeCloseTo(0.15, 9);
  });

  it("accounts, dearest first, with display names and no emails", async () => {
    const r = await costUsers(d1, range, 0, 10);
    expect(r.total).toBe(3);
    expect(r.rows.map((x) => x.userId)).toEqual(["u2", "u1", ""]);
    expect(r.rows[0]).toMatchObject({ name: "Bob", freeCalls: 1, paidCalls: 1 });
    expect(r.rows[2].name).toBeNull();
    expect(JSON.stringify(r)).not.toContain("@x.com");
    const page2 = await costUsers(d1, range, 1, 1);
    expect(page2.rows.map((x) => x.userId)).toEqual(["u1"]);
  });

  it("feature from a charge key", () => {
    expect(paidFeature("read.gloss")).toBe("read.gloss");
    expect(paidFeature("u1")).toBe("partner.reply");
    expect(paidFeature("")).toBe("partner.reply");
    expect(providerUsd(1.5)).toBeCloseTo(1, 12);
  });

  it("the API: 404 unless admin, ranges checked, users batched", async () => {
    const get = (q: string) => new Request(`https://lianki.com/api/dev/costs?${q}`);
    expect((await costsGet(get(""), false, d1, NOW)).status).toBe(404);
    expect((await costsGet(get(""), true, null, NOW)).status).toBe(404);
    expect((await costsGet(get("from=2026-11-12&to=2026-11-10"), true, d1, NOW)).status).toBe(400);
    expect((await costsGet(get("from=2020-01-01&to=2026-11-10"), true, d1, NOW)).status).toBe(400);
    const s = await (await costsGet(get("from=2026-11-10&to=2026-11-11"), true, d1, NOW)).json();
    expect(s.totals.freeCalls).toBe(4);
    const u = await (
      await costsGet(get("from=2026-11-10&to=2026-11-11&view=users&limit=2"), true, d1, NOW)
    ).json();
    expect(u.rows).toHaveLength(2);
    expect(u.next).toBe(2);
    expect(rangeOf(new URLSearchParams(), NOW)).toEqual({ from: "2026-10-13", to: "2026-11-11" });
  });
});
