import { beforeEach, describe, expect, it, spyOn, afterEach } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { getBalance, type D1WithBatch } from "@/lib/payments/credits-store";
import { reserveCredits } from "@/lib/payments/ai-credits";
import { FEATURES } from "@/lib/payments/prices";
import { FEATURES as USAGE_FEATURES } from "@/lib/payments/credit-usage";
import { FLAGS } from "@/lib/flags";
import { PARTNER_AI_MODEL } from "@/lib/partner-ai-config";
import type { Complete } from "@/lib/read/gloss-server";
import { parseWordList } from "@/lib/import/wordlist";
import { TEMPLATES } from "@/lib/import/template";
import { writeXlsx } from "@/lib/import/xlsx";
import { ImportFileError, type FileLike } from "@/lib/self-intro/import-parse";
import {
  AI_IMPORT,
  AiImportRequest,
  ROWS_JSON_SCHEMA,
  aiCalls,
  aiQuota,
  chunkText,
  convertToCsv,
  handleAiConvert,
  handleAiQuota,
  holdUsdFor,
  importAiOn,
  mergeRows,
  minHoldUsd,
  parseRowsAnswer,
  rowsToTemplateCsv,
  type AiImportDeps,
  type AiPayer,
} from "@/lib/import/ai-convert";
import { readAnyFile } from "@/lib/import/ai-read";
import type { AiRow } from "@/lib/import/ai-convert";
import type { ChunkCache } from "@/lib/import/chunk-cache";

/**
 * "AI: any file" (docs/import-material.md): the file's text → the word-list
 * CSV template, through a mocked model; the gate (flag + credits); and the
 * credits path against a real wallet: hold the fixed max, settle, refund, the
 * hold as a hard cap, never below zero. Made-up material only.
 */

let d1: TestD1Database;
const db = () => d1 as unknown as D1WithBatch;
const fund = (n: number) =>
  d1.raw().exec(`INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u1', ${n}, 'x')`);
const bal = () => getBalance(db(), "u1");
const ledger = () =>
  d1.raw().prepare("SELECT reason, amount, note FROM credit_ledger ORDER BY rowid").all() as {
    reason: string;
    amount: number;
    note: string | null;
  }[];

let calls = 0;
let seen: Record<string, unknown>[] = [];
const model =
  (
    content: string | ((i: number) => string),
    usage: { prompt_tokens?: number; completion_tokens?: number } | undefined = {
      prompt_tokens: 100,
      completion_tokens: 20,
    },
  ): Complete =>
  async (body) => {
    const i = calls++;
    seen.push(body);
    return {
      choices: [{ message: { content: typeof content === "string" ? content : content(i) } }],
      usage,
    };
  };
const failing: Complete = async () => {
  calls++;
  throw new Error("down");
};
const ROWS = JSON.stringify({
  rows: [
    { word: "apple", meaning: "a fruit", example: "I eat an apple." },
    { word: "brave, bold", meaning: 'not "afraid"', example: "" },
  ],
});
const notAdmin = () => false;
const payer = (complete: Complete, over: Partial<AiPayer> = {}): AiPayer => ({
  userId: "u1",
  email: "u1@x.com",
  db: db(),
  complete,
  admin: notAdmin,
  log: () => {},
  ...over,
});
const req = (over: Partial<AiImportRequest> = {}): AiImportRequest => ({
  text: "apple - a fruit\nbrave - not afraid",
  images: [],
  locale: "en",
  ...over,
});

let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  calls = 0;
  seen = [];
  d1 = createTestD1(testSchema());
  d1.raw().exec(
    "INSERT INTO user (id, email, createdAt, updatedAt) VALUES ('u1', 'u1@x.com', 'x', 'x')",
  );
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

