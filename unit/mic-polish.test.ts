import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { createToken, DEFAULT_TOKEN_SCOPES, SCOPE_IDS, OWNER_SCOPES } from "@/lib/api-tokens";
import { defaultConfig, CONFIG } from "@/lib/config";
import { FLAGS } from "@/lib/flags";
import { FEATURES } from "@/lib/payments/prices";
import { FEATURES as USAGE_FEATURES } from "@/lib/payments/credit-usage";
import { getBalance, type D1WithBatch } from "@/lib/payments/credits-store";
import { setPermissionSnapshot, clearPermissionCache } from "@/lib/permissions";
import {
  MIC_POLISH_MODEL,
  dailyUsed,
  handleMicPolish,
  micPolishMaxTokens,
  micPolishMessages,
  micPolishText,
  parseMicPolish,
  releaseDailySlot,
  sessionAllowed,
  takeDailySlot,
  utcDayStart,
  type MicComplete,
  type MicPolishConfig,
  type MicPolishDeps,
} from "@/lib/mic-polish";

const NOW = Date.parse("2026-11-18T09:30:00Z");
let d1: TestD1Database;
const db = () => d1 as unknown as D1WithBatch;
let token: string;
let clock: number;
let calls: Record<string, unknown>[];

const setBalance = (n: number) =>
  d1.raw().exec(`INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u1', ${n}, 'x')`);
const bal = () => getBalance(db(), "u1");
const ledger = () =>
  (
    d1.raw().prepare("SELECT reason, amount, note FROM credit_ledger ORDER BY rowid").all() as {
      reason: string;
      amount: number;
      note: string | null;
    }[]
  ).map((r) => `${r.reason}:${r.amount}:${r.note ?? ""}`);

const answer =
  (text: string, delay = 0): MicComplete =>
  async (body) => {
    calls.push(body);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return {
      choices: [{ message: { content: JSON.stringify({ text }) } }],
      usage: { prompt_tokens: 400, completion_tokens: 40 },
    };
  };

const cfg = (over: Partial<MicPolishConfig> = {}): MicPolishConfig => {
  const c = defaultConfig();
  return {
    "mic.polishDailyMax": c["mic.polishDailyMax"],
    "mic.polishPerMinute": c["mic.polishPerMinute"],
    "mic.polishMaxChars": c["mic.polishMaxChars"],
    "mic.polishMaxContextChars": c["mic.polishMaxContextChars"],
    "mic.polishMaxBodyBytes": c["mic.polishMaxBodyBytes"],
    ...over,
  };
};

const deps = (over: Partial<MicPolishDeps> = {}, config = cfg()): MicPolishDeps => ({
  flags: async () => ({ "mic.polish-api": true }),
  d1: db,
  config: async () => config,
  session: async () => null,
  complete: answer("Hello, world."),
  now: () => clock,
  ...over,
});

