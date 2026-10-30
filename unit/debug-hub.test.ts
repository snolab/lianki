import { describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage, hashToken } from "@/workers/push/src/debug";
import push, { type Env, VersionHub } from "@/workers/push/src/index";
import { debugIdentity } from "@/workers/push/src/auth";
import {
  APPROVAL_MS,
  CHAT_HISTORY,
  EVAL_GRANT_MS,
  CHAT_MS,
  FRIEND_CHAT_MAX,
  FRIEND_CHAT_WINDOW_MS,
  PAGE_ENDED,
  PAGE_GONE_GRACE_MS,
  PAGES_GONE,
  PAGES_IDLE,
  PAGES_IDLE_MS,
  PENDING_MS,
  type Identity,
  hashId,
  MAX_EDITS,
} from "@/lib/dev-eval";

/** A socket as the hibernation API hands it to the hub, recording what it was sent. */
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

/** Durable Object storage's key-value API, in memory (keys sorted as the real one does). */
function fakeStorage(
  store = new Map<string, unknown>(),
): Storage & { store: Map<string, unknown>; alarm: number | null } {
  return {
    store,
    alarm: null,
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(at: number) {
      this.alarm = at;
    },
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

function setup() {
  const sockets: FakeSocket[] = [];
  let t = 1_000_000;
  const storage = fakeStorage();
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    undefined,
    () => t,
  );
  const page = (label = "/words pwa iPhone") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    void hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}`),
    );
    return ws;
  };
  const controller = (label = "main lane") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    void hub.connectController(
      ws,
      new URL(`https://lianki.com/api/version/debug/control?label=${encodeURIComponent(label)}`),
    );
    return ws;
  };
  /** A controller reconnecting with a grant token (resolves once the hub has checked it). */
  const resume = async (token: string, label = "") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL(`https://lianki.com/api/version/debug/control?label=${encodeURIComponent(label)}`),
      token,
    );
    return ws;
  };
  /** A signed-in non-owner's page (resolves once the hub has looked them up). */
  const friend = async (userId = "f1", email = "f1@x.com", label = "/words Android") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}`),
      { userId, email, owner: false },
    );
    return ws;
  };
  /** A controller asking for a pairing on a friend's pages, with a grant token. */
  const forFriend = async (token: string | null, email: string, label = "agent") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL(
        `https://lianki.com/api/version/debug/control?label=${encodeURIComponent(label)}&for=${encodeURIComponent(email)}`,
      ),
      token,
    );
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const pairOf = (p: FakeSocket) =>
    (p.last("state") as { pending: { pair: string } | null }).pending?.pair ?? "";
  return {
    hub,
    sockets,
    page,
    controller,
    resume,
    friend,
    forFriend,
    msg,
    pairOf,
    storage,
    tick: (ms: number) => (t += ms),
  };
}

describe("DebugHub pairing", () => {
  it("a controller cannot run code before the owner allows it", () => {
    const { page, controller, msg } = setup();
    const p = page();
    const c = controller();
    expect(c.last("pending")?.code).toMatch(/^[0-9a-f]{4}$/);
    msg(c, { type: "eval", code: "document.title" });
    expect(c.last("error")?.error).toBe("not approved yet");
    expect(p.sent.some((m) => m.type === "eval")).toBe(false);
  });

  it("the page is prompted with the label and the same short code", () => {
    const { page, controller } = setup();
    const p = page();
    const c = controller("lianki main lane on mac");
    const state = p.last("state") as { pending: { code: string; label: string } };
    expect(state.pending.label).toBe("lianki main lane on mac");
    expect(state.pending.code).toBe(c.last("pending")?.code as string);
  });

  it("after Allow, code reaches the pages and results come back", async () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    await msg(p, { type: "allow", pair });
    expect(c.last("approved")).toBeTruthy();
    msg(c, { type: "eval", code: "1+1" });
    const ev = p.last("eval") as { id: string; code: string; to: string };
    expect(ev.code).toBe("1+1");
    expect(c.last("sent")).toMatchObject({ id: ev.id, delivered: 1 });
    msg(p, { type: "result", id: ev.id, to: ev.to, ok: true, value: "2" });
    expect(c.last("result")).toMatchObject({
      id: ev.id,
      ok: true,
      value: "2",
      page: "/words pwa iPhone",
    });
  });

  it("a streamed result's chunks reach the controller, ahead of the result", async () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    await msg(p, { type: "allow", pair: pairOf(p) });
    msg(c, { type: "eval", code: "$lk.send(png)" });
    const ev = p.last("eval") as { id: string; to: string };
    const big = "A".repeat(100_000);
    for (const seq of [0, 1])
      msg(p, { type: "chunk", id: ev.id, to: ev.to, part: 0, seq, total: 2, data: big });
    msg(p, { type: "result", id: ev.id, to: ev.to, ok: true, value: "{}" });
    const got = c.sent.filter((m) => m.type === "chunk" || m.type === "result");
    expect(got.map((m) => [m.type, m.seq])).toEqual([
      ["chunk", 0],
      ["chunk", 1],
      ["result", undefined],
    ]);
    expect(got[0]).toEqual({
      type: "chunk",
      id: ev.id,
      part: 0,
      seq: 0,
      total: 2,
      data: big,
      page: "/words pwa iPhone",
    });
  });

  it("chunks go nowhere for a pairing not yet allowed, or one that lapsed", async () => {
    const { page, controller, msg, pairOf, tick } = setup();
    const p = page();
    const c = controller();
    const chunk = (to: string) => ({
      type: "chunk",
      id: "x",
      to,
      part: 0,
      seq: 0,
      total: 1,
      data: "d",
    });
    msg(p, chunk(pairOf(p)));
    expect(c.last("chunk")).toBeUndefined();
    await msg(p, { type: "allow", pair: pairOf(p) });
    const ev = (msg(c, { type: "eval", code: "1" }), p.last("eval") as { to: string });
    tick(EVAL_GRANT_MS + 1);
    msg(p, chunk(ev.to));
    expect(c.last("chunk")).toBeUndefined();
  });

  it("only pages whose label contains the target get the code", async () => {
    const { page, controller, msg, pairOf } = setup();
    const phone = page("/words pwa iPhone");
    const mac = page("/list Macintosh");
    const c = controller();
    await msg(phone, { type: "allow", pair: pairOf(phone) });
    msg(c, { type: "eval", code: "1", target: "iphone" });
    expect(phone.last("eval")).toBeTruthy();
    expect(mac.last("eval")).toBeUndefined();
  });

  it("Deny closes the controller", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    msg(p, { type: "deny", pair: pairOf(p) });
    expect(c.last("denied")).toBeTruthy();
    expect(c.closed).toBe(4403);
    expect((p.last("state") as { pending: unknown }).pending).toBeNull();
  });

  it("End revokes an approved session", async () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    await msg(p, { type: "allow", pair });
    await msg(p, { type: "revoke", pair });
    expect(c.closed).toBe(4401);
    expect((p.last("state") as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it("one pairing waits at a time; a stale one is replaced", () => {
    const { page, controller, tick } = setup();
    page();
    const first = controller();
    const second = controller();
    expect(second.closed).toBe(4429);
    tick(PENDING_MS + 1);
    const third = controller();
    expect(first.closed).toBe(4408);
    expect(third.last("pending")).toBeTruthy();
  });

  it("an Allow after the prompt expired does nothing", () => {
    const { page, controller, msg, pairOf, tick } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    tick(PENDING_MS + 1);
    msg(p, { type: "allow", pair });
    expect(c.last("approved")).toBeUndefined();
  });

  it("the owner's eval approval runs out after EVAL_GRANT_MS (8 hours)", async () => {
    const { page, controller, msg, pairOf, tick } = setup();
    const p = page();
    const c = controller();
    await msg(p, { type: "allow", pair: pairOf(p) });
    expect(EVAL_GRANT_MS).toBe(8 * 60 * 60_000);
    tick(EVAL_GRANT_MS - 1);
    await msg(c, { type: "eval", code: "1" });
    expect(c.closed).toBeUndefined();
    tick(2);
    await msg(c, { type: "eval", code: "2" });
    expect(c.closed).toBe(4408);
    expect(p.sent.filter((m) => m.type === "eval").map((m) => m.code)).toEqual(["1"]);
  });

  it("with no owner page open, a controller is turned away", () => {
    const { controller } = setup();
    const c = controller();
    expect(c.closed).toBe(4404);
  });

  it("a controller cannot approve itself or another controller", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    msg(c, { type: "allow", pair: pairOf(p) });
    expect(c.last("approved")).toBeUndefined();
  });
});

type Chat = {
  message: {
    id: string;
    from: string;
    label: string;
    text: string;
    at: number;
    thread?: string;
    sender?: unknown;
    taskPath?: string;
    agentId?: string;
    to?: string;
  };
};
const chats = (ws: FakeSocket) =>
  ws.sent.filter((m) => m.type === "chat").map((m) => (m as unknown as Chat).message);

describe("DebugHub chat", () => {
  it("an owner message reaches every page and every approved controller, not a pending one", async () => {
    const { page, controller, msg, pairOf } = setup();
    const phone = page();
    const mac = page("/list Macintosh");
    const approved = controller("agent");
    await msg(phone, { type: "allow", pair: pairOf(phone) });
    const waiting = controller("stranger");
    await msg(phone, { type: "chat", id: "m1", text: "  hello agent  " });
    for (const ws of [phone, mac, approved])
      expect(chats(ws)).toEqual([
        {
          id: "m1",
          from: "owner",
          label: "/words pwa iPhone",
          text: "hello agent",
          at: 1_000_000,
          thread: "owner",
        },
      ]);
    expect(chats(waiting)).toEqual([]);
  });

  it("a controller's say reaches the pages and is acknowledged", async () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller("main lane");
    await msg(p, { type: "allow", pair: pairOf(p) });
    await msg(c, { type: "say", text: "on it" });
    expect(chats(p).at(-1)).toMatchObject({ from: "agent", label: "main lane", text: "on it" });
    expect(c.last("said")?.id).toBe(chats(p).at(-1)?.id as string);
  });

  it("an unapproved controller cannot say", async () => {
    const { page, controller, msg } = setup();
    const p = page();
    const c = controller();
    await msg(c, { type: "say", text: "hi" });
    expect(c.last("error")?.error).toBe("not approved yet");
    expect(chats(p)).toEqual([]);
  });

  it("a reloaded page gets the history; only the last CHAT_HISTORY are kept", async () => {
    const { hub, page, msg, storage } = setup();
    const p = page();
    for (let i = 0; i < CHAT_HISTORY + 5; i++)
      await msg(p, { type: "chat", id: `m${i}`, text: `${i}` });
    const again = page();
    await hub.history();
    const h = again.last("history") as { messages: { id: string }[] };
    expect(h.messages).toHaveLength(CHAT_HISTORY);
    expect(h.messages[0].id).toBe("m5");
    expect(h.messages.at(-1)?.id).toBe(`m${CHAT_HISTORY + 4}`);
    expect([...storage.store.keys()].filter((k) => k.startsWith("msg:"))).toHaveLength(
      CHAT_HISTORY,
    );
  });

  it("malformed or oversized chat is dropped", async () => {
    const { page, msg } = setup();
    const p = page();
    await msg(p, { type: "chat", id: "x", text: "   " });
    await msg(p, { type: "chat", id: "y", text: "a".repeat(4001) });
    await msg(p, { type: "chat", text: "no id" });
    expect(chats(p)).toEqual([]);
  });
});

