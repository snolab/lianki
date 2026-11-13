/**
 * Eval tokens (docs/secrets-and-auth.md, "Eval tokens"): an API token with the
 * `eval` permission runs code on the site owner's open pages, no pairing tap.
 * What matters: only a site owner can make one (server-checked at creation and
 * at every use), at most 30 days, never offered to anyone else, every use
 * audited; the hub takes it for the owner's thread only, asks again before
 * each eval, and closes it when revoked; it reaches the box only with box:eval.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import { BOX_HEADER, EMBED_HEADER } from "@/workers/push/src/auth";
import push, { type Env } from "@/workers/push/src/index";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  EVAL_MAX_DAYS,
  createToken,
  parseScopes,
  revokeToken,
  type ScopeId,
} from "@/lib/api-tokens";
import { EVAL_LIMIT, evalTokenCheck, type EvalTokenDb } from "@/lib/eval-token";
import { tokenApi } from "@/lib/api-token-api";
import { chatTokenCheck } from "@/lib/chat-token";
import { rpcStub } from "./support/rpc-stub";

const SCHEMA = testSchema();
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-07T12:00:00Z");

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  closed?: number;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = 3;
    this.closed = code;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

function fakeStorage(store = new Map<string, unknown>()): Storage {
  return {
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({ prefix, limit }: { prefix: string; limit?: number }) => {
      let ks = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (limit !== undefined) ks = ks.slice(0, limit);
      return new Map(ks.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

let d1: TestD1Database;
let t: number;
const db = () => d1 as unknown as EvalTokenDb;
const OWNER = { userId: "uOwner", email: "owner@example.com" };
const ALICE = { userId: "uAlice", email: "alice@example.com" };

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  t = T0;
  const raw = d1.raw();
  for (const u of [OWNER, ALICE])
    raw
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-11-01', '2026-11-01')",
      )
      .run(u.userId, u.email);
  raw.prepare("DELETE FROM account_permission").run();
  raw
    .prepare(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES (?, 'dev', 'test', 1)",
    )
    .run(OWNER.email);
});

const mint = (who: typeof OWNER, scopes: ScopeId[] = ["eval"], days = 30) =>
  createToken(db(), who, { name: "lane", scopes, expiresAt: new Date(t + days * DAY) }, t);
const audits = (kind: string) =>
  d1.raw().prepare("SELECT detail FROM security_audit WHERE kind = ?").all(kind) as {
    detail: string;
  }[];

const call = (method: string, body?: unknown) =>
  new Request("https://lianki.com/api/token", {
    method,
    headers: { "content-type": "application/json", origin: "https://lianki.com" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const apiDeps = (who: typeof OWNER, site: boolean) => ({
  who: async () => who,
  db: () => db(),
  siteOwner: async () => site,
  revoked: async () => {},
  now: () => t,
});

describe("making an eval token", () => {
  it("is offered to a site owner only, with its 30-day cap", async () => {
    const mine = (await (await tokenApi(call("GET"), apiDeps(OWNER, true))).json()) as {
      scopes: { id: string }[];
      evalMaxDays?: number;
    };
    expect(mine.scopes.map((s) => s.id)).toContain("eval");
    expect(mine.evalMaxDays).toBe(EVAL_MAX_DAYS);
    const theirs = (await (await tokenApi(call("GET"), apiDeps(ALICE, false))).json()) as {
      scopes: { id: string }[];
      evalMaxDays?: number;
    };
    expect(theirs.scopes.map((s) => s.id)).not.toContain("eval");
    expect(theirs.evalMaxDays).toBeUndefined();
    // No site-owner check wired: nobody gets it.
    const none = (await (
      await tokenApi(call("GET"), { ...apiDeps(OWNER, true), siteOwner: undefined })
    ).json()) as { scopes: { id: string }[] };
    expect(none.scopes.map((s) => s.id)).not.toContain("eval");
  });

  it("is refused for anyone else, as if it did not exist; and past 30 days", async () => {
    const body = { name: "x", scopes: ["eval"], expiry: { days: 30 } };
    expect((await tokenApi(call("POST", body), apiDeps(ALICE, false))).status).toBe(400);
    expect(
      (await tokenApi(call("POST", { ...body, expiry: { days: 90 } }), apiDeps(OWNER, true)))
        .status,
    ).toBe(400);
    const r = await tokenApi(call("POST", body), apiDeps(OWNER, true));
    expect(r.status).toBe(200);
    const made = (await r.json()) as { scopes: string[]; token: string };
    expect(made.scopes).toEqual(["eval"]);
    expect(audits("api-token.create")[0]?.detail).toContain("[eval]");
  });

  it("never through a path without the owner check (the CLI login parses without it)", () => {
    expect(parseScopes(["eval"])).toBeNull();
    expect(parseScopes(["study", "eval"])).toBeNull();
    expect(parseScopes(["eval"], { owner: true })).toEqual(["eval"]);
  });
});

describe("using an eval token (the main Worker's check)", () => {
  it("connects and each use is audited; the token never is", async () => {
    const { token, id } = await mint(OWNER);
    const c = await evalTokenCheck(db(), { op: "connect", token }, t);
    expect(c).toMatchObject({ ok: true, id, name: "lane", userId: OWNER.userId });
    expect(
      await evalTokenCheck(db(), { op: "use", tokenHash: id, len: 4, target: "box" }, t),
    ).toMatchObject({ ok: true });
    const rows = audits("api-token.eval");
    expect(rows.map((r) => r.detail)).toEqual(["connect lane", "eval lane len 4 target box"]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("refuses: no eval permission, not a site owner, expired, revoked, malformed", async () => {
    const chat = await mint(OWNER, ["chat:read"]);
    expect(await evalTokenCheck(db(), { op: "connect", token: chat.token }, t)).toMatchObject({
      ok: false,
      error: "scope",
    });
    // Alice's eval token (only possible by hand in the db): refused at use.
    const hers = await mint(ALICE);
    expect(await evalTokenCheck(db(), { op: "connect", token: hers.token }, t)).toMatchObject({
      ok: false,
      error: "not-owner",
    });
    const mine = await mint(OWNER);
    // The owner role revoked: refused from the next use.
    d1.raw().prepare("UPDATE account_permission SET revoked_at = 2").run();
    expect(await evalTokenCheck(db(), { op: "use", tokenHash: mine.id }, t)).toMatchObject({
      ok: false,
      error: "not-owner",
    });
    d1.raw().prepare("UPDATE account_permission SET revoked_at = NULL").run();
    t += 31 * DAY;
    expect(await evalTokenCheck(db(), { op: "use", tokenHash: mine.id }, t)).toMatchObject({
      ok: false,
      error: "expired",
    });
    t = T0;
    await revokeToken(db(), OWNER, mine.id);
    expect(await evalTokenCheck(db(), { op: "use", tokenHash: mine.id }, t)).toMatchObject({
      ok: false,
      error: "unknown",
    });
    for (const bad of [
      null,
      { op: "eval", token: mine.token },
      { op: "connect" },
      { op: "connect", token: "lk_short" },
      { op: "use", token: mine.token },
      { op: "connect", token: mine.token, tokenHash: mine.id },
    ])
      expect(await evalTokenCheck(db(), bad, t)).toMatchObject({ ok: false });
    expect(audits("api-token.refused").length).toBeGreaterThan(0);
  });

  it("a token from before expiry dates is never an eval token", async () => {
    const { token, id } = await mint(OWNER);
    d1.raw().prepare("UPDATE api_tokens SET expires_at = NULL WHERE token_hash = ?").run(id);
    expect(await evalTokenCheck(db(), { op: "connect", token }, t)).toMatchObject({
      ok: false,
      error: "expired",
    });
  });

  it("is rate limited per token", async () => {
    const { id } = await mint(OWNER);
    let last: unknown;
    for (let i = 0; i <= EVAL_LIMIT.max; i++)
      last = await evalTokenCheck(db(), { op: "use", tokenHash: id }, t);
    expect(last).toMatchObject({ ok: false, error: "rate" });
  });
});

describe("the hub: an eval token's sender", () => {
  const setup = (o: { rpc?: boolean; boxEval?: "live" | "gone"; unsure?: boolean } = {}) => {
    const sockets: FakeSocket[] = [];
    const SESSIONS = {
      live: async () => "gone",
      boxChat: async () => "live",
      boxEval: async () => o.boxEval ?? "gone",
      ...(o.rpc === false
        ? {}
        : {
            evalToken: async (req: unknown) => {
              if (o.unsure) throw new Error("d1");
              return evalTokenCheck(db(), req, t);
            },
          }),
    };
    const hub = new DebugHub(
      {
        acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
        getWebSockets: () => sockets,
        storage: fakeStorage(),
      },
      { SESSIONS: rpcStub(SESSIONS) },
      () => t,
    );
    const g = globalThis as { WebSocketPair?: unknown };
    g.WebSocketPair = class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    };
    const sender = async (token: string) => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug/control?label=lane", {
          headers: { "x-debug-eval-token": token },
        }),
      );
      return sockets.at(-1)!;
    };
    const ownerPage = async () => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Fhome", {
          headers: { "x-debug-user": OWNER.userId, "x-debug-owner": "1" },
        }),
      );
      return sockets.at(-1)!;
    };
    const friendPage = async () => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Fwords", {
          headers: { "x-debug-user": ALICE.userId, "x-debug-owner": "0" },
        }),
      );
      return sockets.at(-1)!;
    };
    let n = 0;
    const boxPage = async () => {
      const exp = Math.floor(t / 1000) + 60;
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Fwords", {
          headers: {
            "x-debug-user": "owner",
            "x-debug-owner": "1",
            [EMBED_HEADER]: `jti-${String(n++).padStart(8, "0")}.${exp}`,
            [BOX_HEADER]: "c1",
          },
        }),
      );
      return sockets.at(-1)!;
    };
    const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
    return { hub, sender, ownerPage, friendPage, boxPage, msg };
  };

  it("runs code on the owner's pages with no tap, never a friend's", async () => {
    const { token } = await mint(OWNER);
    const { sender, ownerPage, friendPage, msg } = setup();
    const owner = await ownerPage();
    const friend = await friendPage();
    const s = await sender(token);
    expect(s.last("approved")).toMatchObject({ scope: "eval", via: "token" });
    expect(JSON.stringify(s.sent)).not.toContain(token);
    // No pairing prompt was ever shown.
    expect(owner.sent.some((m) => m.type === "state" && m.pending)).toBe(false);
    await msg(s, { type: "eval", code: "1+1" });
    expect(owner.last("eval")).toMatchObject({ code: "1+1" });
    expect(friend.last("eval")).toBeUndefined();
    expect(audits("api-token.eval").length).toBe(2);
  });

  it("reaches the box only while that box holds box:eval", async () => {
    const { token } = await mint(OWNER);
    const off = setup({ boxEval: "gone" });
    const b1 = await off.boxPage();
    const s1 = await off.sender(token);
    await off.msg(s1, { type: "eval", code: "1", target: "box" });
    expect(b1.last("eval")).toBeUndefined();
    const on = setup({ boxEval: "live" });
    const b2 = await on.boxPage();
    const s2 = await on.sender(token);
    await on.msg(s2, { type: "eval", code: "2", target: "box" });
    expect(b2.last("eval")).toMatchObject({ code: "2" });
  });

  it("refused at connect: no eval, not an owner's, unknown, an older main Worker", async () => {
    const chat = await mint(OWNER, ["chat:read"]);
    const hers = await mint(ALICE);
    for (const tok of [chat.token, hers.token, `lk_${"0".repeat(64)}`]) {
      const s = await setup().sender(tok);
      expect(s.closed).toBe(4498);
      expect(s.last("approved")).toBeUndefined();
    }
    const { token } = await mint(OWNER);
    expect((await setup({ rpc: false }).sender(token)).closed).toBe(4498);
    expect((await setup({ unsure: true }).sender(token)).closed).toBe(4503);
  });

  it("revoked: the next eval is refused and the sender closed; the notice closes it at once", async () => {
    const a = await mint(OWNER);
    const { hub, sender, ownerPage, msg } = setup();
    const owner = await ownerPage();
    const s = await sender(a.token);
    await revokeToken(db(), OWNER, a.id);
    await msg(s, { type: "eval", code: "x" });
    expect(owner.last("eval")).toBeUndefined();
    expect(s.closed).toBe(4498);
    const b = await mint(OWNER);
    const s2 = await sender(b.token);
    const res = await hub.fetch(
      new Request("https://lianki-push/internal/chat-tokens/revoked", {
        method: "POST",
        body: JSON.stringify({ tags: [b.id.slice(0, 16)] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(s2.closed).toBe(4498);
  });

  it("expired between evals: refused at use", async () => {
    const { token } = await mint(OWNER, ["eval"], 1);
    const { sender, ownerPage, msg } = setup();
    const owner = await ownerPage();
    const s = await sender(token);
    t += 2 * DAY;
    await msg(s, { type: "eval", code: "x" });
    expect(owner.last("eval")).toBeUndefined();
  });
});

describe("lianki-push: the eval token's header", () => {
  it("comes only from the sender's Authorization, on the control route", async () => {
    const seen: Headers[] = [];
    const env = {
      DEBUG: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (r: Request) => {
            seen.push(r.headers);
            return new Response(null, { status: 204 });
          },
        }),
      },
    } as unknown as Env;
    const tok = `lk_${"a".repeat(64)}`;
    const ctl = (h: Record<string, string>) =>
      new Request("https://lianki.com/api/version/debug/control?label=x", {
        headers: { upgrade: "websocket", ...h },
      });
    await push.fetch(ctl({ authorization: `Bearer ${tok}` }), env);
    expect(seen[0].get("x-debug-eval-token")).toBe(tok);
    expect(seen[0].get("authorization")).toBeNull();
    // Set by hand: dropped.
    await push.fetch(ctl({ "x-debug-eval-token": tok }), env);
    expect(seen[1].get("x-debug-eval-token")).toBeNull();
    // Not a token: nothing.
    await push.fetch(ctl({ authorization: "Bearer nope" }), env);
    expect(seen[2].get("x-debug-eval-token")).toBeNull();
  });
});

// The `progress` permission (lib/api-tokens.ts): offered to site owners only
// (OWNER_SCOPES), without eval's 30-day cap, and checked for the hub by
// chatTokenCheck with op "progress" (lib/chat-token.ts).
describe("the progress permission", () => {
  it("is offered to a site owner only and takes a long expiry; eval alone is capped", async () => {
    const mine = (await (await tokenApi(call("GET"), apiDeps(OWNER, true))).json()) as {
      scopes: { id: string }[];
    };
    expect(mine.scopes.map((s) => s.id)).toContain("progress");
    const theirs = (await (await tokenApi(call("GET"), apiDeps(ALICE, false))).json()) as {
      scopes: { id: string }[];
    };
    expect(theirs.scopes.map((s) => s.id)).not.toContain("progress");
    const body = { name: "codex", scopes: ["progress", "chat:write"], expiry: { days: 365 } };
    expect((await tokenApi(call("POST", body), apiDeps(ALICE, false))).status).toBe(400);
    const r = await tokenApi(call("POST", body), apiDeps(OWNER, true));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { scopes: string[] }).scopes).toEqual(["chat:write", "progress"]);
    expect(
      (
        await tokenApi(
          call("POST", { ...body, scopes: ["eval", "progress"] }),
          apiDeps(OWNER, true),
        )
      ).status,
    ).toBe(400);
    expect(parseScopes(["progress"])).toBeNull();
    expect(parseScopes(["progress"], { owner: true })).toEqual(["progress"]);
  });

  it("is what the hub asks for with op progress: the owner flag and the token's name", async () => {
    const { token, id } = await mint(OWNER, ["progress"], 365);
    const a = await chatTokenCheck(
      db() as never,
      { op: "progress", token, client: "mcp/0.4.0 tool=lianki_progress_report" },
      t,
    );
    expect(a).toMatchObject({ ok: true, owner: true, lane: "lane", userId: OWNER.userId });
    expect(audits("api-token.use").map((x) => x.detail)).toEqual([
      "progress lane via mcp/0.4.0 lianki_progress_report",
    ]);
    const chat = await mint(OWNER, ["chat:write"], 30);
    expect(
      await chatTokenCheck(db() as never, { op: "progress", token: chat.token }, t),
    ).toMatchObject({
      ok: false,
      error: "scope",
    });
    expect(id).toHaveLength(64);
  });
});
