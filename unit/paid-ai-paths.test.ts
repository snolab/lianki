import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { getBalance, type D1WithBatch } from "@/lib/payments/credits-store";
import { parseLemmas } from "@/lib/read/lemma";
import type { BookCtx } from "@/lib/read/book-word-list";
import {
  fillGlosses,
  promptChars,
  usageUsd,
  type Complete,
  type GlossAi,
} from "@/lib/read/gloss-server";
import { livePolishAi } from "@/lib/read/live-polish-server";
import { polishChunksAi } from "@/lib/read/polish-server";
import { translate } from "@/lib/read/translate-server";
import { followupTurn } from "@/lib/self-intro/followup";
import { extractSelfIntro } from "@/lib/self-intro/import-extract";
import { handleFollowup, handleImport } from "@/lib/self-intro/import-handler";
import { setPermissionSnapshot, clearPermissionCache } from "@/lib/permissions";
import { textUsd } from "@/lib/payments/prices";

/**
 * Each paid model path of the reader and self-intro, against a real wallet:
 * charged; not enough → refused before the model; an admin pays like anyone; the user's
 * own AI (BYOK) never reaches our model; a failed call refunded.
 */
let d1: TestD1Database;
const db = () => d1 as unknown as D1WithBatch;
const setBalance = (n: number) =>
  d1.raw().exec(`INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u1', ${n}, 'x')`);
const bal = () => getBalance(db(), "u1");
const reasons = () =>
  (
    d1.raw().prepare("SELECT reason, note FROM credit_ledger ORDER BY rowid").all() as {
      reason: string;
      note: string | null;
    }[]
  ).map((r) => `${r.reason}:${r.note ?? ""}`);

let calls = 0;
const answer =
  (content: string): Complete =>
  async () => {
    calls++;
    return {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    };
  };
const failing: Complete = async () => {
  calls++;
  throw new Error("down");
};
const payer = (complete: Complete, email = "u1@x.com") => ({
  userId: "u1",
  email,
  db: db(),
  complete,
});

beforeEach(() => {
  calls = 0;
  d1 = createTestD1(testSchema());
  d1.raw().exec(
    "INSERT INTO user (id, email, createdAt, updatedAt) VALUES ('u1', 'u1@x.com', 'x', 'x'), ('u9', 'boss@x.com', 'x', 'x')",
  );
  clearPermissionCache();
});

describe("the reader's word meanings (read.gloss)", () => {
  const lem = parseLemmas("#lianki-lemmas v1 fr\nboa\t0s\n");
  const book: BookCtx = { hash: "h1", title: "T", lang: "fr", lem };

  it("charged: held, then settled; the meaning comes back", async () => {
    setBalance(5);
    const ai: GlossAi = payer(answer('{"boa": "boa (snake)"}'));
    const [x] = await fillGlosses(d1, book, [{ w: "boa" }], ai);
    expect(x.back).toBe("boa (snake)");
    expect(ai.refused).toBeUndefined();
    expect(reasons()[0]).toBe("ai:read.gloss");
    expect(await bal()).toBeLessThanOrEqual(5);
  });

  it("not enough: the model is not asked, the refusal is on the payer", async () => {
    const ai: GlossAi = payer(answer('{"boa": "x"}'));
    const [x] = await fillGlosses(d1, book, [{ w: "boa" }], ai);
    expect(x.back ?? null).toBeNull();
    expect(calls).toBe(0);
    expect(ai.refused).toEqual({ balance: 0, need: 1 });
  });

  it("BYOK (own: true → no payer): our model is never asked, nothing charged", async () => {
    await fillGlosses(d1, book, [{ w: "boa" }], null);
    expect(calls).toBe(0);
    expect(reasons()).toEqual([]);
  });

  it("an admin or dev holder pays like anyone: refused with no credits, charged with them", async () => {
    setPermissionSnapshot(
      [
        { email: "boss@x.com", permission: "admin" },
        { email: "boss@x.com", permission: "dev" },
      ],
      Date.now(),
    );
    const boss = (): GlossAi => ({
      userId: "u9",
      email: "boss@x.com",
      db: db(),
      complete: answer('{"boa": "b"}'),
    });
    const refused = boss();
    const [none] = await fillGlosses(d1, book, [{ w: "boa" }], refused);
    expect(none.back ?? null).toBeNull();
    expect(calls).toBe(0);
    expect(refused.refused).toEqual({ balance: 0, need: 1 });
    d1.raw().exec("INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u9', 5, 'x')");
    const [x] = await fillGlosses(d1, book, [{ w: "boa" }], boss());
    expect(x.back).toBe("b");
    expect(reasons()[0]).toBe("ai:read.gloss");
    expect(await getBalance(db(), "u9")).toBeLessThanOrEqual(5);
  });

  it("the model fails: the hold comes back in full", async () => {
    setBalance(5);
    await fillGlosses(d1, book, [{ w: "boa" }], payer(failing));
    expect(await bal()).toBe(5);
    expect(reasons()).toEqual(["ai:read.gloss", "refund:"]);
  });
});

