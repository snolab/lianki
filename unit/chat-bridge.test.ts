import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  createChatBridge,
  filterDecision,
  bridgeConfig,
  BRIDGE_DEFAULTS,
} from "../packages/lianki-cli/chat-bridge.mjs";
import {
  createFilterHandler,
  createWorkersClassifier,
  filterConfig,
} from "../scripts/dev/chat-filter-lib";
import { run } from "../packages/lianki-cli/cli.mjs";

const ignore = { v: 1, action: "ignore", confidence: "high", reason: "household" };
const line = (id: string, text: string, extra = {}) => ({
  type: "chat",
  message: { id, text, from: "owner", thread: "owner", source: "stt", ...extra },
});
const localToken = "test-local-filter-authentication";

describe("CLI bridge protocol", () => {
  test("authenticated own-thread alias works for non-owner users", async () => {
    const sent: any[] = [];
    const b = createChatBridge({
      deliver: async (s: string) => {
        sent.push(JSON.parse(s));
      },
    });
    await b.accept({ type: "ready", thread: "own" });
    await b.accept(line("friend", "please help", { from: "friend", thread: "user-scoped-id" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].message.thread).toBe("user-scoped-id");
  });

  test("flattened history supplies context and identity for later merged edits", async () => {
    const sent: any[] = [];
    const b = createChatBridge({
      deliver: async (s: string) => {
        sent.push(JSON.parse(s));
      },
    });
    await b.accept({ ...line("old", "fix the"), history: true });
    expect(sent).toHaveLength(0);
    await b.accept({ type: "edited", id: "old", text: "fix the button" });
    expect(sent[0].message).toMatchObject({ from: "owner", update: true, text: "fix the button" });
    expect(sent[0].context[0].text).toBe("fix the");
  });

  test("in-flight delivery serializes edits, coalesces intermediate revisions and marks updates", async () => {
    let ack!: () => void;
    const sent: any[] = [];
    const b = createChatBridge({
      deliver: async (s: string) => {
        sent.push(JSON.parse(s));
        if (sent.length === 1)
          await new Promise<void>((r) => {
            ack = r;
          });
      },
    });
    const initial = b.accept(line("a", "please fix"));
    const edit = b.accept({ type: "edited", id: "a", text: "please fix that" });
    const latest = b.accept({ type: "edited", id: "a", text: "please fix that button" });
    expect(sent).toHaveLength(1);
    ack();
    await Promise.all([initial, edit, latest]);
    expect(sent.map((x) => [x.message.text, x.message.update])).toEqual([
      ["please fix", false],
      ["please fix that button", true],
    ]);
  });

  test("failed delivery can retry the same id without suppressing it as a duplicate", async () => {
    let calls = 0;
    const b = createChatBridge({
      deliver: async () => {
        if (++calls === 1) throw Error("offline");
      },
    });
    await expect(b.accept(line("a", "please fix"))).rejects.toThrow("offline");
    await b.accept(line("a", "please fix"));
    expect(calls).toBe(2);
  });

  test("failed tap delivery can retry; concurrent duplicates and successful retries dispatch once", async () => {
    let calls = 0;
    const b = createChatBridge({
      deliver: async () => {
        if (++calls === 1) throw Error("offline");
      },
    });
    const tap = {
      type: "answered",
      id: "card",
      askId: "ask",
      thread: "owner",
      answer: { labels: ["Yes"] },
    };
    await expect(b.accept(tap)).rejects.toThrow("offline");
    await Promise.all([b.accept(tap), b.accept(tap)]);
    await b.accept(tap);
    expect(calls).toBe(2);
  });

  test("simultaneous household fragments are each classified rather than bypassing a busy filter", async () => {
    let calls = 0;
    const sent: string[] = [];
    const b = createChatBridge({
      classify: async () => {
        calls++;
        await Promise.resolve();
        return ignore;
      },
      deliver: async (s: string) => {
        sent.push(s);
      },
    });
    await Promise.all([b.accept(line("a", "吃饭了")), b.accept(line("b", "宝宝过来"))]);
    expect(calls).toBe(2);
    expect(sent).toHaveLength(0);
  });

  test("history is context, duplicate lines never replay, agents cannot loop", async () => {
    const sent: any[] = [];
    const b = createChatBridge({
      deliver: async (body: string) => {
        sent.push(JSON.parse(body));
      },
    });
    await b.accept({ type: "history", messages: [line("old", "earlier").message] });
    await b.accept(line("old", "earlier"));
    await b.accept(line("agent", "reply", { from: "agent" }));
    await b.accept(line("new", "please fix"));
    await b.accept(line("new", "please fix"));
    expect(sent).toHaveLength(1);
    expect(sent[0].context.map((x: any) => x.id)).toEqual(["old", "agent"]);
    expect(sent[0].reply.command).toEqual([
      "lianki",
      "--api",
      "https://lianki.com",
      "chat",
      "send",
      "<reply>",
    ]);
  });

  test("household stays silent, a merged edit can recover a filtered fragment", async () => {
    const sent: any[] = [];
    const b = createChatBridge({
      classify: async () => ignore,
      addressed: (s: string) => s.includes("codex"),
      deliver: async (s: string) => {
        sent.push(JSON.parse(s));
      },
    });
    await b.accept(line("a", "吃饭了"));
    expect(sent).toHaveLength(0);
    await b.accept({
      type: "edited",
      id: "a",
      text: "codex，帮我把吃饭提醒做成按钮",
      merged: true,
      parts: 2,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].message.text).toContain("按钮");
    expect(sent[0].message.update).toBe(false);
    await b.accept({
      type: "edited",
      id: "a",
      text: "codex，帮我把吃饭提醒做成按钮，默认关",
      merged: true,
    });
    expect(sent[1].message.update).toBe(true);
  });

  test("explicit requests and bounded voice continuations bypass classification", async () => {
    let now = 0;
    let calls = 0;
    const sent: string[] = [];
    const b = createChatBridge({
      now: () => now,
      addressed: (s: string) => s.includes("codex"),
      classify: async () => {
        calls++;
        return ignore;
      },
      deliver: async (s: string) => {
        sent.push(s);
      },
    });
    await b.accept(line("a", "codex，改一下"));
    now = 500;
    await b.accept(line("b", "那个按钮"));
    expect(calls).toBe(0);
    now = 9000;
    await b.accept(line("c", "吃饭了"));
    expect(calls).toBe(1);
    expect(sent).toHaveLength(2);
  });

  test("newer edits supersede slow classifications, independent speech never queues behind inference", async () => {
    let resolve!: (v: unknown) => void;
    const sent: any[] = [];
    const b = createChatBridge({
      classify: (input: any) =>
        input.message.text === "那个"
          ? new Promise((r) => {
              resolve = r;
            })
          : Promise.resolve({ action: "forward" }),
      deliver: async (s: string) => {
        sent.push(JSON.parse(s));
      },
    });
    const pending = b.accept(line("a", "那个"));
    await b.accept({ type: "edited", id: "a", text: "那个按钮修一下", merged: true });
    await b.accept(line("b", "然后保持蓝色"));
    resolve(ignore);
    await pending;
    expect(sent.map((s) => s.message.text)).toEqual(["那个按钮修一下", "然后保持蓝色"]);
  });

  test("unknown edits, history-marked lines and other threads do not dispatch", async () => {
    const sent: string[] = [];
    const b = createChatBridge({
      deliver: async (s: string) => {
        sent.push(s);
      },
    });
    await b.accept({ type: "edited", id: "unknown", text: "household" });
    await b.accept({ ...line("history", "old"), history: true });
    await b.accept(line("other", "no", { thread: "friend@example.test" }));
    expect(sent).toHaveLength(0);
  });
});

describe("optional filter contract", () => {
  test("optional adapter uses the existing fixed provider model and bounded request options", async () => {
    const calls: any[] = [];
    const provider: any = {
      withOptions: (options: any) => {
        expect(options.maxRetries).toBe(0);
        return {
          chat: {
            completions: {
              create: async (...args: any[]) => {
                calls.push(args);
                return { choices: [{ message: { content: JSON.stringify(ignore) } }] };
              },
            },
          },
        };
      },
    };
    const classify = createWorkersClassifier(
      filterConfig({ LIANKI_CHAT_FILTER_TIMEOUT_MS: "900" }),
      provider,
    );
    expect(await classify({ v: 1, message: { text: "synthetic" }, context: [] })).toEqual(ignore);
    expect(calls[0][0].model).toContain("deepseek");
    expect(calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  test("fails open for failures, malformed or uncertain verdicts; never forwards account tokens", async () => {
    for (const result of [
      null,
      { ...ignore, confidence: "uncertain" },
      { ...ignore, reason: "instruction" },
      { ...ignore, v: 2 },
    ]) {
      expect(
        (
          await filterDecision(
            "http://127.0.0.1:5196/v1/filter",
            {},
            {
              fetch: async (_url: any, init: any) => {
                expect(init.headers.authorization).toBeUndefined();
                return Response.json(result);
              },
            },
          )
        ).action,
      ).toBe("forward");
    }
    expect(
      (
        await filterDecision(
          "http://localhost/v1/filter",
          {},
          {
            fetch: async () => {
              throw Error("offline");
            },
          },
        )
      ).action,
    ).toBe("forward");
    expect(
      (
        await filterDecision(
          "http://localhost/v1/filter",
          {},
          { fetch: async () => Response.json(ignore) },
        )
      ).action,
    ).toBe("ignore");
    await expect(filterDecision("http://remote.example/v1/filter", {})).rejects.toThrow("HTTPS");
  });

  test("loopback service authenticates, blocks browser origins, validates and bounds requests", async () => {
    let calls = 0;
    const handler = createFilterHandler({
      token: localToken,
      classify: async () => {
        calls++;
        return ignore;
      },
    });
    const request = (body: any, headers = {}) =>
      new Request("http://localhost/v1/filter", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${localToken}`,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const input = {
      v: 1,
      message: { text: "吃饭了" },
      context: [{ from: "owner", text: "synthetic prior utterance" }],
    };
    expect((await handler(request(input, { authorization: "wrong" }))).status).toBe(401);
    expect((await handler(request(input, { origin: "https://example.test" }))).status).toBe(403);
    expect((await handler(request({ ...input, message: { text: "x".repeat(2001) } }))).status).toBe(
      400,
    );
    expect(
      (await handler(request({ ...input, message: { text: "x".repeat(40000) } }))).status,
    ).toBe(413);
    expect(await (await handler(request(input))).json()).toEqual(ignore);
    expect(calls).toBe(1);
  });

  test("service timeout, concurrency and request budget return forward", async () => {
    let now = 0;
    const config = { ...filterConfig({}), timeoutMs: 5, maxConcurrent: 1, requestsPerMinute: 1 };
    let calls = 0;
    const handler = createFilterHandler({
      token: localToken,
      config,
      now: () => now,
      classify: () => {
        calls++;
        return new Promise(() => {});
      },
    });
    const req = () =>
      new Request("http://localhost/v1/filter", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${localToken}` },
        body: JSON.stringify({ v: 1, message: { text: "test" }, context: [] }),
      });
    const first = handler(req());
    expect((await (await handler(req())).json()).action).toBe("forward");
    expect((await (await first).json()).action).toBe("forward");
    expect((await (await handler(req())).json()).action).toBe("forward");
    expect(calls).toBe(1);
    now = 60001;
    await handler(req());
    expect(calls).toBe(2);
  });
});

test("real CLI parses streaming stdin bridge and delivers without credentials, sockets or replies", async () => {
  const out: string[] = [];
  const delivered: any[] = [];
  const code = await run(
    ["chat", "bridge", "--stdin", "--deliver", "test-agent", "--cwd", "/tmp", "--ai", "off"],
    {
      env: {},
      out: (s: string) => out.push(s),
      err: () => {},
      bridgeInput: Readable.from([
        JSON.stringify(line("a", "codex，继续")) + "\n",
        JSON.stringify(line("a", "codex，继续")) + "\n",
      ]),
      deliver: async (...args: any[]) => {
        delivered.push(args);
      },
      fetch: async () => {
        throw Error("no network expected");
      },
    },
  );
  expect(code).toBe(0);
  expect(delivered).toHaveLength(1);
  expect(delivered[0].slice(0, 2)).toEqual(["test-agent", "/tmp"]);
  expect(JSON.parse(delivered[0][2]).message.text).toBe("codex，继续");
  expect(out).toHaveLength(0);
});

test("live socket bridge exits immediately after delivery failure without another event", async () => {
  let closed = false;
  class FakeSocket {
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    send() {
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify({ type: "ready", thread: "own" }) }),
      );
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify(
            line("a", "please help", { from: "friend", thread: "user-scoped", source: "typed" }),
          ),
        }),
      );
    }
    close() {
      closed = true;
    }
  }
  const errors: string[] = [];
  const code = await run(["chat", "listen", "--deliver", "test-agent"], {
    env: { LIANKI_TOKEN: `lk_${"ab".repeat(32)}` },
    WebSocket: FakeSocket,
    deliver: async () => {
      throw Error("delivery unavailable");
    },
    out: () => {},
    err: (s: string) => errors.push(s),
  });
  expect(code).toBe(4);
  expect(closed).toBe(true);
  expect(errors.join("\n")).toContain("delivery unavailable");
}, 1000);