describe("DebugHub chat-only grants", () => {
  /** Pair a controller and answer "Allow chat for 30 days"; returns the token it was handed. */
  const chatPair = async (s: ReturnType<typeof setup>, p: FakeSocket) => {
    const c = s.controller("listener");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat" });
    return { c, token: c.last("approved")?.token as string };
  };

  it("Allow chat grants chat but not eval, and hands out a token stored only hashed", async () => {
    const s = setup();
    const p = s.page();
    const { c, token } = await chatPair(s, p);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(c.last("approved")).toMatchObject({ scope: "chat", until: 1_000_000 + CHAT_MS });
    expect(c.last("history")).toEqual({ type: "history", messages: [] });
    expect(s.storage.store.get(`grant:${await hashToken(token)}`)).toEqual({
      label: "listener",
      until: 1_000_000 + CHAT_MS,
    });
    expect(JSON.stringify([...s.storage.store.entries()])).not.toContain(token);
    await s.msg(c, { type: "eval", code: "document.cookie" });
    expect(c.last("error")?.error).toContain("chat-only");
    expect(p.last("eval")).toBeUndefined();
    await s.msg(p, { type: "chat", id: "m1", text: "hi" });
    expect(chats(c).map((m) => m.text)).toEqual(["hi"]);
    const sessions = (p.last("state") as { sessions: { scope: string }[] }).sessions;
    expect(sessions.map((x) => x.scope)).toEqual(["chat"]);
  });

  it("Allow for eval grants eval and chat for 8 hours, with a token stored only hashed", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller();
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    expect(c.last("approved")).toMatchObject({ scope: "eval", until: 1_000_000 + EVAL_GRANT_MS });
    const token = c.last("approved")?.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.storage.store.get(`grant:${await hashToken(token)}`)).toEqual({
      label: "main lane",
      until: 1_000_000 + EVAL_GRANT_MS,
      scope: "eval",
      at: 1_000_000,
    });
    expect(JSON.stringify([...s.storage.store.entries()])).not.toContain(token);
    expect(c.last("history")).toBeTruthy();
  });

  it("the token resumes chat scope with no prompt, even with no page open", async () => {
    const s = setup();
    const p = s.page();
    const { c, token } = await chatPair(s, p);
    await s.msg(p, { type: "chat", id: "m1", text: "while you were away" });
    c.close(1006);
    p.close(1001);
    const again = await s.resume(token);
    expect(again.last("approved")).toMatchObject({ scope: "chat", resumed: true });
    expect(again.last("pending")).toBeUndefined();
    expect(
      (again.last("history") as { messages: { id: string }[] }).messages.map((m) => m.id),
    ).toEqual(["m1"]);
    await s.msg(again, { type: "say", text: "back" });
    expect(again.last("said")).toBeTruthy();
    await s.msg(again, { type: "eval", code: "1" });
    expect(again.last("error")?.error).toContain("chat-only");
  });

  it("a wrong or expired token is refused with 4498", async () => {
    const s = setup();
    const p = s.page();
    const { token } = await chatPair(s, p);
    const wrong = await s.resume("0".repeat(64));
    expect(wrong.closed).toBe(4498);
    s.tick(CHAT_MS + 1);
    const late = await s.resume(token);
    expect(late.closed).toBe(4498);
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(false);
  });

  it("End revokes the grant and closes every socket holding it", async () => {
    const s = setup();
    const p = s.page();
    const { c, token } = await chatPair(s, p);
    const other = await s.resume(token);
    const sessions = (p.last("state") as { sessions: { pair: string }[] }).sessions;
    expect(sessions).toHaveLength(2);
    await s.msg(p, { type: "revoke", pair: sessions[1].pair });
    expect(c.closed).toBe(4401);
    expect(other.closed).toBe(4401);
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(false);
    expect((await s.resume(token)).closed).toBe(4498);
  });
});

describe("lianki-push debug routes", () => {
  const upgrade = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://lianki.com${path}`, { headers: { upgrade: "websocket", ...headers } });
  const env = (whoami: number, calls: string[] = []): Env => {
    const stub = { fetch: async () => new Response("hub") };
    return {
      HUB: { idFromName: () => 0, get: () => stub },
      DEBUG: { idFromName: () => 0, get: () => stub },
      MAIN: {
        fetch: async (url, init) => {
          calls.push(`${url} ${new Headers(init?.headers).get("cookie")}`);
          return whoami === 200
            ? Response.json({ userId: "u1", email: "o@x", owner: true })
            : new Response("no", { status: whoami });
        },
      },
    };
  };

  it("a page socket without a signed-in session is refused", async () => {
    const own = { origin: "https://lianki.com", cookie: "s=1" };
    expect((await push.fetch(upgrade("/api/version/debug", own), env(401))).status).toBe(403);
    expect(
      (await push.fetch(upgrade("/api/version/debug", { origin: "https://lianki.com" }), env(200)))
        .status,
    ).toBe(403);
    expect(
      (
        await push.fetch(
          upgrade("/api/version/debug", { ...own, origin: "https://evil.example" }),
          env(200),
        )
      ).status,
    ).toBe(403);
  });

  it("the cookie is checked by the main Worker", async () => {
    const calls: string[] = [];
    const req = upgrade("/api/version/debug", { origin: "https://lianki.com", cookie: "s=1" });
    expect(await debugIdentity(req, env(200, calls).MAIN)).toEqual({
      userId: "u1",
      email: "o@x",
      owner: true,
    });
    expect(calls).toEqual(["https://lianki.com/api/debug/identity s=1"]);
  });

  it("the hub is told who the page is, and a page cannot claim it itself", async () => {
    const seen: Headers[] = [];
    const e: Env = {
      ...env(200),
      DEBUG: {
        idFromName: () => 0,
        get: () => ({
          fetch: async (r: Request) => {
            seen.push(r.headers);
            return new Response("hub");
          },
        }),
      },
      MAIN: {
        fetch: async () => Response.json({ userId: "friend1", email: "f@x", owner: false }),
      },
    };
    await push.fetch(
      upgrade("/api/version/debug", {
        origin: "https://lianki.com",
        cookie: "s=1",
        "x-debug-owner": "1",
        "x-debug-user": "someone-else",
      }),
      e,
    );
    expect(seen[0].get("x-debug-user")).toBe("friend1");
    expect(seen[0].get("x-debug-owner")).toBe("0");
    expect(seen[0].get("x-debug-email")).toBe("f@x");
    await push.fetch(upgrade("/api/version/debug/control", { "x-debug-owner": "1" }), e);
    expect(seen[1].get("x-debug-owner")).toBeNull();
  });

  it("an old main Worker (no identity route) falls back to the owner-only whoami", async () => {
    const req = upgrade("/api/version/debug", { origin: "https://lianki.com", cookie: "s=1" });
    const old = (whoami: Response, calls: string[] = []) => ({
      fetch: async (url: string) => {
        calls.push(url);
        return url.endsWith("/api/debug/identity") ? new Response("", { status: 404 }) : whoami;
      },
    });
    const calls: string[] = [];
    expect(await debugIdentity(req, old(Response.json({ owner: true }), calls))).toEqual({
      userId: "owner",
      email: "",
      owner: true,
    });
    expect(calls).toEqual([
      "https://lianki.com/api/debug/identity",
      "https://lianki.com/api/dev/whoami",
    ]);
    expect(await debugIdentity(req, old(new Response("", { status: 404 })))).toBeNull();
    expect(await debugIdentity(req, old(Response.json({ owner: false })))).toBeNull();
    // Through the router, the owner page reaches the hub as the owner.
    const seen: Headers[] = [];
    const stub = { fetch: async () => new Response("hub") };
    const res = await push.fetch(req, {
      HUB: { idFromName: () => 0, get: () => stub },
      DEBUG: {
        idFromName: () => 0,
        get: () => ({
          fetch: async (r: Request) => {
            seen.push(r.headers);
            return new Response("hub");
          },
        }),
      },
      MAIN: old(Response.json({ owner: true })),
    });
    expect(res.status).toBe(200);
    expect(seen[0].get("x-debug-owner")).toBe("1");
    // Any other answer from the identity route is not a reason to fall back.
    const down = { fetch: async () => new Response("", { status: 500 }) };
    expect(await debugIdentity(req, down)).toBeNull();
  });

  it("a malformed identity answer is refused", async () => {
    const req = upgrade("/api/version/debug", { origin: "https://lianki.com", cookie: "s=1" });
    const main = (body: unknown) => ({ fetch: async () => Response.json(body) });
    expect(await debugIdentity(req, main({ owner: true }))).toBeNull();
    expect(await debugIdentity(req, main({ userId: "a:b", email: "x", owner: false }))).toBeNull();
  });

  it("a controller from a browser (with Origin) is refused", async () => {
    const res = await push.fetch(
      upgrade("/api/version/debug/control", { origin: "https://evil.example" }),
      env(200),
    );
    expect(res.status).toBe(403);
  });

  it("internal paths answer only on the binding's hostname", async () => {
    const res = await push.fetch(
      new Request("https://lianki.com/internal/publish", { method: "POST", body: "x" }),
      env(200),
    );
    expect(res.status).toBe(404);
  });
});

// The Workers runtime's socket pair, for the hubs' fetch(); bun has none.
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
  0 = new FakeSocket();
  1 = new FakeSocket();
};

describe("DebugHub.fetch", () => {
  it("upgrades pages and controllers, and drops a closed controller from the prompt", async () => {
    const sockets: FakeSocket[] = [];
    const hub = new DebugHub({
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    });
    expect(
      (await hub.fetch(new Request("https://lianki.com/api/version/debug?label=p"))).status,
    ).toBe(403);
    expect(sockets).toHaveLength(0);
    const res = await hub.fetch(
      new Request("https://lianki.com/api/version/debug?label=p", {
        headers: { "x-debug-user": "u1", "x-debug-owner": "1" },
      }),
    );
    expect(res.status).toBe(101);
    const [page] = sockets;
    await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=c"));
    const ctl = sockets[1];
    expect(ctl.last("pending")).toBeTruthy();
    hub.webSocketClose(ctl, 1005);
    expect(ctl.closed).toBe(1000);
    expect((page.last("state") as { pending: unknown }).pending).toBeNull();
    expect(page.last("history")).toEqual({ type: "history", messages: [] });
  });

  it("passes the grant token header to the hub", async () => {
    const sockets: FakeSocket[] = [];
    const hub = new DebugHub({
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    });
    await hub.fetch(
      new Request("https://lianki.com/api/version/debug/control?label=c", {
        headers: { "x-debug-token": "nope" },
      }),
    );
    expect(sockets[0].closed).toBe(4498);
  });
});

describe("VersionHub", () => {
  const make = () => {
    const sockets: FakeSocket[] = [];
    const store = new Map<string, unknown>();
    const hub = new VersionHub(
      {
        acceptWebSocket: (ws) => sockets.push(ws as unknown as FakeSocket),
        getWebSockets: () => sockets as unknown as WebSocket[],
        storage: {
          get: async <T>(k: string) => store.get(k) as T | undefined,
          put: async (k: string, v: unknown) => void store.set(k, v),
        },
      },
      {} as Env,
    );
    const publish = (b: string) =>
      hub.fetch(new Request("https://lianki-push/internal/publish", { method: "POST", body: b }));
    return { hub, sockets, publish };
  };

  it("pushes a new build once, and names it to a page on connect", async () => {
    const { hub, sockets, publish } = make();
    expect((await publish(" ")).status).toBe(400);
    expect(await (await publish("b1")).json()).toEqual({ build: "b1", pushed: 0 });
    expect((await hub.fetch(new Request("https://lianki.com/api/version/ws"))).status).toBe(101);
    expect(sockets[0].sent).toEqual([{ build: "b1" }]);
    expect(await (await publish("b1")).json()).toEqual({ build: "b1", pushed: 0 });
    expect(await (await publish("b2")).json()).toEqual({ build: "b2", pushed: 1 });
    hub.webSocketMessage();
    hub.webSocketClose(sockets[0] as unknown as WebSocket, 1001);
    expect(sockets[0].closed).toBe(1001);
  });
});

