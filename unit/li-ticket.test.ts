/**
 * M2 of Li chat from the userscript pill (docs/userscript-li-chat.md): the
 * account-scoped Li chat ticket. The route mints it only for a signed-in
 * non-dev account with both flags on; lianki-push takes it only from the
 * lianki.com frame, once, and binds the socket to THAT account's own thread
 * as a chat-only page: never the owner's thread, another account's thread,
 * eval, a pairing or the page list.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stubGlobals } from "./support/globals";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import push, { type Env } from "@/workers/push/src/index";
import {
  EMBED_HEADER,
  PAGE_CHAT_HEADER,
  SUB_THREAD_HEADER,
  SUB_ORIGIN_HEADER,
  liChatTicket,
  partnerTicket,
} from "@/workers/push/src/auth";
import { liTicket, type LiTicketDeps } from "@/lib/li-ticket-route";
import { pillChatAccess, pillChatState } from "@/lib/pill-chat-route";
import {
  LI_CHAT_TICKET_AUD,
  PARTNER_SUBPROTOCOL,
  PARTNER_TICKET_AUD,
  PARTNER_TICKET_HEADER,
  b64url,
  fromB64url,
  isTicketSub,
  signSttTicket,
} from "@/lib/stt-ticket";
import { CONFIG } from "@/lib/config";
import { FLAGS } from "@/lib/flags";

const NOW = 1_800_000_000_000;

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { priv: pair.privateKey, pub: b64url(raw) };
}

const payloadOf = (ticket: string) =>
  JSON.parse(new TextDecoder().decode(fromB64url(ticket.split(".")[0]!))) as Record<
    string,
    unknown
  >;

// ── the route ────────────────────────────────────────────────────────────────

describe("POST /api/chat/li-ticket", () => {
  const req = (h: Record<string, string> = { [PARTNER_TICKET_HEADER]: "1" }, method = "POST") =>
    new Request("https://lianki.com/api/chat/li-ticket", { method, headers: h });
  const setup = async (
    o: {
      flags?: Record<string, boolean>;
      user?: { id: string; email: string } | null;
      dev?: boolean;
      key?: boolean;
      allow?: boolean;
    } = {},
  ) => {
    const k = await keys();
    const allowed: string[] = [];
    const deps: LiTicketDeps = {
      backend: () => "d1",
      d1: () => ({}) as never,
      sessionUser: async () => (o.user === undefined ? { id: "user_1", email: "u@x" } : o.user),
      isDev: async () => o.dev ?? false,
      flags: async () => o.flags ?? { "ext.pill-chat": true, "ext.pill-chat-users": true },
      key: async () => (o.key === false ? null : k.priv),
      allow: async (id) => (allowed.push(id), o.allow ?? true),
      now: () => NOW,
    };
    return { deps, k, allowed };
  };

  it("a signed-in account gets a 60 s ticket naming itself, chat audience, never cached", async () => {
    const { deps, allowed } = await setup();
    const r = await liTicket(req(), deps);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { ticket, exp } = (await r.json()) as { ticket: string; exp: number };
    const p = payloadOf(ticket);
    expect(p).toMatchObject({ aud: LI_CHAT_TICKET_AUD, sub: "user_1" });
    expect(p.email).toBeUndefined();
    expect(exp - (p.iat as number)).toBe(60);
    expect(allowed).toEqual(["user_1"]);
  });

  it("404 without the userscript header, as GET, with either flag off, signed out, or for a dev account", async () => {
    const cases: [Request, Awaited<ReturnType<typeof setup>>][] = [
      [req({}), await setup()],
      [req(undefined, "GET"), await setup()],
      [req(), await setup({ flags: { "ext.pill-chat": true } })],
      [req(), await setup({ flags: { "ext.pill-chat-users": true } })],
      [req(), await setup({ user: null })],
      [req(), await setup({ user: { id: "user_1", email: "" } })],
      [req(), await setup({ user: { id: "a:b", email: "u@x" } })],
      // The owner keeps his partner ticket: an account ticket never names a dev account.
      [req(), await setup({ dev: true })],
    ];
    for (const [r, s] of cases) {
      const res = await liTicket(r, s.deps);
      expect(res.status).toBe(404);
      expect(s.allowed).toEqual([]);
    }
  });

  it("users flag read again by the route itself: a stale access answer cannot widen it", async () => {
    const { deps } = await setup();
    let n = 0;
    deps.flags = async () =>
      n++ === 0
        ? { "ext.pill-chat": true, "ext.pill-chat-users": true }
        : { "ext.pill-chat": true, "ext.pill-chat-users": false };
    expect((await liTicket(req(), deps)).status).toBe(404);
  });

  it("429 past the per-account rate, 503 without a key", async () => {
    expect((await liTicket(req(), (await setup({ allow: false })).deps)).status).toBe(429);
    expect((await liTicket(req(), (await setup({ key: false })).deps)).status).toBe(503);
  });

  it("the rate is a config key; the users flag ships off (M5 is the owner's call)", () => {
    expect(CONFIG["chat.pillTicketsPerMinute"].default).toBe(20);
    expect(CONFIG["chat.pillShareChars"].default).toBe(2000);
    expect(FLAGS["ext.pill-chat-users"].default).toBe(false);
    expect(FLAGS["ext.pill-chat"].default).toBe(false);
  });
});

describe("GET /api/ext/pill-chat says which ticket", () => {
  const req = () => new Request("https://lianki.com/api/ext/pill-chat");
  const deps = (o: {
    flags: Record<string, boolean>;
    user: { id: string; email: string } | null;
    dev: boolean;
  }) => ({
    backend: () => "d1" as const,
    d1: () => ({}) as never,
    sessionUser: async () => o.user,
    isDev: async () => o.dev,
    flags: async () => o.flags,
  });
  const both = { "ext.pill-chat": true, "ext.pill-chat-users": true };
  const u = { id: "user_1", email: "u@x" };
  it("owner: his partner ticket; a user: only with the users flag; signed out: off", async () => {
    const body = async (o: Parameters<typeof deps>[0]) =>
      (await pillChatState(req(), deps(o))).json();
    expect(await body({ flags: { "ext.pill-chat": true }, user: u, dev: true })).toEqual({
      on: true,
      ticket: "owner",
    });
    expect(await body({ flags: { "ext.pill-chat": true }, user: u, dev: false })).toEqual({
      on: false,
    });
    expect(await body({ flags: both, user: u, dev: false })).toEqual({
      on: true,
      ticket: "account",
    });
    expect(await body({ flags: both, user: null, dev: false })).toEqual({ on: false });
    expect(await body({ flags: { "ext.pill-chat-users": true }, user: u, dev: true })).toEqual({
      on: false,
    });
    expect(await pillChatAccess(req(), deps({ flags: both, user: u, dev: false }))).toEqual({
      user: u,
      ticket: "account",
    });
  });
});

describe("the ticket's account id", () => {
  it("only a D1 user id travels; anything else is refused at signing", async () => {
    const k = await keys();
    expect(isTicketSub("abc_DEF-1") && !isTicketSub("a@b") && !isTicketSub("")).toBe(true);
    await expect(signSttTicket(k.priv, { aud: LI_CHAT_TICKET_AUD, sub: "x@y.z" })).rejects.toThrow(
      "bad sub",
    );
  });
});

// ── lianki-push: the ticket's half ───────────────────────────────────────────

const upgrade = (headers: Record<string, string>) =>
  new Request("https://lianki.com/api/version/debug?label=news.example%2Fa", {
    headers: { upgrade: "websocket", ...headers },
  });

describe("liChatTicket", () => {
  it("from the lianki.com frame, once; names the account", async () => {
    const k = await keys();
    const { ticket } = await signSttTicket(k.priv, {
      aud: LI_CHAT_TICKET_AUD,
      sub: "user_1",
      now: NOW,
    });
    const r = () =>
      upgrade({
        origin: "https://lianki.com",
        "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
      });
    const seen = new Map();
    expect(await liChatTicket(r(), k.pub, seen, NOW + 1000)).toMatchObject({ sub: "user_1" });
    expect(await liChatTicket(r(), k.pub, seen, NOW + 2000)).toBeNull();
  });

  it("refused from the host page's origin, no origin, without the key, as another audience, without sub, expired", async () => {
    const k = await keys();
    const proto = (t: string) => ({ "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${t}` });
    const li = (await signSttTicket(k.priv, { aud: LI_CHAT_TICKET_AUD, sub: "user_1", now: NOW }))
      .ticket;
    const lianki = { origin: "https://lianki.com" };
    expect(
      await liChatTicket(
        upgrade({ origin: "https://news.example", ...proto(li) }),
        k.pub,
        new Map(),
        NOW,
      ),
    ).toBeNull();
    expect(await liChatTicket(upgrade(proto(li)), k.pub, new Map(), NOW)).toBeNull();
    expect(
      await liChatTicket(upgrade({ ...lianki, ...proto(li) }), undefined, new Map(), NOW),
    ).toBeNull();
    expect(
      await liChatTicket(upgrade({ ...lianki, ...proto(li) }), k.pub, new Map(), NOW + 70_000),
    ).toBeNull();
    expect(
      await liChatTicket(
        upgrade({ ...lianki, "sec-websocket-protocol": li }),
        k.pub,
        new Map(),
        NOW,
      ),
    ).toBeNull();
    // The owner's partner ticket is not an account ticket, nor the other way round.
    const owner = (await signSttTicket(k.priv, { aud: PARTNER_TICKET_AUD, now: NOW })).ticket;
    expect(
      await liChatTicket(upgrade({ ...lianki, ...proto(owner) }), k.pub, new Map(), NOW),
    ).toBeNull();
    expect(
      await partnerTicket(upgrade({ ...lianki, ...proto(li) }), k.pub, new Map(), NOW),
    ).toBeNull();
    // No sub, or one that is not a user id: refused, and its jti not spent.
    const seen = new Map();
    const noSub = (await signSttTicket(k.priv, { aud: LI_CHAT_TICKET_AUD, now: NOW })).ticket;
    expect(
      await liChatTicket(upgrade({ ...lianki, ...proto(noSub) }), k.pub, seen, NOW),
    ).toBeNull();
    expect(seen.size).toBe(0);
    // Junk in the key: refused, not thrown.
    expect(
      await liChatTicket(upgrade({ ...lianki, ...proto(li) }), "!!", new Map(), NOW),
    ).toBeNull();
  });
});

describe("lianki-push routes an account ticket to that account, never the owner", () => {
  const env = async (seen: Headers[]) => {
    const k = await keys();
    const e: Env = {
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
      MAIN: { fetch: async () => Response.json({ userId: "owner_id", email: "o@x", owner: true }) },
      PARTNER_TICKET_PUB: k.pub,
    };
    return { e, k };
  };

  it("identity from the ticket alone: the account, not owner; cookie and claimed headers dropped", async () => {
    const seen: Headers[] = [];
    const { e, k } = await env(seen);
    const { ticket } = await signSttTicket(k.priv, { aud: LI_CHAT_TICKET_AUD, sub: "user_1" });
    const res = await push.fetch(
      upgrade({
        origin: "https://lianki.com",
        cookie: "better-auth.session_token=owner",
        "x-debug-owner": "1",
        "x-debug-user": "owner",
        "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
      }),
      e,
    );
    expect(await res.text()).toBe("hub");
    expect(seen[0].get("cookie")).toBeNull();
    expect(seen[0].get("x-debug-user")).toBe("user_1");
    expect(seen[0].get("x-debug-owner")).toBe("0");
    expect(seen[0].get(EMBED_HEADER)).toMatch(/^[A-Za-z0-9_-]+\.\d+$/);
  });

  it("the same ticket from the host page's origin is refused", async () => {
    const seen: Headers[] = [];
    const { e, k } = await env(seen);
    const { ticket } = await signSttTicket(k.priv, { aud: LI_CHAT_TICKET_AUD, sub: "user_1" });
    const res = await push.fetch(
      upgrade({
        origin: "https://news.example",
        "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
      }),
      e,
    );
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });
});

// ── the hub: chat only, in its own thread ────────────────────────────────────

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

describe("DebugHub: an account ticket page is chat-only in its own thread", () => {
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
  const T = 1_800_000_000_000;
  const setup = () => {
    const sockets: FakeSocket[] = [];
    const hub = new DebugHub(
      {
        acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
        getWebSockets: () => sockets,
        storage: fakeStorage(),
      },
      undefined,
      () => T,
    );
    const exp = Math.floor(T / 1000) + 60;
    let n = 0;
    // As index.ts forwards an account ticket socket.
    const ticketPage = async (user = "user_1") => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=news.example%2Fa", {
          headers: {
            "x-debug-user": user,
            "x-debug-email": "",
            "x-debug-owner": "0",
            [EMBED_HEADER]: `jti-${String(++n).padStart(8, "0")}.${exp}`,
          },
        }),
      );
      return sockets.at(-1)!;
    };
    const cookiePage = async (user: string, owner: boolean, label = "/words") => {
      await hub.fetch(
        new Request(`https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}`, {
          headers: {
            "x-debug-user": user,
            "x-debug-email": `${user}@x`,
            "x-debug-owner": owner ? "1" : "0",
          },
        }),
      );
      return sockets.at(-1)!;
    };
    const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
    return { hub, sockets, ticketPage, cookiePage, msg };
  };
  const texts = (ws: FakeSocket) =>
    ws.sent
      .filter((m) => m.type === "chat")
      .map((m) => (m as { message: { text: string } }).message.text);

  it("its lines go to its own thread only: never the owner's, never another account's", async () => {
    const { ticketPage, cookiePage, msg } = setup();
    const owner = await cookiePage("owner_id", true);
    const other = await cookiePage("user_2", false);
    const mine = await cookiePage("user_1", false, "/list");
    const t = await ticketPage("user_1");
    expect(t.last("friend-status")).toMatchObject({ status: "open" });
    expect(t.last("history")).toMatchObject({ thread: "user_1" });
    await msg(t, { type: "chat", id: "l1", text: "from the pill" });
    expect(texts(t)).toEqual(["from the pill"]);
    expect(texts(mine)).toEqual(["from the pill"]); // the same account's lianki.com page
    expect(texts(owner)).toEqual([]);
    expect(texts(other)).toEqual([]);
    // And it hears nothing from another account's thread or the owner's.
    await msg(other, { type: "chat", id: "o1", text: "someone else" });
    await msg(owner, { type: "chat", id: "w1", text: "owner line" });
    expect(texts(t)).toEqual(["from the pill"]);
  });

  it("minimal state, no page list; its pairing answers and other powers are ignored", async () => {
    const { ticketPage, msg } = setup();
    const t = await ticketPage("user_1");
    for (const s of t.sent.filter((m) => m.type === "state"))
      expect(Object.keys(s).sort()).toEqual(["listeners", "pending", "sessions", "type"]);
    await msg(t, { type: "allow", pair: "x" });
    await msg(t, { type: "read", lastReadSeq: 5 });
    await msg(t, { type: "page-error", kind: "error", message: "x", path: "/", at: 1 });
    expect(
      t.sent.some((m) => m.type === "eval" || m.type === "read-ack" || m.type === "pending"),
    ).toBe(false);
    expect(t.closed).toBeUndefined();
  });

  it("a replayed ticket is refused; a blocked account is closed", async () => {
    const { hub, ticketPage } = setup();
    const exp = Math.floor(T / 1000) + 60;
    const req = () =>
      new Request("https://lianki.com/api/version/debug?label=x", {
        headers: {
          "x-debug-user": "user_1",
          "x-debug-owner": "0",
          [EMBED_HEADER]: `jti-replayed.${exp}`,
        },
      });
    expect((await hub.fetch(req())).status).toBe(101);
    expect((await hub.fetch(req())).status).toBe(403);
    // No identity at all: nobody.
    const none = await hub.fetch(
      new Request("https://lianki.com/api/version/debug?label=x", {
        headers: { "x-debug-owner": "0", [EMBED_HEADER]: `jti-noone000.${exp}` },
      }),
    );
    expect(none.status).toBe(403);
    // A known account, then blocked: its pill frame is closed at once.
    const first = await ticketPage("user_9");
    await hub.webSocketMessage(first, JSON.stringify({ type: "chat", id: "z", text: "hi" }));
    const res = await hub.fetch(
      new Request("https://lianki-push/internal/friends", {
        method: "POST",
        body: JSON.stringify({ userId: "user_9", action: "block" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(first.closed).toBe(4403);
    const blocked = await ticketPage("user_9");
    expect(blocked.last("friend-status")).toMatchObject({ status: "blocked" });
    expect(blocked.closed).toBe(4403);
  });

  it("an owner's agent cannot pair with an account whose only page is the pill's frame", async () => {
    const { hub, sockets, ticketPage, cookiePage, msg } = setup();
    const owner = await cookiePage("owner_id", true);
    // The owner's agent with a 30-day chat grant.
    await hub.fetch(
      new Request("https://lianki.com/api/version/debug/control?label=agent&scope=chat"),
    );
    const agent = sockets.at(-1)!;
    const pair = (owner.last("state") as { pending: { pair: string } }).pending.pair;
    await msg(owner, { type: "allow", pair, scope: "chat" });
    const token = agent.last("approved")?.token as string;
    expect(token).toBeTruthy();
    const t = await ticketPage("user_1");
    await msg(t, { type: "chat", id: "a", text: "hi" }); // known to the hub now
    await hub.fetch(
      new Request("https://lianki.com/api/version/debug/control?label=agent&for=user_1", {
        headers: { "x-debug-token": token },
      }),
    );
    const ask = sockets.at(-1)!;
    expect(ask.closed).toBe(4404);
    expect(ask.last("error")).toMatchObject({ error: expect.stringContaining("no debug page") });
    expect(t.sent.some((m) => m.type === "pending" || m.type === "eval")).toBe(false);
    // The control: with a real lianki.com page of that account, the pairing is asked there.
    const real = await cookiePage("user_1", false);
    await hub.fetch(
      new Request("https://lianki.com/api/version/debug/control?label=agent&for=user_1", {
        headers: { "x-debug-token": token },
      }),
    );
    expect(sockets.at(-1)!.closed).toBeUndefined();
    expect((real.last("state") as { pending: unknown }).pending).toBeTruthy();
    expect(t.sent.filter((m) => m.type === "state").every((m) => m.pending === null)).toBe(true);
  });
});

describe("page-realm chat attachment: advanced capabilities stay on first-party pages", () => {
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
  const setup = () => {
    const sockets: FakeSocket[] = [];
    const storage = fakeStorage();
    const hub = new DebugHub(
      {
        acceptWebSocket: (w) => sockets.push(w as FakeSocket),
        getWebSockets: () => sockets,
        storage,
      },
      undefined,
      () => NOW,
    );
    let n = 0;
    const limited = async (extra: Record<string, string> = {}) => {
      const r = await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=example.test", {
          headers: {
            "x-debug-user": "account_owner",
            "x-debug-owner": "1",
            [EMBED_HEADER]:
              "page-only-" + String(++n).padStart(8, "0") + "." + String(NOW / 1000 + 60),
            [PAGE_CHAT_HEADER]: "1",
            [SUB_THREAD_HEADER]: "abcdefghijklmnopqrstuv",
            [SUB_ORIGIN_HEADER]: "https://example.test",
            ...extra,
          },
        }),
      );
      return { r, ws: sockets.at(-1)! };
    };
    const owner = async () => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=first-party", {
          headers: { "x-debug-user": "account_owner", "x-debug-owner": "1" },
        }),
      );
      return sockets.at(-1)!;
    };
    const msg = (w: FakeSocket, m: unknown) => hub.webSocketMessage(w, JSON.stringify(m));
    return { hub, sockets, storage, limited, owner, msg };
  };
  it("mandatory site binding, minimal state and no session/eval authority survive attachment", async () => {
    const s = setup();
    expect((await s.limited({ [SUB_THREAD_HEADER]: "" })).r.status).toBe(403);
    const { r, ws } = await s.limited();
    expect(r.status).toBe(101);
    expect(ws.deserializeAttachment()).toMatchObject({
      embed: true,
      chatOnly: true,
      user: "account_owner",
      thread: "owner~abcdefghijklmnopqrstuv",
    });
    expect(ws.deserializeAttachment()).not.toHaveProperty("session");
    expect(ws.last("state")).toEqual({
      type: "state",
      pending: null,
      sessions: [],
      listeners: 0,
      chatOnly: true,
    });
  });
  it("chat/history stay in this site and never reach the privileged main-thread controller", async () => {
    const s = setup();
    const real = await s.owner();
    await s.msg(real, { type: "chat", id: "main-line", text: "private main-thread sentinel" });
    const { ws } = await s.limited();
    await s.msg(ws, { type: "chat", id: "site-line", text: "Hello from this site" });
    await s.msg(ws, { type: "replay", afterSeq: 0 });
    const beforeSpoof = ws.sent.length;
    await s.msg(ws, { type: "replay", afterSeq: 0, thread: "owner" });
    expect(ws.sent).toHaveLength(beforeSpoof);
    const h = ws.last("history") as { messages: { text: string }[] };
    expect(h.messages.map((m) => m.text)).toContain("Hello from this site");
    expect(h.messages.map((m) => m.text)).not.toContain("private main-thread sentinel");
    expect(
      real.sent.filter((m) => m.type === "chat").map((m) => (m.message as { text: string }).text),
    ).not.toContain("Hello from this site");
  });
  it("eval, pairing approval, token, settings, payment and private-data frames are refused", async () => {
    const s = setup();
    const { ws } = await s.limited();
    const before = ws.sent.length;
    for (const frame of [
      { type: "eval", code: "1+1" },
      { type: "allow", pair: "pretend-pair", scope: "eval" },
      { type: "answer", askId: "pretend-ask", choices: ["approve"] },
      { type: "result", id: "pretend-eval", ok: true, value: "data" },
      { type: "token", name: "new-token" },
      { type: "settings", value: { debug: true } },
      { type: "payment", amount: 1 },
      { type: "private-data", path: "/api/profile" },
      { type: "pair", scope: "eval" },
    ])
      await s.msg(ws, frame);
    expect(ws.sent).toHaveLength(before);
    expect(ws.deserializeAttachment()).toMatchObject({ embed: true, chatOnly: true });
    expect(ws.last("approved")).toBeUndefined();
  });
  it("a valid first-party eval grant never reaches or binds to the limited page", async () => {
    const s = setup();
    const real = await s.owner();
    const { ws } = await s.limited();
    await s.hub.fetch(
      new Request("https://lianki.com/api/version/debug/control?label=controller&scope=eval"),
    );
    const controller = s.sockets.at(-1)!;
    const pair = (real.last("state") as { pending: { pair: string } }).pending.pair;
    expect(pair).toBeTruthy();
    await s.msg(ws, { type: "allow", pair, scope: "eval" });
    expect(controller.last("approved")).toBeUndefined();
    await s.msg(real, { type: "allow", pair, scope: "eval" });
    expect(controller.last("approved")).toBeTruthy();
    await s.msg(controller, { type: "eval", code: "1+1" });
    expect(real.last("eval")).toBeTruthy();
    expect(ws.last("eval")).toBeUndefined();
    await s.msg(ws, { type: "chat", id: "site-command", text: "site-only command sentinel" });
    expect(
      controller.sent
        .filter((m) => m.type === "chat")
        .map((m) => (m.message as { text: string }).text),
    ).not.toContain("site-only command sentinel");
    expect((ws.last("state") as { pending: unknown }).pending).toBeNull();
  });
});
