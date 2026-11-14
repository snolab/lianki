import { beforeEach, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import { parsePrepare, prepareVerdict, prepareChatTurn } from "../lib/chat-prepare";
import type { PartnerDb } from "../lib/partner-ai";
import { getBalance } from "../lib/payments/credits-store";

let d1: TestD1Database;
const input = { v: 1 as const, requestId: "req-1", text: "不要删除按钮然后改成蓝色", context: [] };
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
test("fixed input contract rejects arbitrary provider/prompt and bounds context", () => {
  expect(parsePrepare({ ...input, model: "evil", userId: "other" })).toEqual(input);
  expect(parsePrepare({ ...input, text: "x".repeat(6001) })).toBeNull();
  expect(parsePrepare({ ...input, requestId: "bad/id" })).toBeNull();
  expect(
    parsePrepare({ ...input, context: [{ from: "x".repeat(5000), text: "hello" }] }),
  ).toBeFalsy();
  expect(
    parsePrepare({
      ...input,
      text: "x".repeat(6000),
      context: [
        { from: "user", text: "x".repeat(2000) },
        { from: "user", text: "x".repeat(2000) },
      ],
    }),
  ).toBeNull();
  expect(
    prepareVerdict({ action: "ignore", confidence: "uncertain", reason: "household" }, input)
      .action,
  ).toBe("forward");
});
test("polish is unrestricted (owner, 2026-11-14): any non-empty text is kept", () => {
  const contextual = { ...input, context: [{ from: "owner", text: "按钮" }] };
  expect(parsePrepare(contextual)).toEqual(contextual);
  expect(
    prepareVerdict(
      { action: "ignore", confidence: "high", reason: "household", polished: contextual.text },
      contextual,
    ).action,
  ).toBe("ignore");
  expect(
    prepareVerdict({ action: "forward", polished: "删除按钮然后改成蓝色" }, input).polished,
  ).toBe("删除按钮然后改成蓝色");
  expect(prepareVerdict({ action: "forward", polished: "  " }, input).polished).toBeUndefined();
  expect(
    prepareVerdict(
      { action: "forward", polished: "不要删除按钮，然后改成蓝色。", turn: "complete" },
      input,
    ).polished,
  ).toBe("不要删除按钮，然后改成蓝色。");
});
test("cloud prepare reserves, calls fixed DeepSeek with no reasoning, settles and deduplicates per account", async () => {
  let calls = 0;
  const request = (async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    expect(body.model).toContain("deepseek");
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages[1].content).not.toContain("userId");
    expect(await getBalance(env().DB, "u_test")).toBeLessThan(100);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: "forward",
              turn: "complete",
              polished: "不要删除按钮，然后改成蓝色。",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 40 },
    });
  }) as unknown as typeof fetch;
  expect(
    await prepareChatTurn(env(), { userId: "u_test", input }, { fetch: request }),
  ).toMatchObject({ ok: true, verdict: { action: "forward", turn: "complete" } });
  expect(
    await prepareChatTurn(env(), { userId: "u_test", input }, { fetch: request }),
  ).toMatchObject({ ok: false, error: "duplicate" });
  expect(calls).toBe(1);
  expect(
    (
      d1.raw().prepare("SELECT count FROM auth_throttle WHERE key='chat-prepare:site'").get() as {
        count: number;
      }
    ).count,
  ).toBe(1);
  const charge = d1.raw().prepare("SELECT note FROM credit_ledger WHERE reason='ai'").get() as {
    note: string;
  };
  expect(charge.note).toBe("chat.prepare");
});
test("no credits never calls inference; provider failure refunds", async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    throw Error("offline");
  }) as unknown as typeof fetch;
  d1.raw().exec("UPDATE credit_balance SET balance=0");
  expect(
    await prepareChatTurn(env(), { userId: "u_test", input }, { fetch: request }),
  ).toMatchObject({ ok: false, error: "no-credits" });
  expect(calls).toBe(0);
  expect(
    d1.raw().prepare("SELECT count FROM auth_throttle WHERE key='chat-prepare:site'").get(),
  ).toBeFalsy();
  d1.raw().exec("UPDATE credit_balance SET balance=100");
  expect(
    await prepareChatTurn(
      env(),
      { userId: "u_test", input: { ...input, requestId: "req-2" } },
      { fetch: request },
    ),
  ).toMatchObject({ ok: false, error: "provider-network" });
  expect(await getBalance(env().DB, "u_test")).toBe(100);
});
test("D1 limits apply across request IDs before a provider call", async () => {
  d1.raw()
    .prepare(
      "INSERT INTO config_values (key,value_json,updated_at,updated_by) VALUES (?,?,1,'test')",
    )
    .run("chat.prepareUserCalls", "1");
  const request = (async () =>
    Response.json({
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })) as unknown as typeof fetch;
  await prepareChatTurn(env(), { userId: "u_test", input }, { fetch: request });
  expect(
    await prepareChatTurn(
      env(),
      { userId: "u_test", input: { ...input, requestId: "req-2" } },
      { fetch: request },
    ),
  ).toMatchObject({ ok: false, error: "rate" });
});