describe("lianki-push routing", () => {
  const stub = (name: string) => ({ fetch: async () => new Response(name) });
  const env = (owner: boolean): Env => ({
    HUB: { idFromName: () => 0, get: () => stub("version") },
    DEBUG: { idFromName: () => 0, get: () => stub("debug") },
    MAIN: {
      fetch: async () =>
        owner
          ? Response.json({ userId: "u1", email: "o@x", owner: true })
          : new Response("", { status: 401 }),
    },
  });
  const ws = { upgrade: "websocket" };
  const go = async (url: string, init: RequestInit, owner = true) =>
    push
      .fetch(new Request(url, init), env(owner))
      .then(async (r) => `${r.status} ${await r.text()}`);

  it("routes each path to its hub, and nothing else", async () => {
    expect(await go("https://lianki.com/api/version/ws", {})).toStartWith("426");
    expect(await go("https://lianki.com/api/version/ws", { headers: ws })).toBe("200 version");
    expect(await go("https://lianki.com/api/version/debug", {})).toStartWith("426");
    expect(
      await go("https://lianki.com/api/version/debug", {
        headers: { ...ws, origin: "https://lianki.com", cookie: "s=1" },
      }),
    ).toBe("200 debug");
    expect(await go("https://lianki.com/api/version/debug/control", {})).toStartWith("426");
    expect(await go("https://lianki.com/api/version/debug/control", { headers: ws })).toBe(
      "200 debug",
    );
    expect(await go("https://lianki-push/internal/publish", { method: "POST", body: "b" })).toBe(
      "200 version",
    );
    expect(await go("https://lianki-push/internal/friends", {})).toBe("200 debug");
    expect(await go("https://lianki.com/internal/friends", {})).toStartWith("404");
    expect(await go("https://lianki.com/api/version/stream", {})).toContain("lianki-push");
    expect(await go("https://lianki.com/elsewhere", {})).toStartWith("404");
  });

  it("an owner check that fails to answer refuses the socket", async () => {
    const req = new Request("https://lianki.com/api/version/debug", {
      headers: { origin: "https://lianki.com", cookie: "s=1" },
    });
    expect(await debugIdentity(req, { fetch: () => Promise.reject(new Error("down")) })).toBeNull();
    expect(await debugIdentity(req, undefined)).toBeNull();
  });
});

describe("DebugHub friends", () => {
  /** The owner's agent: a listener with a 30-day chat grant (approved on an owner page). */
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return { c, token: c.last("approved")?.token as string };
  };
  it("a friend chats without approval; the agent hears it with thread, email and page", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    const f = await s.friend("f1", "f1@x.com", "/words pwa Android");
    expect(f.last("friend-status")?.status).toBe("open");
    expect(f.last("history")).toEqual({ type: "history", messages: [] });
    await s.msg(f, { type: "chat", id: "a", text: "the button is too small" });
    expect(chats(c).at(-1)).toMatchObject({
      from: "friend",
      thread: "f1",
      email: "f1@x.com",
      label: "/words pwa Android",
      text: "the button is too small",
    });
    expect(chats(f).map((m) => m.text)).toEqual(["the button is too small"]);
    // The owner's pages do not get a friend's thread.
    expect(chats(owner)).toEqual([]);
  });

  it("a friend's first message tells the agent once", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    const f = await s.friend();
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    await s.msg(f, { type: "chat", id: "b", text: "again" });
    expect(c.sent.filter((m) => m.type === "friend-new")).toEqual([
      { type: "friend-new", userId: "f1", email: "f1@x.com", at: 1_000_000 },
    ]);
    expect(s.storage.store.get("friend:f1")).toMatchObject({
      email: "f1@x.com",
      firstSeen: 1_000_000,
      count: 2,
    });
  });

  it("a friend never sees the owner's thread or another friend's", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, { type: "chat", id: "o1", text: "owner secret" });
    const a = await s.friend("fa", "a@x.com");
    const b = await s.friend("fb", "b@x.com");
    expect((a.last("history") as { messages: unknown[] }).messages).toEqual([]);
    await s.msg(a, { type: "chat", id: "a1", text: "from a" });
    await s.msg(owner, { type: "chat", id: "o2", text: "owner again" });
    await s.msg(c, { type: "say", text: "to owner" });
    await s.msg(c, { type: "say", text: "to a", to: "a@x.com" });
    expect(chats(a).map((m) => m.text)).toEqual(["from a", "to a"]);
    expect(chats(b)).toEqual([]);
    expect(chats(owner).map((m) => m.text)).toEqual(["owner secret", "owner again", "to owner"]);
    // A reload of b gets b's (empty) thread; a's history is a's alone.
    const b2 = await s.friend("fb", "b@x.com");
    expect((b2.last("history") as { messages: unknown[] }).messages).toEqual([]);
    const a2 = await s.friend("fa", "a@x.com");
    const texts = (a2.last("history") as { messages: { text: string }[] }).messages.map(
      (m) => m.text,
    );
    expect(texts).toEqual(["from a", "to a"]);
  });

  it("say reaches a friend by email or user id, and refuses an unknown one", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    const f = await s.friend("f1", "F1@X.com");
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    await s.msg(c, { type: "say", text: "by email", to: "f1@x.com" });
    await s.msg(c, { type: "say", text: "by id", to: "f1" });
    expect(chats(f).map((m) => m.text)).toEqual(["hi", "by email", "by id"]);
    expect(c.last("said")?.thread).toBe("f1");
    await s.msg(c, { type: "say", text: "?", to: "nobody@x.com" });
    expect(c.last("error")?.error).toContain("no chat thread");
  });

  it("a friend may send FRIEND_CHAT_MAX messages per window, then is told and dropped", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    const f = await s.friend();
    for (let i = 0; i < FRIEND_CHAT_MAX + 2; i++)
      await s.msg(f, { type: "chat", id: `m${i}`, text: `${i}` });
    expect(chats(c).filter((m) => m.from === "friend")).toHaveLength(FRIEND_CHAT_MAX);
    expect(f.last("rate-limited")).toMatchObject({ retryIn: FRIEND_CHAT_WINDOW_MS });
    s.tick(FRIEND_CHAT_WINDOW_MS);
    await s.msg(f, { type: "chat", id: "late", text: "later" });
    expect(chats(c).at(-1)?.text).toBe("later");
    // The owner has no such limit.
    for (let i = 0; i < FRIEND_CHAT_MAX + 2; i++)
      await s.msg(owner, { type: "chat", id: `o${i}`, text: `${i}` });
    expect(owner.last("rate-limited")).toBeUndefined();
  });

  it("each friend thread keeps the last CHAT_HISTORY, apart from the owner's", async () => {
    const s = setup();
    s.page();
    const f = await s.friend();
    for (let i = 0; i < CHAT_HISTORY + 3; i++) {
      if (i % FRIEND_CHAT_MAX === 0) s.tick(FRIEND_CHAT_WINDOW_MS);
      await s.msg(f, { type: "chat", id: `m${i}`, text: `${i}` });
    }
    const keys = [...s.storage.store.keys()];
    expect(keys.filter((k) => k.startsWith("t:f1:msg:"))).toHaveLength(CHAT_HISTORY);
    expect(keys.filter((k) => k.startsWith("msg:"))).toHaveLength(0);
    expect((await s.hub.history("f1"))[0].id).toBe("m3");
  });

  it("Block closes the friend's sockets and refuses them after; unblock lets them back", async () => {
    const s = setup();
    const owner = s.page();
    const { c, token } = await agent(s, owner);
    const f = await s.friend();
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const p = await s.forFriend(token, "f1@x.com");
    const api = (body: unknown) =>
      s.hub.fetch(
        new Request("https://lianki-push/internal/friends", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    expect((await api({ userId: "nobody", action: "block" })).status).toBe(404);
    expect((await api({ userId: "f1", action: "nope" })).status).toBe(400);
    expect((await api({ userId: "f1", action: "block" })).status).toBe(200);
    expect(f.closed).toBe(4403);
    expect(f.last("friend-status")?.status).toBe("blocked");
    expect(p.closed).toBe(4401);
    const again = await s.friend();
    expect(again.closed).toBe(4403);
    await s.msg(c, { type: "say", text: "x", to: "f1@x.com" });
    expect(c.last("error")?.error).toContain("blocked");
    const list = (await (
      await s.hub.fetch(new Request("https://lianki-push/internal/friends"))
    ).json()) as { friends: { userId: string; blocked: boolean; count: number }[] };
    expect(list.friends).toMatchObject([{ userId: "f1", blocked: true, count: 1 }]);
    await api({ userId: "f1", action: "unblock" });
    const back = await s.friend();
    expect(back.closed).toBeUndefined();
    expect(back.last("friend-status")?.status).toBe("open");
  });

  it("the owner's read-only view gets one friend's thread over the internal API", async () => {
    const s = setup();
    const f = await s.friend();
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const res = await s.hub.fetch(
      new Request("https://lianki-push/internal/friends/thread?user=f1"),
    );
    const { messages } = (await res.json()) as { messages: { text: string }[] };
    expect(messages.map((m) => m.text)).toEqual(["hi"]);
    expect(
      (await s.hub.fetch(new Request("https://lianki-push/internal/friends/thread?user=a:b")))
        .status,
    ).toBe(400);
  });

  it("a page with a malformed identity is closed", async () => {
    const s = setup();
    const ws = await s.friend("bad:id");
    expect(ws.closed).toBe(4403);
  });
});

