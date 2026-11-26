/**
 * MCP Events (docs/mcp-events.md; lib/mcp-events/*): the mention match, the
 * loop guard, the thread scope, the Standard Webhooks signature, callback
 * verification, retries, revocation, the flag and its owner audience, and the
 * remote MCP server's forwarding. Synthetic data only: example.com accounts,
 * fake callback hosts, tokens minted in an in-memory D1.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import type { D1Like } from "../lib/d1/types";
import { createToken, revokeToken } from "../lib/api-tokens";
import { FLAGS } from "../lib/flags";
import { CONFIG, defaultConfig } from "../lib/config";
import {
  EVENT_DEFINITIONS,
  MCP_EVENTS_FLAG,
  anyCandidate,
  b64encode,
  callbackUrl,
  canonicalJson,
  eventsLimits,
  grantedTtl,
  mayTrigger,
  mentions,
  outcome,
  signature,
  signingKey,
  subscriptionId,
  type EventsLimits,
} from "../lib/mcp-events/rules";
import {
  MAX_ANSWER_BYTES,
  eventsRpc,
  mentionEvents,
  type EventsDeps,
} from "../lib/mcp-events/server";
import { resolveDoh } from "../lib/mcp-events/deps";
import { addressVerdict, dohAddresses, hostAllowed, publicAddress } from "../lib/mcp-events/rules";
import { handle, type Env } from "../workers/mcp/src/mcp";

const SEAL = "s".repeat(40);
const CALLBACK = "https://receiver.example.net/mcp-events/cb_1";
const keyBytes = new Uint8Array(32).map((_, i) => i + 1);
const SECRET = `whsec_${b64encode(keyBytes)}`;

type Sent = { url: string; headers: Headers; body: string };

let db: TestD1Database;
let now: number;
let flag: boolean;
let sent: Sent[];
let respond: (s: Sent) => Response | Promise<Response>;
let slept: number[];
let onSleep: () => void | Promise<void>;
/** What the callback's host resolves to now (DNS over HTTPS in production). */
let addrs: string[] | null;
let resolved: string[];
let limits: EventsLimits;
let ownerToken: string;
let ownerHash: string;

const D = () => db as unknown as D1Like;

function deps(over: Partial<EventsDeps> = {}): EventsDeps {
  return {
    db: D(),
    flagOn: async () => flag,
    limits: async () => limits,
    sealSecret: SEAL,
    fetch: async (url, init) => {
      const s = { url, headers: new Headers(init.headers), body: String(init.body) };
      sent.push(s);
      return respond(s);
    },
    resolve: async (host) => {
      resolved.push(host);
      return addrs;
    },
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      await onSleep();
    },
    ...over,
  };
}

/** A well-behaved receiver: echoes the verification challenge, 200 on events. */
const echo = (s: Sent) => {
  const b = JSON.parse(s.body);
  return b.type === "verification" ? Response.json({ challenge: b.challenge }) : new Response("");
};

const subscribeParams = (over: Record<string, unknown> = {}) => ({
  name: "chat.mention",
  arguments: {},
  delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
  cursor: null,
  ...over,
});

const ownerLine = (text: string, id = "l1", from: "owner" | "friend" | "agent" = "owner") => ({
  op: "put",
  thread: "owner",
  lines: [
    { id, from, lane: from === "agent" ? "main" : null, text, at: now, ask: false, answer: null },
  ],
});

beforeEach(async () => {
  db = createTestD1(testSchema());
  db.raw().exec(
    `INSERT INTO user(id,email,emailVerified,createdAt,updatedAt) VALUES
     ('owner1','owner@example.com',1,'2026-11-01','2026-11-01'),
     ('user2','user2@example.com',1,'2026-11-01','2026-11-01');
     INSERT INTO account_permission (email, permission, granted_by, granted_at)
     VALUES ('owner@example.com','dev','test',1);`,
  );
  now = Date.parse("2026-11-27T00:00:00Z");
  flag = true;
  sent = [];
  slept = [];
  onSleep = () => {};
  addrs = ["203.0.114.7", "2606:4700:10::6816:1"];
  resolved = [];
  respond = echo;
  // The synthetic receivers' hosts are allowed here; the shipped default is OpenAI's.
  limits = { ...eventsLimits(defaultConfig()), timeoutMs: 200, callbackHosts: [".example.net"] };
  const t = await createToken(
    D(),
    { userId: "owner1", email: "owner@example.com" },
    { name: "Arden", scopes: ["chat:read", "chat:write"], expiresAt: new Date(now + 7 * 86400e3) },
    now,
  );
  ownerToken = t.token;
  ownerHash = t.id;
});

async function subscribe(token = ownerToken, params: unknown = subscribeParams()) {
  return eventsRpc(deps(), token, { method: "events/subscribe", params });
}

