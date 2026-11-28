import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { NoObjectGeneratedError } from "ai";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import { getBalance, type D1WithBatch } from "@/lib/payments/credits-store";
import { metered } from "@/lib/payments/metered";
import {
  DESCRIPTION_MAX,
  KEYWORD_MAX,
  MAX_KEYWORDS,
  MAX_STEPS,
  fitRoadmap,
  type LooseRoadmap,
} from "@/lib/roadmap/generate-schema";
import {
  ATTEMPTS,
  RoadmapGenerateError,
  generateFailedResponse,
  generateWithRetry,
  type GenerateOnce,
} from "@/lib/roadmap/generate";
import { deckHref, matchExamDecks } from "@/lib/roadmap/exam-match";
import { SaveRoadmapSchema } from "@/lib/roadmap/save-schema";
import catalogue from "@/public/words/index.json";

const step = (i: number, extra: Partial<LooseRoadmap["nodes"][number]> = {}) => ({
  id: `s${i}`,
  title: `Step ${i}`,
  description: `Learn part ${i}`,
  keywords: [`k${i}a`, `k${i}b`],
  order: i,
  ...extra,
});
const roadmap = (n: number) => ({ nodes: Array.from({ length: n }, (_, i) => step(i)) });

describe("fitRoadmap: clamp and trim instead of rejecting", () => {
  it("trims an over-long description to the limit", () => {
    const r = fitRoadmap({
      nodes: [step(0, { description: "word ".repeat(80) }), step(1), step(2)],
    })!;
    expect(r.nodes[0].description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(r.nodes[0].description.endsWith("…")).toBe(true);
  });

  it("cuts too many keywords to 8, drops duplicates, trims long ones", () => {
    const many = [...Array.from({ length: 12 }, (_, i) => `kw${i}`), "kw0", "x".repeat(90)];
    const r = fitRoadmap({ nodes: [step(0, { keywords: many }), step(1), step(2)] })!;
    expect(r.nodes[0].keywords.length).toBe(MAX_KEYWORDS);
    expect(new Set(r.nodes[0].keywords).size).toBe(MAX_KEYWORDS);
    for (const k of r.nodes.flatMap((n) => n.keywords))
      expect(k.length).toBeLessThanOrEqual(KEYWORD_MAX);
  });

  it("fills too few keywords up to 2 from the title", () => {
    const r = fitRoadmap({
      nodes: [step(0, { keywords: [] }), step(1, { keywords: undefined }), step(2)],
    })!;
    expect(r.nodes[0].keywords.length).toBeGreaterThanOrEqual(2);
    expect(r.nodes[1].keywords.length).toBeGreaterThanOrEqual(2);
  });

  it("caps and dedupes the fallback keywords too (long title, one long word, no keywords)", () => {
    const long = "Superlongwordwithoutanyspacesatallthatkeepsgoingonandon";
    const r = fitRoadmap({
      nodes: [
        step(0, { title: `${"Kanji ".repeat(20)}end`, keywords: [] }),
        step(1, { title: long, keywords: undefined }),
        step(2, { title: "Kanji", keywords: ["kanji", "KANJI", "Kanji "] }),
      ],
    })!;
    for (const n of r.nodes) {
      expect(n.keywords.length).toBeGreaterThanOrEqual(2);
      for (const k of n.keywords) expect(k.length).toBeLessThanOrEqual(KEYWORD_MAX);
      expect(new Set(n.keywords.map((k) => k.toLowerCase())).size).toBe(n.keywords.length);
    }
  });

  it("clamps more than 12 steps to 12, in order, renumbered from 0", () => {
    const r = fitRoadmap(roadmap(15))!;
    expect(r.nodes.length).toBe(MAX_STEPS);
    expect(r.nodes.map((n) => n.order)).toEqual([...Array(MAX_STEPS).keys()]);
  });

  it("refuses fewer than 3 usable steps (nothing to clamp up to)", () => {
    expect(fitRoadmap(roadmap(2))).toBeNull();
    expect(fitRoadmap({ nodes: [step(0), step(1), step(2, { title: "  " })] })).toBeNull();
  });

  it("makes ids unique and sorts by order", () => {
    const r = fitRoadmap({
      nodes: [step(2, { id: "same" }), step(0, { id: "same" }), step(1, { id: "same" })],
    })!;
    expect(r.nodes.map((n) => n.title)).toEqual(["Step 0", "Step 1", "Step 2"]);
    expect(new Set(r.nodes.map((n) => n.id)).size).toBe(3);
  });
});

describe("the generate output is what POST /api/roadmap saves, as is", () => {
  const big = "x".repeat(300);
  const nasty: LooseRoadmap[] = [
    roadmap(3),
    roadmap(15),
    {
      nodes: Array.from({ length: 14 }, (_, i) =>
        step(i, {
          id: i % 2 ? undefined : "dup",
          title: `${big} ${i}`,
          description: `${"long words ".repeat(40)}`,
          keywords: [...Array.from({ length: 11 }, (_, j) => `${big}${j}`), "", "a", "A"],
          order: i % 3 === 0 ? undefined : 14 - i,
        }),
      ),
    },
    {
      nodes: [
        step(0, { keywords: [], description: undefined }),
        step(1, { title: "語彙", keywords: undefined, order: 2.5 }),
        step(2, { title: "x".repeat(120), keywords: ["x".repeat(120)] }),
      ],
    },
  ];
  it.each(nasty.map((r, i) => [i, r] as const))("case %d: accepted, no 400", (_i, raw) => {
    const fitted = fitRoadmap(raw)!;
    const parsed = SaveRoadmapSchema.safeParse({ topic: "jlpt n1", nodes: fitted.nodes });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues[0]));
    expect(parsed.data.nodes).toEqual(fitted.nodes);
  });

  it("through the route's own path: generateWithRetry's value saves as is", async () => {
    const r = await generateWithRetry(scripted([nasty[2]]), price, quiet);
    expect(SaveRoadmapSchema.safeParse({ topic: "t", nodes: r.value.nodes }).success).toBe(true);
  });
});

