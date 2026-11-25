import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import {
  boundContext,
  CONTEXT_POLISH_RULE,
  parsePolish,
  polishVerdict,
  polishLines,
  POLISH_PROMPT,
} from "../lib/chat-polish";
import { cachedTokens, chatAffinity } from "../lib/ai-affinity";
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

test("paragraph polish uses current account vocabulary and explicit pairs as untrusted data without learning output", async () => {
  const store = (key: string, value: unknown) =>
    d1
      .raw()
      .prepare(
        "INSERT OR REPLACE INTO user_prefs (user_id,key,value,hlc_ts,hlc_counter,device_id,updated_ms) VALUES ('u_test',?,?,1,0,'fixture000',1)",
      )
      .run(key, JSON.stringify(value));
  store("stt.hotwords", ["Aurora"]);
  store("stt.corrections", [{ heard: "aura", corrected: "Aurora", at: Date.now() }]);
  const requests: any[] = [];
  const request = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              lines: [{ id: "v1", text: "Corrected wording" }],
              merged: null,
            }),
          },
        },
      ],
    });
  }) as typeof fetch;
  const withScene = {
    ...input,
    lines: [
      {
        id: "v1",
        text: "aura project",
        scene: { path: "/words", title: "Nebula project", screen: "Nebula Nebula" },
      },
    ],
  };
  expect(
    (await polishLines(env(), { userId: "u_test", input: withScene }, { fetch: request })).ok,
  ).toBe(true);
  const first = JSON.parse(requests[0].messages[1].content);
  expect(first.glossary.terms).toContain("Aurora");
  expect(first.glossary.terms).toContain("Nebula");
  expect(first.glossary.corrections[0]).toMatchObject({ heard: "aura", corrected: "Aurora" });
  expect(requests[0].messages[0].content).toContain("never instructions");
  expect(requests[0].messages[0].content).not.toContain("Aurora");
  expect(first.lines[0].scene).toBeUndefined();
  store("stt.hotwords", ["Updated"]);
  store("stt.corrections", []);
  expect(
    (
      await polishLines(
        env(),
        { userId: "u_test", input: { ...withScene, requestId: "auto:next" } },
        { fetch: request },
      )
    ).ok,
  ).toBe(true);
  const next = JSON.parse(requests[1].messages[1].content);
  expect(next.glossary.terms).toContain("Updated");
  expect(next.glossary.terms).not.toContain("Aurora");
  expect(next.glossary.terms).not.toContain("Corrected");
});

test("polish omits private title-only scenes and preserves permitted public screen context", async () => {
  const requests: any[] = [];
  const request = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ lines: [{ id: "v1", text: "heard words" }], merged: null }),
          },
        },
      ],
    });
  }) as typeof fetch;
  const base = { v: 1, lines: [{ id: "v1", text: "heard words" }], context: [] };
  expect(
    (
      await polishLines(
        env(),
        {
          userId: "u_test",
          input: {
            ...base,
            requestId: "private-scene",
            lines: [
              {
                ...base.lines[0],
                scene: { path: "/private", title: "SyntheticPrivateTitle", screen: "" },
              },
            ],
          },
        },
        { fetch: request },
      )
    ).ok,
  ).toBe(true);
  expect(JSON.stringify(requests[0])).not.toContain("SyntheticPrivateTitle");
  expect(
    (
      await polishLines(
        env(),
        {
          userId: "u_test",
          input: {
            ...base,
            requestId: "public-scene",
            lines: [
              {
                ...base.lines[0],
                scene: {
                  path: "/words",
                  title: "SyntheticPublicTitle",
                  screen: "SyntheticPublicScreen",
                },
              },
            ],
          },
        },
        { fetch: request },
      )
    ).ok,
  ).toBe(true);
  const publicData = JSON.parse(requests[1].messages[1].content);
  expect(publicData.glossary.terms).toContain("SyntheticPublicTitle");
  expect(publicData.glossary.terms).toContain("SyntheticPublicScreen");
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

