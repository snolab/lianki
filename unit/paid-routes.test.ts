import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { getBalance, type D1WithBatch } from "@/lib/payments/credits-store";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import {
  HOLD_STALE_MS,
  isPaused,
  isRefused,
  metered,
  pausedResponse,
  refusalOf,
  refusedAs,
  refusedResponse,
  settleHold,
  takeHold,
} from "@/lib/payments/metered";
import {
  CREDITS_HEADER,
  creditsRefusal,
  installNoCreditsWatch,
} from "@/lib/payments/no-credits-watch";
import {
  MAX_OUT,
  chatHoldUsd,
  openAiCreate,
  paidChat,
  paidSpeech,
  paidStt,
  type Create,
} from "@/lib/payments/paid-calls";
import {
  AURA2_USD_PER_KCHAR,
  FEATURES,
  HOLD_AUDIO_SEC_PER_BYTE,
  HOLD_SPEECH_SEC_PER_CHAR,
  HOLD_TOKENS_PER_CHAR,
  HOLD_TOKENS_PER_IMAGE,
  MELOTTS_USD_PER_MIN,
  PRICES_VERSION,
  STT_USD_PER_MIN,
  TEXT_PRICES,
  speechHoldUsd,
  sttUsd,
  textHoldUsd,
} from "@/lib/payments/prices";
import { walletUserId } from "@/lib/payments/wallet-db";
import { pendingHolds, reserveAi, settleAi, sweepStaleAi } from "@/lib/payments/ai-credits";
import { wordsTts, type WordsTtsDeps } from "@/lib/words-tts";
import { handleStt, type SttDeps } from "@/lib/stt-handler";

/**
 * The direct routes' paid calls (labs, self-intro translate/speech, roadmap,
 * blog translate, word audio, the mic), the feature pause, and the rule that
 * every hold covers the provider's real bill.
 */
let d1: TestD1Database;
const db = () => d1 as unknown as D1WithBatch;
const NOW = new Date("2026-11-09T12:00:00Z");
const fund = (n: number) =>
  d1.raw().exec(`INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u1', ${n}, 'x')`);
const bal = () => getBalance(db(), "u1");
const payer = () => ({ userId: "u1", email: "u1@x.com", db: db() });
const notes = () =>
  (
    d1.raw().prepare("SELECT reason, note FROM credit_ledger ORDER BY rowid").all() as {
      reason: string;
      note: string | null;
    }[]
  ).map((r) => `${r.reason}:${r.note ?? ""}`);

beforeEach(() => {
  d1 = createTestD1(testSchema());
  d1.raw().exec(
    "INSERT INTO user (id, email, createdAt, updatedAt) VALUES ('u1', 'u1@x.com', 'x', 'x')",
  );
});

describe("every hold covers the provider's real bill", () => {
  it("text: the provider's most at list price (no margin) is at most the hold", () => {
    for (const [model, p] of Object.entries(TEXT_PRICES))
      for (const [chars, maxOut, images] of [
        [1, 1, 0],
        [500, 1200, 0],
        [40_000, 1500, 4],
        [100_000, 32_000, 0],
      ]) {
        // The ceiling of what the provider can count: every char as 2 tokens, every image, every output token.
        const providerMax =
          ((chars * HOLD_TOKENS_PER_CHAR + images * HOLD_TOKENS_PER_IMAGE) * p.inPerM +
            maxOut * p.outPerM) /
          1e6;
        expect(textHoldUsd(model, chars, maxOut, images)).toBeGreaterThanOrEqual(providerMax);
      }
  });

  it("speech and transcription likewise", () => {
    for (const n of [1, 60, 500]) {
      expect(speechHoldUsd(n)).toBeGreaterThanOrEqual(
        ((n * HOLD_SPEECH_SEC_PER_CHAR) / 60) * MELOTTS_USD_PER_MIN,
      );
      expect(speechHoldUsd(n, true)).toBeGreaterThanOrEqual((n / 1000) * AURA2_USD_PER_KCHAR);
    }
    for (const b of [1, 64_000, 2 * 1024 * 1024])
      expect(sttUsd(b)).toBeGreaterThanOrEqual(
        ((b * HOLD_AUDIO_SEC_PER_BYTE) / 60) * STT_USD_PER_MIN,
      );
  });

  it("every chat feature has a fixed answer ceiling; every feature is a known id", () => {
    for (const k of Object.keys(MAX_OUT)) expect(FEATURES as readonly string[]).toContain(k);
    for (const v of Object.values(MAX_OUT)) expect(v).toBeGreaterThan(0);
  });
});