describe("the CSV conversion contract", () => {
  it("rows → the table import's template: header in the user's language, parsed back by the same parser", () => {
    for (const locale of ["en", "zh-CN", "ar", "xx"]) {
      const rows = parseRowsAnswer(ROWS)!;
      const csv = rowsToTemplateCsv(rows, locale);
      const header =
        (TEMPLATES as Record<string, { header: string[] }>)[locale.split("-")[0]!]?.header ??
        TEMPLATES.en.header;
      expect(csv.split("\r\n")[0]).toBe(header.join(","));
      const parsed = parseWordList(csv, "file.csv");
      expect(parsed.header).toBe(true);
      expect(parsed.rows.map((r) => [r.term, r.back, r.ex ?? ""])).toEqual([
        ["apple", "a fruit", "I eat an apple."],
        ["brave, bold", 'not "afraid"', ""],
      ]);
    }
  });

  it("reads the model's answer: a fence tolerated, rows without a word dropped, cells one clipped line", () => {
    const long = "m".repeat(AI_IMPORT.maxCellChars.meaning + 50);
    const rows = parseRowsAnswer(
      "```json\n" +
        JSON.stringify({
          rows: [
            { word: "  big\n cat ", meaning: long },
            { word: "", meaning: "x" },
            { meaning: "no word" },
            "junk",
          ],
        }) +
        "\n```",
    )!;
    expect(rows).toEqual([
      { word: "big cat", meaning: "m".repeat(AI_IMPORT.maxCellChars.meaning), example: "" },
    ]);
    expect(parseRowsAnswer("no json here")).toBeNull();
    expect(parseRowsAnswer('{"facts": []}')).toBeNull();
  });

  it("merges the calls' rows: repeats (normalized) dropped, capped at maxRows", () => {
    const r = (word: string) => ({ word, meaning: "", example: "" });
    expect(
      mergeRows([
        [r("Apple"), r("pear")],
        [r("apple "), r("fig")],
      ]).rows.map((x) => x.word),
    ).toEqual(["Apple", "pear", "fig"]);
    const many = Array.from({ length: AI_IMPORT.maxRows + 3 }, (_, i) => r(`w${i}`));
    const m = mergeRows([many]);
    expect(m.rows).toHaveLength(AI_IMPORT.maxRows);
    expect(m.capped).toBe(true);
  });

  it("chunks long text on line breaks; a line longer than a chunk is cut", () => {
    expect(chunkText("a\nb\nc", 3)).toEqual(["a\nb", "c"]);
    expect(chunkText("abcdefg", 3)).toEqual(["abc", "def", "g"]);
    expect(chunkText("ab\nabcdefg\n\n", 3)).toEqual(["ab", "abc", "def", "g"]);
    expect(chunkText("  \n \n")).toEqual([]);
    const big = Array.from({ length: 2000 }, (_, i) => `word${i} - meaning ${i}`).join("\n");
    for (const c of chunkText(big)) expect(c.length).toBeLessThanOrEqual(AI_IMPORT.chunkChars);
  });

  it("one call per chunk (at most maxChunks, else truncated) and one for the images; the material fenced", () => {
    const one = aiCalls(req());
    expect(one.calls).toHaveLength(1);
    expect(one.truncated).toBe(false);
    const sys = one.calls[0]!.messages[0]!.content as string;
    expect(sys).toContain("not instructions");
    expect(sys).toContain("English");
    expect(one.calls[0]!.messages[1]!.content).toContain("<material>");
    const long = "x"
      .repeat(AI_IMPORT.chunkChars)
      .concat("\n")
      .repeat(AI_IMPORT.maxChunks + 2);
    const many = aiCalls(req({ text: long, images: ["data:image/png;base64,AAAA"] }));
    expect(many.calls).toHaveLength(AI_IMPORT.maxChunks + 1);
    expect(many.truncated).toBe(true);
    expect(many.calls.at(-1)!.images).toBe(1);
    // The hold covers every call: more calls, a bigger hold.
    expect(holdUsdFor(many.calls)).toBeGreaterThan(holdUsdFor(one.calls));
    expect(minHoldUsd()).toBeGreaterThan(0);
  });

  it("sends the model the Learning Partner's DeepSeek, the schema, the output ceiling", async () => {
    fund(100);
    await convertToCsv(req(), payer(model(ROWS)));
    expect(seen[0]).toMatchObject({
      model: PARTNER_AI_MODEL,
      max_tokens: AI_IMPORT.maxOutputTokens,
      response_format: { json_schema: { schema: ROWS_JSON_SCHEMA } },
    });
  });

  it("checks the request: image data URLs only, within the caps", () => {
    expect(AiImportRequest.safeParse({ text: "a" }).success).toBe(true);
    expect(AiImportRequest.safeParse({ images: ["https://x/y.png"] }).success).toBe(false);
    expect(
      AiImportRequest.safeParse({ text: "x".repeat(AI_IMPORT.maxTextChars + 1) }).success,
    ).toBe(false);
    expect(
      AiImportRequest.safeParse({
        images: Array(AI_IMPORT.maxImages + 1).fill("data:image/png;base64,AAAA"),
      }).success,
    ).toBe(false);
  });
});