describe("DebugHub eval scoping between the owner and friends", () => {
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return { c, token: c.last("approved")?.token as string };
  };
  type St = { pending: { pair: string; label: string } | null; sessions: unknown[] };
  const st = (ws: FakeSocket) => ws.last("state") as St;
  /** Owner page, agent grant, two friends who have chatted. */
  const world = async () => {
    const s = setup();
    const owner = s.page("/words Macintosh");
    const { c, token } = await agent(s, owner);
    const a = await s.friend("fa", "a@x.com", "/words Android");
    const b = await s.friend("fb", "b@x.com", "/list iPhone");
    await s.msg(a, { type: "chat", id: "a", text: "hi" });
    await s.msg(b, { type: "chat", id: "b", text: "hi" });
    return { s, owner, c, token, a, b };
  };

  it("an owner-approved eval reaches only the owner's pages", async () => {
    const { s, owner, a, b } = await world();
    const e = s.controller("eval lane");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner) });
    // Friends were never shown the owner's prompt.
    expect(st(a).pending).toBeNull();
    await s.msg(e, { type: "eval", code: "document.title" });
    expect(owner.last("eval")).toBeTruthy();
    expect(a.last("eval")).toBeUndefined();
    expect(b.last("eval")).toBeUndefined();
  });

  it("only the owner's grant may ask a friend for a pairing", async () => {
    const { s } = await world();
    expect((await s.forFriend(null, "a@x.com")).closed).toBe(4498);
    expect((await s.forFriend("0".repeat(64), "a@x.com")).closed).toBe(4498);
  });

  it("a friend pairing prompts only that friend, and only they can answer it", async () => {
    const { s, owner, token, a, b } = await world();
    const p = await s.forFriend(token, "a@x.com", "agent on mac");
    expect(p.last("pending")?.code).toMatch(/^[0-9a-f]{4}$/);
    expect(st(a).pending?.label).toBe("agent on mac");
    expect(st(b).pending).toBeNull();
    expect(st(owner).pending).toBeNull();
    const pair = st(a).pending?.pair ?? "";
    // Neither the owner nor another friend can approve it.
    await s.msg(owner, { type: "allow", pair });
    await s.msg(b, { type: "allow", pair });
    expect(p.last("approved")).toBeUndefined();
    // Asking for chat scope from a friend's page still gives eval only, and no token.
    await s.msg(a, { type: "allow", pair, scope: "chat" });
    expect(p.last("approved")).toMatchObject({ scope: "eval", for: "a@x.com" });
    expect(p.last("approved")?.token).toBeUndefined();
    expect(p.last("history")).toBeUndefined();
  });

  it("a friend-approved eval reaches only that friend's pages, and cannot chat", async () => {
    const { s, owner, c, token, a, b } = await world();
    const a2 = await s.friend("fa", "a@x.com", "/words pwa Android");
    const p = await s.forFriend(token, "a@x.com");
    await s.msg(a, { type: "allow", pair: st(a).pending?.pair ?? "" });
    await s.msg(p, { type: "eval", code: "1", target: "pwa" });
    expect(p.last("sent")).toMatchObject({ delivered: 1, labels: ["/words pwa Android"] });
    await s.msg(p, { type: "eval", code: "2" });
    expect(p.last("sent")?.delivered).toBe(2);
    expect(owner.last("eval")).toBeUndefined();
    expect(b.last("eval")).toBeUndefined();
    const ev = a.last("eval") as { id: string; to: string };
    // A result from the owner's page (or another friend's) cannot reach it.
    await s.msg(owner, { type: "result", id: ev.id, to: ev.to, ok: true, value: "x" });
    await s.msg(b, { type: "result", id: ev.id, to: ev.to, ok: true, value: "x" });
    expect(p.last("result")).toBeUndefined();
    await s.msg(a, { type: "result", id: ev.id, to: ev.to, ok: true, value: "2" });
    expect(p.last("result")).toMatchObject({ value: "2", page: "/words Android" });
    // It is no listener: it hears no chat and may not say.
    await s.msg(a2, { type: "chat", id: "z", text: "zz" });
    expect(chats(p)).toEqual([]);
    expect(chats(c).at(-1)?.text).toBe("zz");
    await s.msg(p, { type: "say", text: "hi", to: "a@x.com" });
    expect(p.last("error")?.error).toContain("cannot chat");
    // Its session shows on the friend's pages, not the owner's.
    expect(st(a).sessions).toHaveLength(1);
    expect(st(owner).sessions).toHaveLength(1); // the owner's own chat grant only
  });

  it("the friend's End closes it, and the owner's End cannot reach it", async () => {
    const { s, owner, token, a } = await world();
    const p = await s.forFriend(token, "a@x.com");
    const pair = st(a).pending?.pair ?? "";
    await s.msg(a, { type: "allow", pair });
    await s.msg(owner, { type: "revoke", pair });
    expect(p.closed).toBeUndefined();
    await s.msg(a, { type: "revoke", pair });
    expect(p.closed).toBe(4401);
  });

  it("an expired friend pairing is closed", async () => {
    const { s, token, a } = await world();
    const p = await s.forFriend(token, "a@x.com");
    await s.msg(a, { type: "allow", pair: st(a).pending?.pair ?? "" });
    s.tick(APPROVAL_MS + 1);
    await s.msg(p, { type: "eval", code: "1" });
    expect(p.last("expired")).toBeTruthy();
    expect(p.closed).toBe(4408);
    expect(a.sent.filter((m) => m.type === "eval")).toHaveLength(0);
  });

  it("a waiting friend pairing does not block the owner's, nor another friend's", async () => {
    const { s, owner, token, b } = await world();
    await s.forFriend(token, "a@x.com");
    const own = s.controller("eval lane");
    expect(own.closed).toBeUndefined();
    expect(st(owner).pending?.label).toBe("eval lane");
    expect((await s.forFriend(token, "b@x.com")).closed).toBeUndefined();
    expect(st(b).pending).toBeTruthy();
    expect((await s.forFriend(token, "a@x.com")).closed).toBe(4429);
  });

  it("a pairing for an unknown friend, or one with no page open, is refused", async () => {
    const { s, token, b } = await world();
    expect((await s.forFriend(token, "nobody@x.com")).closed).toBe(4404);
    b.close(1001);
    expect((await s.forFriend(token, "b@x.com")).closed).toBe(4404);
  });
});

describe("DebugHub heartbeat (agent is working)", () => {
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return c;
  };
  const beats = (ws: FakeSocket) => ws.sent.filter((m) => m.type === "busy");

  it("goes to the owner's pages only by default, unstored, and is acknowledged", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    const f = await s.friend("f1", "f1@x.com");
    const keys = s.storage.store.size;
    await s.msg(c, { type: "busy" });
    expect(beats(owner)).toEqual([{ type: "busy", label: "agent", at: 1_000_000 }]);
    expect(beats(f)).toEqual([]);
    expect(c.last("beat")).toEqual({ type: "beat", thread: "owner", delivered: 1, at: 1_000_000 });
    expect(s.storage.store.size).toBe(keys);
  });

  it("goes to one friend's pages with --to, under the given label", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const g = await s.friend("f2", "f2@x.com");
    await s.msg(c, { type: "busy", to: "F1@x.com", label: "fixing" });
    expect(beats(f)).toEqual([{ type: "busy", label: "fixing", at: 1_000_000 }]);
    expect(beats(owner)).toEqual([]);
    expect(beats(g)).toEqual([]);
    expect(c.last("beat")?.thread).toBe("f1");
  });

  it("is refused from an unapproved controller, a friend's pairing, or to nobody", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    const token = c.last("approved")?.token as string;
    const stranger = s.controller("stranger");
    await s.msg(stranger, { type: "busy" });
    expect(stranger.last("error")?.error).toBe("not approved yet");
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const preview = await s.forFriend(token, "f1@x.com");
    await s.msg(f, { type: "allow", pair: s.pairOf(f) });
    await s.msg(preview, { type: "busy" });
    expect(preview.last("error")?.error).toBe("a pairing for a friend cannot chat");
    await s.msg(c, { type: "busy", to: "nobody@x.com" });
    expect(c.last("error")?.error).toBe("no chat thread for nobody@x.com");
    expect(beats(owner)).toEqual([]);
    expect(beats(f)).toEqual([]);
  });
});

describe("DebugHub page moves (relabel)", () => {
  it("relabels only that socket, tells the listeners silently, and later chat carries the new path", async () => {
    const s = setup();
    const phone = s.page("/words pwa iPhone");
    const mac = s.page("/list Macintosh");
    const c = s.controller("agent");
    await s.msg(phone, { type: "allow", pair: s.pairOf(phone), scope: "chat" });
    const before = phone.sent.length;
    await s.msg(phone, { type: "page", label: "/home pwa iPhone" });
    expect(c.last("page-changed")).toEqual({
      type: "page-changed",
      label: "/home pwa iPhone",
      thread: "owner",
      at: 1_000_000,
    });
    // Nothing shows on the pages (only the page list in their state), nothing is stored as chat.
    expect(phone.sent.slice(before).every((m) => m.type === "state")).toBe(true);
    expect((mac.last("state") as { pages: { label: string }[] }).pages.map((p) => p.label)).toEqual(
      ["/home pwa iPhone", "/list Macintosh"],
    );
    expect(mac.last("page-changed")).toBeUndefined();
    expect([...s.storage.store.keys()].some((k) => k.startsWith("msg:"))).toBe(false);
    await s.msg(phone, { type: "chat", id: "m1", text: "here" });
    expect(chats(c).at(-1)?.label).toBe("/home pwa iPhone");
    await s.msg(mac, { type: "chat", id: "m2", text: "there" });
    expect(chats(c).at(-1)?.label).toBe("/list Macintosh");
    // The same label again is no news.
    const n = c.sent.length;
    await s.msg(phone, { type: "page", label: "/home pwa iPhone" });
    expect(c.sent.length).toBe(n);
  });

  it("eval targets follow the new path", async () => {
    const s = setup();
    const p = s.page("/words iPhone");
    const c = s.controller("main lane");
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    await s.msg(p, { type: "page", label: "/home iPhone" });
    await s.msg(c, { type: "eval", code: "1", target: "/words" });
    expect(c.last("sent")?.delivered).toBe(0);
    await s.msg(c, { type: "eval", code: "1", target: "/home" });
    expect(c.last("sent")?.delivered).toBe(1);
  });

  it("a friend's page relabels only its own socket; the agent hears thread and email", async () => {
    const s = setup();
    const owner = s.page("/words iPhone");
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    const f = await s.friend("f1", "f1@x.com", "/words Android");
    await s.msg(f, { type: "page", label: "/home Android" });
    expect(c.last("page-changed")).toEqual({
      type: "page-changed",
      label: "/home Android",
      thread: "f1",
      email: "f1@x.com",
      at: 1_000_000,
    });
    await s.msg(owner, { type: "chat", id: "o", text: "x" });
    expect(chats(c).at(-1)?.label).toBe("/words iPhone");
    await s.msg(f, { type: "chat", id: "f", text: "y" });
    expect(chats(c).at(-1)?.label).toBe("/home Android");
  });
});

describe("DebugHub page list and End page", () => {
  type St = { pages: { id: string; label: string; at: number }[]; self?: string };
  const st = (ws: FakeSocket) => ws.last("state") as unknown as St;

  it("the owner's state lists the owner's pages only, with self; a friend's only their own", async () => {
    const s = setup();
    const a = s.page("/words iPhone");
    const b = s.page("/home Macintosh");
    const f = await s.friend("f1", "f1@x.com", "/words Android");
    const g = await s.friend("f2", "f2@x.com", "/list Pixel");
    expect(st(a).pages.map((p) => p.label)).toEqual(["/words iPhone", "/home Macintosh"]);
    expect(st(a).self).toBe(st(a).pages[0].id);
    expect(st(b).self).toBe(st(b).pages[1].id);
    expect(st(f).pages.map((p) => p.label)).toEqual(["/words Android"]);
    expect(st(g).pages.map((p) => p.label)).toEqual(["/list Pixel"]);
    expect(st(a).pages[0].at).toBe(1_000_000);
  });

  it("a page closing updates the others' list", async () => {
    const s = setup();
    const a = s.page("/a");
    const b = s.page("/b");
    b.close(1001);
    s.hub.webSocketClose(b, 1001);
    expect(st(a).pages.map((p) => p.label)).toEqual(["/a"]);
  });

  it("End page closes that page with PAGE_ENDED, in the same audience only", async () => {
    const s = setup();
    const a = s.page("/a");
    const b = s.page("/b");
    const f = await s.friend("f1", "f1@x.com", "/f");
    const bId = st(b).self as string;
    const fId = st(f).self as string;
    // A friend cannot end the owner's page, nor the owner a friend's.
    await s.msg(f, { type: "end-page", id: bId });
    await s.msg(a, { type: "end-page", id: fId });
    expect(b.closed).toBeUndefined();
    expect(f.closed).toBeUndefined();
    await s.msg(a, { type: "end-page", id: bId });
    expect(b.last("page-ended")).toEqual({ type: "page-ended" });
    expect(b.closed).toBe(PAGE_ENDED);
    expect(st(a).pages.map((p) => p.label)).toEqual(["/a"]);
    // Ending this page itself works the same way.
    await s.msg(a, { type: "end-page", id: st(a).self });
    expect(a.closed).toBe(PAGE_ENDED);
  });
});