describe("an overage pauses the feature for everyone, until the price table changes", () => {
  it("settled at the hold, paused, refused after with no charge; a new table version resumes", async () => {
    fund(10);
    const logs: Record<string, unknown>[] = [];
    const deps = {
      d1: db(),
      now: () => NOW,
      log: (o: Record<string, unknown>) => void logs.push(o),
    };
    const holdUsd = 1 / CREDITS_PER_USD;
    await metered(deps, payer(), { what: "polyglot.tts", holdUsd }, async () => ({
      value: 0,
      usd: 3 / CREDITS_PER_USD,
    }));
    expect(await bal()).toBe(9);
    expect(logs.find((l) => l.event === "credits.overage")).toMatchObject({ what: "polyglot.tts" });
    expect(await isPaused(db(), "polyglot.tts")).toBe(true);
    expect(await isPaused(db(), "words.tts")).toBe(false);
    let called = false;
    const r = await metered(deps, payer(), { what: "polyglot.tts", holdUsd }, async () => {
      called = true;
      return { value: 0, usd: 0 };
    });
    expect(r).toEqual({ ok: false, reason: "paused" });
    expect(called).toBe(false);
    expect(await bal()).toBe(9);
    // The table updated (another version): the old pause no longer applies.
    d1.raw().exec(`UPDATE credit_feature_pause SET version = 'old-${PRICES_VERSION}'`);
    expect(await isPaused(db(), "polyglot.tts")).toBe(false);
  });

  it("an admin's overage pauses it too; no table yet reads as not paused", async () => {
    const deps = { d1: db(), admin: () => true, log: () => {} };
    await metered(deps, payer(), { what: "tts", holdUsd: 0.001 }, async () => ({
      value: 0,
      usd: 1,
    }));
    expect(await isPaused(db(), "tts")).toBe(true);
    d1.raw().exec("DROP TABLE credit_feature_pause");
    expect(await isPaused(db(), "tts")).toBe(false);
  });

  it("refusals map to answers: 402 short, 503 paused (with the header), else nothing", async () => {
    const p = pausedResponse();
    expect(p.status).toBe(503);
    expect(p.headers.get(CREDITS_HEADER)).toBe("paused");
    expect(creditsRefusal(p)).toBe("paused");
    expect(refusedAs({ ok: false, reason: "paused" }, "x")).toEqual({
      ok: false,
      error: "credits-paused",
    });
    expect(refusedAs({ ok: false, reason: "duplicate" }, "x")).toBe("x");
    expect(isRefused({ ok: false, error: "credits-paused" })).toBe(true);
    expect(isRefused({ ok: false, error: "busy" })).toBe(false);
    expect(refusalOf({ ok: false, error: "credits-paused" }).status).toBe(503);
    expect(
      refusedResponse({ ok: false, error: "no-credits", balance: 0, need: 1 } as never)?.status,
    ).toBe(402);
    expect(refusedResponse({ ok: false, error: "credits-paused" })?.status).toBe(503);
    expect(refusedResponse({ ok: false, error: "busy" })).toBeNull();
    let kind = "";
    const win = { fetch: async (_i: RequestInfo | URL, _o?: RequestInit) => pausedResponse() };
    installNoCreditsWatch(win, (k) => void (kind = k));
    await win.fetch("/x");
    expect(kind).toBe("paused");
  });
});

