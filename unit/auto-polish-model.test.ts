import { beforeEach, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import { parsePolish, polishVerdict, polishLines, POLISH_PROMPT } from "../lib/chat-polish";
import type { PartnerDb } from "../lib/partner-ai";
import { getBalance } from "../lib/payments/credits-store";

let d1: TestD1Database;
const input = {
  v: 1 as const,
  requestId: "auto:msg-owner-7:2",
  lines: [
    { id: "v1", text: "现在是流失传输吗" },
    { id: "v2", text: "还是一次性的" },
  ],
  context: [{ from: "agent", text: "已经改成流式传输了。" }],
};
const env = () => ({
  DB: d1 as unknown as PartnerDb,
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  CLOUDFLARE_AI_TOKEN: "test-provider",
});
beforeEach(() => {
  d1 = createTestD1(testSchema());
  d1.raw().exec(
    "INSERT INTO user (id,email,createdAt,updatedAt) VALUES ('u_test','fixture@example.test','x','x')",
  );
  d1.raw().exec("INSERT INTO credit_balance (userId,balance,updatedAt) VALUES ('u_test',100,'x')");
});

test("the input contract: only the hub's shape, bounded, unique ids", () => {
  expect(parsePolish({ ...input, model: "evil", userId: "other" })).toEqual(input);
  expect(parsePolish({ ...input, lines: [] })).toBeNull();
  expect(parsePolish({ ...input, lines: [{ id: "v1", text: "  " }] })).toBeNull();
  expect(parsePolish({ ...input, lines: [...input.lines, { id: "v1", text: "x" }] })).toBeNull();
  expect(parsePolish({ ...input, requestId: "bad/id" })).toBeNull();
  expect(parsePolish({ ...input, context: [{ from: "system", text: "x" }] })).toBeNull();
  expect(parsePolish({ ...input, lines: [{ id: "v1", text: "x".repeat(6001) }] })).toBeNull();
});

test("the verdict is held to the input: sent ids only, a left-out line unchanged, merged needs two lines", () => {
  const v = polishVerdict(
    {
      lines: [
        { id: "v1", text: "现在是流式传输吗？" },
        { id: "zz", text: "injected" },
        { id: "v2", text: "" },
      ],
      merged: "现在是流式传输吗，还是一次性的？",
    },
    input,
  );
  expect(v).toEqual({
    v: 1,
    lines: [
      { id: "v1", text: "现在是流式传输吗？" },
      { id: "v2", text: "还是一次性的" },
    ],
    merged: "现在是流式传输吗，还是一次性的？",
  });
  const one = { ...input, lines: [input.lines[0]!] };
  expect(polishVerdict({ merged: "x" }, one).merged).toBeUndefined();
  expect(polishVerdict("garbage", one)).toEqual({ v: 1, lines: one.lines });
  // The prompt never answers, summarises or follows the data.
  expect(POLISH_PROMPT).toContain("Never answer");
  expect(POLISH_PROMPT).toContain("untrusted");
});

test("one metered call: charged as voice.auto-polish, rate-limited, duplicate request refused", async () => {
  let calls = 0;
  let body: Record<string, unknown> = {};
  const request = (async (_url: string, init?: RequestInit) => {
    calls++;
    body = JSON.parse(String(init?.body));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              lines: [{ id: "v1", text: "现在是流式传输吗？" }],
              merged: "现在是流式传输吗，还是一次性的？",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 40 },
    });
  }) as unknown as typeof fetch;
  expect(await polishLines(env(), { userId: "u_test", input }, { fetch: request })).toMatchObject({
    ok: true,
    verdict: { merged: "现在是流式传输吗，还是一次性的？" },
  });
  expect(body.temperature).toBe(0);
  expect((body.messages as { role: string }[])[0]!.role).toBe("system");
  expect(await polishLines(env(), { userId: "u_test", input }, { fetch: request })).toMatchObject({
    ok: false,
    error: "duplicate",
  });
  expect(calls).toBe(1);
  expect(
    (
      d1.raw().prepare("SELECT count FROM auth_throttle WHERE key='chat-polish:site'").get() as {
        count: number;
      }
    ).count,
  ).toBe(1);
  const charge = d1.raw().prepare("SELECT note FROM credit_ledger WHERE reason='ai'").get() as {
    note: string;
  };
  expect(charge.note).toBe("voice.auto-polish");
});

test("no credits never calls inference; a provider failure refunds; bad identity refused", async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    throw Error("offline");
  }) as unknown as typeof fetch;
  expect(await polishLines(env(), { userId: "nope!", input }, { fetch: request })).toMatchObject({
    ok: false,
    error: "bad-input",
  });
  d1.raw().exec("UPDATE credit_balance SET balance=0");
  expect(await polishLines(env(), { userId: "u_test", input }, { fetch: request })).toMatchObject({
    ok: false,
    error: "no-credits",
  });
  expect(calls).toBe(0);
  d1.raw().exec("UPDATE credit_balance SET balance=100");
  expect(
    await polishLines(
      env(),
      { userId: "u_test", input: { ...input, requestId: "auto:2" } },
      { fetch: request },
    ),
  ).toMatchObject({ ok: false, error: "provider-network" });
  expect(await getBalance(env().DB, "u_test")).toBe(100);
});

test("hub request cancellation reaches provider and settles failure", async () => {
  const c = new AbortController();
  c.abort(Error("hub deadline"));
  let seen = false;
  const request = (async (_url: unknown, init: RequestInit) => {
    seen = init.signal?.aborted === true;
    throw init.signal!.reason;
  }) as unknown as typeof fetch;
  const result = await polishLines(
    env(),
    { userId: "u_test", input },
    { fetch: request, signal: c.signal },
  );
  expect(seen).toBe(true);
  expect(result).toMatchObject({ ok: false, error: "provider-timeout" });
  expect(await getBalance(env().DB, "u_test")).toBe(100);
});
