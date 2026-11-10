/**
 * `lianki chat` with API tokens, end to end in one process: the hub
 * (workers/push/src/token-chat.ts inside DebugHub) asking the real main-Worker
 * check (lib/chat-token.ts) over a TestD1 database, and the token API
 * (lib/api-token-api.ts). Scope: own thread only, no eval/pair/grant/answer,
 * revoked and expired refused, lane on every line, card answers to their lane.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import {
  AUTH_MS,
  RECHECK_MS,
  TOKEN_REFUSED,
  TokenChat,
  forLane,
  laneText,
  tokenAtt,
} from "@/workers/push/src/token-chat";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import {
  createToken,
  checkToken,
  parseExpiry,
  parseScopes,
  revokeAllTokens,
  revokeToken,
  cleanTokenName,
  type ScopeId,
} from "@/lib/api-tokens";
import { CHAT_LIMITS, chatTokenCheck, type ChatTokenDb } from "@/lib/chat-token";
import { tokenApi } from "@/lib/api-token-api";
import { OWNER_THREAD } from "@/lib/dev-eval";

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
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
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
    list: async <T>({
      prefix,
      reverse,
      limit,
    }: {
      prefix: string;
      reverse?: boolean;
      limit?: number;
    }) => {
      let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

let d1: TestD1Database;
let t: number;
const db = () => d1 as unknown as ChatTokenDb;
const OWNER = { userId: "uOwner", email: "owner@example.com" };
const ALICE = { userId: "uAlice", email: "alice@example.com" };
const BOB = { userId: "uBob", email: "bob@example.com" };
const CHAT: ScopeId[] = ["chat:read", "chat:write", "chat:ask"];

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  t = T0;
  const raw = d1.raw();
  for (const u of [OWNER, ALICE, BOB])
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

const mint = (who: typeof OWNER, name: string, scopes = CHAT, days = 30) =>
  createToken(db(), who, { name, scopes, expiresAt: new Date(t + days * DAY) }, t);

function hubSetup() {
  const sockets: FakeSocket[] = [];
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    },
    {
      SESSIONS: {
        live: async () => "gone",
        chatToken: (req: unknown) => chatTokenCheck(db(), req, t),
      },
    },
    () => t,
  );
  const http = async (token: string | null, body: unknown) => {
    const r = await hub.fetch(
      new Request("https://lianki.com/api/version/chat", {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  /** A token socket that has sent its token (as `lianki chat listen` does). */
  const listen = async (token: string, history?: number) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    hub["tokens"].opened(ws);
    await hub.webSocketMessage(
      ws,
      JSON.stringify({ type: "auth", token, ...(history ? { history } : {}) }),
    );
    return ws;
  };
  const page = async (who: { userId: string; email: string; owner: boolean }) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(ws, new URL("https://lianki.com/api/version/debug?label=%2Fwords"), who);
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  return { hub, sockets, http, listen, page, msg };
}

describe("tokens: permissions as data, expiry required, one account", () => {
  it("only known permissions; eval, pair, grant are not permissions", () => {
    expect(parseScopes(["chat:write", "study", "chat:write"])).toEqual(["study", "chat:write"]);
    for (const bad of [
      [],
      ["eval"],
      ["chat:read", "pair"],
      ["grant"],
      ["admin"],
      "chat:read",
      null,
    ])
      expect(parseScopes(bad)).toBeNull();
  });
  it("an expiry is required: listed days or a date within a year", () => {
    expect(parseExpiry(undefined, T0)).toBeNull();
    expect(parseExpiry({}, T0)).toBeNull();
    expect(parseExpiry({ days: 0 }, T0)).toBeNull();
    expect(parseExpiry({ days: 3650 }, T0)).toBeNull();
    expect(parseExpiry({ days: 30 }, T0)?.getTime()).toBe(T0 + 30 * DAY);
    expect(parseExpiry({ date: "2027-01-31" }, T0)?.toISOString()).toBe("2027-01-31T23:59:59.999Z");
    expect(parseExpiry({ date: "2028-01-31" }, T0)).toBeNull();
    expect(parseExpiry({ date: "2026-11-01" }, T0)).toBeNull();
  });
  it("names: one line, no 【】, at most 40", () => {
    expect(cleanTokenName("  codex \n lane ")).toBe("codex lane");
    expect(cleanTokenName("【owner】")).toBe("owner");
    expect(cleanTokenName("x".repeat(41))).toBeNull();
    expect(cleanTokenName("")).toBeNull();
  });
  it("a token acts only as the account that made it; another can neither use nor revoke it", async () => {
    const a = await mint(ALICE, "alice-lane");
    expect(await revokeToken(db(), BOB, a.id)).toBeNull();
    const c = await checkToken(db(), a.token, "chat:write", t);
    expect(c.ok && c.user.id).toBe(ALICE.userId);
    // The account's row gone: the token is nobody.
    d1.raw().prepare("DELETE FROM user WHERE id = ?").run(ALICE.userId);
    expect((await checkToken(db(), a.token, "chat:write", t)).ok).toBe(false);
  });
  it("a sign-out everywhere deletes every token of the account, only that account", async () => {
    await mint(ALICE, "a1");
    await mint(ALICE, "a2");
    const b = await mint(BOB, "b1");
    expect((await revokeAllTokens(db(), ALICE)).length).toBe(2);
    expect((await checkToken(db(), b.token, "chat:read", t)).ok).toBe(true);
  });
});

