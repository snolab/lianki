/**
 * `say --play` on the server (lib/play-check.ts; docs/li-sound-hub.md,
 * "Playing audio from an agent"): the flag, the deny list, a lane token's
 * chat:play and dev grant, the rate limit, the audit of every play; and the
 * token path end to end in one process (workers/push/src/token-chat.ts in
 * DebugHub asking the real check over a TestD1). Nothing is fetched.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { createToken, type ScopeId } from "@/lib/api-tokens";
import { chatTokenCheck, type ChatTokenDb } from "@/lib/chat-token";
import { PLAY_FLAG, type PlayCheckDb, playCheck } from "@/lib/play-check";

const SCHEMA = testSchema();
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-11T12:00:00Z");

let d1: TestD1Database;
let t: number;
const db = () => d1 as unknown as PlayCheckDb;
const OWNER = { userId: "uOwner", email: "owner@example.com" };
const ALICE = { userId: "uAlice", email: "alice@example.com" };
const CHAT: ScopeId[] = ["chat:read", "chat:write", "chat:ask"];
const PLAY: ScopeId[] = [...CHAT, "chat:play"];

const flag = (on: boolean) =>
  d1
    .raw()
    .prepare(
      "INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, 'x', 'x')",
    )
    .run(PLAY_FLAG, on ? 1 : 0);
const config = (key: string, value: unknown) =>
  d1
    .raw()
    .prepare(
      "INSERT OR REPLACE INTO config_values (key, value_json, updated_at, updated_by) VALUES (?, ?, 'x', 'x')",
    )
    .run(key, JSON.stringify(value));
const audits = () =>
  d1
    .raw()
    .prepare(
      "SELECT kind, actor, subject, detail FROM security_audit WHERE kind IN ('chat.play', 'api-token.refused') ORDER BY id",
    )
    .all() as { kind: string; actor: string; subject: string | null; detail: string | null }[];

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

const mint = (who: typeof OWNER, name: string, scopes = PLAY) =>
  createToken(db() as never, who, { name, scopes, expiresAt: new Date(t + 30 * DAY) }, t);

describe("playCheck", () => {
  const grant = { via: "grant", label: "main lane", host: "cdn.example.com", kind: "file" };

  it("deny by default: the flag off refuses everything", async () => {
    expect(await playCheck(db(), grant, t)).toEqual({ ok: false, error: "flag" });
    expect(audits()).toEqual([]);
  });

  it("the grant path: allowed and audited (host and kind, never a URL)", async () => {
    flag(true);
    expect(await playCheck(db(), grant, t)).toEqual({ ok: true });
    expect(audits()).toEqual([
      { kind: "chat.play", actor: "grant", subject: "cdn.example.com", detail: "file main lane" },
    ]);
  });

  it("bad requests", async () => {
    flag(true);
    for (const bad of [
      null,
      { ...grant, host: "a b" },
      { ...grant, host: "" },
      { ...grant, kind: "rtc" },
      { ...grant, via: "page" },
      { via: "token", host: "a.example.com", kind: "file" },
      { via: "token", token: "x", tokenHash: "y", host: "a.example.com", kind: "file" },
      { via: "token", token: "not-a-token", host: "a.example.com", kind: "file" },
    ])
      expect(await playCheck(db(), bad, t)).toEqual({ ok: false, error: "bad request" });
  });

  it("the deny list (config): the host and everything under it", async () => {
    flag(true);
    config("chat.play.denyHosts", "example.com, other.org");
    expect(await playCheck(db(), grant, t)).toEqual({ ok: false, error: "denied" });
    expect(await playCheck(db(), { ...grant, host: "fine.example.net" }, t)).toEqual({ ok: true });
  });

  it("the rate limit (config), per sender, in a 10-minute window", async () => {
    flag(true);
    config("chat.play.perTenMin", 2);
    expect((await playCheck(db(), grant, t)).ok).toBe(true);
    expect((await playCheck(db(), grant, t)).ok).toBe(true);
    const third = await playCheck(db(), grant, t);
    expect(third).toMatchObject({ ok: false, error: "rate" });
    t += 11 * 60_000;
    expect((await playCheck(db(), grant, t)).ok).toBe(true);
    config("chat.play.perTenMin", 0);
    expect(await playCheck(db(), { ...grant, label: undefined }, t + 1)).toMatchObject({
      error: "rate",
    });
  });

  it("a token: chat:play, a dev holder's account, its own limit; every play audited", async () => {
    flag(true);
    const { token } = await mint(OWNER, "codex");
    const req = { via: "token", token, host: "cdn.example.com", kind: "stream" };
    expect(await playCheck(db(), req, t)).toEqual({ ok: true });
    expect(audits().at(-1)).toEqual({
      kind: "chat.play",
      actor: OWNER.userId,
      subject: "cdn.example.com",
      detail: "stream token codex",
    });
    const noPlay = await mint(OWNER, "agy", CHAT);
    expect(await playCheck(db(), { ...req, token: noPlay.token }, t)).toEqual({
      ok: false,
      error: "scope",
    });
    expect(audits().at(-1)).toMatchObject({ kind: "api-token.refused", detail: "chat play scope" });
    // A user without the dev grant: the flag's audience is the owner's.
    const alice = await mint(ALICE, "mine");
    expect(await playCheck(db(), { ...req, token: alice.token }, t)).toEqual({
      ok: false,
      error: "flag",
    });
    expect(await playCheck(db(), { ...req, token: `lk_${"0".repeat(64)}` }, t)).toEqual({
      ok: false,
      error: "unknown",
    });
    config("chat.play.perTenMin", 1);
    const lane = await mint(OWNER, "main");
    expect((await playCheck(db(), { ...req, token: lane.token }, t)).ok).toBe(true);
    expect(await playCheck(db(), { ...req, token: lane.token }, t)).toMatchObject({
      error: "rate",
    });
  });
});

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
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
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map(
        [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .sort()
          .map((k) => [k, structuredClone(store.get(k)) as T]),
      ),
  } as Storage;
}

function hub(withPlay = true) {
  const sockets: FakeSocket[] = [];
  const h = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    },
    {
      SESSIONS: {
        live: async () => "gone",
        chatToken: (req: unknown) => chatTokenCheck(db() as unknown as ChatTokenDb, req, t),
        ...(withPlay ? { playAudio: (req: unknown) => playCheck(db(), req, t) } : {}),
      },
    },
    () => t,
  );
  const http = async (token: string, body: unknown) => {
    const r = await h.fetch(
      new Request("https://lianki.com/api/version/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const listen = async (token: string) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    h["tokens"].opened(ws);
    await h.webSocketMessage(ws, JSON.stringify({ type: "auth", token }));
    return ws;
  };
  return { h, http, listen };
}

describe("lianki chat say --play (a lane token, through the hub)", () => {
  it("a line with audio, checked first; the history keeps it", async () => {
    flag(true);
    const { token } = await mint(OWNER, "codex");
    const s = hub();
    const r = await s.http(token, {
      op: "say",
      text: "listen",
      play: { src: "https://ice.example.com/live", title: "Radio" },
    });
    expect(r).toMatchObject({ status: 200, body: { ok: true, lane: "codex" } });
    const line = (await s.h.history()).at(-1)!;
    expect(line).toMatchObject({
      text: "【codex】listen",
      via: "token",
      audio: { src: "https://ice.example.com/live", kind: "stream", title: "Radio" },
    });
    expect(
      audits()
        .filter((a) => a.kind === "chat.play")
        .at(-1),
    ).toMatchObject({
      subject: "ice.example.com",
      detail: "stream token codex",
    });
  });

  it("refused: a bad src, the flag off, no chat:play, an older main Worker", async () => {
    const { token } = await mint(OWNER, "codex");
    const s = hub();
    const bad = await s.http(token, {
      op: "say",
      text: "x",
      play: { src: "http://a.example.com/a.mp3" },
    });
    expect(bad).toMatchObject({ status: 400 });
    expect(String(bad.body.error)).toContain("https");
    const off = await s.http(token, {
      op: "say",
      text: "x",
      play: { src: "https://a.example.com/a.mp3" },
    });
    expect(String(off.body.error)).toContain("chat.play-audio");
    flag(true);
    const agy = await mint(OWNER, "agy", CHAT);
    const scope = await s.http(agy.token, {
      op: "say",
      text: "x",
      play: { src: "https://a.example.com/a.mp3" },
    });
    expect(String(scope.body.error)).toContain("chat:play");
    const old = hub(false);
    const none = await old.http(token, {
      op: "say",
      text: "x",
      play: { src: "https://a.example.com/a.mp3" },
    });
    expect(String(none.body.error)).toContain("nothing was sent");
    expect((await s.h.history()).some((m) => m.text === "【codex】x")).toBe(false);
  });

  it("a listening socket's say --play is checked by the token's hash", async () => {
    flag(true);
    const { token } = await mint(OWNER, "codex");
    const s = hub();
    const ws = await s.listen(token);
    await s.h.webSocketMessage(
      ws,
      JSON.stringify({ type: "say", text: "hear", play: { src: "https://cdn.example.com/a.ogg" } }),
    );
    expect(ws.sent.find((m) => m.type === "sent")).toBeTruthy();
    expect((await s.h.history()).at(-1)?.audio).toMatchObject({ kind: "file", mime: "audio/ogg" });
    await s.h.webSocketMessage(
      ws,
      JSON.stringify({ type: "say", text: "no", play: { src: "https://[::1]/a.ogg" } }),
    );
    expect(String(ws.sent.at(-1)?.error)).toContain("IP");
    // The check itself throwing: refused, never posted.
    const broken = new DebugHub(
      { acceptWebSocket: () => {}, getWebSockets: () => [], storage: fakeStorage() },
      {
        SESSIONS: {
          live: async () => "gone",
          chatToken: (req: unknown) => chatTokenCheck(db() as unknown as ChatTokenDb, req, t),
          playAudio: async () => {
            throw new Error("down");
          },
        },
      },
      () => t,
    );
    const r = await broken.fetch(
      new Request("https://lianki.com/api/version/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          op: "say",
          text: "x",
          play: { src: "https://a.example.com/a.mp3" },
        }),
      }),
    );
    expect(String(((await r.json()) as { error: string }).error)).toContain("nothing was sent");
  });
});