describe("the two-phase ledger: hold, then one settle or void", () => {
  const rows = () =>
    d1.raw().prepare("SELECT amount, reason, refId FROM credit_ledger ORDER BY rowid").all() as {
      amount: number;
      reason: string;
      refId: string;
    }[];

  it("hold and settle are separate append-only rows linked by refId; a second settle or void is refused", async () => {
    fund(5);
    await reserveAi(db(), { userId: "u1", key: "k1", reserved: 3, what: "tts" }, NOW);
    const first = await settleAi(db(), "k1", 1_000_000, NOW);
    expect(first).toEqual({ charged: 1, refunded: 2 });
    expect(await settleAi(db(), "k1", 0, NOW)).toBeNull(); // a void after the settle
    expect(await settleAi(db(), "k1", 3_000_000, NOW)).toBeNull(); // a second settle
    const r = rows();
    expect(r.map((x) => [x.reason, x.amount])).toEqual([
      ["ai", -3],
      ["refund", 2],
    ]);
    expect(new Set(r.map((x) => x.refId)).size).toBe(1);
    expect(await bal()).toBe(4); // 5 − 3 held + 2 back
  });

  it("a settle above the hold is capped at the hold, never past it", async () => {
    fund(5);
    await reserveAi(db(), { userId: "u1", key: "k2", reserved: 2, what: "tts" }, NOW);
    expect(await settleAi(db(), "k2", 9_000_000, NOW)).toEqual({ charged: 2, refunded: 0 });
    expect(await bal()).toBe(3);
  });

  it("the same idempotency key holds once: a retried hold is a duplicate", async () => {
    fund(5);
    expect((await reserveAi(db(), { userId: "u1", key: "k3", reserved: 1 }, NOW)).status).toBe(
      "reserved",
    );
    expect((await reserveAi(db(), { userId: "u1", key: "k3", reserved: 1 }, NOW)).status).toBe(
      "duplicate",
    );
    expect(await bal()).toBe(4);
  });

  it("available = posted − pending holds; an expired hold is released on the wallet's next read", async () => {
    fund(5);
    const old = new Date(NOW.getTime() - HOLD_STALE_MS - 1000);
    await reserveAi(db(), { userId: "u1", key: "k4", reserved: 2 }, old);
    await reserveAi(db(), { userId: "u1", key: "k5", reserved: 1 }, NOW);
    expect(await bal()).toBe(2); // spendable
    expect(await pendingHolds(db(), "u1")).toBe(3); // in progress
    // Another wallet's read does not touch this one.
    expect(await sweepStaleAi(db(), HOLD_STALE_MS, NOW, 20, "someone-else")).toBe(0);
    expect(await sweepStaleAi(db(), HOLD_STALE_MS, NOW, 20, "u1")).toBe(1);
    expect(await bal()).toBe(4);
    expect(await pendingHolds(db(), "u1")).toBe(1);
  });
});

describe("a streamed call: hold before, settle after", () => {
  it("takeHold then settleHold keeps the real cost; a failed stream keeps nothing", async () => {
    fund(5);
    const h = await takeHold({ d1: db(), now: () => NOW }, payer(), {
      what: "blog.translate",
      holdUsd: 3 / CREDITS_PER_USD,
    });
    if (!h.ok) throw new Error("no hold");
    expect(await bal()).toBe(2);
    expect(await settleHold(h.hold, 2 / CREDITS_PER_USD, { now: () => NOW })).toBe(2);
    expect(await bal()).toBe(3);
    const h2 = await takeHold({ d1: db() }, payer(), {
      what: "blog.translate",
      holdUsd: 1 / CREDITS_PER_USD,
    });
    if (!h2.ok) throw new Error("no hold");
    expect(await settleHold(h2.hold, null)).toBe(0);
    expect(await bal()).toBe(3);
  });

  it("a free pass settles to nothing and says why", async () => {
    const logs: Record<string, unknown>[] = [];
    const h = await takeHold({ d1: null }, payer(), { what: "tts", holdUsd: 1 });
    if (!h.ok) throw new Error("no pass");
    expect(await settleHold(h.hold, 0.5, { log: (o) => void logs.push(o) })).toBe(0);
    expect(logs[0]).toMatchObject({ event: "credits.unmetered" });
  });

  it("the wallet's owner by email (API token routes)", async () => {
    expect(await walletUserId(db(), "U1@x.com")).toBe("u1");
    expect(await walletUserId(db(), "nobody@x.com")).toBe("");
    expect(await walletUserId(null, "u1@x.com")).toBe("");
  });
});