test("stdin bridge closes immediately on failed delivery even when input stays open", async () => {
  const { PassThrough } = await import("node:stream");
  const input = new PassThrough();
  const task = run(["chat", "bridge", "--stdin", "--deliver", "test-agent"], {
    env: {},
    bridgeInput: input,
    deliver: async () => {
      throw Error("delivery unavailable");
    },
    out: () => {},
    err: () => {},
  });
  input.write(JSON.stringify(line("a", "please help", { source: "typed" })) + "\n");
  try {
    expect(await task).toBe(4);
  } finally {
    input.destroy();
  }
}, 1000);

test("one failed delivery aborts another in-flight delivery without draining forever", async () => {
  const signals: AbortSignal[] = [];
  const code = await run(["chat", "bridge", "--stdin", "--deliver", "test-agent"], {
    env: {},
    bridgeInput: Readable.from([
      JSON.stringify(line("hang", "please wait", { source: "typed" })) +
        "\n" +
        JSON.stringify(line("fail", "please fail", { source: "typed" })) +
        "\n",
    ]),
    deliver: async (
      _target: string,
      _cwd: string,
      body: string,
      { signal }: { signal: AbortSignal },
    ) => {
      signals.push(signal);
      if (JSON.parse(body).message.id === "fail") throw Error("unavailable");
      return new Promise(() => {});
    },
    out: () => {},
    err: () => {},
  });
  expect(code).toBe(4);
  expect(signals).toHaveLength(2);
  expect(signals.every((s) => s.aborted)).toBe(true);
}, 1000);

