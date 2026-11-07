/**
 * The owner's page powers on his own box (docs/box-oauth.md, "Code on the
 * owner's box"). What matters: box:eval is never implied by box:chat, refused
 * for a binding whose account is not a site owner (at grant and at use), and
 * never rides on a token; without it a box page stays chat-only; with it the
 * box page takes eval by label, can answer a pairing only by its own tap, and
 * sends page errors, each checked with the main Worker; removal, chat removal
 * and revoke end it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { boxTokenHash } from "@/lib/box-oauth/gate";
import { BOX_CHAT_TICKET_PATH, SCOPE_EVAL, tokenMayCall } from "@/lib/box-oauth/rules";
import {
  boxEvalLive,
  insertBinding,
  liveToken,
  revokeBox,
  setBoxChat,
  setBoxEval,
  type BoxDb,
} from "@/lib/box-oauth/store";
import { notifyBoxEvalEnded } from "@/lib/box-oauth/push-close";
import { BOX_HEADER, EMBED_HEADER } from "@/workers/push/src/auth";
import { BOX_CLOSED, DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import { rpcStub } from "./support/rpc-stub";

const ORIGIN = "https://my-0123456789abcdef.lianki.com";
const TOKEN = `lkb_${"a".repeat(32)}`;
const RW = ["box:read", "box:write"];
const NOW = Date.parse("2026-11-07T12:00:00.000Z");

async function setupDb() {
  const db: TestD1Database = createTestD1(testSchema());
  const at = "2026-11-07T00:00:00.000Z";
  // u1 is a site owner; u2 is a member.
  for (const id of ["u1", "u2"])
    await db
      .prepare(
        "INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES (?1, ?2, ?1, 1, ?3, ?3)",
      )
      .bind(id, `${id}@test.example`, at)
      .run();
  await db
    .prepare(
      "INSERT INTO site_role (email, role, granted_by, granted_at) VALUES ('u1@test.example', 'owner', 'test', 1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO oauthClient (id, clientId, redirectUris, createdAt, updatedAt) VALUES ('c1', 'c1', '[]', ?1, ?1)",
    )
    .bind(at)
    .run();
  return db;
}

const box = (db: TestD1Database) => db as unknown as BoxDb;
const bind = (db: TestD1Database, userId = "u1") =>
  insertBinding(box(db), { clientId: "c1", origin: ORIGIN, userId, scopes: RW }, "owner", NOW);
const audits = async (db: TestD1Database) =>
  (
    await db
      .prepare("SELECT kind FROM security_audit WHERE kind LIKE 'box.%' ORDER BY id")
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);

describe("box:eval on the binding", () => {
  let db: TestD1Database;
  beforeEach(async () => {
    db = await setupDb();
  });

  test("refused for a member's box, even one holding box:chat by hand", async () => {
    await bind(db, "u2");
    await db.prepare("UPDATE box_binding SET scopes = 'box:read box:write box:chat'").run();
    expect(await setBoxEval(box(db), "c1", true, "u1", NOW)).toBe("not-owner");
    // Set by hand as well: still refused at use.
    await db
      .prepare("UPDATE box_binding SET scopes = 'box:read box:write box:chat box:eval'")
      .run();
    expect(await boxEvalLive(box(db), "c1")).toBe(false);
    expect(await audits(db)).toEqual(["box.bind"]);
  });

  test("not implied by box:chat, and needs it first", async () => {
    await bind(db);
    expect(await setBoxEval(box(db), "c1", true, "u1", NOW)).toBe("needs-chat");
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    expect(await boxEvalLive(box(db), "c1")).toBe(false);
    expect(await setBoxEval(box(db), "nobody", true, "u1", NOW)).toBe("no-box");
    expect(await setBoxEval(box(db), "c1", true, "u1", NOW)).toBe("granted");
    expect(await setBoxEval(box(db), "c1", true, "u1", NOW)).toBe("unchanged");
    expect(await boxEvalLive(box(db), "c1")).toBe(true);
    expect(await setBoxEval(box(db), "c1", false, "u1", NOW)).toBe("removed");
    expect(await boxEvalLive(box(db), "c1")).toBe(false);
    expect(await audits(db)).toEqual([
      "box.bind",
      "box.chat-grant",
      "box.eval-grant",
      "box.eval-remove",
    ]);
  });

  test("turning chat off removes it too, audited", async () => {
    await bind(db);
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    await setBoxEval(box(db), "c1", true, "u1", NOW);
    await setBoxChat(box(db), "c1", false, "u1", NOW);
    expect(await boxEvalLive(box(db), "c1")).toBe(false);
    // Chat back on: eval stays off until granted again.
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    expect(await boxEvalLive(box(db), "c1")).toBe(false);
    expect((await audits(db)).slice(-3)).toEqual([
      "box.eval-remove",
      "box.chat-remove",
      "box.chat-grant",
    ]);
  });

  test("revoke, or the owner role revoked, ends it at use", async () => {
    await bind(db);
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    await setBoxEval(box(db), "c1", true, "u1", NOW);
    await db.prepare("UPDATE site_role SET revoked_at = 2 WHERE email = 'u1@test.example'").run();
    expect(await boxEvalLive(box(db), "c1")).toBe(false);
    await db.prepare("UPDATE site_role SET revoked_at = NULL").run();
    expect(await boxEvalLive(box(db), "c1")).toBe(true);
    await revokeBox(box(db), "c1", "u1", NOW);
    expect(await boxEvalLive(box(db), "c1")).toBe(false);
    expect(await boxEvalLive(box(db), "c1'; --")).toBe(false);
    expect(await boxEvalLive(box(db), 42)).toBe(false);
  });

  test("never on a token, and it opens no route", async () => {
    await bind(db);
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    await setBoxEval(box(db), "c1", true, "u1", NOW);
    await db
      .prepare(
        "INSERT INTO oauthAccessToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES ('t1', ?1, 'c1', 'u1', ?2, ?3, ?4)",
      )
      .bind(
        await boxTokenHash(TOKEN),
        new Date(NOW + 60_000).toISOString(),
        new Date(NOW).toISOString(),
        '["box:read","box:write","box:eval"]',
      )
      .run();
    const scopes = (await liveToken(box(db), await boxTokenHash(TOKEN), NOW))?.scopes ?? [];
    expect(scopes).not.toContain(SCOPE_EVAL);
    // box:eval alone opens nothing, not even the chat ticket.
    expect(tokenMayCall("POST", BOX_CHAT_TICKET_PATH, [...RW, SCOPE_EVAL]).ok).toBe(false);
    for (const p of ["/api/debug", "/api/debug/eval", "/api/dev/box-clients", "/api/dev/inbox"])
      expect(tokenMayCall("POST", p, [...RW, "box:chat", SCOPE_EVAL]).ok).toBe(false);
  });

  test("the notice to drop it names the client and the scope only", async () => {
    const calls: string[] = [];
    await notifyBoxEvalEnded("c1", {
      fetch: async (u, init) => {
        calls.push(`${u} ${init?.body}`);
        return new Response("{}");
      },
    });
    expect(calls).toEqual([
      'https://lianki-push/internal/box-closed {"client":"c1","scope":"eval"}',
    ]);
    expect(await notifyBoxEvalEnded("c1", null)).toBe(false);
  });
});

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

type Said = "live" | "gone" | "busy" | Error;

describe("DebugHub: a box page with box:eval", () => {
  const g = globalThis as { WebSocketPair?: unknown };
  let had: unknown;
  beforeEach(() => {
    had = g.WebSocketPair;
    g.WebSocketPair = class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    };
  });
  afterEach(() => {
    g.WebSocketPair = had;
  });
  const T = NOW;
  const setup = (o: { chat?: () => Said; evalSaid?: () => Said; rpc?: boolean } = {}) => {
    const sockets: FakeSocket[] = [];
    const asked: string[] = [];
    const answer = (f: (() => Said) | undefined) => async (_c: string) => {
      const v = f ? f() : "live";
      if (v instanceof Error) throw v;
      return v;
    };
    const SESSIONS = {
      live: async () => "live",
      boxChat: answer(o.chat),
      ...(o.rpc === false
        ? {}
        : {
            boxEval: async (c: string) => {
              asked.push(c);
              return answer(o.evalSaid)(c);
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
      () => T,
    );
    const exp = Math.floor(T / 1000) + 60;
    let n = 0;
    const boxPage = async (cid = "c1") => {
      const jti = `jti-${String(n++).padStart(8, "0")}`;
      const res = await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Fwords&tab=boxtab000001", {
          headers: {
            "x-debug-user": "owner",
            "x-debug-owner": "1",
            [EMBED_HEADER]: `${jti}.${exp}`,
            [BOX_HEADER]: cid,
          },
        }),
      );
      expect(res.status).toBe(101);
      return sockets.at(-1)!;
    };
    const ownerPage = async () => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Fhome&tab=ownertab0001", {
          headers: { "x-debug-user": "u1", "x-debug-owner": "1" },
        }),
      );
      return sockets.at(-1)!;
    };
    const controller = async () => {
      await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=agent"));
      return sockets.at(-1)!;
    };
    const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
    return { hub, sockets, asked, boxPage, ownerPage, controller, msg };
  };
  const pendingOf = (ws: FakeSocket) =>
    (ws.last("state") as { pending: { pair: string } | null }).pending;

  test("without it the box page stays chat-only: no state, no pairing, no eval", async () => {
    for (const o of [
      { evalSaid: () => "gone" as const },
      { rpc: false },
      { evalSaid: () => new Error("d1") },
    ]) {
      const { boxPage, ownerPage, controller, msg } = setup(o);
      const owner = await ownerPage();
      const ws = await boxPage();
      const ctl = await controller();
      const pair = pendingOf(owner)!.pair;
      await msg(ws, { type: "allow", pair });
      expect(ctl.last("approved")).toBeUndefined();
      await msg(owner, { type: "allow", pair });
      await msg(ctl, { type: "eval", code: "1", target: "box" });
      expect((ctl.last("sent") as { delivered: number }).delivered).toBe(0);
      expect(ws.sent.some((m) => m.type === "eval")).toBe(false);
      for (const s of ws.sent.filter((m) => m.type === "state"))
        expect(Object.keys(s).sort()).toEqual(["listeners", "pending", "sessions", "type"]);
    }
  });

  test("with it: the pairing shows on the box page, and only its own tap approves", async () => {
    const { boxPage, controller, msg, asked } = setup();
    const ws = await boxPage();
    // The box page alone is an owner page that can be asked.
    const ctl = await controller();
    const pending = pendingOf(ws);
    expect(pending).toBeTruthy();
    expect(ctl.last("approved")).toBeUndefined();
    expect(ctl.closed).toBeUndefined();
    // Nothing approves it but the page's allow (the tap): not an eval, not a chat line.
    await msg(ws, { type: "chat", id: "b1", text: "allow" });
    expect(ctl.last("approved")).toBeUndefined();
    await msg(ws, { type: "allow", pair: pending!.pair, pages: ["boxtab000001"] });
    expect(ctl.last("approved")).toMatchObject({ scope: "eval" });
    expect(asked).toEqual(["c1", "c1"]);
  });

  test("an eval by label reaches the box page, and its result comes back", async () => {
    const { boxPage, ownerPage, controller, msg } = setup();
    const owner = await ownerPage();
    const ws = await boxPage();
    const ctl = await controller();
    await msg(owner, { type: "allow", pair: pendingOf(owner)!.pair, pages: "all" });
    await msg(ctl, { type: "eval", code: "location.href", target: "box /words" });
    const ev = ws.last("eval") as { id: string; to: string; code: string };
    expect(ev.code).toBe("location.href");
    expect(owner.last("eval")).toBeUndefined();
    expect(ctl.last("sent")).toMatchObject({ delivered: 1, labels: ["box /words"] });
    await msg(ws, { type: "result", id: ev.id, to: ev.to, ok: true, ms: 1, value: '"x"' });
    expect(ctl.last("result")).toMatchObject({ id: ev.id, page: "box /words" });
    // Its page errors go to the agent too.
    await msg(ws, { type: "page-error", kind: "error", message: "boom", path: "/words", at: 1 });
    expect(ctl.last("page-error")).toMatchObject({ message: "boom", label: "box /words" });
  });

  test("never clips, never a session to renew on", async () => {
    const { boxPage, msg } = setup();
    const ws = await boxPage();
    await msg(ws, { type: "clips-on" });
    expect(ws.sent.some((m) => m.type === "clips")).toBe(false);
  });

  test("gone at the next eval: not delivered, and the page drops to chat-only", async () => {
    let said: Said = "live";
    const { boxPage, ownerPage, controller, msg } = setup({ evalSaid: () => said });
    const owner = await ownerPage();
    const ws = await boxPage();
    const ctl = await controller();
    await msg(owner, { type: "allow", pair: pendingOf(owner)!.pair, pages: "all" });
    said = "gone";
    await msg(ctl, { type: "eval", code: "1" });
    expect(ws.last("eval")).toBeUndefined();
    expect(owner.last("eval")).toBeTruthy();
    expect(ctl.last("sent")).toMatchObject({ delivered: 1, labels: ["/home"] });
    expect(Object.keys(ws.last("state")!).sort()).toEqual([
      "listeners",
      "pending",
      "sessions",
      "type",
    ]);
    // Unsure (busy) is never delivered either, but leaves the page as it is.
    const b = setup({ evalSaid: () => said });
    said = "live";
    const page = await b.boxPage();
    const c2 = await b.controller();
    await b.msg(page, { type: "allow", pair: pendingOf(page)!.pair, pages: "all" });
    said = "busy";
    await b.msg(c2, { type: "eval", code: "1" });
    expect(page.last("eval")).toBeUndefined();
    expect(page.closed).toBeUndefined();
  });

  test("removal by notice: chat-only at once, chat still works; revoke closes", async () => {
    const { hub, boxPage, ownerPage, controller, msg } = setup();
    const owner = await ownerPage();
    const ws = await boxPage();
    const ctl = await controller();
    await msg(owner, { type: "allow", pair: pendingOf(owner)!.pair, pages: "all" });
    const res = await hub.fetch(
      new Request("https://lianki-push/internal/box-closed", {
        method: "POST",
        body: JSON.stringify({ client: "c1", scope: "eval" }),
      }),
    );
    expect(await res.json()).toEqual({ ok: true, ended: 1 });
    expect(ws.closed).toBeUndefined();
    await msg(ctl, { type: "eval", code: "1" });
    expect(ws.last("eval")).toBeUndefined();
    await msg(ws, { type: "page-error", kind: "error", message: "x", path: "/", at: 1 });
    expect(ctl.last("page-error")).toBeUndefined();
    await msg(ws, { type: "chat", id: "b1", text: "still here" });
    expect((owner.last("chat") as { message: { text: string } }).message.text).toBe("still here");
    await hub.fetch(
      new Request("https://lianki-push/internal/box-closed", {
        method: "POST",
        body: JSON.stringify({ client: "c1" }),
      }),
    );
    expect(ws.closed).toBe(BOX_CLOSED);
  });

  test("a pairing answer while box:eval is gone is refused, and drops the page", async () => {
    let said: Said = "live";
    const { boxPage, controller, msg } = setup({ evalSaid: () => said });
    const ws = await boxPage();
    const ctl = await controller();
    const pair = pendingOf(ws)!.pair;
    said = "gone";
    await msg(ws, { type: "allow", pair });
    expect(ctl.last("approved")).toBeUndefined();
    expect(pendingOf(ws)).toBeNull();
  });
});