const noObject = (usage = { inputTokens: 100, outputTokens: 50 }) =>
  new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    response: { id: "r", timestamp: new Date(), modelId: "m" },
    usage: usage as never,
    finishReason: "stop",
  });

/** A model that answers from a script: an object, or an error to throw. */
function scripted(answers: (LooseRoadmap | Error)[]): GenerateOnce & { calls: number } {
  const f = Object.assign(
    async () => {
      const a = answers[f.calls++];
      if (a instanceof Error) throw a;
      return { object: a, usage: { inputTokens: 100, outputTokens: 50 } };
    },
    { calls: 0 },
  );
  return f;
}

/** 1 credit per call at these prices. */
const ONE_CALL_USD = 1 / CREDITS_PER_USD;
const price = { usd: () => ONE_CALL_USD / 2, fallbackUsd: ONE_CALL_USD };
const quiet = () => {};

describe("generateWithRetry", () => {
  it("retries once on NoObjectGeneratedError and answers the second try", async () => {
    const once = scripted([noObject(), roadmap(5)]);
    const r = await generateWithRetry(once, price, quiet);
    expect(once.calls).toBe(2);
    expect(r.value.nodes.length).toBe(5);
    // Both attempts reported usage: both are paid, once each.
    expect(r.usd).toBeCloseTo(ONE_CALL_USD, 12);
  });

  it("retries once when the answer cannot be repaired (schema failure)", async () => {
    const once = scripted([roadmap(1), roadmap(4)]);
    const r = await generateWithRetry(once, price, quiet);
    expect(once.calls).toBe(2);
    expect(r.value.nodes.length).toBe(4);
  });

  it("does not retry a provider error", async () => {
    const once = scripted([new Error("upstream 500: secret detail"), roadmap(5)]);
    const err = await generateWithRetry(once, price, quiet).catch((e) => e);
    expect(once.calls).toBe(1);
    expect(err).toBeInstanceOf(RoadmapGenerateError);
    expect(err.reason).toBe("provider-error");
  });

  it("gives up after ATTEMPTS", async () => {
    const once = scripted([noObject(), noObject(), roadmap(5)]);
    const err = await generateWithRetry(once, price, quiet).catch((e) => e);
    expect(once.calls).toBe(ATTEMPTS);
    expect(err.reason).toBe("no-object");
  });
});