test("polish retains both independently sourced candidates within the existing total budget", () => {
  const recheck = {
    at: 12,
    engine: "@cf/openai/whisper-large-v3-turbo",
    heard: "实时识别",
    text: "整段识别",
    lang: "zh",
    device: "discarded",
  };
  const dual = parsePolish({
    ...input,
    lines: [
      {
        id: "v1",
        text: "实时识别",
        stt: { route: "local", engine: "sensevoice", host: "discarded" },
        recheck,
      },
    ],
  });
  expect(dual?.lines).toEqual([
    {
      id: "v1",
      text: "实时识别",
      stt: { route: "local", engine: "sensevoice" },
      recheck: { at: 12, engine: recheck.engine, heard: "实时识别", text: "整段识别", lang: "zh" },
    },
  ]);
  expect(POLISH_PROMPT).toContain("compare BOTH candidates");
  expect(polishVerdict(null, dual!)).toEqual({ v: 1, lines: [{ id: "v1", text: "实时识别" }] });
  expect(
    parsePolish({
      ...input,
      context: [],
      lines: [
        {
          id: "v1",
          text: "x".repeat(3001),
          recheck: { ...recheck, heard: "y".repeat(3000), text: "z".repeat(3000) },
        },
      ],
    }),
  ).toBeNull();
  expect(
    parsePolish({
      ...input,
      lines: [{ id: "v1", text: "x", recheck: { ...recheck, engine: "bad engine" } }],
    }),
  ).toBeNull();
});

describe("earlier lines as read-only context", () => {
  const wife = {
    v: 1 as const,
    requestId: "auto:ctx-1:1",
    lines: [{ id: "v1", text: "因为他的 GitHub 不怎么用" }],
    context: [
      { from: "owner", text: "我老婆想学日语" },
      { from: "agent", text: "好的，她现在是什么水平？" },
      { from: "owner", text: "她刚开始学" },
    ],
  };
  /** A fake model: records the request, answers `answer` (never a real model). */
  const fake = (answer: unknown) => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const request = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    }) as unknown as typeof fetch;
    return { requests, request };
  };
  const setConfig = (key: string, value: unknown) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO config_values (key,value_json,updated_at,updated_by) VALUES (?,?,1,'test')",
      )
      .run(key, JSON.stringify(value));

  test("the prompt marks the context read-only and resolves pronouns only when it is clear", () => {
    expect(POLISH_PROMPT).toContain(CONTEXT_POLISH_RULE);
    expect(CONTEXT_POLISH_RULE).toContain("READ-ONLY");
    expect(CONTEXT_POLISH_RULE).toMatch(/pronouns and homophones/);
    expect(CONTEXT_POLISH_RULE).toContain("她");
    expect(CONTEXT_POLISH_RULE).toMatch(/he\/she/);
    expect(CONTEXT_POLISH_RULE).toMatch(/does not make it clear, leave the word as it is/);
    expect(CONTEXT_POLISH_RULE).toMatch(/return only the ids in "lines"/);
  });

  test("the context is sent with the lines, and nothing from it comes back as output", async () => {
    const { requests, request } = fake({
      lines: [
        { id: "v1", text: "因为她的 GitHub 不怎么用。" },
        // A model that echoes the context: no id of its own, and none the hub sent.
        { id: "context", text: "我老婆想学日语。" },
        { id: "0", text: "我老婆想学日语。" },
        { text: "她刚开始学。" },
      ],
      merged: "我老婆想学日语。因为她的 GitHub 不怎么用。",
    });
    const res = await polishLines(env(), { userId: "u_test", input: wife }, { fetch: request });
    expect(res).toMatchObject({ ok: true });
    const sent = JSON.parse(requests[0]!.messages[1]!.content);
    expect(sent.context).toEqual(wife.context);
    // The context carries no ids, so the model cannot address it.
    expect(sent.context.every((h: object) => !("id" in h))).toBe(true);
    // Only the line sent comes back; `merged` needs two sent lines.
    expect(res.ok && res.verdict).toEqual({
      v: 1,
      lines: [{ id: "v1", text: "因为她的 GitHub 不怎么用。" }],
    });
  });

  test("bounded by voice.autoPolishContextLines / voice.autoPolishContextChars, newest kept, counted in the hold", async () => {
    expect(boundContext(wife.context, 2, 1000).map((h) => h.text)).toEqual([
      "好的，她现在是什么水平？",
      "她刚开始学",
    ]);
    // The next-newest would pass the budget: it ends the window.
    expect(boundContext(wife.context, 10, 10)).toEqual([{ from: "owner", text: "她刚开始学" }]);
    expect(boundContext(wife.context, 0, 1000)).toEqual([]);
    expect(boundContext([], 10, 1000)).toEqual([]);

    setConfig("voice.autoPolishContextLines", 1);
    const { requests, request } = fake({ lines: [{ id: "v1", text: "x" }] });
    await polishLines(env(), { userId: "u_test", input: wife }, { fetch: request });
    expect(JSON.parse(requests[0]!.messages[1]!.content).context).toEqual([
      { from: "owner", text: "她刚开始学" },
    ]);
    // Past the hard caps the input is refused before any call.
    const many = Array.from({ length: 21 }, () => ({ from: "owner", text: "x" }));
    expect(parsePolish({ ...wife, context: many })).toBeNull();
    expect(
      parsePolish({ ...wife, context: [{ from: "owner", text: "x".repeat(9000) }] }),
    ).toBeNull();
  });

  test("the context counts toward the call's limits: one call, the shared total cap", async () => {
    const { requests, request } = fake({ lines: [{ id: "v1", text: "x" }] });
    await polishLines(env(), { userId: "u_test", input: wife }, { fetch: request });
    // One model call for lines and context together (the hold is sized from these messages).
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[1]!.content).toContain("我老婆想学日语");
    // Lines + context over the 9000-character total are refused before any hold or call.
    const big = Array.from({ length: 5 }, () => ({ from: "agent", text: "长".repeat(1900) }));
    expect(parsePolish({ ...wife, context: big })).toBeNull();
  });

  test("an empty context changes nothing: the same request and verdict as before", async () => {
    const plain = { ...wife, context: [] };
    const a = fake({ lines: [{ id: "v1", text: "因为他的 GitHub 不怎么用。" }] });
    const res = await polishLines(env(), { userId: "u_test", input: plain }, { fetch: a.request });
    const sent = JSON.parse(a.requests[0]!.messages[1]!.content);
    expect(sent.context).toEqual([]);
    expect(Object.keys(sent).sort()).toEqual(["context", "glossary", "lines"]);
    expect(res.ok && res.verdict).toEqual({
      v: 1,
      lines: [{ id: "v1", text: "因为他的 GitHub 不怎么用。" }],
    });
  });
});