describe("chatTokenCheck (the main Worker's side)", () => {
  it("names the token account's own thread: the owner's, or the user's", async () => {
    const o = await mint(OWNER, "codex");
    const a = await mint(ALICE, "my-mac");
    expect(await chatTokenCheck(db(), { op: "say", token: o.token }, t)).toMatchObject({
      ok: true,
      owner: true,
      lane: "codex",
    });
    expect(await chatTokenCheck(db(), { op: "say", token: a.token }, t)).toMatchObject({
      ok: true,
      owner: false,
      userId: ALICE.userId,
      lane: "my-mac",
    });
  });
  it("deny by default: unknown op, missing scope, expired, revoked, malformed", async () => {
    const readOnly = await mint(ALICE, "ro", ["chat:read"]);
    expect(await chatTokenCheck(db(), { op: "eval", token: readOnly.token }, t)).toMatchObject({
      ok: false,
    });
    expect(await chatTokenCheck(db(), { op: "pair", token: readOnly.token }, t)).toMatchObject({
      ok: false,
    });
    expect(await chatTokenCheck(db(), { op: "say", token: readOnly.token }, t)).toEqual({
      ok: false,
      error: "scope",
    });
    expect(await chatTokenCheck(db(), { op: "ask", token: readOnly.token }, t)).toEqual({
      ok: false,
      error: "scope",
    });
    expect((await chatTokenCheck(db(), { op: "read", token: readOnly.token }, t)).ok).toBe(true);
    const study = await mint(ALICE, "cards", ["study"]);
    expect(await chatTokenCheck(db(), { op: "read", token: study.token }, t)).toEqual({
      ok: false,
      error: "scope",
    });
    const short = await mint(ALICE, "short", CHAT, 7);
    expect(await chatTokenCheck(db(), { op: "read", token: short.token }, t + 8 * DAY)).toEqual({
      ok: false,
      error: "expired",
    });
    await revokeToken(db(), ALICE, short.id);
    expect(await chatTokenCheck(db(), { op: "read", token: short.token }, t)).toEqual({
      ok: false,
      error: "unknown",
    });
    expect(await chatTokenCheck(db(), { op: "read", token: "lk_nope" }, t)).toEqual({
      ok: false,
      error: "bad request",
    });
    expect(
      await chatTokenCheck(db(), { op: "read", token: study.token, tokenHash: study.id }, t),
    ).toEqual({
      ok: false,
      error: "bad request",
    });
  });
  it("rate-limited per token; uses and refusals are audited by tag, never the token", async () => {
    const a = await mint(ALICE, "busy");
    for (let i = 0; i < CHAT_LIMITS.post.max; i++)
      expect((await chatTokenCheck(db(), { op: "say", token: a.token }, t)).ok).toBe(true);
    expect(await chatTokenCheck(db(), { op: "say", token: a.token }, t)).toMatchObject({
      ok: false,
      error: "rate",
    });
    // Another token of the same account has its own budget.
    const b = await mint(ALICE, "other");
    expect((await chatTokenCheck(db(), { op: "say", token: b.token }, t)).ok).toBe(true);
    const rows = d1.raw().prepare("SELECT kind, actor, subject, detail FROM security_audit").all();
    const dump = JSON.stringify(rows);
    expect(dump).toContain("api-token.use");
    expect(dump).toContain("api-token.refused");
    expect(dump).not.toContain(a.token);
    expect(dump).not.toContain(a.token.slice(3));
  });
});