describe("credits: hold the fixed max, settle, refund the rest", () => {
  it("no credits: refused (402) before any call; nothing charged", async () => {
    const r = await convertToCsv(req(), payer(model(ROWS)));
    expect(calls).toBe(0);
    expect("refused" in r && r.refused.status).toBe(402);
    expect(ledger()).toEqual([]);
  });

  it("charged: the hold is debited, the real cost kept, the rest refunded; the CSV comes back", async () => {
    fund(100);
    const r = await convertToCsv(req(), payer(model(ROWS)));
    expect(r).toMatchObject({ ok: true, rows: 2, truncated: false });
    if (!r.ok || "refused" in r) throw new Error("expected ok");
    expect(r.csv.split("\r\n")).toHaveLength(3);
    const hold = reserveCredits(holdUsdFor(aiCalls(req()).calls));
    const rows = ledger();
    expect(rows[0]).toMatchObject({ reason: "ai", amount: -hold, note: "words.import-ai" });
    expect(rows.some((x) => x.reason === "refund")).toBe(true);
    expect(await bal()).toBe(100 - r.charged);
    expect(r.charged).toBeLessThanOrEqual(hold);
  });

  it("never shrinks the max: below one call's hold → 402 with the need, the recommended for all, the balance", async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `term${i} meaning${i}`).join("\n");
    const all = aiCalls(req({ text: long })).calls;
    expect(all.length).toBeGreaterThan(1);
    const need = reserveCredits(holdUsdFor([all[0]!]));
    fund(need - 1);
    const r = await convertToCsv(req({ text: long }), payer(model(ROWS)));
    expect("refused" in r).toBe(true);
    if (!("refused" in r)) return;
    const body = (await r.refused.json()) as Record<string, number>;
    expect(body).toMatchObject({ error: "no-credits", need, have: need - 1, completed: 0 });
    expect(body.total).toBe(all.length);
    // Too little history: the recommended is every call's most.
    expect(body.recommended).toBeGreaterThanOrEqual(need * all.length);
    expect(r.refused.headers.get("x-lianki-credits-recommended")).toBe(String(body.recommended));
    expect(calls).toBe(0);
    expect(await bal()).toBe(need - 1);
  });

  it("a failed call keeps nothing: refunded in full", async () => {
    fund(50);
    expect(await convertToCsv(req(), payer(failing))).toEqual({
      ok: false,
      error: "model-failed",
    });
    expect(await bal()).toBe(50);
  });

  it("an answer with no rows keeps nothing", async () => {
    fund(50);
    expect(await convertToCsv(req(), payer(model('{"rows": []}')))).toEqual({
      ok: false,
      error: "nothing-found",
    });
    expect(await bal()).toBe(50);
  });

  it("empty material: no hold, no call", async () => {
    fund(50);
    expect(await convertToCsv(req({ text: " " }), payer(model(ROWS)))).toEqual({
      ok: false,
      error: "empty",
    });
    expect(calls).toBe(0);
    expect(ledger()).toEqual([]);
  });

  it("each hold is a hard cap: an overrun is charged at most its hold, pauses the feature, stops the rest; never below zero", async () => {
    const long = "y"
      .repeat(AI_IMPORT.chunkChars)
      .concat("\n")
      .repeat(AI_IMPORT.parallel * 2);
    const all = aiCalls(req({ text: long })).calls;
    const holds = all.map((c) => reserveCredits(holdUsdFor([c])));
    const start = holds.reduce((n, h) => n + h, 0);
    fund(start);
    const log: Record<string, unknown>[] = [];
    // Pricing drift: each call reports far more tokens than any hold covers.
    const r = await convertToCsv(
      req({ text: long }),
      payer(model(ROWS, { prompt_tokens: 50_000_000, completion_tokens: 0 }), {
        log: (o) => log.push(o),
      }),
    );
    expect(calls).toBe(AI_IMPORT.parallel); // the second round never ran
    // Paused after the overage: the rest is refused (503), nothing charged past the holds.
    expect("refused" in r && r.refused.status).toBe(503);
    const spent = start - (await bal());
    const roundHolds = holds.slice(0, AI_IMPORT.parallel).reduce((n, h) => n + h, 0);
    expect(spent).toBeLessThanOrEqual(roundHolds);
    expect(spent).toBeGreaterThanOrEqual(roundHolds - AI_IMPORT.parallel);
    expect(await bal()).toBeGreaterThanOrEqual(0);
    expect(log.some((o) => o.event === "credits.overage")).toBe(true);
    const paused = d1.raw().prepare("SELECT feature FROM credit_feature_pause").all();
    expect(paused).toEqual([{ feature: "words.import-ai" }]);
    const next = await convertToCsv(req(), payer(model(ROWS)));
    expect("refused" in next && next.refused.status).toBe(503);
  });

  it("resume: a run stopped for credits keeps its paid chunks; after a top-up only the rest is paid", async () => {
    const mem = new Map<string, AiRow[]>();
    const cache: ChunkCache = {
      get: async (u, f, h) => mem.get(`${u}/${f}/${h}`) ?? null,
      put: async (u, f, h, rows) => void mem.set(`${u}/${f}/${h}`, rows),
    };
    const two = "a - one\n".repeat(AI_IMPORT.chunkChars / 8) + "b - two";
    const all = aiCalls(req({ text: two })).calls;
    expect(all).toHaveLength(2);
    const first = reserveCredits(holdUsdFor([all[0]!]));
    fund(first); // enough for one call only
    const answer = (i: number) =>
      JSON.stringify({ rows: [{ word: i === 0 ? "alpha" : "beta", meaning: "m", example: "" }] });
    const p1 = payer(model(answer), { cache, fileId: "f".repeat(20) });
    const stopped = await convertToCsv(req({ text: two }), p1);
    expect("refused" in stopped && stopped.refused.status).toBe(402);
    if (!("refused" in stopped)) return;
    expect(await stopped.refused.json()).toMatchObject({ completed: 1, total: 2 });
    expect(calls).toBe(1);
    expect(mem.size).toBe(1);
    // Top up, run again: the finished chunk comes from the cache, one call is paid.
    d1.raw().exec("UPDATE credit_balance SET balance = balance + 100 WHERE userId = 'u1'");
    const before = await bal();
    const done = await convertToCsv(req({ text: two }), p1);
    expect(done).toMatchObject({ ok: true, rows: 2, reused: 1 });
    expect(calls).toBe(2);
    if (!done.ok || "refused" in done) return;
    expect(before - (await bal())).toBe(done.charged);
    expect(done.csv).toContain("alpha");
    expect(done.csv).toContain("beta");
  });

  it("an admin pays nothing; no wallet (local dev) runs unmetered", async () => {
    const a = await convertToCsv(req(), payer(model(ROWS), { admin: () => true }));
    expect(a).toMatchObject({ ok: true, charged: 0 });
    const u = await convertToCsv(req(), payer(model(ROWS), { db: null }));
    expect(u).toMatchObject({ ok: true, charged: 0 });
    expect(ledger()).toEqual([]);
  });

  it("is a known feature, shown on the usage page", () => {
    expect(FEATURES as readonly string[]).toContain(AI_IMPORT.feature);
    expect(USAGE_FEATURES[AI_IMPORT.feature]).toEqual({ group: "ai", href: "/words" });
  });
});