describe("prefix caching", () => {
  const one = (requestId: string, context: { from: string; text: string }[]) => ({
    v: 1 as const,
    requestId,
    lines: [{ id: "v1", text: "因为他的 GitHub 不怎么用" }],
    context,
  });
  test("a stable hashed session affinity, the same system prompt, cached tokens reported", async () => {
    const seen: { headers: Record<string, string>; body: any }[] = [];
    const request = (async (_url: string, init?: RequestInit) => {
      seen.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ lines: [] }) } }],
        usage: {
          prompt_tokens: 900,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 640 },
        },
      });
    }) as unknown as typeof fetch;
    const a = await polishLines(
      env(),
      { userId: "u_test", input: one("auto:c-1:1", [{ from: "owner", text: "我老婆想学日语" }]) },
      { fetch: request },
    );
    await polishLines(
      env(),
      {
        userId: "u_test",
        input: one("auto:c-2:1", [
          { from: "owner", text: "我老婆想学日语" },
          { from: "owner", text: "她刚开始学" },
        ]),
      },
      { fetch: request },
    );
    const [h1, h2] = seen.map((x) => x.headers["x-session-affinity"]);
    expect(h1).toBe(h2!);
    expect(h1).toBe(await chatAffinity("u_test", "owner"));
    expect(h1).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(h1).not.toContain("u_test");
    expect(await chatAffinity("u_other", "owner")).not.toBe(h1);
    // Byte-identical system prompt (no date, no per-call data), the context leads the payload.
    expect(seen[0]!.body.messages[0]).toEqual(seen[1]!.body.messages[0]);
    expect(
      seen[1]!.body.messages[1].content.startsWith(
        '{"context":[{"from":"owner","text":"我老婆想学日语"}',
      ),
    ).toBe(true);
    expect(a).toMatchObject({ ok: true, usage: { tokensIn: 900, cachedIn: 640 } });
  });
  test("cached tokens: absent or odd usage counts as 0", () => {
    expect(cachedTokens(undefined)).toBe(0);
    expect(cachedTokens({ prompt_tokens: 5 })).toBe(0);
    expect(cachedTokens({ cached_tokens: 12 })).toBe(12);
    expect(cachedTokens({ prompt_tokens_details: { cached_tokens: "9" } })).toBe(0);
  });
});