describe("the mention match", () => {
  test("@name, case-insensitive, full-width ＠, at word edges", () => {
    expect(mentions("hey @Arden can you look", "Arden")).toBe(true);
    expect(mentions("@arden", "Arden")).toBe(true);
    expect(mentions("ping @ARDEN.", "Arden")).toBe(true);
    expect(mentions("（＠Ａｒｄｅｎ）", "Arden")).toBe(true);
    expect(mentions("@Arden, then @Bo", "arden")).toBe(true);
  });
  test("not a mention: no @, a longer name, an email address", () => {
    expect(mentions("Arden, look", "Arden")).toBe(false);
    expect(mentions("@Ardent is a word", "Arden")).toBe(false);
    expect(mentions("@Arden-bot", "Arden")).toBe(false);
    expect(mentions("mail bob@arden.example", "arden")).toBe(false);
    expect(mentions("@Arden", "")).toBe(false);
  });
  test("a name in a script without spaces may be followed by text", () => {
    expect(mentions("@小克你好", "小克")).toBe(true);
    expect(mentions("看看@小克", "小克")).toBe(true);
  });
  test("names with spaces", () => {
    expect(mentions("@arden bot please", "Arden Bot")).toBe(true);
  });
});

describe("the loop guard", () => {
  test("only a person's line can trigger", () => {
    expect(mayTrigger({ id: "a", from: "owner", text: "@Arden" })).toBe(true);
    expect(mayTrigger({ id: "a", from: "friend", text: "@Arden" })).toBe(true);
    expect(mayTrigger({ id: "a", from: "agent", text: "@Arden" })).toBe(false);
    expect(anyCandidate([{ id: "a", from: "agent", text: "@Arden" }])).toBe(false);
    expect(anyCandidate([{ id: "a", from: "owner", text: "no mention" }])).toBe(false);
  });

  test("the agent's own line naming itself sends nothing and reads no subscription", async () => {
    expect((await subscribe()).body).toHaveProperty("result");
    sent = [];
    const r = await mentionEvents(deps(), ownerLine("【Arden】 noted, @Arden here", "a1", "agent"));
    expect(r.delivered).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("the signature (Standard Webhooks)", () => {
  test("a known vector: HMAC-SHA256 over id.timestamp.body, v1,<base64>", async () => {
    // The Standard Webhooks reference test vector.
    const key = signingKey("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")!;
    const sig = await signature(
      key,
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1614265330,
      '{"test": 2432232314}',
    );
    expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });
  test("secrets: whsec_ and 24–64 bytes only", () => {
    expect(signingKey(SECRET)).not.toBeNull();
    expect(signingKey(b64encode(keyBytes))).toBeNull();
    expect(signingKey(`whsec_${b64encode(new Uint8Array(16))}`)).toBeNull();
    expect(signingKey(`whsec_${b64encode(new Uint8Array(65))}`)).toBeNull();
    expect(signingKey("whsec_not base64!")).toBeNull();
  });
});

describe("rules", () => {
  test("callback URLs: public https host names only", () => {
    expect(callbackUrl(CALLBACK).ok).toBe(true);
    for (const bad of [
      "http://receiver.example.net/x",
      "https://user:pw@receiver.example.net/x",
      "https://127.0.0.1/x",
      "https://10.0.0.8/x",
      "https://[::1]/x",
      "https://2130706433/x",
      "https://localhost/x",
      "https://box.internal/x",
      "https://mac.tail1234.ts.net/x",
      "https://lianki.com/api/x",
      "https://dev.lianki.com/x",
      "https://receiver.example.net:8443/x",
      "not a url",
    ])
      expect(callbackUrl(bad).ok).toBe(false);
  });
  test("ids are deterministic over canonical arguments", async () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const a = await subscriptionId("h", CALLBACK, "chat.mention", "{}");
    expect(a).toBe(await subscriptionId("h", CALLBACK, "chat.mention", "{}"));
    expect(a).not.toBe(await subscriptionId("h2", CALLBACK, "chat.mention", "{}"));
  });
  test("ttl: default, capped, null = the longest", () => {
    expect(grantedTtl(undefined, limits)).toBe(limits.ttlMs);
    expect(grantedTtl(null, limits)).toBe(limits.maxTtlMs);
    expect(grantedTtl(1e15, limits)).toBe(limits.maxTtlMs);
  });
  test("outcomes: 2xx ok, 410 gone, 413/3xx/4xx final, 5xx/429/timeout retry", () => {
    expect(outcome({ status: 204 })).toBe("ok");
    expect(outcome({ status: 410 })).toBe("gone");
    expect(outcome({ status: 413 })).toBe("final");
    expect(outcome({ status: 302 })).toBe("final");
    expect(outcome({ status: 403 })).toBe("final");
    expect(outcome({ status: 503 })).toBe("retry");
    expect(outcome({ status: 429 })).toBe("retry");
    expect(outcome({ error: "timeout" })).toBe("retry");
  });
  test("the flag is off by default, owner audience; every limit is a config key", () => {
    expect(FLAGS[MCP_EVENTS_FLAG].default).toBe(false);
    expect(FLAGS[MCP_EVENTS_FLAG].audience).toBe("owner");
    for (const k of [
      "mcp.eventsSubscribePerHour",
      "mcp.eventsMaxPerToken",
      "mcp.eventsPerMinute",
      "mcp.eventsTtlMin",
      "mcp.eventsMaxTtlMin",
      "mcp.eventsTimeoutMs",
      "mcp.eventsRetries",
      "mcp.eventsRetryBaseMs",
      "mcp.eventsVerifyCacheMin",
      "mcp.eventsRotationOverlapMin",
    ])
      expect(Object.hasOwn(CONFIG, k)).toBe(true);
  });
});

describe("subscribe", () => {
  test("verifies the callback with a signed challenge, stores a sealed secret", async () => {
    const out = await subscribe();
    const result = (out.body as { result: Record<string, unknown> }).result;
    expect(result.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(result.cursor).toBeNull();
    expect(result.truncated).toBe(false);
    expect(Date.parse(result.refreshBefore as string)).toBeGreaterThan(now);
    expect(sent).toHaveLength(1);
    const v = sent[0];
    expect(JSON.parse(v.body).type).toBe("verification");
    expect(v.headers.get("x-mcp-subscription-id")).toBe(result.id as string);
    const ts = Number(v.headers.get("webhook-timestamp"));
    expect(v.headers.get("webhook-signature")).toBe(
      await signature(keyBytes, v.headers.get("webhook-id")!, ts, v.body),
    );
    const row = db.raw().prepare("SELECT * FROM mcp_event_subscription").get() as Record<
      string,
      unknown
    >;
    expect(row.thread).toBe("owner");
    expect(row.token_hash).toBe(ownerHash);
    expect(String(row.secret_sealed)).not.toContain(SECRET.slice(6));
  });

  test("a wrong echo or an unreachable callback: -32015 with a reason, nothing stored", async () => {
    respond = () => Response.json({ challenge: "nope" });
    const bad = (await subscribe()).body as { error: { code: number; data?: unknown } };
    expect(bad.error.code).toBe(-32015);
    expect(bad.error.data).toEqual({ reason: "challenge_failed" });
    respond = () => {
      throw new Error("refused");
    };
    const down = (await subscribe()).body as { error: { data?: unknown } };
    expect(down.error.data).toEqual({ reason: "unreachable" });
    expect(db.raw().prepare("SELECT COUNT(*) AS n FROM mcp_event_subscription").get()).toEqual({
      n: 0,
    });
  });

  test("idempotent: the same identity is one row; a re-subscribe within the cache skips verification", async () => {
    const a = (await subscribe()).body as { result: { id: string } };
    const b = (await subscribe()).body as { result: { id: string } };
    expect(a.result.id).toBe(b.result.id);
    expect(sent).toHaveLength(1);
    expect(db.raw().prepare("SELECT COUNT(*) AS n FROM mcp_event_subscription").get()).toEqual({
      n: 1,
    });
  });

  test("bad params: unknown event, arguments, http callback, short secret", async () => {
    for (const p of [
      subscribeParams({ name: "chat.line" }),
      subscribeParams({ arguments: { thread: "user2" } }),
      subscribeParams({
        delivery: { mode: "webhook", url: "http://x.example.net/", secret: SECRET },
      }),
      subscribeParams({ delivery: { mode: "webhook", url: CALLBACK, secret: "whsec_AAAA" } }),
      subscribeParams({ delivery: { mode: "poll", url: CALLBACK, secret: SECRET } }),
    ]) {
      const out = (await subscribe(ownerToken, p)).body as { error: { code: number } };
      expect(out.error.code).toBe(-32602);
    }
    expect(sent).toEqual([]);
  });

  test("flag off or not the owner audience: probe says off, methods are not found", async () => {
    flag = false;
    expect((await eventsRpc(deps(), ownerToken, { method: "events/probe" })).body).toEqual({
      result: { on: false },
    });
    expect(((await subscribe()).body as { error: { code: number } }).error.code).toBe(-32601);
    flag = true;
    const other = await createToken(
      D(),
      { userId: "user2", email: "user2@example.com" },
      { name: "Arden", scopes: ["chat:read"], expiresAt: new Date(now + 86400e3) },
      now,
    );
    expect((await eventsRpc(deps(), other.token, { method: "events/probe" })).body).toEqual({
      result: { on: false },
    });
    expect(((await subscribe(other.token)).body as { error: { code: number } }).error.code).toBe(
      -32601,
    );
  });

  test("a token without chat:read is told which permission; an unknown token is 401", async () => {
    const noRead = await createToken(
      D(),
      { userId: "owner1", email: "owner@example.com" },
      { name: "Writer", scopes: ["chat:write"], expiresAt: new Date(now + 86400e3) },
      now,
    );
    const out = (await subscribe(noRead.token)).body as { error: { code: number } };
    expect(out.error.code).toBe(-32003);
    const unknown = await eventsRpc(deps(), `lk_${"0".repeat(64)}`, { method: "events/list" });
    expect(unknown.status).toBe(401);
  });

  test("events/list describes chat.mention only", async () => {
    const out = (await eventsRpc(deps(), ownerToken, { method: "events/list" })).body as {
      result: { events: typeof EVENT_DEFINITIONS };
    };
    expect(out.result.events.map((e) => e.name)).toEqual(["chat.mention"]);
    expect(Object.keys(out.result.events[0].payloadSchema.properties)).toEqual([
      "id",
      "text",
      "author",
    ]);
  });
});

describe("delivery", () => {
  test("a person's line naming the token: one signed POST with only id, text, author", async () => {
    const sub = ((await subscribe()).body as { result: { id: string } }).result.id;
    sent = [];
    const r = await mentionEvents(deps(), ownerLine("@arden what is due today?"));
    expect(r.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    const s = sent[0];
    expect(s.url).toBe(CALLBACK);
    const body = JSON.parse(s.body);
    expect(body.name).toBe("chat.mention");
    expect(body.data).toEqual({ id: "l1", text: "@arden what is due today?", author: "owner" });
    expect(body.cursor).toBeNull();
    expect(s.headers.get("webhook-id")).toBe(body.eventId);
    expect(s.headers.get("x-mcp-subscription-id")).toBe(sub);
    const ts = Number(s.headers.get("webhook-timestamp"));
    expect(s.headers.get("webhook-signature")).toBe(
      await signature(keyBytes, body.eventId, ts, s.body),
    );
  });

  test("no mention, another name, or another thread: nothing sent", async () => {
    await subscribe();
    sent = [];
    await mentionEvents(deps(), ownerLine("just a note"));
    await mentionEvents(deps(), ownerLine("@Bo please"));
    await mentionEvents(deps(), { ...ownerLine("@Arden"), thread: "user2" });
    await mentionEvents(deps(), { ...ownerLine("@Arden"), thread: "owner~abcdef12" });
    expect(sent).toEqual([]);
  });

  test("the flag off stops delivery; the row stays", async () => {
    await subscribe();
    sent = [];
    flag = false;
    await mentionEvents(deps(), ownerLine("@Arden"));
    expect(sent).toEqual([]);
    expect(db.raw().prepare("SELECT COUNT(*) AS n FROM mcp_event_subscription").get()).toEqual({
      n: 1,
    });
  });

  test("retries 5xx with backoff, the same eventId each time; 410 deletes the subscription", async () => {
    await subscribe();
    sent = [];
    let n = 0;
    respond = () => new Response("", { status: ++n < 3 ? 503 : 200 });
    const r = await mentionEvents(deps(), ownerLine("@Arden"));
    expect(r.delivered).toBe(1);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => s.headers.get("webhook-id"))).size).toBe(1);
    expect(slept).toEqual([limits.retryBaseMs, limits.retryBaseMs * 2]);
    sent = [];
    respond = () => new Response("", { status: 410 });
    expect((await mentionEvents(deps(), ownerLine("@Arden", "l2"))).dropped).toBe(1);
    expect(sent).toHaveLength(1);
    expect(db.raw().prepare("SELECT COUNT(*) AS n FROM mcp_event_subscription").get()).toEqual({
      n: 0,
    });
  });

  test("a timeout is retried and then given up", async () => {
    await subscribe();
    sent = [];
    const hang = deps({
      fetch: (url, init) =>
        new Promise((_, reject) => {
          sent.push({ url, headers: new Headers(init.headers), body: String(init.body) });
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    limits = { ...limits, timeoutMs: 5, retries: 1 };
    const r = await mentionEvents(hang, ownerLine("@Arden"));
    expect(r.delivered).toBe(0);
    expect(sent).toHaveLength(2);
  });

  test("the per-subscription rate limit", async () => {
    await subscribe();
    sent = [];
    limits = { ...limits, perMinute: 2 };
    for (let i = 0; i < 4; i++) await mentionEvents(deps(), ownerLine("@Arden", `m${i}`));
    expect(sent).toHaveLength(2);
  });
});

describe("revocation", () => {
  test("revoking the token deletes its subscriptions (D1 trigger)", async () => {
    await subscribe();
    await revokeToken(D(), { userId: "owner1", email: "owner@example.com" }, ownerHash);
    expect(db.raw().prepare("SELECT COUNT(*) AS n FROM mcp_event_subscription").get()).toEqual({
      n: 0,
    });
  });

  test("an expired token's subscription is dropped at the next mention, nothing sent", async () => {
    await subscribe();
    sent = [];
    db.raw().exec(`UPDATE api_tokens SET expires_at = '2026-11-26T00:00:00.000Z'`);
    const r = await mentionEvents(deps(), ownerLine("@Arden"));
    expect(r.dropped).toBe(1);
    expect(sent).toEqual([]);
    expect(db.raw().prepare("SELECT COUNT(*) AS n FROM mcp_event_subscription").get()).toEqual({
      n: 0,
    });
  });

  test("losing the owner audience stops delivery", async () => {
    await subscribe();
    sent = [];
    db.raw().exec(`UPDATE account_permission SET revoked_at = 2`);
    await mentionEvents(deps(), ownerLine("@Arden"));
    expect(sent).toEqual([]);
  });

  test("unsubscribe by name, arguments and URL; idempotent", async () => {
    await subscribe();
    const params = {
      name: "chat.mention",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK },
    };
    expect(
      (await eventsRpc(deps(), ownerToken, { method: "events/unsubscribe", params })).body,
    ).toEqual({
      result: {},
    });
    expect(
      (await eventsRpc(deps(), ownerToken, { method: "events/unsubscribe", params })).body,
    ).toEqual({
      result: {},
    });
    expect(db.raw().prepare("SELECT COUNT(*) AS n FROM mcp_event_subscription").get()).toEqual({
      n: 0,
    });
  });
});

describe("the remote MCP server", () => {
  const TOKEN = `lk_${"a".repeat(64)}`;
  function env(on: boolean) {
    const calls: { path: string; body: string }[] = [];
    const main = {
      fetch: async (req: Request) => {
        const u = new URL(req.url);
        const body = req.method === "GET" ? "" : await req.text();
        calls.push({ path: u.pathname, body });
        if (req.headers.get("authorization") !== `Bearer ${TOKEN}`)
          return new Response("", { status: 401 });
        if (u.pathname === "/api/cli-login/token")
          return Response.json({ id: "b".repeat(64), name: "Arden", scopes: ["chat:read"] });
        if (u.pathname === "/api/mcp-events") {
          const m = JSON.parse(body).method;
          if (m === "events/probe") return Response.json({ result: { on } });
          if (m === "events/list") return Response.json({ result: { events: EVENT_DEFINITIONS } });
          return Response.json({
            error: { code: -32015, message: "x", data: { reason: "timeout" } },
          });
        }
        return new Response("not found", { status: 404 });
      },
    };
    return { env: { MAIN: main, PUSH: main } as unknown as Env, calls };
  }
  const rpc = (method: string, params: unknown = {}) =>
    new Request("https://lianki.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  test("advertises events only when the main Worker says on", async () => {
    const on = await (
      await handle(rpc("initialize", { protocolVersion: "2025-03-26" }), env(true).env)
    ).json();
    expect(on.result.capabilities.events).toEqual({});
    const off = await (
      await handle(rpc("initialize", { protocolVersion: "2025-03-26" }), env(false).env)
    ).json();
    expect(off.result.capabilities.events).toBeUndefined();
  });

  test("forwards events/* with the caller's token, passing results and errors through", async () => {
    const { env: e, calls } = env(true);
    const list = await (await handle(rpc("events/list"), e)).json();
    expect(list.result.events[0].name).toBe("chat.mention");
    const sub = await (await handle(rpc("events/subscribe", subscribeParams()), e)).json();
    expect(sub.error.code).toBe(-32015);
    expect(calls.filter((c) => c.path === "/api/mcp-events")).toHaveLength(2);
  });
});

const count = () =>
  (db.raw().prepare("SELECT COUNT(*) AS n FROM mcp_event_subscription").get() as { n: number }).n;

describe("review fix 1: the callback's resolved addresses", () => {
  test("publicAddress: private, loopback, link-local, CGNAT, ULA, metadata, mapped are refused", () => {
    for (const ip of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.20.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "::",
      "::1",
      "fe80::1",
      "fd00:ec2::254",
      "fc00::1",
      "ff02::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:0a00:0001::1",
      "2001:db8::1",
      "not an ip",
    ])
      expect([ip, publicAddress(ip)]).toEqual([ip, false]);
    for (const ip of ["203.0.114.7", "8.8.4.4", "2606:4700:10::6816:1", "::ffff:203.0.114.7"])
      expect([ip, publicAddress(ip)]).toEqual([ip, true]);
  });

  test("a verdict needs at least one answer, and every answer public", () => {
    expect(addressVerdict(null)).toBe("unresolved");
    expect(addressVerdict([])).toBe("unresolved");
    expect(addressVerdict(["203.0.114.7", "10.0.0.1"])).toBe("private_address");
    expect(addressVerdict(["203.0.114.7"])).toBe("ok");
  });

  test("DNS over HTTPS: A and AAAA both asked; CNAMEs ignored; a resolver failure is null", async () => {
    const asked: string[] = [];
    const doh = async (url: string) => {
      const u = new URL(url);
      asked.push(`${u.searchParams.get("name")}/${u.searchParams.get("type")}`);
      return Response.json(
        u.searchParams.get("type") === "A"
          ? {
              Status: 0,
              Answer: [
                { type: 5, data: "edge.example.net." },
                { type: 1, data: "203.0.114.7" },
              ],
            }
          : { Status: 0, Answer: [{ type: 28, data: "fd00::5" }] },
      );
    };
    const got = await resolveDoh("receiver.example.net", doh);
    expect(got).toEqual(["203.0.114.7", "fd00::5"]);
    expect(addressVerdict(got)).toBe("private_address");
    expect(asked.sort()).toEqual(["receiver.example.net/A", "receiver.example.net/AAAA"]);
    expect(await resolveDoh("x.example.net", async () => Response.json({ Status: 2 }))).toBeNull();
    expect(dohAddresses({ Status: 3 })).toEqual([]);
  });

  test("subscribe: a private or unresolvable host is refused before any POST", async () => {
    addrs = ["203.0.114.7", "169.254.169.254"];
    const bad = (await subscribe()).body as { error: { code: number; data?: unknown } };
    expect(bad.error.code).toBe(-32015);
    expect(bad.error.data).toEqual({ reason: "private_address" });
    addrs = [];
    const none = (await subscribe()).body as { error: { data?: unknown } };
    expect(none.error.data).toEqual({ reason: "unresolved" });
    expect(sent).toEqual([]);
    expect(resolved).toEqual(["receiver.example.net", "receiver.example.net"]);
    expect(count()).toBe(0);
  });

  test("delivery: re-resolved before every attempt; a host re-pointed at a private address gets nothing", async () => {
    await subscribe();
    sent = [];
    resolved = [];
    addrs = ["10.0.0.9"];
    const r = await mentionEvents(deps(), ownerLine("@Arden"));
    expect(r.delivered).toBe(0);
    expect(sent).toEqual([]);
    expect(resolved).toEqual(["receiver.example.net"]);
    // Public again, with a 503 then a 200: resolved once per attempt.
    addrs = ["203.0.114.7"];
    resolved = [];
    let n = 0;
    respond = () => new Response("", { status: ++n === 1 ? 503 : 200 });
    expect((await mentionEvents(deps(), ownerLine("@Arden", "l9"))).delivered).toBe(1);
    expect(resolved).toHaveLength(2);
  });
});

describe("review fix 2: a retry re-checks everything live", () => {
  async function retried(change: () => void | Promise<void>) {
    await subscribe();
    sent = [];
    respond = () => new Response("", { status: 503 });
    onSleep = change;
    const r = await mentionEvents(deps(), ownerLine("@Arden"));
    return { r, posts: sent.length };
  }
  test("token revoked during the backoff: no second POST", async () => {
    const { r, posts } = await retried(async () => {
      await revokeToken(D(), { userId: "owner1", email: "owner@example.com" }, ownerHash);
    });
    expect(r.delivered).toBe(0);
    expect(posts).toBe(1);
  });
  test("token expired during the backoff", async () => {
    const { posts } = await retried(() => {
      db.raw().exec(`UPDATE api_tokens SET expires_at = '2026-11-26T00:00:00.000Z'`);
    });
    expect(posts).toBe(1);
  });
  test("chat:read removed during the backoff", async () => {
    const { posts } = await retried(() => {
      db.raw().exec(`UPDATE api_tokens SET scopes = '["chat:write"]'`);
    });
    expect(posts).toBe(1);
  });
  test("unsubscribed during the backoff", async () => {
    const { posts } = await retried(() => {
      db.raw().exec(`DELETE FROM mcp_event_subscription`);
    });
    expect(posts).toBe(1);
  });
  test("subscription expired during the backoff", async () => {
    const { posts } = await retried(() => {
      now += limits.maxTtlMs + 1;
    });
    expect(posts).toBe(1);
  });
  test("flag turned off during the backoff", async () => {
    const { posts } = await retried(() => {
      flag = false;
    });
    expect(posts).toBe(1);
  });
  test("audience lost during the backoff", async () => {
    const { posts } = await retried(() => {
      db.raw().exec(`UPDATE account_permission SET revoked_at = 2`);
    });
    expect(posts).toBe(1);
  });
  test("nothing changed: every retry is sent", async () => {
    const { posts } = await retried(() => {});
    expect(posts).toBe(limits.retries + 1);
  });
});

describe("review fix 3: the answer is read bounded, under the deadline", () => {
  /** A body that streams `chunks`, then waits forever (or ends with `end`). */
  function streamed(chunks: string[], end: boolean) {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
        else if (end) c.close();
        else return new Promise(() => {});
      },
    });
  }
  test("an answer past 4096 bytes fails verification, without reading it all", async () => {
    let pulled = 0;
    const big = "x".repeat(1024);
    respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulled++;
            c.enqueue(new TextEncoder().encode(big));
          },
        }),
      );
    const out = (await subscribe()).body as { error: { data?: unknown } };
    expect(out.error.data).toEqual({ reason: "challenge_failed" });
    expect(pulled).toBeLessThan(MAX_ANSWER_BYTES / 1024 + 3);
    expect(count()).toBe(0);
  });
  test("a body that trickles past the deadline is a timeout", async () => {
    limits = { ...limits, timeoutMs: 30 };
    respond = () => new Response(streamed(['{"chall'], false));
    const out = (await subscribe()).body as { error: { data?: unknown } };
    expect(out.error.data).toEqual({ reason: "timeout" });
  });
  test("a well-formed echo split over chunks still verifies", async () => {
    respond = (s) => {
      const c = JSON.stringify({ challenge: JSON.parse(s.body).challenge });
      return new Response(streamed([c.slice(0, 5), c.slice(5)], true));
    };
    expect((await subscribe()).body).toHaveProperty("result");
  });
});