const answer = JSON.stringify({ action: "forward", turn: "complete", polished: input.text });
const envelope = (content: string) =>
  Response.json({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  });
for (const [name, request, expected] of [
  [
    "provider HTTP rejection",
    async () => new Response("SECRET-provider-body", { status: 403 }),
    { error: "provider-http", status: 403 },
  ],
  [
    "provider throttling",
    async () => new Response("SECRET-provider-body", { status: 429 }),
    { error: "provider-http", status: 429 },
  ],
  [
    "invalid provider envelope JSON",
    async () => new Response("SECRET-provider-body"),
    { error: "provider-invalid-json" },
  ],
  [
    "invalid model JSON",
    async () => envelope("SECRET-provider-body"),
    { error: "provider-invalid-json" },
  ],
  [
    "prose around a JSON fence",
    async () => envelope("explanation\n```json\n" + answer + "\n```"),
    { error: "provider-invalid-json" },
  ],
  [
    "non-JSON code fence",
    async () => envelope("```javascript\n" + answer + "\n```"),
    { error: "provider-invalid-json" },
  ],
  [
    "missing content",
    async () => Response.json({ choices: [] }),
    { error: "provider-invalid-response" },
  ],
  [
    "refusal",
    async () => Response.json({ choices: [{ message: { refusal: "SECRET-provider-body" } }] }),
    { error: "provider-refused" },
  ],
] as const) {
  test(`${name} returns safe diagnostics and refunds`, async () => {
    const result = await prepareChatTurn(
      env(),
      { userId: "u_test", input },
      { fetch: request as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: false, ...expected });
    expect(JSON.stringify(result)).not.toContain("SECRET-provider-body");
    expect(await getBalance(env().DB, "u_test")).toBe(100);
  });
}
test("a complete json fence is accepted and settles usage", async () => {
  const result = await prepareChatTurn(
    env(),
    { userId: "u_test", input },
    {
      fetch: (async () => envelope("  ```json\n" + answer + "\n```  ")) as unknown as typeof fetch,
    },
  );
  expect(result).toMatchObject({ ok: true, verdict: { turn: "complete", polished: input.text } });
  expect(d1.raw().prepare("SELECT note FROM credit_ledger WHERE reason='ai'").get()).toMatchObject({
    note: "chat.prepare",
  });
});
test("default provider deadline allows responses slower than the old 1500ms budget", async () => {
  const result = await prepareChatTurn(
    env(),
    { userId: "u_test", input },
    {
      fetch: (async (_url: unknown, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(envelope(answer)), 1650);
          init.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal!.reason);
            },
            { once: true },
          );
        })) as typeof fetch,
    },
  );
  expect(result).toMatchObject({ ok: true });
}, 4000);
for (const phase of ["fetch", "body"] as const) {
  test(`provider timeout during ${phase} is identifiable and refunds`, async () => {
    d1.raw()
      .prepare(
        "INSERT INTO config_values(key,value_json,updated_at,updated_by) VALUES(?,?,1,'test')",
      )
      .run("chat.prepareTimeoutMs", "200");
    const request = (async (_url: unknown, init: RequestInit) => {
      const wait = () =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(envelope(answer)), 1000);
          init.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal!.reason);
            },
            { once: true },
          );
        });
      if (phase === "fetch") return wait();
      const res = envelope(answer);
      res.json = async () => {
        await wait();
        return {};
      };
      return res;
    }) as typeof fetch;
    expect(await prepareChatTurn(env(), { userId: "u_test", input }, { fetch: request })).toEqual({
      ok: false,
      error: "provider-timeout",
    });
    expect(await getBalance(env().DB, "u_test")).toBe(100);
  });
}

test("hub request cancellation reaches provider and settles failure", async () => {
  const c = new AbortController();
  c.abort(Error("hub deadline"));
  let seen = false;
  const request = (async (_url: unknown, init: RequestInit) => {
    seen = init.signal?.aborted === true;
    throw init.signal!.reason;
  }) as unknown as typeof fetch;
  const result = await prepareChatTurn(
    env(),
    { userId: "u_test", input },
    { fetch: request, signal: c.signal },
  );
  expect(seen).toBe(true);
  expect(result).toMatchObject({ ok: false, error: "provider-timeout" });
  expect(await getBalance(env().DB, "u_test")).toBe(100);
});