describe("translate, polish, live polish", () => {
  const input = { text: "Bonjour le monde", to: "en", from: "fr" };

  it("translate: charged, and refused with nothing asked when short", async () => {
    expect(await translate(d1, input, payer(answer("Hello world")))).toEqual({
      ok: false,
      error: "no-credits",
      balance: 0,
      need: 1,
      recommended: 1,
    });
    expect(calls).toBe(0);
    setBalance(5);
    expect(await translate(d1, input, payer(answer("Hello world")))).toMatchObject({ ok: true });
    expect(reasons()[0]).toBe("ai:read.translate");
  });

  it("translate: a failed model is refunded", async () => {
    setBalance(5);
    expect(await translate(d1, input, payer(failing))).toMatchObject({ error: "model-failed" });
    expect(await bal()).toBe(5);
  });

  it("polish: refused when short; charged otherwise; a failure refunded", async () => {
    const chunks = [{ text: "hello world how are you", start: 0, end: 1 }] as never;
    expect(await polishChunksAi(chunks, payer(answer("Hello world. How are you?")))).toMatchObject({
      error: "no-credits",
    });
    expect(calls).toBe(0);
    setBalance(5);
    await polishChunksAi(chunks, payer(answer("Hello world. How are you?")));
    expect(reasons()[0]).toBe("ai:read.polish");
    await polishChunksAi(chunks, payer(failing));
    expect(await bal()).toBeGreaterThanOrEqual(4);
  });

  it("live polish: refused when short; charged otherwise", async () => {
    expect(
      await livePolishAi(["um so hello"], "", payer(answer('<p n="1">Hello.</p>'))),
    ).toMatchObject({
      error: "no-credits",
    });
    expect(calls).toBe(0);
    setBalance(5);
    const r = await livePolishAi(["um so hello"], "", payer(answer('<p n="1">Hello.</p>')));
    expect(r.ok).toBe(true);
    expect(reasons()[0]).toBe("ai:read.live-polish");
  });
});

describe("self-intro import and follow-up", () => {
  const facts = '{"facts":[{"field":"hobby","value":"tennis","quote":"tennis"}]}';

  it("import and follow-up: refused when short, charged otherwise", async () => {
    expect(
      await extractSelfIntro({ text: "I play tennis", images: [] }, payer(answer(facts))),
    ).toMatchObject({
      error: "no-credits",
    });
    expect(
      await followupTurn({ facts: [], asked: [], locale: "en" } as never, payer(answer("{}"))),
    ).toMatchObject({ error: "no-credits" });
    expect(calls).toBe(0);
    setBalance(10);
    await extractSelfIntro({ text: "I play tennis", images: [] }, payer(answer(facts)));
    expect(reasons()[0]).toBe("ai:self-intro.import");
  });

  it("the routes answer 402 with the top-up path", async () => {
    const deps = {
      user: { id: "u1", email: "u1@x.com" },
      owner: true,
      flags: {},
      configured: true,
      complete: answer(facts),
      db: db(),
    };
    const post = (path: string, body: unknown) =>
      new Request(`https://lianki.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://lianki.com" },
        body: JSON.stringify(body),
      });
    const r = await handleImport(post("/api/self-intro/import", { text: "I play tennis" }), deps);
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "no-credits", topUp: "/membership" });
    const f = await handleFollowup(
      post("/api/self-intro/followup", { facts: [], asked: [] }),
      deps,
    );
    expect([402, 400]).toContain(f.status);
  });
});

describe("seam helpers", () => {
  it("counts text parts of a prompt; images are held apart", () => {
    expect(
      promptChars([
        { content: "abc" },
        { content: [{ type: "text", text: "de" }, { type: "image_url" }] },
        { content: null },
      ]),
    ).toBe(5);
  });

  it("a delivered answer's price: its tokens, or the whole hold when none are reported", () => {
    const m = "@cf/openai/gpt-oss-120b";
    expect(usageUsd(m, { prompt_tokens: 10, completion_tokens: 2 }, 1)).toBe(textUsd(m, 10, 2));
    expect(usageUsd(m, undefined, 0.5)).toBe(0.5);
  });
});