describe("review fix 4: the per-token cap holds under concurrency", () => {
  test("two subscribes racing for the last slot: exactly one row", async () => {
    limits = { ...limits, maxPerToken: 1 };
    const other = subscribeParams({
      delivery: { mode: "webhook", url: "https://receiver2.example.net/cb", secret: SECRET },
    });
    const [a, b] = await Promise.all([subscribe(), subscribe(ownerToken, other)]);
    const oks = [a, b].filter((x) => "result" in x.body);
    expect(oks).toHaveLength(1);
    const refused = [a, b].find((x) => !("result" in x.body))!.body as { error: { code: number } };
    expect(refused.error.code).toBe(-32005);
    expect(count()).toBe(1);
  });
  test("a refresh of an existing row is never blocked by the cap", async () => {
    limits = { ...limits, maxPerToken: 1 };
    await subscribe();
    expect((await subscribe()).body).toHaveProperty("result");
    expect(count()).toBe(1);
  });
});

describe("review fix 5: the lifetime never exceeds the configured longest", () => {
  test("a default above the max is cut to the max, absent, null or asked", () => {
    const c = { ...defaultConfig(), "mcp.eventsTtlMin": 1440, "mcp.eventsMaxTtlMin": 60 };
    const l = eventsLimits(c);
    expect(l.maxTtlMs).toBe(60 * 60_000);
    expect(l.ttlMs).toBe(60 * 60_000);
    expect(grantedTtl(undefined, l)).toBe(60 * 60_000);
    expect(grantedTtl(null, l)).toBe(60 * 60_000);
    expect(grantedTtl(24 * 3600_000, l)).toBe(60 * 60_000);
    // Even when handed limits whose default is above the max.
    expect(grantedTtl(undefined, { ...l, ttlMs: 10 * 3600_000 })).toBe(60 * 60_000);
  });
  test("subscribe's refreshBefore follows the capped lifetime", async () => {
    limits = { ...limits, ttlMs: 24 * 3600_000, maxTtlMs: 3600_000 };
    const out = (await subscribe()).body as { result: { refreshBefore: string } };
    expect(Date.parse(out.result.refreshBefore) - now).toBeLessThanOrEqual(3600_000);
    const row = db.raw().prepare("SELECT expires_at_ms FROM mcp_event_subscription").get() as {
      expires_at_ms: number;
    };
    expect(row.expires_at_ms - now).toBe(3600_000);
  });
});