describe("billing: one hold for the try and its retry", () => {
  let d1: TestD1Database;
  const db = () => d1 as unknown as D1WithBatch;
  const deps = () => ({ d1: db(), now: () => new Date("2026-11-27T00:00:00Z"), log: quiet });
  const alice = { userId: "u_alice", email: "alice@x.com" };
  const ledger = () =>
    d1.raw().prepare("SELECT amount, reason, refId FROM credit_ledger ORDER BY rowid").all() as {
      amount: number;
      reason: string;
      refId: string;
    }[];
  beforeEach(() => {
    d1 = createTestD1(testSchema());
    d1.raw().exec(`INSERT INTO user (id, email, createdAt, updatedAt) VALUES
      ('u_alice', 'alice@x.com', 'x', 'x')`);
    d1.raw().exec(
      `INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u_alice', 10, 'x')`,
    );
  });

  it("a retried success takes one hold and keeps only the real cost", async () => {
    const once = scripted([noObject(), roadmap(5)]);
    const r = await metered(
      deps(),
      alice,
      { what: "roadmap.generate", holdUsd: ONE_CALL_USD * ATTEMPTS },
      () => generateWithRetry(once, price, quiet),
    );
    expect(r.ok).toBe(true);
    const rows = ledger();
    // One refId: one hold (2 credits), one settle; never a second hold.
    expect(new Set(rows.map((x) => x.refId)).size).toBe(1);
    expect(rows.filter((x) => x.amount < 0).length).toBe(1);
    expect(rows.find((x) => x.amount < 0)!.amount).toBe(-2);
    // Kept: the two attempts' real cost (1 credit), the rest refunded.
    expect(await getBalance(db(), "u_alice")).toBe(9);
  });

  it("every attempt failed: the hold is refunded in full and the route answers 502", async () => {
    const once = scripted([noObject(), noObject()]);
    const err = await metered(
      deps(),
      alice,
      { what: "roadmap.generate", holdUsd: ONE_CALL_USD * ATTEMPTS },
      () => generateWithRetry(once, price, quiet),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RoadmapGenerateError);
    expect(await getBalance(db(), "u_alice")).toBe(10);

    const logs: Record<string, unknown>[] = [];
    const res = generateFailedResponse(err, (o) => void logs.push(o));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "generate-failed", reason: "no-object" });
    expect(logs[0]).toMatchObject({ event: "roadmap.generate.failed", reason: "no-object" });
  });
});

describe("generateFailedResponse: never leaks the provider's words", () => {
  it("logs only bounded error metadata, never provider prompts or generated text", () => {
    const logs: Record<string, unknown>[] = [];
    const cause = Object.assign(new Error("private prompt and generated content"), {
      name: "AI_APICallError",
      statusCode: 404,
      finishReason: "length",
      responseBody: "private provider payload",
    });
    generateFailedResponse(new RoadmapGenerateError("provider-error", cause), (entry) =>
      logs.push(entry),
    );
    expect(logs).toEqual([
      {
        event: "roadmap.generate.failed",
        reason: "provider-error",
        error: "AI_APICallError",
        statusCode: 404,
        finishReason: "length",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("private");
    const unsafe = Object.assign(new Error("private"), {
      name: "private payload with spaces",
      statusCode: "private",
      finishReason: "private",
    });
    generateFailedResponse(unsafe, (entry) => logs.push(entry));
    expect(logs[1]).toEqual({
      event: "roadmap.generate.failed",
      reason: "provider-error",
      error: "object",
    });
  });

  it("answers a short code for any error", async () => {
    const res = generateFailedResponse(new Error("Workers AI 5xx: account abc123 token"), quiet);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toBe(JSON.stringify({ error: "generate-failed", reason: "provider-error" }));
    expect(body).not.toContain("abc123");
  });
});

describe("matchExamDecks: the wish names an exam deck of the catalogue", () => {
  const lists = catalogue.lists;
  const ids = (wish: string) => matchExamDecks(wish, lists).map((d) => d.id);

  it("matches 'jlpt n1' and its spellings to ja-jlpt-n1", () => {
    for (const w of [
      "jlpt n1",
      "JLPT-N1",
      "jlptn1",
      "n1",
      "Pass JLPT N1 in July",
      "我想考 JLPT N1",
    ])
      expect(ids(w)).toEqual(["ja-jlpt-n1"]);
  });

  it("matches other exams by the same rule", () => {
    expect(ids("HSK 4")).toEqual(["zh-hsk-4"]);
    expect(ids("hsk 7-9")).toEqual(["zh-hsk-7-9"]);
  });

  it("a wish naming no exam gives none", () => {
    expect(ids("learn python loops")).toEqual([]);
    expect(ids("python1 basics")).toEqual([]);
    expect(ids("cook pasta")).toEqual([]);
  });

  it("links to the deck on /words", () => {
    expect(deckHref("ja-jlpt-n1")).toBe("/words?deck=ja-jlpt-n1");
  });
});

describe("default logs: one JSON line each, without the provider's text in the answer", () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  it("logs the retry and the failure to the console", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    spies.push(warn, error);
    const err = await generateWithRetry(scripted([noObject(), noObject()]), price).catch((e) => e);
    expect(warn).toHaveBeenCalledTimes(ATTEMPTS);
    expect(generateFailedResponse(err).status).toBe(502);
    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
      event: "roadmap.generate.failed",
    });
  });
});