describe("the hub: a named MCP client reaches the audit log", () => {
  it("x-lianki-client is passed on and kept only in its known shape", async () => {
    const s = hubSetup();
    const a = await mint(ALICE, "my AI");
    const post = (client: string) =>
      s.hub.fetch(
        new Request("https://lianki.com/api/version/chat", {
          method: "POST",
          headers: { authorization: `Bearer ${a.token}`, "x-lianki-client": client },
          body: JSON.stringify({ op: "say", text: "hi" }),
        }),
      );
    expect((await post("mcp/0.4.0 tool=lianki_chat_say")).status).toBe(200);
    const uses = () =>
      d1.raw().prepare("SELECT detail FROM security_audit WHERE kind = 'api-token.use'").all() as {
        detail: string;
      }[];
    expect(uses()).toEqual([{ detail: "chat say my AI via mcp/0.4.0 lianki_chat_say" }]);
    // A header in any other shape adds nothing to the row.
    d1.raw().prepare("UPDATE api_tokens SET last_used_at = NULL").run();
    expect((await post("mcp/0.4.0 tool=lianki_x; DROP TABLE")).status).toBe(200);
    expect(uses()[1]).toEqual({ detail: "chat say my AI" });
  });
});

describe("the hub: own thread only", () => {
  it("a user's token posts into that user's thread, labelled with its lane, as an agent line", async () => {
    const s = hubSetup();
    const a = await mint(ALICE, "my-mac");
    const alicePage = await s.page({ userId: ALICE.userId, email: ALICE.email, owner: false });
    const bobPage = await s.page({ userId: BOB.userId, email: BOB.email, owner: false });
    const ownerPage = await s.page({ userId: OWNER.userId, email: OWNER.email, owner: true });
    const r = await s.http(a.token, {
      op: "say",
      text: "hello",
      thread: OWNER_THREAD,
      to: BOB.userId,
    });
    expect(r.status).toBe(200);
    const line = alicePage.of("chat").at(-1)?.message as Record<string, unknown>;
    expect(line).toMatchObject({
      from: "agent",
      via: "token",
      tokenLane: "my-mac",
      label: "my-mac",
      text: "【my-mac】hello",
      thread: ALICE.userId,
    });
    expect(line.lane).toBeUndefined(); // "my-mac" is not a known lane: the prefix stays
    // The `thread`/`to` it sent are ignored: nobody else's thread got it.
    expect(bobPage.of("chat")).toEqual([]);
    expect(ownerPage.of("chat")).toEqual([]);
  });

  it("the owner's lane token posts into the owner thread; a read sees only its own thread", async () => {
    const s = hubSetup();
    const o = await mint(OWNER, "codex");
    const a = await mint(ALICE, "alice");
    await s.http(a.token, { op: "say", text: "alice line" });
    await s.http(o.token, { op: "say", text: "PR is green", quiet: true });
    const ro = await s.http(o.token, { op: "read" });
    expect(ro.body.thread).toBe("owner");
    const texts = (ro.body.messages as { text: string }[]).map((m) => m.text);
    expect(texts).toEqual(["【codex】PR is green"]);
    const ra = await s.http(a.token, { op: "read" });
    expect((ra.body.messages as { text: string }[]).map((m) => m.text)).toEqual([
      "【alice】alice line",
    ]);
  });

  it("no token, a revoked one, an expired one, or the wrong permission: refused, nothing posted", async () => {
    const s = hubSetup();
    const p = await s.page({ userId: ALICE.userId, email: ALICE.email, owner: false });
    expect((await s.http(null, { op: "say", text: "x" })).status).toBe(401);
    const a = await mint(ALICE, "gone");
    await revokeToken(db(), ALICE, a.id);
    expect((await s.http(a.token, { op: "say", text: "x" })).status).toBe(401);
    const e = await mint(ALICE, "old", CHAT, 7);
    t += 8 * DAY;
    expect((await s.http(e.token, { op: "say", text: "x" })).status).toBe(401);
    const ro = await mint(ALICE, "ro", ["chat:read"]);
    expect((await s.http(ro.token, { op: "say", text: "x" })).status).toBe(403);
    expect((await s.http(ro.token, { op: "ask", question: "q", options: ["a"] })).status).toBe(403);
    expect((await s.http(ro.token, { op: "eval", code: "1" })).status).toBe(400);
    expect(p.of("chat")).toEqual([]);
  });

  it("a token socket can say and ask, never eval, pair, grant or answer", async () => {
    const s = hubSetup();
    const o = await mint(OWNER, "codex");
    const ws = await s.listen(o.token);
    expect(ws.of("ready")[0]).toMatchObject({ lane: "codex", thread: "owner" });
    for (const m of [
      { type: "eval", code: "document.cookie" },
      { type: "allow", pair: "x" },
      { type: "grant", from: "/", to: "/x" },
      { type: "inbox", op: "list" },
      { type: "clips", op: "on" },
      { type: "answer", askId: "a1", choices: { q1: "o1" } },
    ]) {
      await s.msg(ws, m);
      expect(ws.sent.at(-1)?.type).toBe("error");
    }
    expect(String(ws.sent.at(-1)?.error)).toContain("tap");
    await s.msg(ws, { type: "say", text: "hi" });
    expect(ws.of("sent")).toHaveLength(1);
  });

  it("the first message must be the token; a bad one closes the socket", async () => {
    const s = hubSetup();
    const ws = await s.listen(`lk_${"0".repeat(64)}`);
    expect(ws.closed).toBe(TOKEN_REFUSED);
    const ws2 = new FakeSocket();
    s.sockets.push(ws2);
    s.hub["tokens"].opened(ws2);
    await s.msg(ws2, { type: "say", text: "no auth" });
    expect(ws2.closed).toBe(TOKEN_REFUSED);
  });

  it("a listener hears only its own thread, and closes on revoke and expiry", async () => {
    const s = hubSetup();
    const a = await mint(ALICE, "alice", CHAT, 7);
    const b = await mint(BOB, "bob");
    const la = await s.listen(a.token);
    const lb = await s.listen(b.token);
    await s.http(b.token, { op: "say", text: "bob only" });
    expect(la.of("chat")).toEqual([]);
    expect(lb.of("chat")).toHaveLength(1);
    // Revoked: the main Worker's notice closes it at once.
    const r = await s.hub.fetch(
      new Request("https://lianki-push/internal/chat-tokens/revoked", {
        method: "POST",
        body: JSON.stringify({ tags: [b.id.slice(0, 16)] }),
      }),
    );
    expect(r.status).toBe(200);
    expect(lb.closed).toBe(TOKEN_REFUSED);
    // Expired: closed at the next event for it.
    t += 8 * DAY;
    await s.page({ userId: ALICE.userId, email: ALICE.email, owner: false });
    const c = await mint(ALICE, "fresh");
    await s.http(c.token, { op: "say", text: "after expiry" });
    expect(la.of("chat")).toEqual([]);
    expect(la.closed).toBe(TOKEN_REFUSED);
  });

  it("a revoke the notice missed is caught by the re-check", async () => {
    const s = hubSetup();
    const a = await mint(ALICE, "alice");
    const la = await s.listen(a.token);
    await revokeToken(db(), ALICE, a.id);
    const c = await mint(ALICE, "other");
    t += RECHECK_MS + 1;
    await s.http(c.token, { op: "say", text: "x" });
    expect(la.of("chat")).toEqual([]);
    expect(la.closed).toBe(TOKEN_REFUSED);
  });
});