describe("DebugHub requested scope and per-page grants", () => {
  /** A controller knocking with ?scope=…; a page answers. */
  const knock = (s: ReturnType<typeof setup>, scope?: string, label = "agent") => {
    const ws = new FakeSocket();

    (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx.getWebSockets().push(ws);
    void s.hub.connectController(
      ws,
      new URL(
        `https://lianki.com/api/version/debug/control?label=${label}${scope ? `&scope=${scope}` : ""}`,
      ),
    );
    return ws;
  };
  type St = { pages: { id: string }[]; self: string; pending: { scope?: string } | null };
  const st = (ws: FakeSocket) => ws.last("state") as unknown as St;
  const evals = (ws: FakeSocket) => ws.sent.filter((m) => m.type === "eval");

  it("Allow grants the scope the requester asked for", async () => {
    const s = setup();
    const p = s.page();
    const chat = knock(s, "chat");
    expect(st(p).pending?.scope).toBe("chat");
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    expect(chat.last("approved")).toMatchObject({ scope: "chat" });
    expect(typeof chat.last("approved")?.token).toBe("string");
    const ev = knock(s);
    expect(st(p).pending?.scope).toBe("eval");
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    expect(ev.last("approved")).toMatchObject({ scope: "eval" });
    // An older page's explicit chat choice still counts.
    const old = knock(s, "eval");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat" });
    expect(old.last("approved")).toMatchObject({ scope: "chat" });
  });

  it("a subset grant reaches exactly those pages — eval, busy and say — and not later ones", async () => {
    const s = setup();
    const a = s.page("/a");
    const b = s.page("/b");
    const c = s.page("/c");
    const ctl = knock(s, "eval");
    const [ia, ib] = [st(a).self, st(b).self];
    await s.msg(a, { type: "allow", pair: s.pairOf(a), pages: [ia, ib, "nosuchpage"] });
    expect(ctl.last("approved")).toMatchObject({ scope: "eval" });
    expect((st(c) as unknown as { sessions: { pages: string[] }[] }).sessions[0].pages).toEqual([
      ia,
      ib,
    ]);
    const d = s.page("/d");
    await s.msg(ctl, { type: "eval", code: "1" });
    expect(ctl.last("sent")?.delivered).toBe(2);
    expect([a, b, c, d].map((w) => evals(w).length)).toEqual([1, 1, 0, 0]);
    await s.msg(ctl, { type: "busy" });
    expect([a, b, c, d].map((w) => w.sent.filter((m) => m.type === "busy").length)).toEqual([
      1, 1, 0, 0,
    ]);
    await s.msg(ctl, { type: "say", text: "hi" });
    expect([a, b, c, d].map((w) => chats(w).length)).toEqual([1, 1, 0, 0]);
    // History is still the thread's.
    expect(chats(a)[0].text).toBe("hi");
  });

  it("'all' reaches every page, also ones that connect later", async () => {
    const s = setup();
    const a = s.page("/a");
    const ctl = knock(s, "eval");
    await s.msg(a, { type: "allow", pair: s.pairOf(a), pages: "all" });
    const later = s.page("/later");
    await s.msg(ctl, { type: "eval", code: "1" });
    expect(ctl.last("sent")?.delivered).toBe(2);
    expect(evals(later)).toHaveLength(1);
  });

  it("another page can be added to an eval grant later", async () => {
    const s = setup();
    const a = s.page("/a");
    const b = s.page("/b");
    const ctl = knock(s, "eval");
    await s.msg(a, { type: "allow", pair: s.pairOf(a), pages: [st(a).self] });
    await s.msg(ctl, { type: "eval", code: "1" });
    expect([a, b].map((w) => evals(w).length)).toEqual([1, 0]);
    const pair = (st(b) as unknown as { sessions: { pair: string }[] }).sessions[0].pair;
    await s.msg(b, { type: "allow", pair, pages: [st(b).self] });
    await s.msg(ctl, { type: "eval", code: "2" });
    expect([a, b].map((w) => evals(w).length)).toEqual([2, 1]);
    // "all" from a page widens it to every page, also later ones.
    await s.msg(b, { type: "allow", pair, pages: "all" });
    const c = s.page("/c");
    await s.msg(ctl, { type: "eval", code: "3" });
    expect(evals(c)).toHaveLength(1);
  });

  it("a chat grant always covers every page, whatever the answer asked", async () => {
    const s = setup();
    const a = s.page("/a");
    const b = s.page("/b");
    const ctl = knock(s, "chat");
    await s.msg(a, { type: "allow", pair: s.pairOf(a), pages: [st(a).self] });
    const token = ctl.last("approved")?.token as string;
    await s.msg(ctl, { type: "say", text: "one" });
    await s.msg(ctl, { type: "busy" });
    expect([a, b].map((w) => chats(w).length)).toEqual([1, 1]);
    expect(b.last("busy")).toBeDefined();
    const later = s.page("/later");
    const again = await s.resume(token);
    await s.msg(again, { type: "say", text: "two" });
    expect(chats(later).map((m) => m.text)).toEqual(["two"]);
    // A widen on a chat grant changes nothing.
    const pair = (st(b) as unknown as { sessions: { pair: string }[] }).sessions[0].pair;
    await s.msg(b, { type: "allow", pair, pages: [st(b).self] });
    await s.msg(ctl, { type: "say", text: "three" });
    expect([a, b, later].map((w) => chats(w).at(-1)?.text)).toEqual(["three", "three", "three"]);
  });

  it("the granted page coming back (same tab id) keeps the grant", async () => {
    const s = setup();
    const tab = (id: string) => {
      const ws = new FakeSocket();
      (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx.getWebSockets().push(ws);
      void s.hub.connectPage(
        ws,
        new URL(`https://lianki.com/api/version/debug?label=/words&tab=${id}`),
      );
      return ws;
    };
    const phone = tab("phone-tab-1");
    const ctl = knock(s, "eval");
    await s.msg(phone, { type: "allow", pair: s.pairOf(phone), pages: ["phone-tab-1"] });
    // The app goes to the background: the socket drops; it comes back with the same id.
    phone.close(1001);
    s.hub.webSocketClose(phone, 1001);
    s.tick(60_000);
    const back = tab("phone-tab-1");
    await s.msg(ctl, { type: "eval", code: "1" });
    expect(ctl.last("sent")?.delivered).toBe(1);
    expect(evals(back)).toHaveLength(1);
    expect(ctl.closed).toBeUndefined();
  });

  it("all granted pages away: an error but no close, until 5 min have passed", async () => {
    const s = setup();
    const a = s.page("/a");
    const b = s.page("/b");
    const ctl = knock(s, "eval");
    await s.msg(a, { type: "allow", pair: s.pairOf(a), pages: [st(a).self] });
    a.close(1001);
    s.hub.webSocketClose(a, 1001);
    s.tick(PAGE_GONE_GRACE_MS - 1);
    await s.msg(ctl, { type: "eval", code: "1" });
    expect(String(ctl.last("error")?.error)).toContain("not connected now");
    expect(ctl.closed).toBeUndefined();
    expect(evals(b)).toEqual([]);
    s.tick(1);
    // The next event of any kind closes it; no timer is involved.
    await s.msg(b, { type: "chat", id: "x", text: "hi" });
    expect(String(ctl.last("error")?.error)).toContain("the page you were authorized for is gone");
    expect(ctl.closed).toBe(PAGES_GONE);
  });

  it("the grace restarts when a granted page was back in between", async () => {
    const s = setup();
    const tab = (id: string) => {
      const ws = new FakeSocket();
      (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx.getWebSockets().push(ws);
      void s.hub.connectPage(
        ws,
        new URL(`https://lianki.com/api/version/debug?label=/a&tab=${id}`),
      );
      return ws;
    };
    const a = tab("tab-aaaaaa");
    const other = s.page("/other");
    const ctl = knock(s, "eval");
    await s.msg(a, { type: "allow", pair: s.pairOf(a), pages: ["tab-aaaaaa"] });
    a.close(1001);
    s.hub.webSocketClose(a, 1001);
    s.tick(PAGE_GONE_GRACE_MS - 10);
    const back = tab("tab-aaaaaa");
    await Promise.resolve();
    back.close(1001);
    s.hub.webSocketClose(back, 1001);
    s.tick(20);
    await s.msg(other, { type: "chat", id: "y", text: "hi" });
    expect(ctl.closed).toBeUndefined();
    // Past the grace, even the controller's own message closes it rather than running.
    s.tick(PAGE_GONE_GRACE_MS);
    await s.msg(ctl, { type: "eval", code: "1" });
    expect(ctl.closed).toBe(PAGES_GONE);
    expect(ctl.last("sent")).toBeUndefined();
  });

  it("an empty or foreign list falls back to the answering page; a friend's ids never cover the owner's", async () => {
    const s = setup();
    const a = s.page("/a");
    const b = s.page("/b");
    const f = await s.friend("f1", "f1@x.com", "/f");
    const ctl = knock(s, "eval");
    await s.msg(a, { type: "allow", pair: s.pairOf(a), pages: [st(f).self] });
    await s.msg(ctl, { type: "eval", code: "1" });
    expect([a, b, f].map((w) => evals(w).length)).toEqual([1, 0, 0]);
  });

  it("a page's tab id survives a reconnect, so its grant does", async () => {
    const s = setup();
    const ws = new FakeSocket();
    (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx.getWebSockets().push(ws);
    await s.hub.connectPage(
      ws,
      new URL("https://lianki.com/api/version/debug?label=/a&tab=tab-123456"),
    );
    expect(st(ws).self).toBe("tab-123456");
    const bad = new FakeSocket();
    (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx.getWebSockets().push(bad);
    await s.hub.connectPage(bad, new URL("https://lianki.com/api/version/debug?label=/b&tab=x:y"));
    expect(st(bad).self).not.toBe("x:y");
  });
});

describe("lianki-push: x-liagent-token is an alias of x-debug-token", () => {
  const seen: (string | null)[] = [];
  const env: Env = {
    HUB: { idFromName: () => 0, get: () => ({ fetch: async () => new Response("v") }) },
    DEBUG: {
      idFromName: () => 0,
      get: () => ({
        fetch: async (r: Request) => {
          seen.push(r.headers.get("x-debug-token"), r.headers.get("x-liagent-token"));
          return new Response("debug");
        },
      }),
    },
  };
  const go = (headers: Record<string, string>) =>
    push.fetch(
      new Request("https://lianki.com/api/version/debug/control", {
        headers: { upgrade: "websocket", ...headers },
      }),
      env,
    );
  it("passes either one on as x-debug-token; refuses two that differ", async () => {
    seen.length = 0;
    expect((await go({ "x-liagent-token": "t1" })).status).toBe(200);
    expect((await go({ "x-debug-token": "t2" })).status).toBe(200);
    expect((await go({ "x-debug-token": "t3", "x-liagent-token": "t3" })).status).toBe(200);
    expect(seen).toEqual(["t1", null, "t2", null, "t3", null]);
    expect((await go({ "x-debug-token": "a", "x-liagent-token": "b" })).status).toBe(400);
  });
});

describe("DebugHub resumable eval grants (no re-prompt until EVAL_GRANT_MS)", () => {
  type Sess = { pair: string; code: string; label: string; scope?: string; pages?: string[] };
  type St = { pending: { pair: string } | null; sessions: Sess[]; self: string };
  const st = (ws: FakeSocket) => ws.last("state") as unknown as St;
  const evals = (ws: FakeSocket) => ws.sent.filter((m) => m.type === "eval");
  /** An owner page with a stable tab id (sessionStorage), as DebugEval connects. */
  const tab = async (s: ReturnType<typeof setup>, id: string, label = "/words") => {
    const ws = new FakeSocket();
    (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx.getWebSockets().push(ws);
    await s.hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=${label}&tab=${id}`),
    );
    return ws;
  };
  const leave = (s: ReturnType<typeof setup>, ws: FakeSocket, code = 1001) => {
    ws.close(code);
    s.hub.webSocketClose(ws, code);
  };
  /** Pair an eval controller and Allow it for `pages` (default: the answering page only). */
  const grant = async (
    s: ReturnType<typeof setup>,
    p: FakeSocket,
    pages: string[] | "all" = [st(p).self],
  ) => {
    const c = s.controller("agent");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), pages });
    return { c, token: c.last("approved")?.token as string };
  };
  const prompts = (p: FakeSocket) =>
    p.sent.filter((m) => m.type === "state" && (m as unknown as St).pending).length;

  it("the token resumes eval scope and the page set, with no prompt", async () => {
    const s = setup();
    const phone = await tab(s, "phone-tab-1", "/words pwa iPhone");
    const mac = await tab(s, "mac-tab-01", "/list Macintosh");
    const { c, token } = await grant(s, phone);
    expect(prompts(phone)).toBe(1);
    leave(s, c, 1006);
    s.tick(EVAL_GRANT_MS - 60_000);
    const again = await s.resume(token);
    expect(again.last("approved")).toMatchObject({
      scope: "eval",
      resumed: true,
      until: 1_000_000 + EVAL_GRANT_MS,
    });
    expect(again.last("pending")).toBeUndefined();
    expect(prompts(phone)).toBe(1);
    expect(prompts(mac)).toBe(1);
    expect(st(mac).sessions.map((x) => x.pages)).toEqual([["phone-tab-1"]]);
    await s.msg(again, { type: "eval", code: "1" });
    expect([phone, mac].map((w) => evals(w).length)).toEqual([1, 0]);
    // Eval implies chat.
    await s.msg(again, { type: "say", text: "hi" });
    expect(again.last("said")).toBeTruthy();
  });

  it("an expired eval grant is refused with 4498 and deleted", async () => {
    const s = setup();
    const p = await tab(s, "tab-aaaaaa");
    const { c, token } = await grant(s, p, "all");
    leave(s, c);
    s.tick(EVAL_GRANT_MS + 1);
    const late = await s.resume(token);
    expect(late.closed).toBe(4498);
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(false);
  });

  it("End on the live session deletes the grant: the token resumes nothing", async () => {
    const s = setup();
    const p = await tab(s, "tab-aaaaaa");
    const { c, token } = await grant(s, p);
    const other = await s.resume(token);
    await s.msg(p, { type: "revoke", pair: st(p).sessions[0].pair });
    expect(c.closed).toBe(4401);
    expect(other.closed).toBe(4401);
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(false);
    expect((await s.resume(token)).closed).toBe(4498);
    expect(st(p).sessions).toEqual([]);
  });

  it("Deny stores nothing; a denied sender has no token to come back with", async () => {
    const s = setup();
    const p = await tab(s, "tab-aaaaaa");
    const c = s.controller("agent");
    await s.msg(p, { type: "deny", pair: s.pairOf(p) });
    expect(c.closed).toBe(4403);
    expect([...s.storage.store.keys()].filter((k) => k.startsWith("grant:"))).toEqual([]);
  });

  it("pages gone closes the socket but keeps the grant; the page back = a silent resume", async () => {
    const s = setup();
    const phone = await tab(s, "phone-tab-1");
    const other = await tab(s, "other-tab-1", "/other");
    const { c, token } = await grant(s, phone);
    leave(s, phone);
    s.tick(PAGE_GONE_GRACE_MS);
    await s.msg(other, { type: "chat", id: "x", text: "hi" });
    expect(c.closed).toBe(PAGES_GONE);
    expect(String(c.last("error")?.error)).toContain("your grant stays");
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(true);
    // Asleep, it is still listed to the owner's pages, so End reaches it.
    expect(st(other).sessions).toMatchObject([{ code: "idle", scope: "eval" }]);
    const back = await tab(s, "phone-tab-1");
    const again = await s.resume(token);
    expect(again.last("approved")).toMatchObject({ scope: "eval", resumed: true });
    await s.msg(again, { type: "eval", code: "1" });
    expect([back, other].map((w) => evals(w).length)).toEqual([1, 0]);
    expect(prompts(back) + prompts(other)).toBe(1);
  });

  it("a sleeping grant can be ended from the menu, also after the hub was evicted", async () => {
    const s = setup();
    const p = await tab(s, "tab-aaaaaa");
    const { c, token } = await grant(s, p);
    leave(s, c, 1006);
    leave(s, p);
    // Eviction: the in-memory copy is gone; the next page reads storage again.
    (s.hub as unknown as { grants?: unknown }).grants = undefined;
    const q = await tab(s, "tab-aaaaaa");
    const idle = st(q).sessions;
    expect(idle).toMatchObject([{ code: "idle", label: "agent", pages: ["tab-aaaaaa"] }]);
    expect(idle[0].pair.startsWith("g:")).toBe(true);
    expect(idle[0].pair).not.toContain(await hashToken(token));
    await s.msg(q, { type: "revoke", pair: idle[0].pair });
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(false);
    expect(st(q).sessions).toEqual([]);
    expect((await s.resume(token)).closed).toBe(4498);
  });

  it("pages added to a grant (live or asleep) are kept for the next resume", async () => {
    const s = setup();
    const a = await tab(s, "tab-aaaaaa", "/a");
    const b = await tab(s, "tab-bbbbbb", "/b");
    const { c, token } = await grant(s, a);
    await s.msg(b, { type: "allow", pair: st(b).sessions[0].pair, pages: [st(b).self] });
    leave(s, c);
    const cc = await tab(s, "tab-cccccc", "/c");
    await s.msg(cc, { type: "allow", pair: st(cc).sessions[0].pair, pages: [st(cc).self] });
    const again = await s.resume(token);
    await s.msg(again, { type: "eval", code: "1" });
    expect([a, b, cc].map((w) => evals(w).length)).toEqual([1, 1, 1]);
  });

  it("a friend never sees the owner's sleeping grant, nor can End it", async () => {
    const s = setup();
    const p = await tab(s, "tab-aaaaaa");
    const { c, token } = await grant(s, p);
    leave(s, c);
    const pair = st(p).sessions[0].pair;
    const f = await s.friend("f1", "f1@x.com");
    expect((f.last("state") as unknown as St).sessions).toEqual([]);
    await s.msg(f, { type: "revoke", pair });
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(true);
  });

  it("a friend's preview stays one socket for an hour: no token is handed out", async () => {
    const s = setup();
    const owner = await tab(s, "tab-aaaaaa");
    const chat = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const p = await s.forFriend(chat.last("approved")?.token as string, "f1@x.com");
    await s.msg(f, { type: "allow", pair: (f.last("state") as unknown as St).pending?.pair ?? "" });
    expect(p.last("approved")).toMatchObject({ scope: "eval", until: 1_000_000 + APPROVAL_MS });
    expect(p.last("approved")?.token).toBeUndefined();
  });

  it("an eval grant's token may also ask a friend for a preview (eval implies chat)", async () => {
    const s = setup();
    const owner = await tab(s, "tab-aaaaaa");
    const { token } = await grant(s, owner);
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const p = await s.forFriend(token, "f1@x.com");
    expect(p.last("pending")).toBeTruthy();
  });
});

/** Connect a heartbeat-only socket (`busy --every`, `?beat=1`) with a grant token. */
const beatSocket = async (s: ReturnType<typeof setup>, token: string) => {
  const ws = new FakeSocket();
  (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx.getWebSockets().push(ws);
  await s.hub.connectController(
    ws,
    new URL("https://lianki.com/api/version/debug/control?label=&scope=chat&beat=1"),
    token,
  );
  return ws;
};
type Counted = { sessions: { code: string }[]; listeners: number };
const counted = (p: FakeSocket) => p.last("state") as unknown as Counted;

describe("DebugHub heartbeat-only sockets", () => {
  it("a busy --every socket (?beat=1) keeps its grant and hears the chat, but is no session or listener", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller("agent");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat" });
    const token = c.last("approved")?.token as string;
    expect([counted(p).sessions.length, counted(p).listeners]).toEqual([1, 1]);
    const beat = await beatSocket(s, token);
    expect(beat.last("approved")).toMatchObject({ scope: "chat", resumed: true });
    expect([counted(p).sessions.length, counted(p).listeners]).toEqual([1, 1]);
    await s.msg(beat, { type: "busy" });
    expect(p.last("busy")).toBeDefined();
    await s.msg(c, { type: "say", text: "done" });
    expect(chats(beat).at(-1)?.text).toBe("done");
    // A plain resume (say) is still a session while it is open.
    await s.resume(token);
    expect(counted(p).sessions).toHaveLength(2);
    expect(counted(p).listeners).toBe(2);
  });

  it("a beat alone is not the agent: the pages read 'offline' (0 listeners)", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller("agent");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat" });
    const token = c.last("approved")?.token as string;
    const beat = await beatSocket(s, token);
    c.close(1001);
    await s.hub.webSocketClose(c, 1001);
    expect(counted(p).listeners).toBe(0);
    expect(counted(p).sessions).toEqual([]);
    // It still beats and hears the chat.
    await s.msg(beat, { type: "busy" });
    expect(beat.last("beat")).toMatchObject({ thread: "owner", delivered: 1 });
  });

  it("a beat on an eval grant leaves that grant listed as asleep, so End still reaches it", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller("agent");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), pages: "all" });
    const token = c.last("approved")?.token as string;
    c.close(1001);
    await s.hub.webSocketClose(c, 1001);
    const beat = await beatSocket(s, token);
    expect(beat.last("approved")).toMatchObject({ scope: "eval", resumed: true });
    const { sessions, listeners } = counted(p);
    expect([sessions.map((x) => x.code), listeners]).toEqual([["idle"], 0]);
    const pair = (p.last("state") as { sessions: { pair: string }[] }).sessions[0].pair;
    await s.msg(p, { type: "revoke", pair });
    expect(beat.closed).toBe(4401);
  });

  it("pages get a fresh state each time a listener connects or leaves", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller("agent");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat" });
    const token = c.last("approved")?.token as string;
    expect(counted(p).listeners).toBe(1);
    const second = await s.resume(token);
    expect(counted(p).listeners).toBe(2);
    second.close(1001);
    await s.hub.webSocketClose(second, 1001);
    expect(counted(p).listeners).toBe(1);
    // An errored socket is gone too.
    await s.hub.webSocketError(c);
    expect(counted(p).listeners).toBe(0);
  });
});

describe("DebugHub presence: pages-idle and pages-back", () => {
  /** An owner page, the agent's chat listener and its heartbeat socket. */
  const world = async () => {
    const s = setup();
    const p = s.page("/words");
    const c = s.controller("agent");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat" });
    const token = c.last("approved")?.token as string;
    const beat = await beatSocket(s, token);
    await s.msg(beat, { type: "busy" });
    const gone = async (ws: FakeSocket) => {
      ws.close(1001);
      await s.hub.webSocketClose(ws, 1001);
    };
    return { s, p, c, beat, gone };
  };
  const idles = (ws: FakeSocket) => ws.sent.filter((m) => m.type === "pages-idle");
  const connect = async (s: ReturnType<typeof setup>, label: string) => {
    const ws = new FakeSocket();
    (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx.getWebSockets().push(ws);
    await s.hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}`),
    );
    return ws;
  };

  it("the last page closing sets the alarm; 60 s later the agent hears pages-idle and the beat is closed", async () => {
    const { s, p, c, beat, gone } = await world();
    await gone(p);
    expect(s.storage.alarm).toBe(1_000_000 + PAGES_IDLE_MS);
    s.tick(PAGES_IDLE_MS - 1);
    await s.hub.alarm();
    expect(idles(c)).toEqual([]);
    s.tick(1);
    await s.hub.alarm();
    expect(idles(c)).toEqual([
      { type: "pages-idle", thread: "owner", at: 1_000_000 + PAGES_IDLE_MS },
    ]);
    expect(idles(beat)).toHaveLength(1);
    expect(beat.closed).toBe(PAGES_IDLE);
    expect(c.closed).toBeUndefined();
    // Announced once.
    await s.hub.alarm();
    expect(idles(c)).toHaveLength(1);
  });

  it("a reload inside the grace is not idle, and not 'back' either", async () => {
    const { s, p, c, beat, gone } = await world();
    await gone(p);
    s.tick(30_000);
    await connect(s, "/words");
    s.tick(PAGES_IDLE_MS);
    await s.hub.alarm();
    expect(idles(c)).toEqual([]);
    expect(c.last("pages-back")).toBeUndefined();
    expect(beat.closed).toBeUndefined();
  });

  it("the first page after idle is announced as pages-back, with its label, once", async () => {
    const { s, p, c, gone } = await world();
    await gone(p);
    s.tick(PAGES_IDLE_MS);
    await s.hub.alarm();
    await connect(s, "/home pwa");
    expect(c.last("pages-back")).toEqual({
      type: "pages-back",
      thread: "owner",
      label: "/home pwa",
      at: 1_000_000 + PAGES_IDLE_MS,
    });
    await connect(s, "/x");
    expect(c.sent.filter((m) => m.type === "pages-back")).toHaveLength(1);
  });

  it("counts pages only: controllers and beat sockets neither keep a thread alive nor empty it", async () => {
    const { s, p, c, beat, gone } = await world();
    const other = s.page("/list");
    await gone(p);
    expect(s.storage.alarm).toBeNull();
    await gone(beat);
    await gone(c);
    expect(s.storage.alarm).toBeNull();
    await gone(other);
    expect(s.storage.alarm).toBe(1_000_000 + PAGES_IDLE_MS);
  });

  it("each thread on its own: a friend's going idle leaves the owner's beat alone", async () => {
    const { s, c, beat } = await world();
    const f = await s.friend("f1", "f1@x.com", "/f");
    f.close(1001);
    await s.hub.webSocketClose(f, 1001);
    s.tick(10_000);
    // Another owner page leaves later, the first still open: the alarm stays at the earliest.
    const o = s.page("/o2");
    o.close(1001);
    await s.hub.webSocketClose(o, 1001);
    expect(s.storage.alarm).toBe(1_000_000 + PAGES_IDLE_MS);
    s.tick(PAGES_IDLE_MS - 10_000);
    await s.hub.alarm();
    expect(idles(c).map((m) => m.thread)).toEqual(["f1"]);
    expect(beat.closed).toBeUndefined();
  });

  it("a thread not yet due re-arms the alarm for its own time", async () => {
    const s = setup();
    const a = s.page("/a");
    const f = await s.friend("f1", "f1@x.com", "/f");
    f.close(1001);
    await s.hub.webSocketClose(f, 1001);
    s.tick(20_000);
    a.close(1001);
    await s.hub.webSocketClose(a, 1001);
    s.tick(PAGES_IDLE_MS - 20_000);
    await s.hub.alarm();
    expect(s.storage.alarm).toBe(1_000_000 + 20_000 + PAGES_IDLE_MS);
  });

  it("a message checks too, without waiting for the alarm", async () => {
    const { s, p, c, gone } = await world();
    await gone(p);
    s.tick(PAGES_IDLE_MS);
    await s.msg(c, { type: "busy" });
    await new Promise((r) => setTimeout(r, 0));
    expect(idles(c)).toHaveLength(1);
  });

  it("the alarm also runs the 4409 grace for page-scoped eval pairings", async () => {
    const s = setup();
    const p = s.page("/a");
    const c = s.controller("agent");
    await s.msg(p, {
      type: "allow",
      pair: s.pairOf(p),
      pages: [(p.last("state") as { self: string }).self],
    });
    p.close(1001);
    await s.hub.webSocketClose(p, 1001);
    s.tick(PAGE_GONE_GRACE_MS);
    await s.hub.alarm();
    expect(c.closed).toBe(PAGES_GONE);
  });
});

describe("DebugHub avatars (sender on chat lines)", () => {
  const PIC = "https://example.com/avatar.png";
  /** A page with a full identity, as index.ts hands it over. */
  const pageAs = async (s: ReturnType<typeof setup>, who: Identity, label = "/words iPhone") => {
    const ws = new FakeSocket();
    s.sockets.push(ws);
    await s.hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}`),
      who,
    );
    return ws;
  };

  it("a friend's page hears who it is, and their lines carry it: hashed id, never the email", async () => {
    const s = setup();
    const f = await pageAs(s, {
      userId: "f1",
      email: "ada@example.com",
      owner: false,
      name: "Ada",
      image: PIC,
    });
    const sender = { id: hashId("f1"), name: "Ada", avatars: [PIC] };
    expect(f.last("me")).toEqual({ type: "me", sender });
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    expect(chats(f).at(-1)?.sender).toEqual(sender);
    expect(JSON.stringify(f.last("me"))).not.toContain("ada@example.com");
  });

  it("the owner's lines carry the owner's sender too", async () => {
    const s = setup();
    const o = await pageAs(s, { userId: "o1", email: "o@example.com", owner: true, name: "Owner" });
    expect(o.last("me")).toEqual({ type: "me", sender: { id: hashId("o1"), name: "Owner" } });
    await s.msg(o, { type: "chat", id: "a", text: "hi" });
    expect(chats(o).at(-1)?.sender).toEqual({ id: hashId("o1"), name: "Owner" });
  });

  it("a picture that is not https is dropped; no identity means no sender (as before)", async () => {
    const s = setup();
    const f = await pageAs(s, {
      userId: "f2",
      email: "",
      owner: false,
      image: "http://example.com/a.png",
    });
    expect(f.last("me")).toEqual({ type: "me", sender: { id: hashId("f2") } });
    const p = s.page();
    await s.msg(p, { type: "chat", id: "b", text: "hi" });
    expect(p.last("me")).toBeUndefined();
    expect(chats(p).at(-1)?.sender).toBeUndefined();
  });

  it("the page's attachment stays under the 2 KB limit at the bounds", async () => {
    const s = setup();
    const f = await pageAs(
      s,
      {
        userId: "f3",
        email: `${"e".repeat(300)}@example.com`,
        owner: false,
        name: "名".repeat(200),
        image: `https://example.com/${"x".repeat(270)}`,
      },
      `/${"p".repeat(400)}`,
    );
    const bytes = new TextEncoder().encode(JSON.stringify(f.deserializeAttachment())).length;
    expect(bytes).toBeLessThan(2048);
  });

  it("index.ts forwards the name (percent-encoded) and picture, and strips a page's own", async () => {
    const seen: Headers[] = [];
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
      MAIN: {
        fetch: async () =>
          Response.json({
            userId: "f1",
            email: "f@example.com",
            owner: false,
            name: "山田 Ada",
            image: PIC,
          }),
      },
    };
    const req = (h: Record<string, string>) =>
      new Request("https://lianki.com/api/version/debug", {
        headers: { upgrade: "websocket", origin: "https://lianki.com", cookie: "s=1", ...h },
      });
    await push.fetch(req({ "x-debug-image": "https://example.com/spoof.png" }), e);
    expect(decodeURIComponent(seen[0].get("x-debug-name") ?? "")).toBe("山田 Ada");
    expect(seen[0].get("x-debug-image")).toBe(PIC);
    // An older main Worker says neither: a page's own headers do not get through.
    e.MAIN = { fetch: async () => Response.json({ userId: "f1", email: "f@x", owner: false }) };
    await push.fetch(
      req({ "x-debug-image": "https://example.com/spoof.png", "x-debug-name": "Spoof" }),
      e,
    );
    expect(seen[1].get("x-debug-image")).toBeNull();
    expect(seen[1].get("x-debug-name")).toBeNull();
  });

  it("debugIdentity keeps a name and an https picture, and drops anything else", async () => {
    const req = new Request("https://lianki.com/api/version/debug", {
      headers: { origin: "https://lianki.com", cookie: "s=1" },
    });
    const main = (body: unknown) => ({ fetch: async () => Response.json(body) });
    expect(
      await debugIdentity(
        req,
        main({ userId: "u", email: "", owner: false, name: "Ada", image: PIC }),
      ),
    ).toEqual({ userId: "u", email: "", owner: false, name: "Ada", image: PIC });
    expect(
      await debugIdentity(
        req,
        main({ userId: "u", email: "", owner: false, name: 3, image: "javascript:x" }),
      ),
    ).toEqual({ userId: "u", email: "", owner: false });
  });

  it("the hub reads the identity headers (a bad name encoding is ignored)", async () => {
    const s = setup();
    const r = (name: string) =>
      new Request("https://lianki.com/api/version/debug?label=/x", {
        headers: {
          "x-debug-user": "f9",
          "x-debug-email": "",
          "x-debug-owner": "0",
          "x-debug-name": name,
          "x-debug-image": PIC,
        },
      });
    // fetch() makes a WebSocketPair, which only the Workers runtime has: stub one.
    const g = globalThis as { WebSocketPair?: unknown };
    const had = g.WebSocketPair;
    const made: FakeSocket[] = [];
    g.WebSocketPair = class {
      0 = new FakeSocket();
      1 = (() => {
        const ws = new FakeSocket();
        made.push(ws);
        return ws;
      })();
    };
    // A 101 Response is refused outside the Workers runtime; the socket is set up by then.
    const call = (req: Request) => s.hub.fetch(req).catch(() => null);
    try {
      await call(r(encodeURIComponent("Ada")));
      await call(r("%E0%A4%A"));
    } finally {
      g.WebSocketPair = had;
    }
    expect(made[0]?.last("me")).toEqual({
      type: "me",
      sender: { id: hashId("f9"), name: "Ada", avatars: [PIC] },
    });
    expect(made[1]?.last("me")).toEqual({
      type: "me",
      sender: { id: hashId("f9"), avatars: [PIC] },
    });
  });
});