test("CLI prepares spoken turns through the account cloud API and keeps raw text authoritative", async () => {
  const requests: any[] = [];
  const delivered: any[] = [];
  const errors: string[] = [];
  const code = await run(["chat", "bridge", "--stdin", "--deliver", "test-agent"], {
    env: { LIANKI_TOKEN: `lk_${"ab".repeat(32)}` },
    bridgeInput: Readable.from([JSON.stringify(line("spoken", "请修复按钮")) + "\n"]),
    fetch: async (url: string, init: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        headers: init.headers,
      });
      return Response.json({
        ok: true,
        verdict: { v: 1, action: "forward", turn: "complete", polished: "请修复按钮。" },
      });
    },
    deliver: async (_target: string, _cwd: string, body: string) => {
      delivered.push(JSON.parse(body));
    },
    out: () => {},
    err: (s: string) => errors.push(s),
  });
  expect(code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://lianki.com/api/version/chat");
  expect(requests[0].headers.authorization).toBe(`Bearer lk_${"ab".repeat(32)}`);
  expect(requests[0].body).toMatchObject({
    op: "prepare",
    input: { v: 1, text: "请修复按钮", context: [] },
  });
  expect(requests[0].body.input.requestId).toBeString();
  expect(delivered).toHaveLength(1);
  expect(delivered[0].message).toMatchObject({
    id: "spoken",
    text: "请修复按钮",
    raw: "请修复按钮",
    polished: "请修复按钮。",
    polishAuthority: "advisory; raw is authoritative",
  });
  expect(errors.join("\n")).not.toContain("prepare-unavailable");
});