describe("re-review fix 1: the callback host allowlist is the control", () => {
  test("hostAllowed: exact hosts, .suffix for subdomains only, nothing for an empty list", () => {
    const list = ["connectors.api.openai.com", ".hooks.example.net"];
    expect(hostAllowed("https://connectors.api.openai.com/cb/1", list)).toBe(true);
    expect(hostAllowed("https://CONNECTORS.api.openai.com./cb", list)).toBe(true);
    expect(hostAllowed("https://a.hooks.example.net/x", list)).toBe(true);
    for (const bad of [
      "https://hooks.example.net/x",
      "https://evilhooks.example.net/x",
      "https://x.connectors.api.openai.com/cb",
      "https://connectors.api.openai.com.evil.example.net/cb",
      "https://api.openai.com/cb",
      "not a url",
    ])
      expect([bad, hostAllowed(bad, list)]).toEqual([bad, false]);
    expect(hostAllowed("https://connectors.api.openai.com/cb", [])).toBe(false);
  });

  test("the shipped default is OpenAI's callback host only, and a config key", () => {
    expect(CONFIG["mcp.eventsCallbackHosts"].default).toEqual(["connectors.api.openai.com"]);
    expect(eventsLimits(defaultConfig()).callbackHosts).toEqual(["connectors.api.openai.com"]);
    expect(CONFIG["mcp.eventsCallbackHosts"].schema.safeParse(["http://x"]).success).toBe(false);
  });

  test("subscribe: a host outside the list is refused before any lookup or POST", async () => {
    limits = { ...limits, callbackHosts: ["connectors.api.openai.com"] };
    const out = (await subscribe()).body as { error: { code: number; data?: unknown } };
    expect(out.error.code).toBe(-32015);
    expect(out.error.data).toEqual({ reason: "host_not_allowed" });
    expect(resolved).toEqual([]);
    expect(sent).toEqual([]);
    expect(count()).toBe(0);
  });

  test("delivery: the list narrowed after subscribing means nothing is sent", async () => {
    await subscribe();
    sent = [];
    resolved = [];
    limits = { ...limits, callbackHosts: ["connectors.api.openai.com"] };
    const r = await mentionEvents(deps(), ownerLine("@Arden"));
    expect(r.delivered).toBe(0);
    expect(sent).toEqual([]);
    expect(resolved).toEqual([]);
  });
});