describe("DebugHub node paths (messages addressed to state-tree nodes)", () => {
  /**
   * The owner's page, the main (root) listener, and listeners at the given
   * nodes, each resumed with the root's chat grant (`?node=&agent=`).
   */
  async function tree(...nodes: string[]) {
    const s = setup();
    const p = s.page();
    const root = s.controller("main lane");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat" });
    const token = root.last("approved")?.token as string;
    const at: Record<string, FakeSocket> = {};
    for (const n of nodes) {
      const ws = new FakeSocket();
      s.sockets.push(ws);
      await s.hub.connectController(
        ws,
        new URL(
          `https://lianki.com/api/version/debug/control?label=sub&node=${encodeURIComponent(n)}&agent=${encodeURIComponent(`agent ${n.split("/").pop()}`)}`,
        ),
        token,
      );
      at[n] = ws;
    }
    return { ...s, p, root, at, token };
  }
  const observed = (ws: FakeSocket) =>
    ws.sent.filter((m) => m.type === "chat").map((m) => m.observed === true);

  it("an owner line to a node reaches that node, its ancestors as observers, and no sibling", async () => {
    const { p, root, at, msg } = await tree("/words", "/words/prefetch", "/words/audio", "/home");
    await msg(p, { type: "chat", id: "m1", text: "prefetch more", to: "/words › prefetch" });
    expect(chats(at["/words/prefetch"])).toMatchObject([{ id: "m1", to: "/words/prefetch" }]);
    expect(observed(at["/words/prefetch"])).toEqual([false]);
    expect(chats(at["/words"]).map((m) => m.id)).toEqual(["m1"]);
    expect(observed(at["/words"])).toEqual([true]);
    expect(chats(root).map((m) => m.id)).toEqual(["m1"]);
    expect(observed(root)).toEqual([true]);
    expect(chats(at["/words/audio"])).toEqual([]);
    expect(chats(at["/home"])).toEqual([]);
    // The owner's page shows it, with its target.
    expect(chats(p).at(-1)).toMatchObject({ id: "m1", to: "/words/prefetch" });
  });

  it("a main-thread line (no `to`, or '/') reaches the root listener only, as before", async () => {
    const { p, root, at, msg } = await tree("/words");
    await msg(p, { type: "chat", id: "m1", text: "hi" });
    await msg(p, { type: "chat", id: "m2", text: "hi", to: "/" });
    await msg(p, { type: "chat", id: "m3", text: "bad", to: "/../x" });
    expect(chats(root).map((m) => [m.id, m.to])).toEqual([
      ["m1", undefined],
      ["m2", undefined],
      ["m3", undefined],
    ]);
    expect(observed(root)).toEqual([false, false, false]);
    expect(chats(at["/words"])).toEqual([]);
  });

  it("a legacy listener (no ?node) counts as the root and observes every node", async () => {
    const { p, root, msg } = await tree();
    await msg(p, { type: "chat", id: "m1", text: "x", to: "/a/b" });
    expect(chats(root)).toMatchObject([{ id: "m1", to: "/a/b" }]);
  });

  it("the state lists the listeners' nodes for completions", async () => {
    const { p } = await tree("/words/prefetch", "/home");
    expect(p.last("state")?.nodes).toEqual(["/home", "/words/prefetch"]);
  });

  it("an agent line carries its taskPath and agentId; the socket's node is the default", async () => {
    const { p, at, msg } = await tree("/words/prefetch");
    const c = at["/words/prefetch"];
    await msg(c, { type: "say", text: "warming the cache" });
    expect(chats(p).at(-1)).toMatchObject({
      from: "agent",
      text: "warming the cache",
      taskPath: "/words/prefetch",
      agentId: "agent prefetch",
    });
    await msg(c, { type: "say", text: "deeper", taskPath: "/words/prefetch/img", agentId: "x9" });
    expect(chats(p).at(-1)).toMatchObject({ taskPath: "/words/prefetch/img", agentId: "x9" });
    // Outside its own node: refused.
    await msg(c, { type: "say", text: "escape", taskPath: "/home" });
    expect(c.last("error")?.reason).toBe(
      "taskPath /home is outside this listener's node /words/prefetch",
    );
  });

  it("a root agent's line without taskPath is unchanged", async () => {
    const { p, root, msg } = await tree();
    await msg(root, { type: "say", text: "plain" });
    const line = chats(p).at(-1);
    expect(line?.text).toBe("plain");
    expect(line?.taskPath).toBeUndefined();
    expect(line?.agentId).toBeUndefined();
    expect(line?.to).toBeUndefined();
  });

  it("agent → agent: into its own subtree, and upward, are allowed", async () => {
    const { p, root, at, msg } = await tree("/words", "/words/prefetch");
    await msg(at["/words"], { type: "say", text: "do X", to: "/words/prefetch" });
    expect(chats(at["/words/prefetch"]).at(-1)).toMatchObject({
      text: "do X",
      taskPath: "/words",
      to: "/words/prefetch",
    });
    await msg(at["/words/prefetch"], { type: "say", text: "done", to: "/words" });
    expect(chats(at["/words"]).at(-1)).toMatchObject({ text: "done", taskPath: "/words/prefetch" });
    await msg(at["/words/prefetch"], { type: "say", text: "to main", to: "/" });
    expect(chats(root).at(-1)).toMatchObject({ text: "to main", taskPath: "/words/prefetch" });
    // The owner's page and the root see all of it.
    expect(chats(p).map((m) => m.text)).toEqual(["do X", "done", "to main"]);
    expect(chats(root).map((m) => m.text)).toEqual(["do X", "done", "to main"]);
  });

  it("agent → a sibling is refused without a grant, naming the common ancestor", async () => {
    const { p, at, msg } = await tree("/words/prefetch", "/words/audio");
    await msg(at["/words/prefetch"], { type: "say", text: "hey", to: "/words/audio" });
    expect(at["/words/prefetch"].last("error")).toMatchObject({
      type: "error",
      reason: "out of scope: needs a grant from /words",
    });
    expect(chats(at["/words/audio"])).toEqual([]);
    expect(chats(p)).toEqual([]);
  });

  it("a grant from the root (or the common ancestor) lets a sibling through until it lapses", async () => {
    const { root, at, msg, tick } = await tree("/words/prefetch", "/words/audio", "/home");
    // A listener that does not hold both nodes cannot grant.
    await msg(at["/home"], { type: "grant", from: "/words/prefetch", to: "/words/audio" });
    expect(at["/home"].last("error")?.reason).toMatch(/^out of scope/);
    await msg(root, { type: "grant", from: "/words/prefetch", to: "/words/audio", ms: 60_000 });
    expect(root.last("granted")).toMatchObject({ from: "/words/prefetch", to: "/words/audio" });
    await msg(at["/words/prefetch"], { type: "say", text: "hey", to: "/words/audio" });
    expect(chats(at["/words/audio"]).at(-1)).toMatchObject({
      text: "hey",
      taskPath: "/words/prefetch",
    });
    // Not the other way round.
    await msg(at["/words/audio"], { type: "say", text: "back", to: "/words/prefetch" });
    expect(at["/words/audio"].last("error")?.reason).toMatch(/^out of scope/);
    tick(60_001);
    await msg(at["/words/prefetch"], { type: "say", text: "late", to: "/words/audio" });
    expect(chats(at["/words/audio"]).map((m) => m.text)).toEqual(["hey"]);
  });

  it("ungrant takes a node grant back", async () => {
    const { root, at, msg } = await tree("/a", "/b");
    await msg(root, { type: "grant", from: "/a", to: "/b" });
    await msg(root, { type: "ungrant", from: "/a", to: "/b" });
    await msg(at["/a"], { type: "say", text: "x", to: "/b" });
    expect(at["/a"].last("error")?.reason).toBe("out of scope: needs a grant from /");
  });

  it("a node listener's history holds only the lines routed to it", async () => {
    const { hub, p, sockets, msg, token } = await tree();
    await msg(p, { type: "chat", id: "m1", text: "main" });
    await msg(p, { type: "chat", id: "m2", text: "for words", to: "/words" });
    await msg(p, { type: "chat", id: "m3", text: "for home", to: "/home" });
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL("https://lianki.com/api/version/debug/control?node=/words"),
      token,
    );
    const h = ws.last("history") as { messages: { id: string }[] };
    expect(h.messages.map((m) => m.id)).toEqual(["m2"]);
  });
});