describe("the gate: flag (owner audience) and credits", () => {
  const base = (over: Partial<AiImportDeps> = {}): AiImportDeps => ({
    user: { id: "u1", email: "u1@x.com" },
    owner: true,
    flags: { "words.import-ai": true },
    configured: true,
    complete: model(ROWS),
    db: db(),
    admin: notAdmin,
    readFile: async () => null,
    ...over,
  });

  it("the flag: default off, no owner audience; off → dev holders, on → everyone", () => {
    expect(FLAGS["words.import-ai"].default).toBe(false);
    expect("audience" in FLAGS["words.import-ai"]).toBe(false);
    expect(importAiOn({}, true)).toBe(true);
    expect(importAiOn({}, false)).toBe(false);
    expect(importAiOn({ "words.import-ai": true }, false)).toBe(true);
  });

  it("hidden without credits; shown with enough for the smallest hold, for an admin, unmetered", async () => {
    expect(await aiQuota(base())).toEqual({ on: true, available: false });
    fund(reserveCredits(minHoldUsd()));
    expect(await aiQuota(base())).toEqual({ on: true, available: true });
    expect(await aiQuota(base({ db: null }))).toEqual({ on: true, available: true });
    d1.raw().exec("DELETE FROM credit_balance");
    expect(await aiQuota(base({ admin: () => true }))).toEqual({ on: true, available: true });
    // Not a dev holder with the flag on: on, credits decide.
    expect(await aiQuota(base({ owner: false, admin: () => true }))).toEqual({
      on: true,
      available: true,
    });
    for (const off of [{ flags: {}, owner: false }, { configured: false }, { user: null }])
      expect(await aiQuota(base(off))).toEqual({ on: false, available: false });
  });

  it("GET answers the same; a guest 401", async () => {
    expect(await (await handleAiQuota(base())).json()).toEqual({ on: true, available: false });
    expect((await handleAiQuota(base({ user: null }))).status).toBe(401);
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://lianki.com/api/import/ai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://lianki.com",
        host: "lianki.com",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const ID = "0123456789abcdef0123";
  const stored = (name: string, type: string, data: string | Uint8Array) => ({
    readFile: async (userId: string, id: string) =>
      userId === "u1" && id === ID
        ? {
            name,
            type,
            bytes: typeof data === "string" ? new TextEncoder().encode(data) : data,
          }
        : null,
  });
  const words = stored("lesson.txt", "text/plain", "apple - a fruit");

  it("POST: 402 without credits (the top-up path), the CSV with them", async () => {
    const r = await handleAiConvert(post({ fileId: ID }), base(words));
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "no-credits", topUp: "/membership" });
    expect(calls).toBe(0);
    fund(100);
    const ok = await handleAiConvert(post({ fileId: ID, locale: "zh" }), base(words));
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as { csv: string; rows: number };
    expect(b.rows).toBe(2);
    expect(b.csv.startsWith(TEMPLATES.zh.header.join(","))).toBe(true);
    expect(JSON.stringify(seen[0])).toContain("apple - a fruit");
  });

  it("POST reads the stored file by its extension first: a Word file sniffed as zip, HTML stored as text", async () => {
    fund(100);
    const html = stored("page.html", "text/plain", "<p>chat</p><script>x()</script><p>chien</p>");
    expect((await handleAiConvert(post({ fileId: ID }), base(html))).status).toBe(200);
    const sent = JSON.stringify(seen.at(-1));
    expect(sent).toContain("chat\\nchien");
    expect(sent).not.toContain("<script>");
  });

  it("POST sends a stored photo as an image; an unusable one is named", async () => {
    fund(100);
    const png = stored("p.png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect((await handleAiConvert(post({ fileId: ID }), base(png))).status).toBe(200);
    expect(JSON.stringify(seen.at(-1))).toContain("data:image/png;base64,iVBORw==");
    const gif = stored("a.gif", "image/gif", "GIF89a");
    const r = await handleAiConvert(post({ fileId: ID }), base(gif));
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "unsupported" });
    const huge = stored("big.jpg", "image/jpeg", new Uint8Array(AI_IMPORT.maxImageChars));
    expect((await handleAiConvert(post({ fileId: ID }), base(huge))).status).toBe(413);
    const video = stored("v.mp4", "video/mp4", "x");
    expect((await handleAiConvert(post({ fileId: ID }), base(video))).status).toBe(422);
  });

  it("POST refuses: cross-site, guest, gate off, too large, bad JSON, bad id, not theirs, empty, not configured, a failed model", async () => {
    fund(1000);
    const st = async (r: Request, d = base(words)) => (await handleAiConvert(r, d)).status;
    const ok = { fileId: ID };
    expect(await st(post(ok, { origin: "https://evil.example" }))).toBe(403);
    expect(await st(post(ok), base({ ...words, user: null }))).toBe(401);
    expect(await st(post(ok), base({ ...words, flags: {}, owner: false }))).toBe(404);
    expect(await st(post(ok, { "content-length": String(AI_IMPORT.maxBodyBytes + 1) }))).toBe(413);
    expect(await st(post({ fileId: ID, pad: "x".repeat(AI_IMPORT.maxBodyBytes) }))).toBe(413);
    expect(await st(post("{nope"))).toBe(400);
    expect(await st(post({ fileId: "../../etc" }))).toBe(400);
    expect(await st(post({ fileId: "f".repeat(20) }))).toBe(404);
    expect(await st(post(ok), base(stored("e.txt", "text/plain", "   ")))).toBe(422);
    expect(await st(post(ok), base({ ...words, configured: false }))).toBe(503);
    expect(await st(post(ok), base({ ...words, complete: failing }))).toBe(502);
    expect(await bal()).toBe(1000);
  });

  it("POST is rate-limited per user", async () => {
    fund(10_000);
    const d = base({ ...words, user: { id: "u1", email: "rate@x.com" }, admin: () => true });
    let last = 0;
    for (let i = 0; i <= AI_IMPORT.rate.max; i++)
      last = (await handleAiConvert(post({ fileId: ID }), d)).status;
    expect(last).toBe(429);
  });
});