test("CLI forwards raw speech when cloud preparation has no credits or fails", async () => {
  for (const failure of ["no-credits", "network"] as const) {
    let requests = 0;
    const delivered: any[] = [];
    const errors: string[] = [];
    const code = await run(["chat", "bridge", "--stdin", "--deliver", "test-agent"], {
      env: { LIANKI_TOKEN: `lk_${"ab".repeat(32)}` },
      bridgeInput: Readable.from([JSON.stringify(line("spoken", "不要删除按钮")) + "\n"]),
      fetch: async () => {
        requests++;
        if (failure === "network") throw Error("offline");
        return Response.json({ ok: false, error: "no-credits" });
      },
      deliver: async (_target: string, _cwd: string, body: string) => {
        delivered.push(JSON.parse(body));
      },
      out: () => {},
      err: (s: string) => errors.push(s),
    });
    expect(code).toBe(0);
    expect(requests).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message).toMatchObject({
      id: "spoken",
      text: "不要删除按钮",
      raw: "不要删除按钮",
    });
    expect(delivered[0].message.polished).toBeUndefined();
    expect(errors.join("\n")).toContain("prepare-unavailable");
    expect(errors.join("\n")).toContain(failure === "network" ? "network-or-auth" : "no-credits");
  }
});

test("prepare client deadline leaves provider overhead and only its timeout can be raised", () => {
  expect(BRIDGE_DEFAULTS.timeoutMs).toBe(6500);
  expect(
    bridgeConfig({
      LIANKI_CHAT_BRIDGE_TIMEOUT_MS: "11000",
      LIANKI_CHAT_BRIDGE_CONTEXT_LINES: "100",
    }),
  ).toMatchObject({ timeoutMs: 11000, contextLines: 12 });
  expect(bridgeConfig({ LIANKI_CHAT_BRIDGE_TIMEOUT_MS: "99999" }).timeoutMs).toBe(12000);
  expect(bridgeConfig({ LIANKI_CHAT_BRIDGE_TIMEOUT_MS: "200" }).timeoutMs).toBe(200);
  expect(bridgeConfig({ LIANKI_CHAT_BRIDGE_TIMEOUT_MS: "NaN" }).timeoutMs).toBe(6500);
});
for (const [failure, expected] of [
  ["http", { reason: "prepare-http", status: 503 }],
  ["json", { reason: "prepare-invalid-json" }],
  ["timeout", { reason: "prepare-timeout" }],
  ["provider", { reason: "provider-http", status: 429 }],
] as const) {
  test(`bridge reports safe ${failure} diagnostic and forwards raw once`, async () => {
    const errors: string[] = [],
      delivered: any[] = [];
    const code = await run(["chat", "bridge", "--stdin", "--deliver", "fixture"], {
      env: { LIANKI_TOKEN: `lk_${"ab".repeat(32)}`, LIANKI_CHAT_BRIDGE_TIMEOUT_MS: "10" },
      bridgeInput: Readable.from([JSON.stringify(line("diagnostic", "不要删除按钮")) + "\n"]),
      fetch: async (_url: string, init: RequestInit) => {
        if (failure === "http") return new Response("SECRET-response-body", { status: 503 });
        if (failure === "json") return new Response("SECRET-response-body");
        if (failure === "provider")
          return Response.json({ ok: false, error: "provider-http", status: 429 });
        return new Promise((_, reject) => {
          const timer = setTimeout(() => reject(Error("SECRET-network-message")), 500);
          init.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal!.reason);
            },
            { once: true },
          );
        });
      },
      deliver: async (_target: string, _cwd: string, body: string) => {
        delivered.push(JSON.parse(body));
      },
      out: () => {},
      err: (s: string) => errors.push(s),
    });
    expect(code).toBe(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message.text).toBe("不要删除按钮");
    expect(errors.map((s) => JSON.parse(s))).toContainEqual({
      type: "prepare-unavailable",
      ...expected,
    });
    expect(errors.join("\n")).not.toContain("SECRET-");
  });
}