describe("re-review fix 2: a live re-check right before every POST", () => {
  const twoLines = () => ({
    op: "put",
    thread: "owner",
    lines: [
      {
        id: "b1",
        from: "owner",
        lane: null,
        text: "@Arden one",
        at: now,
        ask: false,
        answer: null,
      },
      {
        id: "b2",
        from: "owner",
        lane: null,
        text: "@Arden two",
        at: now,
        ask: false,
        answer: null,
      },
    ],
  });
  async function afterFirstPost(change: () => void | Promise<void>) {
    await subscribe();
    sent = [];
    let first = true;
    respond = async () => {
      if (first) {
        first = false;
        await change();
      }
      return new Response("");
    };
    await mentionEvents(deps(), twoLines());
    return sent.map((s) => JSON.parse(s.body).data.id);
  }
  test("unsubscribed after the first line's POST: the second line is not sent", async () => {
    const ids = await afterFirstPost(() => {
      db.raw().exec(`DELETE FROM mcp_event_subscription`);
    });
    expect(ids).toEqual(["b1"]);
  });
  test("token revoked after the first POST: the second is not sent", async () => {
    const ids = await afterFirstPost(() =>
      revokeToken(D(), { userId: "owner1", email: "owner@example.com" }, ownerHash).then(() => {}),
    );
    expect(ids).toEqual(["b1"]);
  });
  test("flag off after the first POST: the second is not sent", async () => {
    const ids = await afterFirstPost(() => {
      flag = false;
    });
    expect(ids).toEqual(["b1"]);
  });
  test("nothing changed: both lines are sent", async () => {
    expect(await afterFirstPost(() => {})).toEqual(["b1", "b2"]);
  });
  test("revoked while the DNS answer was pending: nothing is sent", async () => {
    await subscribe();
    sent = [];
    const slow = deps({
      resolve: async () => {
        await revokeToken(D(), { userId: "owner1", email: "owner@example.com" }, ownerHash);
        return addrs;
      },
    });
    const r = await mentionEvents(slow, ownerLine("@Arden"));
    expect(r.delivered).toBe(0);
    expect(sent).toEqual([]);
  });
  test("flag off while the DNS answer was pending, first attempt: nothing is sent", async () => {
    await subscribe();
    sent = [];
    const slow = deps({
      resolve: async () => {
        flag = false;
        return addrs;
      },
    });
    await mentionEvents(slow, ownerLine("@Arden"));
    expect(sent).toEqual([]);
  });
});