describe("ask cards: only a tap answers, only the asking lane hears it", () => {
  it("routes the answer to the lane that asked, not to another lane or eval listeners", async () => {
    const s = hubSetup();
    const codex = await mint(OWNER, "codex");
    const agy = await mint(OWNER, "agy");
    const owner = await s.page({ userId: OWNER.userId, email: OWNER.email, owner: true });
    const lc = await s.listen(codex.token);
    const la = await s.listen(agy.token);
    const asked = await s.http(codex.token, {
      op: "ask",
      question: "Ship it?",
      options: [{ label: "Yes", recommended: true }, "No"],
    });
    expect(asked.status).toBe(200);
    const askId = asked.body.askId as string;
    const card = owner.of("chat").at(-1)?.message as Record<string, unknown>;
    expect(card).toMatchObject({
      tokenLane: "codex",
      lane: "codex", // a known lane: its mark and voice
      via: "token",
      text: "【codex】Ship it? — Yes / No",
    });
    // A token socket cannot answer it.
    await s.msg(lc, { type: "answer", askId, choices: { q1: "o1" } });
    expect(owner.of("answered")).toEqual([]);
    // The owner's tap does.
    await s.msg(owner, { type: "answer", askId, choices: { q1: "o1" } });
    expect(owner.of("answered")).toHaveLength(1);
    expect(lc.of("answered")).toHaveLength(1);
    expect(lc.of("answered")[0]).toMatchObject({ askId, labels: { q1: ["Yes"] } });
    expect(la.of("answered")).toEqual([]);
    // A read by another lane does not carry the answer; the asking lane's does.
    const otherRead = await s.http(agy.token, { op: "read" });
    const ownRead = await s.http(codex.token, { op: "read" });
    const find = (r: typeof otherRead) =>
      (r.body.messages as Record<string, unknown>[]).find(
        (m) => (m.ask as { askId: string })?.askId === askId,
      );
    expect(find(otherRead)?.answer).toBeUndefined();
    expect(find(ownRead)?.answer).toMatchObject({ source: "tap", choices: { q1: ["o1"] } });
  });

  it("a user's ask is answered only by that user's page", async () => {
    const s = hubSetup();
    const a = await mint(ALICE, "alice");
    const bobPage = await s.page({ userId: BOB.userId, email: BOB.email, owner: false });
    const alicePage = await s.page({ userId: ALICE.userId, email: ALICE.email, owner: false });
    const la = await s.listen(a.token);
    const { body } = await s.http(a.token, {
      op: "ask",
      question: "Study now?",
      options: ["Yes", "Later"],
    });
    await s.msg(bobPage, { type: "answer", askId: body.askId, choices: { q1: "o1" } });
    expect(la.of("answered")).toEqual([]);
    await s.msg(alicePage, { type: "answer", askId: body.askId, choices: { q1: "o2" } });
    expect(la.of("answered")[0]).toMatchObject({ labels: { q1: ["Later"] } });
  });
});

