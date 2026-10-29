import { describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage, hashToken } from "@/workers/push/src/debug";
import push, { type Env, VersionHub } from "@/workers/push/src/index";
import { isOwnerSocket } from "@/workers/push/src/auth";
import { APPROVAL_MS, CHAT_HISTORY, CHAT_MS, PENDING_MS } from "@/lib/dev-eval";

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
): Storage & { store: Map<string, unknown> } {
  return {
    store,
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
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const pairOf = (p: FakeSocket) =>
    (p.last("state") as { pending: { pair: string } | null }).pending?.pair ?? "";
  return {
    hub,
    page,
    controller,
    resume,
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

  it("after Allow, code reaches the pages and results come back", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    msg(p, { type: "allow", pair });
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

  it("only pages whose label contains the target get the code", () => {
    const { page, controller, msg, pairOf } = setup();
    const phone = page("/words pwa iPhone");
    const mac = page("/list Macintosh");
    const c = controller();
    msg(phone, { type: "allow", pair: pairOf(phone) });
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

  it("End revokes an approved session", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    msg(p, { type: "allow", pair });
    msg(p, { type: "revoke", pair });
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

  it("approval runs out after an hour", () => {
    const { page, controller, msg, pairOf, tick } = setup();
    const p = page();
    const c = controller();
    msg(p, { type: "allow", pair: pairOf(p) });
    tick(APPROVAL_MS + 1);
    msg(c, { type: "eval", code: "1" });
    expect(c.closed).toBe(4408);
    expect(p.last("eval")).toBeUndefined();
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

type Chat = { message: { id: string; from: string; label: string; text: string; at: number } };
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
        { id: "m1", from: "owner", label: "/words pwa iPhone", text: "hello agent", at: 1_000_000 },
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

  it("Allow for 1 hour grants eval and chat, with no token", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller();
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    expect(c.last("approved")).toMatchObject({ scope: "eval" });
    expect(c.last("approved")?.token).toBeUndefined();
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
            ? Response.json({ owner: true })
            : new Response("no", { status: whoami });
        },
      },
    };
  };

  it("a page socket without the owner's session is refused", async () => {
    const own = { origin: "https://lianki.com", cookie: "s=1" };
    expect((await push.fetch(upgrade("/api/version/debug", own), env(404))).status).toBe(403);
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

  it("the owner's cookie is checked by the main Worker", async () => {
    const calls: string[] = [];
    const req = upgrade("/api/version/debug", { origin: "https://lianki.com", cookie: "s=1" });
    expect(await isOwnerSocket(req, env(200, calls).MAIN)).toBe(true);
    expect(calls).toEqual(["https://lianki.com/api/dev/whoami s=1"]);
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
    const res = await hub.fetch(new Request("https://lianki.com/api/version/debug?label=p"));
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
        owner ? Response.json({ owner: true }) : new Response("", { status: 404 }),
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
    expect(await go("https://lianki.com/api/version/stream", {})).toContain("lianki-push");
    expect(await go("https://lianki.com/elsewhere", {})).toStartWith("404");
  });

  it("an owner check that fails to answer refuses the socket", async () => {
    const req = new Request("https://lianki.com/api/version/debug", {
      headers: { origin: "https://lianki.com", cookie: "s=1" },
    });
    expect(await isOwnerSocket(req, { fetch: () => Promise.reject(new Error("down")) })).toBe(
      false,
    );
    expect(await isOwnerSocket(req, undefined)).toBe(false);
  });
});