describe("re-review fix 3: a stream cancel that never settles holds nothing up", () => {
  /** A body whose cancel() never resolves. */
  function stuck(chunks: string[] | "endless", end = false) {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (chunks === "endless") c.enqueue(enc.encode("x".repeat(1024)));
        else if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
        else if (end) c.close();
        else return new Promise(() => {});
      },
      cancel: () => new Promise<void>(() => {}),
    });
  }
  test("delivery: the unread body's cancel never resolves, the delivery still completes", async () => {
    await subscribe();
    sent = [];
    respond = () => new Response(stuck(["ok"], false));
    const r = await mentionEvents(deps(), ownerLine("@Arden"));
    expect(r.delivered).toBe(1);
  });
  test("verification: too large with a stuck cancel still fails at once", async () => {
    respond = () => new Response(stuck("endless"));
    const out = (await subscribe()).body as { error: { data?: unknown } };
    expect(out.error.data).toEqual({ reason: "challenge_failed" });
  });
  test("verification: a trickle past the deadline with a stuck cancel is a timeout", async () => {
    limits = { ...limits, timeoutMs: 30 };
    respond = () => new Response(stuck(['{"ch'], false));
    const out = (await subscribe()).body as { error: { data?: unknown } };
    expect(out.error.data).toEqual({ reason: "timeout" });
  });
});