describe("DebugHub agent edits of voice messages", () => {
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("main lane");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return { c, token: c.last("approved")?.token as string };
  };
  const voice = (id: string, text: string) => ({ type: "chat", id, text, source: "stt" });
  const stored = (s: ReturnType<typeof setup>) =>
    [...s.storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as Record<string, unknown>);

  it("a page's voice line carries source stt; a typed one none", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "hello world"));
    await s.msg(owner, { type: "chat", id: "t1", text: "typed", source: "keyboard" });
    expect(chats(c).map((m) => (m as { source?: string }).source)).toEqual(["stt", undefined]);
  });

  it("polishes the owner's latest stt line: raw kept, edited marked, stored, broadcast", async () => {
    const s = setup();
    const owner = s.page();
    const mac = s.page("/list Macintosh");
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "fix the sink button"));
    s.tick(5);
    await s.msg(c, { type: "edit", id: "v1", text: "Fix the sync button." });
    const ev = {
      type: "edited",
      id: "v1",
      thread: "owner",
      text: "Fix the sync button.",
      raw: "fix the sink button",
      edited: { at: 1_000_005, by: "main lane", count: 1 },
    };
    expect(owner.last("edited")).toEqual(ev);
    expect(mac.last("edited")).toEqual(ev);
    expect(c.last("edited")).toEqual(ev);
    expect(stored(s)[0]).toMatchObject({
      id: "v1",
      text: "Fix the sync button.",
      raw: "fix the sink button",
      source: "stt",
      edited: { by: "main lane", count: 1 },
    });
    // A page connecting later gets the polished line in its history.
    const hist0 = await s.hub.history();
    expect(hist0[0]).toMatchObject({ text: "Fix the sync button.", raw: "fix the sink button" });
    const late = s.page();
    await new Promise((r) => setTimeout(r, 0));
    const hist = (late.last("history") as { messages: Record<string, unknown>[] }).messages;
    expect(hist[0]).toMatchObject({ text: "Fix the sync button.", raw: "fix the sink button" });
    // Nothing new was posted as a chat line.
    expect(chats(owner)).toHaveLength(1);
  });

  it("keeps the first raw across edits, and stops after MAX_EDITS", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "raw one"));
    for (const t of ["two", "three", "four"]) await s.msg(c, { type: "edit", id: "v1", text: t });
    expect(owner.last("edited")).toMatchObject({ text: "four", raw: "raw one" });
    expect((owner.last("edited") as { edited: { count: number } }).edited.count).toBe(MAX_EDITS);
    await s.msg(c, { type: "edit", id: "v1", text: "five" });
    expect(c.last("error")?.error).toContain(`already polished ${MAX_EDITS} times`);
    expect(stored(s)[0]).toMatchObject({ text: "four", raw: "raw one" });
  });

  it("refuses a typed line", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, { type: "chat", id: "t1", text: "typed" });
    await s.msg(c, { type: "edit", id: "t1", text: "Typed." });
    expect(c.last("error")?.error).toContain("typed, not spoken");
    expect(owner.last("edited")).toBeUndefined();
  });

  it("refuses any but the owner's latest line; agent replies after it do not count", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "first"));
    await s.msg(owner, voice("v2", "second"));
    await s.msg(c, { type: "say", text: "on it" });
    await s.msg(c, { type: "edit", id: "v1", text: "First." });
    expect(c.last("error")?.error).toContain("not the owner's latest");
    await s.msg(c, { type: "edit", id: "v2", text: "Second." });
    expect(owner.last("edited")).toMatchObject({ id: "v2", text: "Second." });
    // The agent's own line is never the target.
    const said = c.last("said")?.id as string;
    await s.msg(c, { type: "edit", id: said, text: "x" });
    expect(c.last("error")?.error).toContain("not the owner's latest");
  });

  it("refuses an unknown id, an unchanged text, and empty or missing fields", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "same"));
    await s.msg(c, { type: "edit", id: "nope", text: "x" });
    expect(c.last("error")?.error).toContain("no message nope");
    await s.msg(c, { type: "edit", id: "v1", text: "same" });
    expect(c.last("error")?.error).toContain("already reads that way");
    await s.msg(c, { type: "edit", id: "v1", text: "  " });
    expect(c.last("error")?.error).toContain("edit needs text");
    await s.msg(c, { type: "edit", text: "x" });
    expect(c.last("error")?.error).toContain("edit needs the id");
    expect(owner.last("edited")).toBeUndefined();
  });

  it("a friend's lines and thread can never be edited, voice or not", async () => {
    const s = setup();
    const owner = s.page();
    const { c, token } = await agent(s, owner);
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(f, voice("fv", "friend voice"));
    expect((chats(c).at(-1) as { source?: string }).source).toBeUndefined();
    await s.msg(c, { type: "edit", id: "fv", text: "Friend voice." });
    expect(c.last("error")?.error).toContain("friends' lines can never be edited");
    // A preview pairing made for the friend cannot edit either.
    const preview = await s.forFriend(token, "f1@x.com");
    await s.msg(f, { type: "allow", pair: s.pairOf(f) });
    await s.msg(preview, { type: "edit", id: "fv", text: "x" });
    expect(preview.last("error")?.error).toBe("a pairing for a friend cannot edit");
    expect(f.last("edited")).toBeUndefined();
  });

  it("needs an approved controller holding a live owner grant", async () => {
    const s = setup();
    const owner = s.page();
    const { c, token } = await agent(s, owner);
    await s.msg(owner, voice("v1", "hello"));
    const stranger = s.controller("stranger");
    await s.msg(stranger, { type: "edit", id: "v1", text: "Hello." });
    expect(stranger.last("error")?.error).toBe("not approved yet");
    // The grant gone from storage (ended elsewhere): this socket may not edit.
    s.storage.store.delete(`grant:${await hashToken(token)}`);
    await s.msg(c, { type: "edit", id: "v1", text: "Hello." });
    expect(c.last("error")?.error).toBe("edit needs a live chat grant from the owner");
    expect(owner.last("edited")).toBeUndefined();
  });

  it("an eval grant may edit too (eval implies chat); an expired one may not", async () => {
    const s = setup();
    const owner = s.page();
    const c = s.controller("eval lane");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner) });
    await s.msg(owner, voice("v1", "hello"));
    await s.msg(c, { type: "edit", id: "v1", text: "Hello." });
    expect(owner.last("edited")).toMatchObject({ text: "Hello." });
    s.tick(EVAL_GRANT_MS + 1);
    await s.msg(owner, voice("v2", "later"));
    await s.msg(c, { type: "edit", id: "v2", text: "Later." });
    expect(c.last("expired")).toBeTruthy();
    expect(owner.last("edited")).toMatchObject({ id: "v1" });
  });

  it("names the agent by its assignee when it has one", async () => {
    const s = setup();
    const owner = s.page();
    const ws = new FakeSocket();
    s.sockets.push(ws);
    void s.hub.connectController(
      ws,
      new URL("https://lianki.com/api/version/debug/control?label=lane&scope=chat&agent=chat-lane"),
    );
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    await s.msg(owner, voice("v1", "hi"));
    await s.msg(ws, { type: "edit", id: "v1", text: "Hi." });
    expect((owner.last("edited") as { edited: { by: string } }).edited.by).toBe("chat-lane");
  });
});