describe("paid chat, speech and transcription", () => {
  const body = {
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: MAX_OUT["ai-sentences"],
  };
  let calls = 0;
  const create: Create = async () => {
    calls++;
    return {
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };
  };
  beforeEach(() => void (calls = 0));

  it("chat: refused when short (no call), charged when funded, tokens priced; no usage = the hold", async () => {
    expect(await paidChat(payer(), "ai-sentences", body, create)).toMatchObject({
      reason: "no-credits",
    });
    expect(calls).toBe(0);
    fund(5);
    expect(await paidChat(payer(), "ai-sentences", body, create)).toMatchObject({ ok: true });
    expect(notes()[0]).toBe("ai:ai-sentences");
    const noUsage: Create = async () => ({ choices: [] });
    expect(await paidChat(payer(), "ai-sentences", body, noUsage)).toMatchObject({ ok: true });
    expect(chatHoldUsd(body)).toBeGreaterThan(0);
  });

  it("chat: a provider failure is refunded and rethrown", async () => {
    fund(5);
    const boom: Create = async () => {
      throw new Error("down");
    };
    await expect(paidChat(payer(), "polyglot.translate", body, boom)).rejects.toThrow("down");
    expect(await bal()).toBe(5);
  });

  it("openAiCreate passes the body to the client", async () => {
    const seen: unknown[] = [];
    const client = {
      chat: { completions: { create: async (b: unknown) => (seen.push(b), { choices: [] }) } },
    };
    await openAiCreate(client as never)(body);
    expect(seen).toEqual([body]);
  });

  it("speech and transcription: refused when short, charged when funded", async () => {
    expect(await paidSpeech(payer(), "self-intro.tts", "hello", async () => 1)).toMatchObject({
      reason: "no-credits",
    });
    expect(await paidStt(payer(), 1000, async () => 1)).toMatchObject({ reason: "no-credits" });
    fund(5);
    expect(await paidSpeech(payer(), "self-intro.tts", "hello", async () => 1, true)).toMatchObject(
      {
        ok: true,
        value: 1,
      },
    );
    expect(await paidStt(payer(), 1000, async () => 2)).toMatchObject({ ok: true, value: 2 });
    expect(notes().filter((n) => n.startsWith("ai:"))).toEqual([
      "ai:self-intro.tts",
      "ai:speech.stt",
    ]);
  });
});

describe("word audio (/api/words/tts): a cache miss is paid", () => {
  const MP3 = new Uint8Array([0x49, 0x44, 0x33, 1]);
  const deps = (over: Partial<WordsTtsDeps> = {}): WordsTtsDeps => ({
    getVoiceClip: async () => null,
    getCachedTTS: async () => null,
    putCachedTTS: async () => {},
    checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
    isConfigured: () => true,
    speechModel: () => "@cf/myshell-ai/melotts",
    speech: async () => ({ audio: new Uint8Array(MP3), contentType: "audio/mpeg" }),
    log: () => {},
    pay: (text, aura, run) => paidSpeech(payer(), "words.tts", text, run, aura),
    ...over,
  });
  const q = new URLSearchParams("lang=en&text=hello");

  it("not enough credits: 402 with the header, nothing generated", async () => {
    let spoke = 0;
    const r = await wordsTts(
      q,
      "u1@x.com",
      deps({
        speech: async () => (spoke++, { audio: new Uint8Array(MP3), contentType: "audio/mpeg" }),
      }),
    );
    expect(r.status).toBe(402);
    expect(r.headers.get(CREDITS_HEADER)).toBe("needed");
    expect(spoke).toBe(0);
  });

  it("funded: the clip, one charge", async () => {
    fund(5);
    const r = await wordsTts(q, "u1@x.com", deps());
    expect(r.status).toBe(200);
    expect(notes()[0]).toBe("ai:words.tts");
  });

  it("a cached clip is free: no hold", async () => {
    const r = await wordsTts(q, "u1@x.com", deps({ getCachedTTS: async () => MP3 }));
    expect(r.status).toBe(200);
    expect(notes()).toEqual([]);
  });
});

describe("the mic (/api/debug/stt): each transcription is paid", () => {
  const post = () =>
    new Request("https://lianki.com/api/debug/stt", {
      method: "POST",
      body: new Uint8Array([1, 2, 3, 4]),
      headers: { "content-type": "audio/webm" },
    });
  const deps = (over: Partial<SttDeps> = {}): SttDeps => ({
    user: { id: "u1" },
    owner: false,
    transcribe: async () => ({ text: "hi" }),
    limit: () => ({ allowed: true, retryAfterMs: 0 }),
    log: () => {},
    pay: (bytes, run) => paidStt(payer(), bytes, run),
    ...over,
  });

  it("not enough credits: 402, never transcribed", async () => {
    let n = 0;
    const r = await handleStt(post(), deps({ transcribe: async () => (n++, { text: "x" }) }));
    expect(r.status).toBe(402);
    expect(n).toBe(0);
  });

  it("funded: transcribed and charged; both models failing: 502 and refunded", async () => {
    fund(5);
    expect((await handleStt(post(), deps())).status).toBe(200);
    const r = await handleStt(
      post(),
      deps({
        transcribe: async () => {
          throw new Error("down");
        },
      }),
    );
    expect(r.status).toBe(502);
    expect(await bal()).toBe(5 - 0); // whole credits: the fraction carries
  });
});
