/**
 * The Learning Partner chat on the owner's own box (docs/box-oauth.md, "Chat on
 * the owner's box"). What matters: a box without box:chat changes nothing; the
 * scope is refused for a binding whose account is not a site owner, at grant
 * and at use; a ticket is good once, for 60 s, from its own box's origin only;
 * a box socket is chat-only in the owner's thread; revoke or removal ends it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stubGlobals } from "./support/globals";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { boxGate, boxTokenHash, type GateDeps } from "@/lib/box-oauth/gate";
import { BOX_IDENTITY_HEADER, signBoxIdentity } from "@/lib/box-oauth/identity";
import {
  BOX_CHAT_STT_PATH,
  BOX_CHAT_TICKET_PATH,
  SCOPE_CHAT,
  boxHubUrl,
  tokenMayCall,
} from "@/lib/box-oauth/rules";
import {
  boxChatLive,
  chatBinding,
  insertBinding,
  isDevUser,
  liveToken,
  revokeBox,
  setBoxChat,
  type BoxDb,
} from "@/lib/box-oauth/store";
import { chatTicketResponse, type ChatTicketDeps } from "@/lib/box-oauth/chat-ticket";
import { notifyBoxClosed } from "@/lib/box-oauth/push-close";
import {
  BOX_CHAT_TICKET_AUD,
  PARTNER_SUBPROTOCOL,
  PARTNER_TICKET_AUD,
  b64url,
  fromB64url,
  signSttTicket,
} from "@/lib/stt-ticket";
import { BOX_HEADER, EMBED_HEADER, boxChatTicket, partnerTicket } from "@/workers/push/src/auth";
import push, { type Env } from "@/workers/push/src/index";
import { BOX_CLOSED, DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import { rpcStub } from "./support/rpc-stub";

const ORIGIN = "https://my-0123456789abcdef.lianki.com";
const OTHER = "https://my-fedcba9876543210.lianki.com";
const SECRET = "x".repeat(40);
const TOKEN = `lkb_${"a".repeat(32)}`;
const TOKEN2 = `lkb_${"b".repeat(32)}`;
const RW = ["box:read", "box:write"];
const NOW = Date.parse("2026-11-07T12:00:00.000Z");

async function setup() {
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
  // Both on the my-box allowlist; tests of the list itself take them off.
  for (const id of ["u1", "u2"])
    await db
      .prepare(
        "INSERT INTO live_frontend_allow (user_id, added_by, added_at) VALUES (?1, 'test', 1)",
      )
      .bind(id)
      .run();
  await db
    .prepare(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES ('u1@test.example', 'dev', 'test', 1)",
    )
    .run();
  for (const c of ["c1", "c2"])
    await db
      .prepare(
        "INSERT INTO oauthClient (id, clientId, redirectUris, createdAt, updatedAt) VALUES (?1, ?1, '[]', ?2, ?2)",
      )
      .bind(c, at)
      .run();
  return db;
}

async function addToken(
  db: TestD1Database,
  o: { id?: string; token?: string; client?: string; user?: string; scopes?: string } = {},
) {
  await db
    .prepare(
      "INSERT INTO oauthAccessToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(
      o.id ?? "t1",
      await boxTokenHash(o.token ?? TOKEN),
      o.client ?? "c1",
      o.user ?? "u1",
      new Date(NOW + 60_000).toISOString(),
      new Date(NOW).toISOString(),
      o.scopes ?? '["box:read","box:write"]',
    )
    .run();
}

const box = (db: TestD1Database) => db as unknown as BoxDb;
const bind = (
  db: TestD1Database,
  over: Partial<{ clientId: string; origin: string; userId: string }> = {},
) =>
  insertBinding(
    box(db),
    { clientId: "c1", origin: ORIGIN, userId: "u1", scopes: RW, ...over },
    "owner",
    NOW,
  );
const audits = async (db: TestD1Database) =>
  (
    await db
      .prepare("SELECT kind FROM security_audit WHERE kind LIKE 'box.%' ORDER BY id")
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);

describe("the routes box:chat opens", () => {
  test("without the scope they do not exist for a token", () => {
    for (const p of [BOX_CHAT_TICKET_PATH, BOX_CHAT_STT_PATH])
      expect(tokenMayCall("POST", p, RW)).toEqual({ ok: false, status: 404, reason: "path" });
  });
  test("with it: POST only, and marked for the owner check", () => {
    const s = [...RW, SCOPE_CHAT];
    expect(tokenMayCall("POST", BOX_CHAT_TICKET_PATH, s)).toEqual({ ok: true, chat: true });
    expect(tokenMayCall("POST", BOX_CHAT_STT_PATH, [SCOPE_CHAT])).toEqual({ ok: true, chat: true });
    expect(tokenMayCall("GET", BOX_CHAT_TICKET_PATH, s).ok).toBe(false);
    expect(tokenMayCall("PUT", BOX_CHAT_STT_PATH, s).ok).toBe(false);
  });
  test("it opens nothing else: no admin, no other debug route, no near-miss path", () => {
    const s = [...RW, SCOPE_CHAT];
    for (const p of [
      "/api/debug/identity",
      "/api/debug/partner-ticket",
      "/api/debug/stt/x",
      "/api/debug/stt%2F",
      "/api/debug//stt",
      "/api/box/chat-ticket/",
      "/api/box/chat-ticketX",
      "/api/dev/log",
      "/api/dev/stt-ticket",
      "/api/dev/inbox",
      "/api/dev/box-clients",
    ])
      expect(tokenMayCall("POST", p, s).ok).toBe(false);
    // And box:chat alone is no read or write of study data.
    expect(tokenMayCall("GET", "/api/prefs", [SCOPE_CHAT]).ok).toBe(false);
  });
});

describe("small pieces", () => {
  test("the hub is the provider's /api/version/debug over ws(s)", () => {
    expect(boxHubUrl("https://lianki.com")).toBe("wss://lianki.com/api/version/debug");
    expect(boxHubUrl("http://127.0.0.1:3911")).toBe("ws://127.0.0.1:3911/api/version/debug");
  });
  test("off the Worker there is no PUSH binding: the notice is a no, never a throw", async () => {
    expect(await notifyBoxClosed("c1")).toBe(false);
    expect(
      await notifyBoxClosed("c1", { fetch: async () => new Response("", { status: 503 }) }),
    ).toBe(false);
  });
});

describe("the scope on the binding", () => {
  let db: TestD1Database;
  beforeEach(async () => {
    db = await setup();
  });

  test("refused for a binding whose account is not a site owner", async () => {
    await bind(db, { userId: "u2" });
    expect(await setBoxChat(box(db), "c1", true, "u1", NOW)).toBe("not-owner");
    expect(await chatBinding(box(db), "c1", "u2")).toBeNull();
    expect(await audits(db)).toEqual(["box.bind"]);
  });

  test("granted for an owner's box, removed, each audited; unknown box refused", async () => {
    await bind(db);
    expect(await setBoxChat(box(db), "nobody", true, "u1", NOW)).toBe("no-box");
    expect(await setBoxChat(box(db), "c1", true, "u1", NOW)).toBe("granted");
    expect(await setBoxChat(box(db), "c1", true, "u1", NOW)).toBe("unchanged");
    expect((await chatBinding(box(db), "c1", "u1"))?.origin).toBe(ORIGIN);
    expect(await setBoxChat(box(db), "c1", false, "u1", NOW)).toBe("removed");
    expect(await chatBinding(box(db), "c1", "u1")).toBeNull();
    expect(await audits(db)).toEqual(["box.bind", "box.chat-grant", "box.chat-remove"]);
  });

  test("a token carries box:chat exactly while the binding does, whatever its own row says", async () => {
    await bind(db);
    await addToken(db, { scopes: '["box:read","box:write","box:chat"]' });
    const hash = await boxTokenHash(TOKEN);
    expect((await liveToken(box(db), hash, NOW))?.scopes).toEqual(RW);
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    expect((await liveToken(box(db), hash, NOW))?.scopes).toEqual([...RW, SCOPE_CHAT]);
    await setBoxChat(box(db), "c1", false, "u1", NOW);
    expect((await liveToken(box(db), hash, NOW))?.scopes).toEqual(RW);
  });

  test("the owner check is read live: a revoked role ends it at use", async () => {
    await bind(db);
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    expect(await isDevUser(box(db), "u1")).toBe(true);
    expect(await boxChatLive(box(db), "c1")).toBe(true);
    await db
      .prepare("UPDATE account_permission SET revoked_at = 2 WHERE email = 'u1@test.example'")
      .run();
    expect(await isDevUser(box(db), "u1")).toBe(false);
    expect(await chatBinding(box(db), "c1", "u1")).toBeNull();
    expect(await boxChatLive(box(db), "c1")).toBe(false);
  });

  test("revoke ends it with the rest", async () => {
    await bind(db);
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    await revokeBox(box(db), "c1", "u1", NOW);
    expect(await boxChatLive(box(db), "c1")).toBe(false);
    expect(await boxChatLive(box(db), "c1'; --")).toBe(false);
    expect(await boxChatLive(box(db), 42)).toBe(false);
  });
});

describe("the gate on the chat routes", () => {
  let db: TestD1Database;
  let seen: Request | null;
  const deps: GateDeps = { flagOn: async () => true, allow: async () => true, now: () => NOW };
  const app = async (r: Request) => {
    seen = r;
    return new Response("ok");
  };
  const call = (path: string, headers: Record<string, string>, method = "POST") =>
    boxGate(
      new Request(`https://lianki.com${path}`, { method, headers }),
      { DB: box(db), AUTH_SECRET: SECRET },
      deps,
      app,
    );
  const tok = (t = TOKEN, origin = ORIGIN) => ({ authorization: `Bearer ${t}`, origin });

  beforeEach(async () => {
    db = await setup();
    seen = null;
    await bind(db);
    await addToken(db);
  });

  test("a box without the scope is refused on both, and the app is never reached", async () => {
    for (const p of [BOX_CHAT_TICKET_PATH, BOX_CHAT_STT_PATH])
      expect((await call(p, tok())).status).toBe(404);
    expect(seen).toBeNull();
  });

  test("with it, the owner's box reaches the route as its account", async () => {
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    expect((await call(BOX_CHAT_TICKET_PATH, tok())).status).toBe(200);
    expect(seen?.headers.get(BOX_IDENTITY_HEADER)).toBeTruthy();
    expect(seen?.headers.get("authorization")).toBeNull();
  });

  test("the account no longer a site owner: refused at use, though the scope is still there", async () => {
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    await db.prepare("UPDATE account_permission SET revoked_at = 2").run();
    expect((await call(BOX_CHAT_TICKET_PATH, tok())).status).toBe(403);
    expect(seen).toBeNull();
  });

  test("a scope set on a member's binding by hand is still refused at use", async () => {
    await revokeBox(box(db), "c1", "u1", NOW);
    await bind(db, { clientId: "c2", origin: OTHER, userId: "u2" });
    await db
      .prepare(
        "UPDATE box_binding SET scopes = 'box:read box:write box:chat' WHERE client_id = 'c2'",
      )
      .run();
    await addToken(db, { id: "t2", token: TOKEN2, client: "c2", user: "u2" });
    expect((await call(BOX_CHAT_TICKET_PATH, tok(TOKEN2, OTHER))).status).toBe(403);
    expect(seen).toBeNull();
  });

  test("another box's token, or this token from another box, is refused", async () => {
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    expect((await call(BOX_CHAT_TICKET_PATH, tok(TOKEN, OTHER))).status).toBe(403);
    expect((await call(BOX_CHAT_TICKET_PATH, tok(TOKEN2, ORIGIN))).status).toBe(401);
    expect(seen).toBeNull();
  });

  test("the owner check failing (a D1 error) refuses, never lets through", async () => {
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    const flaky = {
      prepare: (sql: string) => {
        // The separate owner check only: the token lookup also reads account_permission (the allowlist).
        if (sql.includes("account_permission") && !sql.includes("oauthAccessToken"))
          throw new Error("d1 down");
        return db.prepare(sql);
      },
    } as unknown as BoxDb;
    const res = await boxGate(
      new Request(`https://lianki.com${BOX_CHAT_TICKET_PATH}`, { method: "POST", headers: tok() }),
      { DB: flaky, AUTH_SECRET: SECRET },
      deps,
      app,
    );
    expect(res.status).toBe(403);
    expect(seen).toBeNull();
  });

  test("a forged identity header never arrives; GET is refused", async () => {
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    await call(BOX_CHAT_TICKET_PATH, { [BOX_IDENTITY_HEADER]: "u1.c1.9999999999999.00" });
    expect(seen?.headers.has(BOX_IDENTITY_HEADER) ?? false).toBe(false);
    seen = null;
    expect((await call(BOX_CHAT_TICKET_PATH, tok(), "GET")).status).toBe(405);
    expect(seen).toBeNull();
  });
});

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { priv: pair.privateKey, pub: b64url(raw) };
}

describe("the ticket route", () => {
  let db: TestD1Database;
  let allow: boolean;
  let k: Awaited<ReturnType<typeof keys>>;
  const deps = (over: Partial<ChatTicketDeps> = {}): ChatTicketDeps => ({
    secret: SECRET,
    db: box(db),
    allow: () => allow,
    sign: ({ org, cid }) => signSttTicket(k.priv, { aud: BOX_CHAT_TICKET_AUD, org, cid, now: NOW }),
    now: () => NOW,
    ...over,
  });
  const ident = async (userId = "u1", clientId = "c1", secret = SECRET) =>
    new Headers({
      [BOX_IDENTITY_HEADER]: await signBoxIdentity(secret, { userId, clientId }, NOW),
    });

  beforeEach(async () => {
    db = await setup();
    allow = true;
    k = await keys();
    await bind(db);
  });

  test("no identity (lianki.com's own pages): 404", async () => {
    expect((await chatTicketResponse(new Headers(), deps())).status).toBe(404);
  });

  test("a box without the scope, a forged identity, another account: 403", async () => {
    expect((await chatTicketResponse(await ident(), deps())).status).toBe(403);
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    expect((await chatTicketResponse(await ident("u1", "c1", "y".repeat(40)), deps())).status).toBe(
      403,
    );
    expect((await chatTicketResponse(await ident("u2", "c1"), deps())).status).toBe(403);
    expect((await chatTicketResponse(await ident("u1", "c2"), deps())).status).toBe(403);
  });

  test("a ticket for this box's exact origin and client, audited; limited; off without the key", async () => {
    await setBoxChat(box(db), "c1", true, "u1", NOW);
    const res = await chatTicketResponse(await ident(), deps());
    expect(res.status).toBe(200);
    const { ticket, exp } = (await res.json()) as { ticket: string; exp: number };
    const p = JSON.parse(new TextDecoder().decode(fromB64url(ticket.split(".")[0])));
    expect(p).toMatchObject({ aud: BOX_CHAT_TICKET_AUD, org: ORIGIN, cid: "c1" });
    expect(exp - p.iat).toBe(60);
    expect(await audits(db)).toEqual(["box.bind", "box.chat-grant", "box.chat-ticket"]);
    allow = false;
    expect((await chatTicketResponse(await ident(), deps())).status).toBe(429);
    allow = true;
    expect((await chatTicketResponse(await ident(), deps({ sign: async () => null }))).status).toBe(
      503,
    );
    // A bad key throws: still 503, nothing minted.
    const broken = deps({ sign: () => Promise.reject(new Error("bad jwk")) });
    expect((await chatTicketResponse(await ident(), broken)).status).toBe(503);
    // A D1 error on the check is a refusal.
    const flaky = deps({
      db: {
        prepare: () => {
          throw new Error("d1 down");
        },
      } as unknown as BoxDb,
    });
    expect((await chatTicketResponse(await ident(), flaky)).status).toBe(403);
  });
});

const upgrade = (headers: Record<string, string>) =>
  new Request("https://lianki.com/api/version/debug?label=%2Fwords", {
    headers: { upgrade: "websocket", ...headers },
  });
const offer = (ticket: string) => ({
  "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
});

describe("lianki-push: a box chat ticket", () => {
  test("taken once, from its own box's origin only", async () => {
    const k = await keys();
    const { ticket } = await signSttTicket(k.priv, {
      aud: BOX_CHAT_TICKET_AUD,
      org: ORIGIN,
      cid: "c1",
      now: NOW,
    });
    const seen = new Map();
    const req = () => upgrade({ origin: ORIGIN, ...offer(ticket) });
    expect(await boxChatTicket(req(), k.pub, seen, NOW)).toMatchObject({ cid: "c1" });
    expect(await boxChatTicket(req(), k.pub, seen, NOW + 1000)).toBeNull();
  });

  test("a named box's ticket works from that named origin only", async () => {
    const k = await keys();
    const named = "https://my-example.lianki.com";
    const { ticket } = await signSttTicket(k.priv, {
      aud: BOX_CHAT_TICKET_AUD,
      org: named,
      cid: "c1",
      now: NOW,
    });
    for (const origin of [
      ORIGIN,
      "https://my-example.lianki.com.evil.com",
      "https://my-other.lianki.com",
    ])
      expect(
        await boxChatTicket(upgrade({ origin, ...offer(ticket) }), k.pub, new Map(), NOW),
      ).toBeNull();
    const req = upgrade({ origin: named, ...offer(ticket) });
    expect(await boxChatTicket(req, k.pub, new Map(), NOW)).toMatchObject({ cid: "c1" });
  });

  test("a reserved name is never a box, even with a ticket naming it", async () => {
    const k = await keys();
    const reserved = "https://my-admin.lianki.com";
    const { ticket } = await signSttTicket(k.priv, {
      aud: BOX_CHAT_TICKET_AUD,
      org: reserved,
      cid: "c1",
      now: NOW,
    });
    const req = upgrade({ origin: reserved, ...offer(ticket) });
    expect(await boxChatTicket(req, k.pub, new Map(), NOW)).toBeNull();
  });

  test("refused from another box, lianki.com, any other site, or no origin", async () => {
    const k = await keys();
    const { ticket } = await signSttTicket(k.priv, {
      aud: BOX_CHAT_TICKET_AUD,
      org: ORIGIN,
      cid: "c1",
      now: NOW,
    });
    for (const origin of [OTHER, "https://lianki.com", "https://github.com", "null"])
      expect(
        await boxChatTicket(upgrade({ origin, ...offer(ticket) }), k.pub, new Map(), NOW),
      ).toBeNull();
    expect(await boxChatTicket(upgrade(offer(ticket)), k.pub, new Map(), NOW)).toBeNull();
  });

  test("never a partner, an STT, an expired, a long-lived, a client-less or another key's ticket", async () => {
    const k = await keys();
    const at = (o: Parameters<typeof signSttTicket>[1]) =>
      signSttTicket(k.priv, { now: NOW, ...o });
    const cases = [
      await at({ aud: PARTNER_TICKET_AUD, org: ORIGIN, cid: "c1" }),
      await at({ org: ORIGIN, cid: "c1" }),
      await at({ aud: BOX_CHAT_TICKET_AUD, org: ORIGIN, cid: "c1", now: NOW - 120_000 }),
      await at({ aud: BOX_CHAT_TICKET_AUD, org: ORIGIN, cid: "c1", ttlS: 3600 }),
      await at({ aud: BOX_CHAT_TICKET_AUD, org: ORIGIN }),
      await at({ aud: BOX_CHAT_TICKET_AUD, cid: "c1" }),
    ];
    for (const { ticket } of cases)
      expect(
        await boxChatTicket(upgrade({ origin: ORIGIN, ...offer(ticket) }), k.pub, new Map(), NOW),
      ).toBeNull();
    const other = await keys();
    const good = await at({ aud: BOX_CHAT_TICKET_AUD, org: ORIGIN, cid: "c1" });
    expect(
      await boxChatTicket(
        upgrade({ origin: ORIGIN, ...offer(good.ticket) }),
        other.pub,
        new Map(),
        NOW,
      ),
    ).toBeNull();
    expect(
      await boxChatTicket(
        upgrade({ origin: ORIGIN, ...offer(good.ticket) }),
        undefined,
        new Map(),
        NOW,
      ),
    ).toBeNull();
    // Nor is a box ticket ever a partner ticket (which any origin may offer).
    expect(
      await partnerTicket(
        upgrade({ origin: "https://github.com", ...offer(good.ticket) }),
        k.pub,
        new Map(),
        NOW,
      ),
    ).toBeNull();
  });

  test("the hub hears which box, as an embed page; nobody else can say so", async () => {
    const k = await keys();
    const seen: Headers[] = [];
    const env: Env = {
      HUB: { idFromName: () => 0, get: () => ({ fetch: async () => new Response("hub") }) },
      DEBUG: {
        idFromName: () => 0,
        get: () => ({
          fetch: async (r: Request) => {
            seen.push(r.headers);
            return new Response("hub");
          },
        }),
      },
      MAIN: { fetch: async () => Response.json({ userId: "u1", email: "o@x", owner: true }) },
      PARTNER_TICKET_PUB: k.pub,
    };
    const { ticket } = await signSttTicket(k.priv, {
      aud: BOX_CHAT_TICKET_AUD,
      org: ORIGIN,
      cid: "c1",
    });
    await push.fetch(
      upgrade({ origin: ORIGIN, cookie: "s=1", [BOX_HEADER]: "c9", ...offer(ticket) }),
      env,
    );
    expect(seen[0].get(BOX_HEADER)).toBe("c1");
    expect(seen[0].get(EMBED_HEADER)).toBeTruthy();
    expect(seen[0].get("cookie")).toBeNull();
    // A partner ticket never names a box, and a cookie page never is one.
    const p = await signSttTicket(k.priv, { aud: PARTNER_TICKET_AUD });
    await push.fetch(
      upgrade({ origin: "https://github.com", [BOX_HEADER]: "c1", ...offer(p.ticket) }),
      env,
    );
    expect(seen[1].get(BOX_HEADER)).toBeNull();
    await push.fetch(
      upgrade({ origin: "https://lianki.com", cookie: "s=1", [BOX_HEADER]: "c1" }),
      env,
    );
    expect(seen[2].get(BOX_HEADER)).toBeNull();
    // The same ticket from another box: refused before the hub.
    const again = await signSttTicket(k.priv, { aud: BOX_CHAT_TICKET_AUD, org: ORIGIN, cid: "c1" });
    const res = await push.fetch(upgrade({ origin: OTHER, ...offer(again.ticket) }), env);
    expect(res.status).toBe(403);
    expect(seen.length).toBe(3);
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

describe("DebugHub: a box socket", () => {
  let restore = () => {};
  beforeEach(() => {
    restore = stubGlobals({
      WebSocketPair: class {
        0 = new FakeSocket();
        1 = new FakeSocket();
      },
    });
  });
  afterEach(() => restore());
  const T = NOW;
  const setup = (said: () => unknown = () => "live", rpc = true) => {
    const sockets: FakeSocket[] = [];
    const asked: string[] = [];
    const SESSIONS = {
      live: async () => "live",
      ...(rpc
        ? {
            boxChat: async (c: string) => {
              asked.push(c);
              const v = said();
              if (v instanceof Error) throw v;
              return v;
            },
          }
        : {}),
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
    const boxReq = (jti = "jti-aaaaaaaa", cid = "c1") =>
      new Request("https://lianki.com/api/version/debug?label=%2Fwords%20Chrome", {
        headers: {
          "x-debug-user": "owner",
          "x-debug-owner": "1",
          [EMBED_HEADER]: `${jti}.${exp}`,
          [BOX_HEADER]: cid,
        },
      });
    const ownerPage = async () => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Fhome", {
          headers: { "x-debug-user": "u1", "x-debug-owner": "1" },
        }),
      );
      return sockets.at(-1)!;
    };
    const boxPage = async (jti?: string, cid?: string) => {
      const res = await hub.fetch(boxReq(jti, cid));
      return { res, ws: sockets.at(-1)! };
    };
    const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
    return { hub, sockets, asked, ownerPage, boxPage, msg };
  };

  test("its ticket is good once: a replay is 403", async () => {
    const { hub, boxPage } = setup();
    expect((await boxPage()).res.status).toBe(101);
    expect((await boxPage()).res.status).toBe(403);
    expect(hub).toBeTruthy();
  });

  test("history and the owner's thread both ways, labelled as the box", async () => {
    const { ownerPage, boxPage, msg, asked } = setup();
    const owner = await ownerPage();
    await msg(owner, { type: "chat", id: "o1", text: "before" });
    const { ws } = await boxPage();
    expect(
      (ws.last("history") as { messages: { text: string }[] }).messages.map((m) => m.text),
    ).toEqual(["before"]);
    await msg(ws, { type: "chat", id: "b1", text: "from the box" });
    const line = owner.last("chat") as { message: { text: string; thread: string; label: string } };
    expect(line.message).toMatchObject({ text: "from the box", thread: "owner" });
    expect(line.message.label.startsWith("box ")).toBe(true);
    expect(asked).toEqual(["c1"]);
    await msg(owner, { type: "chat", id: "o2", text: "to the box" });
    expect((ws.last("chat") as { message: { text: string } }).message.text).toBe("to the box");
  });

  test("never eval, no pairing it can answer, no clips, no page errors", async () => {
    const { hub, sockets, ownerPage, boxPage, msg } = setup();
    const owner = await ownerPage();
    const { ws } = await boxPage();
    await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=agent"));
    const ctl = sockets.at(-1)!;
    const pair = (owner.last("state") as { pending: { pair: string } }).pending.pair;
    await msg(ws, { type: "allow", pair });
    expect(ctl.last("approved")).toBeUndefined();
    await msg(ws, { type: "clips-on" });
    await msg(ws, { type: "page-error", kind: "error", message: "x", path: "/", at: 1 });
    await msg(owner, { type: "allow", pair });
    await msg(ctl, { type: "eval", code: "document.cookie" });
    expect(owner.last("eval")).toBeTruthy();
    expect(ws.sent.some((m) => m.type === "eval" || m.type === "pending")).toBe(false);
    for (const s of ws.sent.filter((m) => m.type === "state"))
      expect(Object.keys(s).sort()).toEqual(["listeners", "pending", "sessions", "type"]);
  });

  test("gone at the main Worker: its line is not posted and it is closed", async () => {
    const { ownerPage, boxPage, msg } = setup(() => "gone");
    const owner = await ownerPage();
    const { ws } = await boxPage();
    await msg(ws, { type: "chat", id: "b1", text: "after revoke" });
    expect(ws.closed).toBe(BOX_CLOSED);
    expect(owner.sent.some((m) => m.type === "chat")).toBe(false);
  });

  test("a main Worker without the check counts as gone; unsure drops the line only", async () => {
    const old = setup(() => "live", false);
    const { ws } = await old.boxPage();
    await old.msg(ws, { type: "chat", id: "b1", text: "x" });
    expect(ws.closed).toBe(BOX_CLOSED);
    const busy = setup(() => new Error("d1"));
    const owner = await busy.ownerPage();
    const b = await busy.boxPage();
    await busy.msg(b.ws, { type: "chat", id: "b2", text: "y" });
    expect(b.ws.closed).toBeUndefined();
    expect(owner.sent.some((m) => m.type === "chat")).toBe(false);
    expect(b.ws.last("error")).toBeTruthy();
  });

  test("/internal/box-closed closes that box's sockets only", async () => {
    const { hub, ownerPage, boxPage } = setup();
    const owner = await ownerPage();
    const one = (await boxPage("jti-aaaaaaaa", "c1")).ws;
    const two = (await boxPage("jti-bbbbbbbb", "c2")).ws;
    const res = await hub.fetch(
      new Request("https://lianki-push/internal/box-closed", {
        method: "POST",
        body: JSON.stringify({ client: "c1" }),
      }),
    );
    expect(await res.json()).toEqual({ ok: true, closed: 1 });
    expect(one.closed).toBe(BOX_CLOSED);
    expect(two.closed).toBeUndefined();
    expect(owner.closed).toBeUndefined();
    const bad = await hub.fetch(
      new Request("https://lianki-push/internal/box-closed", { method: "POST", body: "{}" }),
    );
    expect(bad.status).toBe(400);
  });

  test("the main Worker's notice goes to that path, and never throws", async () => {
    const calls: string[] = [];
    const ok = await notifyBoxClosed("c1", {
      fetch: async (u, init) => {
        calls.push(`${u} ${init?.body}`);
        return new Response("{}");
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(['https://lianki-push/internal/box-closed {"client":"c1"}']);
    expect(await notifyBoxClosed("c1", { fetch: async () => Promise.reject(new Error("x")) })).toBe(
      false,
    );
    expect(await notifyBoxClosed("c1", null)).toBe(false);
  });
});