const req = (
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${token}` },
) =>
  new Request("https://lianki.com/api/mic/polish", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ok = { transcript: "hello world", context: { title: "Docs", site: "example.com" } };

beforeEach(async () => {
  clock = NOW;
  calls = [];
  d1 = createTestD1(testSchema());
  d1.raw().exec(
    "INSERT INTO user (id, email, createdAt, updatedAt) VALUES ('u1', 'u1@x.com', 'x', 'x'), ('u2', 'u2@x.com', 'x', 'x')",
  );
  clearPermissionCache();
  ({ token } = await createToken(
    d1,
    { userId: "u1", email: "u1@x.com" },
    { name: "otoji", scopes: ["mic:polish"], expiresAt: new Date(NOW + 30 * 86_400_000) },
    NOW,
  ));
});

describe("registry", () => {
  it("mic:polish is a scope anyone may pick, never a default, never owner-only", () => {
    expect(SCOPE_IDS).toContain("mic:polish");
    expect(OWNER_SCOPES).not.toContain("mic:polish");
    expect(DEFAULT_TOKEN_SCOPES).not.toContain("mic:polish");
  });
  it("the flag ships off; the feature is metered and shown under speech", () => {
    expect(FLAGS["mic.polish-api"].default).toBe(false);
    expect(FEATURES as readonly string[]).toContain("mic.polish");
    expect(USAGE_FEATURES["mic.polish"]).toEqual({ group: "stt", href: null });
  });
  it("caps are at least what the otoji proxy lets through", () => {
    expect(CONFIG["mic.polishMaxChars"].default).toBeGreaterThanOrEqual(8000);
    expect(CONFIG["mic.polishMaxBodyBytes"].default).toBeGreaterThanOrEqual(32 * 1024);
  });
});

describe("parseMicPolish", () => {
  const caps = cfg({ "mic.polishMaxChars": 20, "mic.polishMaxContextChars": 30 });
  it("takes transcript and context; trims; context may be null or missing", () => {
    expect(parseMicPolish({ transcript: "  hi  ", context: null }, caps)).toEqual({
      ok: true,
      input: { transcript: "hi", context: null },
    });
    expect(parseMicPolish({ transcript: "hi" }, caps)).toEqual({
      ok: true,
      input: { transcript: "hi", context: null },
    });
    expect(parseMicPolish({ transcript: "hi", context: { t: "x" } }, caps)).toMatchObject({
      ok: true,
    });
  });
  it("refuses anything else", () => {
    expect(parseMicPolish(null, caps)).toEqual({ ok: false, error: "bad-input" });
    expect(parseMicPolish([1], caps)).toEqual({ ok: false, error: "bad-input" });
    expect(parseMicPolish({ transcript: "  " }, caps)).toMatchObject({ field: "transcript" });
    expect(parseMicPolish({ transcript: 3 }, caps)).toMatchObject({ error: "bad-input" });
    expect(parseMicPolish({ transcript: "x".repeat(21) }, caps)).toMatchObject({
      error: "too-long",
      field: "transcript",
    });
    expect(parseMicPolish({ transcript: "hi", context: "page" }, caps)).toMatchObject({
      field: "context",
    });
    expect(parseMicPolish({ transcript: "hi", context: [] }, caps)).toMatchObject({
      field: "context",
    });
    expect(parseMicPolish({ transcript: "hi", context: { t: "y".repeat(40) } }, caps)).toEqual({
      ok: false,
      error: "too-long",
      field: "context",
    });
  });
  it("never takes a user id, model or price from the client", () => {
    for (const field of ["userId", "model", "price", "holdUsd", "max_tokens"])
      expect(parseMicPolish({ transcript: "hi", [field]: "x" }, caps)).toEqual({
        ok: false,
        error: "unknown-field",
        field,
      });
  });
});

describe("micPolishText", () => {
  it("reads raw or fenced JSON, drops <think>", () => {
    expect(micPolishText('{"text":" Hi. "}', "hi")).toBe("Hi.");
    expect(micPolishText('```json\n{"text":"Hi."}\n```', "hi")).toBe("Hi.");
    expect(micPolishText('<think>x</think>{"text":"Hi."}', "hi")).toBe("Hi.");
  });
  it("refuses what is not a polish", () => {
    expect(micPolishText(null, "hi")).toBeNull();
    expect(micPolishText("Sure! Hi.", "hi")).toBeNull();
    expect(micPolishText('{"text":""}', "hi")).toBeNull();
    expect(micPolishText('{"txt":"Hi"}', "hi")).toBeNull();
    expect(micPolishText("null", "hi")).toBeNull();
    expect(micPolishText(JSON.stringify({ text: "x".repeat(100) }), "hi")).toBeNull();
  });
  it("messages and ceiling", () => {
    const m = micPolishMessages({ transcript: "a", context: null });
    expect(m[0].role).toBe("system");
    expect(JSON.parse(m[1].content)).toEqual({ transcript: "a", context: null });
    expect(micPolishMaxTokens(10)).toBe(120);
    expect(micPolishMaxTokens(1e6)).toBe(16_000);
  });
});

describe("sessionAllowed", () => {
  const r = (h: Record<string, string>) =>
    new Request("https://lianki.com/api/mic/polish", { method: "POST", headers: h });
  it("our own origin, or no browser marks at all", () => {
    expect(sessionAllowed(r({}))).toBe(true);
    expect(
      sessionAllowed(r({ "sec-fetch-site": "same-origin", origin: "https://lianki.com" })),
    ).toBe(true);
    expect(sessionAllowed(r({ "sec-fetch-site": "none" }))).toBe(true);
  });
  it("never another site's page", () => {
    expect(sessionAllowed(r({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sessionAllowed(r({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(sessionAllowed(r({ origin: "https://otoji.org" }))).toBe(false);
  });
});

describe("the daily slot", () => {
  it("counts per UTC day, refuses at max, restarts the next day, gives back", async () => {
    expect(utcDayStart(NOW)).toBe(Date.parse("2026-11-18T00:00:00Z"));
    expect(await takeDailySlot(d1, "u1", 2, NOW)).toEqual({ ok: true, used: 1, max: 2 });
    expect(await takeDailySlot(d1, "u1", 2, NOW)).toEqual({ ok: true, used: 2, max: 2 });
    expect(await takeDailySlot(d1, "u1", 2, NOW)).toEqual({ ok: false, used: 2, max: 2 });
    // another account has its own count
    expect((await takeDailySlot(d1, "u2", 2, NOW)).ok).toBe(true);
    await releaseDailySlot(d1, "u1", NOW);
    expect(await dailyUsed(d1, "u1", NOW)).toBe(1);
    const tomorrow = Date.parse("2026-11-19T00:00:01Z");
    expect(await dailyUsed(d1, "u1", tomorrow)).toBe(0);
    // yesterday's slot is not given back into today
    await releaseDailySlot(d1, "u1", tomorrow);
    expect(await takeDailySlot(d1, "u1", 2, tomorrow)).toEqual({ ok: true, used: 1, max: 2 });
    expect(await dailyUsed(d1, "u1", NOW)).toBe(0);
  });
  it("a lowered max refuses at once", async () => {
    for (let i = 0; i < 3; i++) await takeDailySlot(d1, "u1", 5, NOW);
    expect((await takeDailySlot(d1, "u1", 2, NOW)).ok).toBe(false);
  });
});

describe("handleMicPolish", () => {
  it("flag off: 404 before anything else", async () => {
    const r = await handleMicPolish(req(ok), deps({ flags: async () => ({}) }));
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("off D1 or without Workers AI: 503", async () => {
    expect((await handleMicPolish(req(ok), deps({ d1: () => null }))).status).toBe(503);
    setBalance(100);
    const r = await handleMicPolish(req(ok), deps({ complete: null }));
    expect(r.status).toBe(503);
    expect(await dailyUsed(d1, "u1", NOW)).toBe(0);
  });

  it("charged: held, settled, the rest refunded; numeric charged and daily", async () => {
    setBalance(100);
    const r = await handleMicPolish(req(ok), deps());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({
      text: "Hello, world.",
      charged: expect.any(Number),
      daily: { used: 1, max: 300 },
    });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(100 - (await bal())).toBe(j.charged);
    const rows = ledger();
    expect(rows[0]).toMatch(/^ai:-\d+:mic\.polish$/);
    expect(rows.some((x) => x.startsWith("refund:"))).toBe(true);
    // the server's model and limits, never the client's
    expect(calls[0].model).toBe(MIC_POLISH_MODEL);
    expect(calls[0].max_tokens).toBe(micPolishMaxTokens(ok.transcript.length));
  });

  it("a client's model or price is refused, never used", async () => {
    setBalance(100);
    for (const extra of [{ model: "@cf/x" }, { price: 0 }, { userId: "u2" }]) {
      const r = await handleMicPolish(req({ ...ok, ...extra }), deps());
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("unknown-field");
    }
    expect(calls).toHaveLength(0);
    expect(await bal()).toBe(100);
  });

  it("an admin pays like anyone", async () => {
    setPermissionSnapshot([{ email: "u1@x.com", permission: "admin" }]);
    setBalance(0);
    const r = await handleMicPolish(req(ok), deps());
    expect(r.status).toBe(402);
    clearPermissionCache();
  });

  describe("auth", () => {
    it("no or bad token: 401; expired: 401", async () => {
      expect((await handleMicPolish(req(ok, {}), deps())).status).toBe(401);
      expect(
        (await handleMicPolish(req(ok, { authorization: "Bearer nope" }), deps())).status,
      ).toBe(401);
      expect((await handleMicPolish(req(ok, { authorization: "Basic x" }), deps())).status).toBe(
        401,
      );
      clock = NOW + 31 * 86_400_000;
      expect((await handleMicPolish(req(ok), deps())).status).toBe(401);
    });
    it("a token without mic:polish: 403 with the one-scope request", async () => {
      const { token: other } = await createToken(
        d1,
        { userId: "u1", email: "u1@x.com" },
        { name: "chat", scopes: ["chat:read"], expiresAt: new Date(NOW + 86_400_000) },
        NOW,
      );
      const r = await handleMicPolish(req(ok, { authorization: `Bearer ${other}` }), deps());
      expect(r.status).toBe(403);
      const j = await r.json();
      expect(j.error).toBe("scope");
      expect(j.needScope).toBe("mic:polish");
      expect(j.requestUrl).toContain("scope=mic%3Apolish");
    });
    it("a session from our own page works; from another site it is refused", async () => {
      setBalance(100);
      const session = async () => ({ id: "u1", email: "u1@x.com" });
      const own = await handleMicPolish(
        req(ok, { origin: "https://lianki.com", "sec-fetch-site": "same-origin" }),
        deps({ session }),
      );
      expect(own.status).toBe(200);
      let asked = false;
      const cross = await handleMicPolish(
        req(ok, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
        deps({ session: async () => ((asked = true), { id: "u1" }) }),
      );
      expect(cross.status).toBe(403);
      expect((await cross.json()).error).toBe("cross-origin");
      expect(asked).toBe(false);
    });
  });

  describe("input", () => {
    it("size caps and bad JSON: 400, nothing held", async () => {
      setBalance(100);
      const small = cfg({ "mic.polishMaxChars": 10, "mic.polishMaxBodyBytes": 4096 });
      const long = await handleMicPolish(req({ transcript: "x".repeat(11) }), deps({}, small));
      expect(long.status).toBe(400);
      expect(await long.json()).toEqual({ error: "too-long", field: "transcript" });
      const big = await handleMicPolish(
        req({ transcript: "x", context: { pad: "y".repeat(5000) } }),
        deps({}, small),
      );
      expect(await big.json()).toEqual({ error: "too-long", field: "body" });
      const declared = await handleMicPolish(
        req(ok, { authorization: `Bearer ${token}`, "content-length": "99999" }),
        deps({}, small),
      );
      expect(declared.status).toBe(400);
      const notJson = await handleMicPolish(req("{nope"), deps());
      expect(await notJson.json()).toEqual({ error: "bad-json" });
      expect(calls).toHaveLength(0);
      expect(await bal()).toBe(100);
      expect(await dailyUsed(d1, "u1", NOW)).toBe(0);
    });
    it("an 8000-character transcript in a 32 KiB body passes with the defaults", async () => {
      setBalance(1000);
      const t = "語".repeat(8000);
      const r = await handleMicPolish(
        req({ transcript: t, context: null }),
        deps({ complete: answer(t) }),
      );
      expect(r.status).toBe(200);
    });
  });

  it("no credits: 402, the model never asked, the daily slot given back", async () => {
    setBalance(0);
    const r = await handleMicPolish(req(ok), deps());
    expect(r.status).toBe(402);
    const j = await r.json();
    expect(j.error).toBe("no-credits");
    expect(j.dailyMax).toBe(300);
    expect(calls).toHaveLength(0);
    expect(await dailyUsed(d1, "u1", NOW)).toBe(0);
  });

  it("paused feature: 503, slot given back", async () => {
    setBalance(100);
    const { PRICES_VERSION } = await import("@/lib/payments/prices");
    d1.raw().exec(
      `INSERT INTO credit_feature_pause (feature, version, usd, holdUsd, createdAt) VALUES ('mic.polish', '${PRICES_VERSION}', 1, 0.5, 'x')`,
    );
    const r = await handleMicPolish(req(ok), deps());
    expect(r.status).toBe(503);
    expect(await dailyUsed(d1, "u1", NOW)).toBe(0);
  });

  it("the model fails or answers nothing usable: 502, refunded in full, slot back", async () => {
    setBalance(100);
    const err = spyOn(console, "error").mockImplementation(() => {});
    const thrown = await handleMicPolish(
      req(ok),
      deps({
        complete: async () => {
          throw new Error("down");
        },
      }),
    );
    expect(thrown.status).toBe(502);
    const junk = await handleMicPolish(
      req(ok),
      deps({ complete: async () => ({ choices: [{ message: { content: "Sure!" } }] }) }),
    );
    expect(junk.status).toBe(502);
    err.mockRestore();
    expect(await bal()).toBe(100);
    expect(await dailyUsed(d1, "u1", NOW)).toBe(0);
  });

  it("a failure before the model: 500, slot back", async () => {
    setBalance(100);
    const err = spyOn(console, "error").mockImplementation(() => {});
    d1.raw().exec("DROP TABLE credit_ai_charge");
    const r = await handleMicPolish(req(ok), deps());
    err.mockRestore();
    expect(r.status).toBe(500);
    expect(await dailyUsed(d1, "u1", NOW)).toBe(0);
  });

  it("no usage reported: charged at the hold", async () => {
    setBalance(100);
    const r = await handleMicPolish(
      req(ok),
      deps({
        complete: async () => ({ choices: [{ message: { content: '{"text":"Hi."}' } }] }),
      }),
    );
    expect(r.status).toBe(200);
    expect((await r.json()).charged).toBeGreaterThanOrEqual(0);
  });

  it("daily limit: 429 under concurrency, exactly max pass, nothing held for the rest", async () => {
    setBalance(1000);
    const d = deps({ complete: answer("Hi.", 5) }, cfg({ "mic.polishDailyMax": 3 }));
    const rs = await Promise.all(Array.from({ length: 8 }, () => handleMicPolish(req(ok), d)));
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    expect(calls).toHaveLength(3);
    const refused = await rs.find((r) => r.status === 429)!.json();
    expect(refused).toEqual({
      error: "daily-limit",
      daily: { used: 3, max: 3 },
      resetAt: "2026-11-19T00:00:00.000Z",
    });
    const used = (await Promise.all(rs.filter((r) => r.status === 200).map((r) => r.json()))).map(
      (j) => j.daily.used,
    );
    expect(used.sort()).toEqual([1, 2, 3]);
    // the holds taken are exactly the three calls'
    expect(ledger().filter((x) => x.startsWith("ai:"))).toHaveLength(3);
  });

  it("rate limit per token: 429 rate-limit with Retry-After", async () => {
    setBalance(1000);
    const d = deps({}, cfg({ "mic.polishPerMinute": 2 }));
    expect((await handleMicPolish(req(ok), d)).status).toBe(200);
    expect((await handleMicPolish(req(ok), d)).status).toBe(200);
    const r = await handleMicPolish(req(ok), d);
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe("rate-limit");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    clock += 61_000;
    expect((await handleMicPolish(req(ok), d)).status).toBe(200);
  });
});
