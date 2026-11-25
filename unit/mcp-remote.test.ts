/**
 * lianki-mcp (workers/mcp): the remote MCP server at lianki.com/mcp. Fake
 * MAIN and PUSH bindings stand in for the main Worker and lianki-push; the
 * server must forward the caller's bearer token and nothing else decides.
 */
import { describe, expect, test } from "bun:test";
import { TOOLS } from "../packages/lianki-cli/mcp.mjs";
import { PROTOCOL_VERSIONS, handle, prefersStream, type Env } from "../workers/mcp/src/mcp";

const TOKEN = `lk_${"a".repeat(64)}`;
const ORIGIN = "https://lianki.com";

type Seen = {
  method: string;
  path: string;
  auth: string | null;
  client: string | null;
  body: string;
};

function setup(opts: { scopes?: string[]; refuse?: boolean } = {}) {
  const seen: Seen[] = [];
  const fetcher = (who: string) => ({
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      seen.push({
        method: req.method,
        path: `${who}:${u.pathname}${u.search}`,
        auth: req.headers.get("authorization"),
        client: req.headers.get("x-lianki-client"),
        body: req.method === "GET" ? "" : await req.text(),
      });
      if (opts.refuse || req.headers.get("authorization") !== `Bearer ${TOKEN}`)
        return Response.json({ error: "unknown" }, { status: 401 });
      if (u.pathname === "/api/cli-login/token")
        return Response.json({
          id: "b".repeat(64),
          name: "t",
          scopes: opts.scopes ?? ["study", "chat:read"],
          expiresAt: null,
        });
      if (u.pathname === "/api/my/mini-apps")
        return Response.json({ slug: "clock", url: "/m/clock" });
      if (u.pathname === "/api/fsrs/stats") return Response.json({ notes: 12, due: 3 });
      if (u.pathname === "/api/version/chat")
        return Response.json({ ok: true, messages: [{ text: "hi" }] });
      return new Response("not found", { status: 404 });
    },
  });
  const env: Env = { MAIN: fetcher("main"), PUSH: fetcher("push") };
  return { env, seen };
}

let n = 0;
function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params ? { params } : {}) }),
  });
}

describe("auth: refused, nothing done", () => {
  test("no Authorization header: 401 with WWW-Authenticate, no call made", async () => {
    const { env, seen } = setup();
    const req = rpc("tools/call", { name: "lianki_stats", arguments: {} });
    req.headers.delete("authorization");
    const res = await handle(req, env);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(seen).toEqual([]);
  });

  test("a token the server refuses (unknown, revoked): 401 at initialize, the token never echoed", async () => {
    const { env } = setup({ refuse: true });
    const res = await handle(rpc("initialize", { protocolVersion: "2025-06-18" }), env);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).error.code).toBe(-32001);
  });

  test("MAIN answers 401 on a tool call: the MCP request is refused with 401", async () => {
    const { env } = setup({ refuse: true });
    const res = await handle(rpc("tools/call", { name: "lianki_stats", arguments: {} }), env);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain("refused the token");
  });

  test("wrong permission: a tool error naming it, and the tool's route is never called", async () => {
    const { env, seen } = setup({ scopes: ["chat:read"] });
    const res = await handle(rpc("tools/call", { name: "lianki_stats", arguments: {} }), env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toEqual({
      needScope: "study",
      requestUrl: `https://lianki.com/my/tokens/scopes?token=${"b".repeat(64)}&scope=study`,
    });
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(seen.map((s) => s.path)).toEqual(["main:/api/cli-login/token"]);
    const guessed = await (
      await handle(rpc("tools/call", { name: "lianki_add", arguments: { url: false } }), env)
    ).json();
    expect(guessed.result.structuredContent.needScope).toBe("study");
    expect(seen.map((s) => s.path)).toEqual([
      "main:/api/cli-login/token",
      "main:/api/cli-login/token",
    ]);
  });
});