describe("helpers", () => {
  it("laneText adds the lane once", () => {
    expect(laneText("codex", "hi")).toBe("【codex】hi");
    expect(laneText("codex", "【codex】hi")).toBe("【codex】hi");
  });
  it("forLane drops another lane's answer", () => {
    const m = {
      id: "1",
      from: "agent" as const,
      label: "x",
      text: "q",
      at: 1,
      via: "token" as const,
      tokenLane: "codex",
      answer: { choices: {}, source: "tap" as const, thread: "owner", label: "", at: 1 },
    };
    expect(forLane(m, "codex").answer).toBeTruthy();
    expect(forLane(m, "agy").answer).toBeUndefined();
  });
});

describe("/api/token (the token page's API)", () => {
  const deps = (who: typeof OWNER | null, revoked: string[][] = []) => ({
    who: async () => who,
    db: () => d1 as unknown as D1Like & ChatTokenDb,
    revoked: async (ids: string[]) => void revoked.push(ids),
    now: () => t,
  });
  const call = (method: string, body?: unknown, h: Record<string, string> = {}) =>
    new Request("https://lianki.com/api/token", {
      method,
      headers: { "content-type": "application/json", origin: "https://lianki.com", ...h },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("creates with name, permissions and expiry; the secret is in that answer only", async () => {
    const r = await tokenApi(
      call("POST", { name: "codex", scopes: CHAT, expiry: { days: 30 } }),
      deps(OWNER),
    );
    expect(r.status).toBe(200);
    const made = (await r.json()) as { token: string; id: string; account: string };
    expect(made.token).toMatch(/^lk_[0-9a-f]{64}$/);
    expect(made.account).toBe(OWNER.email);
    const list = (await (await tokenApi(call("GET"), deps(OWNER))).json()) as {
      account: string;
      tokens: Record<string, unknown>[];
    };
    expect(list.account).toBe(OWNER.email);
    expect(list.tokens[0]).toMatchObject({
      name: "codex",
      scopes: CHAT,
      email: OWNER.email,
      lastUsedAt: null,
    });
    expect(JSON.stringify(list)).not.toContain(made.token);
    expect(JSON.stringify(d1.raw().prepare("SELECT * FROM api_tokens").all())).not.toContain(
      made.token,
    );
    expect(JSON.stringify(d1.raw().prepare("SELECT * FROM security_audit").all())).toContain(
      "api-token.create",
    );
  });

  it("refuses no expiry, no permission, eval, a cross-site write, a guest", async () => {
    const d = deps(OWNER);
    expect((await tokenApi(call("POST", { name: "x", scopes: CHAT }), d)).status).toBe(400);
    expect(
      (await tokenApi(call("POST", { name: "x", scopes: [], expiry: { days: 7 } }), d)).status,
    ).toBe(400);
    expect(
      (
        await tokenApi(
          call("POST", { name: "x", scopes: ["chat:read", "eval"], expiry: { days: 7 } }),
          d,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await tokenApi(
          call(
            "POST",
            { name: "x", scopes: CHAT, expiry: { days: 7 } },
            { origin: "https://evil.example" },
          ),
          d,
        )
      ).status,
    ).toBe(403);
    expect((await tokenApi(call("GET"), deps(null))).status).toBe(401);
  });

  it("one-click revoke of one's own token; another account's is not found", async () => {
    const revoked: string[][] = [];
    const a = await mint(ALICE, "alice");
    expect((await tokenApi(call("DELETE", { id: a.id }), deps(BOB, revoked))).status).toBe(404);
    expect((await tokenApi(call("DELETE", { id: a.id }), deps(ALICE, revoked))).status).toBe(200);
    expect(revoked).toEqual([[a.id]]);
    expect((await checkToken(db(), a.token, "chat:read", t)).ok).toBe(false);
    expect(JSON.stringify(d1.raw().prepare("SELECT * FROM security_audit").all())).toContain(
      "api-token.revoke",
    );
  });
});

describe("/api/token: the rest of the refusals", () => {
  const deps = (who: typeof OWNER | null) => ({
    who: async () => who,
    db: () => d1 as unknown as D1Like & ChatTokenDb,
    revoked: async () => {},
    maxTokens: 2,
    now: () => t,
  });
  const req = (method: string, body?: string, h: Record<string, string> = {}) =>
    new Request("https://lianki.com/api/token", {
      method,
      headers: { "content-type": "application/json", ...h },
      ...(body === undefined ? {} : { body }),
    });
  const good = JSON.stringify({ name: "x", scopes: ["chat:read"], expiry: { days: 7 } });

  it("method, content type, cross-site fetch, bad JSON, bad name, the cap, unknown id", async () => {
    expect((await tokenApi(req("PUT", good), deps(OWNER))).status).toBe(405);
    expect(
      (await tokenApi(req("POST", good, { "content-type": "text/plain" }), deps(OWNER))).status,
    ).toBe(403);
    expect(
      (await tokenApi(req("POST", good, { "sec-fetch-site": "cross-site" }), deps(OWNER))).status,
    ).toBe(403);
    expect((await tokenApi(req("POST", "{nope"), deps(OWNER))).status).toBe(400);
    const noName = JSON.stringify({ name: "  ", scopes: ["chat:read"], expiry: { days: 7 } });
    expect((await tokenApi(req("POST", noName), deps(OWNER))).status).toBe(400);
    // No Origin at all (a script with the session) is fine; the cap is per account.
    expect((await tokenApi(req("POST", good), deps(OWNER))).status).toBe(200);
    expect((await tokenApi(req("POST", good), deps(OWNER))).status).toBe(200);
    expect((await tokenApi(req("POST", good), deps(OWNER))).status).toBe(409);
    expect((await tokenApi(req("POST", good), deps(ALICE))).status).toBe(200);
    const unknownId = JSON.stringify({ id: "f".repeat(64) });
    expect((await tokenApi(req("DELETE", unknownId), deps(OWNER))).status).toBe(404);
    expect((await tokenApi(req("DELETE", JSON.stringify({ id: "x" })), deps(OWNER))).status).toBe(
      404,
    );
  });
});

describe("TokenChat edges (a fake main Worker)", () => {
  const TOK = `lk_${"1".repeat(64)}`;
  const ID = "a".repeat(64);
  const okAnswer = (over: Record<string, unknown> = {}) => ({
    ok: true,
    userId: "uX",
    owner: false,
    lane: "x",
    id: ID,
    tag: ID.slice(0, 16),
    expiresAt: null,
    ...over,
  });
  function edge(rpc: ((req: { op: string }) => unknown) | null, blocked = false) {
    const sockets: FakeSocket[] = [];
    let now = T0;
    const posted: unknown[] = [];
    const history = [
      { id: "h1", from: "agent" as const, label: "x", text: "old", at: 1, thread: "uX" },
    ];
    const tc = new TokenChat({
      now: () => now,
      rpc: () => (rpc ? { chatToken: async (r) => rpc(r) } : undefined),
      sockets: () => sockets,
      post: async (m) => void posted.push(m),
      history: async () => history,
      blocked: async () => blocked,
    });
    const sock = () => {
      const ws = new FakeSocket();
      sockets.push(ws);
      tc.opened(ws);
      return ws;
    };
    const say = (ws: FakeSocket, m: unknown) =>
      tc.message(ws, tokenAtt(ws)!, typeof m === "string" ? m : JSON.stringify(m));
    const post = (body: unknown, auth = `Bearer ${TOK}`, method = "POST") =>
      tc.http(
        new Request("https://lianki.com/api/version/chat", {
          method,
          headers: { authorization: auth },
          ...(method === "POST"
            ? { body: typeof body === "string" ? body : JSON.stringify(body) }
            : {}),
        }),
      );
    return { tc, sockets, sock, say, post, posted, tick: (ms: number) => (now += ms) };
  }

  it("no RPC, a throwing RPC, a malformed answer, a bad user id: 503, nothing posted", async () => {
    for (const rpc of [
      null,
      () => {
        throw new Error("down");
      },
      () => null,
      () => okAnswer({ userId: "has:colon" }),
    ]) {
      const e = edge(rpc);
      expect((await e.post({ op: "say", text: "x" })).status).toBe(503);
      expect(e.posted).toEqual([]);
    }
  });

  it("HTTP: method, body size, JSON, op, rate (Retry-After), blocked, bad ask, read limit", async () => {
    const e = edge(() => okAnswer());
    expect((await e.post(null, undefined, "GET")).status).toBe(405);
    expect((await e.post("x".repeat(20_000))).status).toBe(413);
    expect((await e.post("[1]")).status).toBe(400);
    expect((await e.post("{")).status).toBe(400);
    expect((await e.post({ op: "eval" })).status).toBe(400);
    expect((await e.post({ op: "say" })).status).toBe(400);
    expect((await e.post({ op: "ask", question: "q", options: [] })).status).toBe(400);
    const r = await e.post({ op: "read", limit: 1 });
    expect(((await r.json()) as { thread: string }).thread).toBe("own");
    const rated = edge(() => ({ ok: false, error: "rate", retryAfterMs: 1500 }));
    const rr = await rated.post({ op: "say", text: "x" });
    expect(rr.status).toBe(429);
    expect(rr.headers.get("retry-after")).toBe("2");
    expect((await edge(() => okAnswer(), true).post({ op: "say", text: "x" })).status).toBe(403);
  });

  it("sockets: blocked at auth, refused at auth, history, too slow, a binary frame", async () => {
    const blocked = edge(() => okAnswer(), true);
    const b = blocked.sock();
    await blocked.say(b, { type: "auth", token: TOK });
    expect(b.closed).toBe(TOKEN_REFUSED);
    const rated = edge(() => ({ ok: false, error: "rate", retryAfterMs: 5 }));
    const r = rated.sock();
    await rated.say(r, { type: "auth", token: TOK });
    expect(r.of("error")[0]).toMatchObject({ error: "rate", retryAfterMs: 5 });
    const e = edge(() => okAnswer());
    const h = e.sock();
    await e.say(h, { type: "auth", token: TOK, history: 5 });
    expect(h.of("history")[0]).toMatchObject({ messages: [{ id: "h1" }] });
    const slow = e.sock();
    e.tick(AUTH_MS + 1);
    await e.say(slow, { type: "auth", token: TOK });
    expect(slow.closed).toBe(TOKEN_REFUSED);
    // A frame that is not JSON (or binary) is no auth: closed.
    const bin = edge(() => okAnswer());
    const s = bin.sock();
    await bin.tc.message(s, tokenAtt(s)!, new ArrayBuffer(4));
    expect(s.closed).toBe(TOKEN_REFUSED);
  });

  it("an authenticated socket: refused say, a thread that changed, a bad ask, a 5th socket", async () => {
    let answer: unknown = okAnswer();
    const e = edge(() => answer);
    const ws = e.sock();
    await e.say(ws, { type: "auth", token: TOK });
    await e.say(ws, { type: "ask", question: "q", options: [] });
    expect(ws.sent.at(-1)?.type).toBe("error");
    await e.say(ws, "not json");
    expect(ws.sent.at(-1)?.type).toBe("error");
    answer = { ok: false, error: "rate", retryAfterMs: 9 };
    await e.say(ws, { type: "say", text: "x" });
    expect(ws.sent.at(-1)).toMatchObject({ error: "rate", retryAfterMs: 9 });
    expect(ws.closed).toBeUndefined();
    answer = { ok: false, error: "unknown" };
    await e.say(ws, { type: "say", text: "x" });
    expect(ws.closed).toBe(TOKEN_REFUSED);
    // The account became the owner's mid-socket: its thread is no longer this one.
    answer = okAnswer();
    const w2 = e.sock();
    await e.say(w2, { type: "auth", token: TOK });
    answer = okAnswer({ owner: true });
    await e.say(w2, { type: "say", text: "x" });
    expect(w2.closed).toBe(TOKEN_REFUSED);
    // MAX_SOCKETS_PER_TOKEN: the oldest closes.
    answer = okAnswer();
    const f = edge(() => answer);
    const many: FakeSocket[] = [];
    for (let i = 0; i < 5; i++) {
      const s = f.sock();
      f.tick(1);
      await f.say(s, { type: "auth", token: TOK });
      many.push(s);
    }
    expect(many[0]!.closed).toBe(4409);
    expect(many[4]!.closed).toBeUndefined();
  });

  it("re-check: no answer skips the delivery; a refusal closes; edits reach owner sockets", async () => {
    let answer: unknown = okAnswer({ owner: true });
    const e = edge(() => answer);
    const ws = e.sock();
    await e.say(ws, { type: "auth", token: TOK });
    const line = {
      id: "l",
      from: "agent" as const,
      label: "x",
      text: "t",
      at: 1,
      thread: OWNER_THREAD,
    };
    await e.tc.edited({ type: "edited", id: "l", thread: OWNER_THREAD, text: "t" } as never);
    expect(ws.of("edited")).toHaveLength(1);
    e.tick(RECHECK_MS + 1);
    answer = { ok: false, error: "unavailable" };
    await e.tc.chat(line);
    expect(ws.of("chat")).toEqual([]);
    expect(ws.closed).toBeUndefined();
    answer = okAnswer({ owner: true });
    await e.tc.chat(line);
    expect(ws.of("chat")).toHaveLength(1);
    e.tick(RECHECK_MS + 1);
    answer = { ok: false, error: "scope" };
    await e.tc.chat(line);
    expect(ws.closed).toBe(TOKEN_REFUSED);
  });

  it("revoke notice: method, JSON, nothing named; by user", async () => {
    const e = edge(() => okAnswer());
    const ws = e.sock();
    await e.say(ws, { type: "auth", token: TOK });
    const rv = (body: string, method = "POST") =>
      e.tc.revoked(
        new Request("https://lianki-push/internal/chat-tokens/revoked", {
          method,
          ...(method === "POST" ? { body } : {}),
        }),
      );
    expect((await rv("", "GET")).status).toBe(405);
    expect((await rv("{")).status).toBe(400);
    expect((await rv(JSON.stringify({ tags: ["nope"] }))).status).toBe(400);
    expect((await rv(JSON.stringify({ userId: "uX" }))).status).toBe(200);
    expect(ws.closed).toBe(TOKEN_REFUSED);
  });

  it("a socket that throws on send or close, or whose attachment cannot be read", () => {
    const bad = {
      send() {
        throw new Error("gone");
      },
      close() {
        throw new Error("gone");
      },
      serializeAttachment() {},
      deserializeAttachment() {
        throw new Error("gone");
      },
    };
    expect(tokenAtt(bad)).toBeNull();
    const e = edge(() => okAnswer());
    e.tc.opened(bad);
    expect(() => e.tc.count(OWNER_THREAD)).not.toThrow();
  });
});

describe("notifyTokensRevoked", () => {
  it("sends tags (never ids or tokens) and the user over the binding; never throws", async () => {
    const { notifyTokensRevoked } = await import("@/lib/push-chat-tokens");
    const sent: { url: string; body: string }[] = [];
    const ok = {
      fetch: async (url: string, init?: RequestInit) => {
        sent.push({ url, body: String(init?.body) });
        return new Response("{}");
      },
    };
    await notifyTokensRevoked({ ids: ["a".repeat(64)], userId: "u1" }, ok);
    expect(sent[0]!.url).toBe("https://lianki-push/internal/chat-tokens/revoked");
    expect(JSON.parse(sent[0]!.body)).toEqual({ tags: ["a".repeat(16)], userId: "u1" });
    await notifyTokensRevoked(
      { ids: [] },
      { fetch: async () => new Response("no", { status: 503 }) },
    );
    await notifyTokensRevoked(
      { userId: "u1" },
      {
        fetch: async () => {
          throw new Error("down");
        },
      },
    );
    await notifyTokensRevoked({ userId: "u1" }, null);
    // Off the Worker (tests, dev) there is no binding: nothing is sent.
    await notifyTokensRevoked({ userId: "u1" });
  });
});