const fileOf = (name: string, type: string, data: Uint8Array | string): FileLike => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
};

describe("reading a stored file (the existing readers)", () => {
  it("text, HTML and subtitles with no type", async () => {
    expect(await readAnyFile(fileOf("a.txt", "text/plain", "apple\npear"))).toEqual({
      text: "apple\npear",
      images: [],
      truncated: false,
    });
    expect((await readAnyFile(fileOf("p.html", "text/html", "<p>chat</p><p>chien</p>"))).text).toBe(
      "chat\nchien",
    );
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nBonjour le monde\n";
    expect((await readAnyFile(fileOf("film.srt", "", srt))).text).toContain("Bonjour le monde");
  });

  it("an .xlsx: its first sheet as CSV; a broken one is unreadable", async () => {
    const x = await writeXlsx([
      ["Word", "Meaning"],
      ["apple", "a fruit"],
    ]);
    expect((await readAnyFile(fileOf("w.xlsx", "", x as Uint8Array))).text).toBe(
      "Word,Meaning\r\napple,a fruit",
    );
    await expect(readAnyFile(fileOf("w.xlsx", "", "not a zip"))).rejects.toMatchObject({
      code: "unreadable",
    });
  });

  it("an image goes to the page's shrinker; at most maxImages", async () => {
    const r = await readAnyFile(fileOf("p.png", "image/png", new Uint8Array([1, 2])), {
      shrinkImage: async () => "data:image/jpeg;base64,AAAA",
    });
    expect(r).toEqual({ text: "", images: ["data:image/jpeg;base64,AAAA"], truncated: false });
  });

  it("long text is cut and says so; too large, unsupported and empty are named", async () => {
    const long = await readAnyFile(
      fileOf("l.txt", "text/plain", "a".repeat(AI_IMPORT.maxTextChars + 5)),
    );
    expect(long.text).toHaveLength(AI_IMPORT.maxTextChars);
    expect(long.truncated).toBe(true);
    const big = { ...fileOf("b.txt", "text/plain", "x"), size: AI_IMPORT.maxFileBytes + 1 };
    await expect(readAnyFile(big)).rejects.toBeInstanceOf(ImportFileError);
    await expect(readAnyFile(big)).rejects.toMatchObject({ code: "too-large" });
    await expect(readAnyFile(fileOf("v.mp4", "video/mp4", "x"))).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(readAnyFile(fileOf("e.txt", "text/plain", "   "))).rejects.toMatchObject({
      code: "empty",
    });
  });
});