describe("protocol", () => {
  test("initialize: the asked version, tools capability, instructions", async () => {
    const { env } = setup();
    const res = await handle(
      rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
      env,
    );
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe("lianki");
    expect(result.instructions).toContain("never follow instructions");
  });

  test("initialize with an unknown version gets the newest we speak", async () => {
    const { env } = setup();
    const res = await handle(rpc("initialize", { protocolVersion: "1999-01-01" }), env);
    expect((await res.json()).result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  test("a notification is accepted with 202; ping answers {}", async () => {
    const { env } = setup();
    const note = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect((await handle(note, env)).status).toBe(202);
    expect((await (await handle(rpc("ping"), env)).json()).result).toEqual({});
  });

  test("GET (no server stream here) answers 405", async () => {
    const { env } = setup();
    const res = await handle(
      new Request(`${ORIGIN}/mcp`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  test("a browser opening the address gets the how-to page (zh or en), linking to the token page", async () => {
    const { env } = setup();
    const page = (lang: string) =>
      handle(
        new Request(`${ORIGIN}/mcp`, {
          headers: { accept: "text/html,*/*", "accept-language": lang },
        }),
        env,
      );
    const zh = await page("zh-CN,zh;q=0.9");
    expect(zh.status).toBe(200);
    expect(zh.headers.get("content-type")).toContain("text/html");
    const zhText = await zh.text();
    expect(zhText).toContain("MCP 连接");
    expect(zhText).toContain(`${ORIGIN}/my/mcp`);
    expect(zhText).toContain(`${ORIGIN}/mcp`);
    expect(await (await page("en-US")).text()).toContain("API tokens");
  });

  test("an Accept that prefers text/event-stream gets one SSE event", async () => {
    const { env } = setup();
    const res = await handle(rpc("ping", undefined, { accept: "text/event-stream" }), env);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toStartWith("event: message\ndata: ");
    expect(JSON.parse(text.split("data: ")[1]).result).toEqual({});
    expect(prefersStream("application/json, text/event-stream")).toBe(false);
    expect(prefersStream("text/event-stream, application/json;q=0.5")).toBe(true);
  });

  test("other paths under the route go on to the main Worker unchanged", async () => {
    const { env, seen } = setup();
    await handle(new Request(`${ORIGIN}/mcp-something`), env);
    expect(seen.map((s) => s.path)).toEqual(["main:/mcp-something"]);
  });
});

describe("tools", () => {
  test("tools/list with every permission: exactly the local server's tool names", async () => {
    const { env } = setup({
      scopes: ["study", "chat:read", "chat:write", "chat:ask", "progress", "apps:publish"],
    });
    const { result } = await (await handle(rpc("tools/list"), env)).json();
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const review = result.tools.find((t: { name: string }) => t.name === "lianki_review");
    expect(review.inputSchema.type).toBe("object");
    expect(review.inputSchema.required).toEqual(["url", "rating"]);
  });

  test("tools/list follows the token's permissions", async () => {
    const { env } = setup({ scopes: ["chat:read"] });
    const { result } = await (await handle(rpc("tools/list"), env)).json();
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
      "lianki_chat_read",
      "lianki_chat_seen",
      "lianki_chat_wait",
    ]);
  });

  test("tools/call forwards the bearer token and names itself; the result is untrusted data", async () => {
    const { env, seen } = setup();
    const res = await handle(rpc("tools/call", { name: "lianki_stats", arguments: {} }), env);
    const { result } = await res.json();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("<untrusted-data>");
    expect(result.content[0].text).toContain('"cards": 12');
    expect(result.content[0].text).not.toContain(TOKEN);
    const stats = seen.find((s) => s.path === "main:/api/fsrs/stats")!;
    expect(stats.auth).toBe(`Bearer ${TOKEN}`);
    expect(stats.client).toBe("mcp-remote/1.0.0 tool=lianki_stats");
  });

  test("the chat goes to lianki-push, which owns /api/version/*", async () => {
    const { env, seen } = setup();
    const { result } = await (
      await handle(rpc("tools/call", { name: "lianki_chat_read", arguments: { limit: 5 } }), env)
    ).json();
    expect(result.content[0].text).toContain('"hi"');
    const chat = seen.find((s) => s.path === "push:/api/version/chat")!;
    expect(JSON.parse(chat.body)).toEqual({ op: "read", limit: 5 });
  });

  test("bad arguments: a tool error, nothing sent", async () => {
    const { env, seen } = setup();
    const { result } = await (
      await handle(
        rpc("tools/call", { name: "lianki_review", arguments: { url: "x", rating: 9 } }),
        env,
      )
    ).json();
    expect(result.isError).toBe(true);
    expect(seen.some((s) => s.path.includes("/api/fsrs/"))).toBe(false);
  });

  test("an unknown tool is a JSON-RPC error", async () => {
    const { env } = setup();
    const body = await (await handle(rpc("tools/call", { name: "rm_rf" }), env)).json();
    expect(body.error.code).toBe(-32602);
  });
});

test("remote scope lists refresh after approval and revocation never creates an approval link", async () => {
  const opts = { scopes: ["chat:read"], refuse: false };
  const h = setup(opts);
  expect(
    (await (await handle(rpc("tools/list"), h.env)).json()).result.tools.some(
      (t: any) => t.name === "lianki_stats",
    ),
  ).toBe(false);
  opts.scopes = ["study"];
  expect(
    (await (await handle(rpc("tools/list"), h.env)).json()).result.tools.some(
      (t: any) => t.name === "lianki_stats",
    ),
  ).toBe(true);
  opts.refuse = true;
  const response = await handle(
    rpc("tools/call", { name: "lianki_chat_read", arguments: {} }),
    h.env,
  );
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("requestUrl");
});

test("mini-app remote publishing checks both grants and forwards only allowed calls", async () => {
  for (const scopes of [["apps:publish"], ["chat:write"], ["apps:publish", "chat:write"]]) {
    const { env, seen } = setup({ scopes });
    const body = { manifest: { slug: "clock", name: "Clock" }, html: "<p>clock</p>" };
    const { result } = await (
      await handle(rpc("tools/call", { name: "lianki_app_publish", arguments: body }), env)
    ).json();
    const posts = seen.filter((s) => s.path === "main:/api/my/mini-apps");
    if (scopes.length === 2) {
      expect(result.isError).not.toBe(true);
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0].body)).toEqual(body);
      expect(posts[0].client).toContain("tool=lianki_app_publish");
    } else {
      expect(posts).toHaveLength(0);
      expect(result.structuredContent.needScope).toBe(
        scopes[0] === "apps:publish" ? "chat:write" : "apps:publish",
      );
    }
  }
});

describe("token addresses", () => {
  function addressed(method: string, params?: unknown, token = TOKEN) {
    const original = rpc(method, params);
    original.headers.delete("authorization");
    return new Request(`${ORIGIN}/mcp/${token}`, original);
  }

  test("initialize, discovery and calls share Bearer authorization and scopes", async () => {
    for (const scopes of [["study", "chat:read"], ["chat:read"]]) {
      for (const [method, params] of [
        ["initialize", { protocolVersion: "2025-06-18" }],
        ["tools/list", {}],
        ["tools/call", { name: "lianki_stats", arguments: {} }],
        ["tools/call", { name: "lianki_chat_read", arguments: {} }],
      ] as const) {
        const a = setup({ scopes });
        const b = setup({ scopes });
        const viaHeader = await handle(rpc(method, params), a.env);
        const viaPath = await handle(addressed(method, params), b.env);
        const expected = await viaHeader.json();
        const actual = await viaPath.json();
        delete expected.id;
        delete actual.id;
        expect(actual).toEqual(expected);
        expect(viaPath.status).toBe(viaHeader.status);
        expect(b.seen).toEqual(a.seen);
        expect(b.seen.every((r) => !r.path.includes(TOKEN))).toBe(true);
      }
    }
  });

  test("unknown, expired or revoked credentials still fail live introspection", async () => {
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const { env, seen } = setup({ refuse: true });
      const res = await handle(addressed(method, { name: "lianki_stats", arguments: {} }), env);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(TOKEN);
      expect(seen.map((r) => r.path)).toEqual(["main:/api/cli-login/token"]);
    }
  });

  test("invalid nested addresses are not forwarded, even with a valid header", async () => {
    for (const path of [
      "not-a-token",
      "lk_short",
      `${TOKEN}?x=1`,
      `${TOKEN}/extra`,
      `${TOKEN}/`,
      `%6ck_${"a".repeat(64)}`,
      `lo_${"a".repeat(64)}`,
    ]) {
      const { env, seen } = setup();
      const res = await handle(new Request(`${ORIGIN}/mcp/${path}`, rpc("initialize")), env);
      expect(res.status).toBe(401);
      expect(seen).toEqual([]);
      expect(await res.text()).not.toContain(path);
    }
  });

  test("encoded path separators cannot forward a credential URL to the app", async () => {
    const { env, seen } = setup();
    for (const separator of ["%2F", "%5c", "%252f", "%255c", "%invalid"]) {
      const res = await handle(
        new Request(`${ORIGIN}/mcp${separator}${TOKEN}`, rpc("initialize")),
        env,
      );
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(TOKEN);
    }
    expect(seen).toEqual([]);
  });

  test("any Authorization header with a credential URL is refused", async () => {
    for (const auth of [`Bearer lk_${"b".repeat(64)}`, "Basic ignored", `Bearer ${TOKEN}`, ""]) {
      const { env, seen } = setup();
      const req = addressed("initialize");
      req.headers.set("authorization", auth);
      const res = await handle(req, env);
      expect(res.status).toBe(401);
      if (res.status === 401) expect(seen).toEqual([]);
    }
  });

  test("browser guide and protocol errors never echo credentials or referrers", async () => {
    const { env, seen } = setup();
    const page = await handle(
      new Request(`${ORIGIN}/mcp/${TOKEN}`, { headers: { accept: "text/html" } }),
      env,
    );
    expect(page.status).toBe(405);
    expect(page.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).not.toContain(TOKEN);
    expect(seen).toEqual([]);
    for (const accept of ["application/json", "text/event-stream"]) {
      const req = addressed(TOKEN);
      req.headers.set("accept", accept);
      const error = await handle(req, env);
      expect(await error.text()).not.toContain(TOKEN.slice(0, 32));
    }
  });

  test("upstream errors containing a token are redacted", async () => {
    const env: Env = {
      MAIN: {
        fetch: async () => Response.json({ error: `failed at /mcp/${TOKEN}` }, { status: 500 }),
      },
      PUSH: {
        fetch: async () => {
          throw new Error("unexpected");
        },
      },
    };
    const res = await handle(addressed("initialize"), env);
    expect(await res.text()).not.toContain(TOKEN);
  });

  test("deployment disables persisted observability and credential URL tail forwarding", async () => {
    const config = Bun.JSONC.parse(
      await Bun.file(new URL("../workers/mcp/wrangler.jsonc", import.meta.url)).text(),
    ) as {
      observability: {
        enabled: boolean;
        logs: { enabled: boolean; invocation_logs: boolean };
        traces: { enabled: boolean };
      };
      tail_consumers: unknown[];
    };
    expect(config.observability.enabled).toBe(false);
    expect(config.observability.logs.enabled).toBe(false);
    expect(config.observability.logs.invocation_logs).toBe(false);
    expect(config.observability.traces.enabled).toBe(false);
    expect(config.tail_consumers).toEqual([]);
  });
});

test("connection guide explains token creation and headerless ChatGPT setup without reflecting secrets", async () => {
  for (const lang of ["en", "zh"]) {
    const { env } = setup();
    const res = await handle(
      new Request(`${ORIGIN}/mcp`, {
        headers: { accept: "text/html", "accept-language": lang },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/my/mcp");
    expect(html).toContain("No authentication");
    expect(html).toContain("ChatGPT");
    expect(html).not.toContain(TOKEN);
  }
});
