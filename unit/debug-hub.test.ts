import { describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage, hashToken } from "@/workers/push/src/debug";
import { rpcStub } from "./support/rpc-stub";
import push, { type Env, KEEP_FINGERPRINTS, VersionHub } from "@/workers/push/src/index";
import { FINGERPRINTS_HEADER } from "@/lib/smart-refresh";
import { DEV_BRIDGE_HEADER, debugIdentity } from "@/workers/push/src/auth";
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
  EDITABLE_LINES,
  applyEditTo,
} from "@/lib/dev-eval";
import { MERGE_RATIO, MERGE_SLACK } from "@/packages/debug-chat/src/polish";

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

/** SESSIONS behaves like a real service-binding stub (unit/support/rpc-stub.ts). */
function withRpc(env: unknown) {
  const e = env as { SESSIONS?: object } | undefined;
  return e?.SESSIONS ? { ...e, SESSIONS: rpcStub(e.SESSIONS) } : env;
}

function setup(env?: unknown, storage = fakeStorage()) {
  const sockets: FakeSocket[] = [];
  let t = 1_000_000;
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    withRpc(env),
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
    quiet?: true;
    loud?: true;
    ownerGrant?: true;
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

  it("HTML's trust stamp: only the hub's, only on an approved pairing's say in the owner's thread", async () => {
    const s = setup();
    const owner = s.page();
    const c = s.controller("main lane");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner) });
    await s.msg(c, { type: "say", text: "stamped" });
    expect(chats(owner).at(-1)).toMatchObject({ from: "agent", thread: "owner", ownerGrant: true });
    // Kept with the line: the same after a reload.
    expect((await s.hub.history()).at(-1)?.ownerGrant).toBe(true);

    // The owner's own typing, even asking for it.
    await s.msg(owner, { type: "chat", id: "o1", text: "<b>mine</b>", ownerGrant: true });
    const mine = chats(owner).at(-1)!;
    expect(mine).toMatchObject({ from: "owner", text: "<b>mine</b>" });
    expect(mine.ownerGrant).toBeUndefined();

    // A friend, asking for it and naming the owner's thread: their own thread, no stamp.
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(f, {
      type: "chat",
      id: "f1",
      text: "<script>x</script>",
      ownerGrant: true,
      thread: "owner",
      from: "agent",
      label: "main lane",
    });
    const said = chats(f).at(-1)!;
    expect(said).toMatchObject({ from: "friend", thread: "f1" });
    expect(said.ownerGrant).toBeUndefined();
    expect(chats(owner).some((m) => m.text === "<script>x</script>")).toBe(false);

    // His agent answering in a friend's thread: not the owner's thread, so no stamp.
    await s.msg(c, { type: "say", text: "<b>to you</b>", to: "f1" });
    const reply = chats(f).at(-1)!;
    expect(reply).toMatchObject({ from: "agent", thread: "f1", text: "<b>to you</b>" });
    expect(reply.ownerGrant).toBeUndefined();

    // A say can't ask for it either way: the hub decides, not the message.
    await s.msg(c, { type: "say", text: "again", to: "f1", ownerGrant: true });
    expect(chats(f).at(-1)?.ownerGrant).toBeUndefined();
    // An ask is no plain say: its question has no HTML to carry.
    expect((await s.hub.history("f1")).every((m) => m.ownerGrant === undefined)).toBe(true);
  });

  it("an unapproved controller can't say at all, so can't be stamped", async () => {
    const { page, controller, msg } = setup();
    const p = page();
    const c = controller("stranger");
    await msg(c, { type: "say", text: "<b>hi</b>" });
    expect(chats(p).some((m) => m.text === "<b>hi</b>")).toBe(false);
  });

  it("say --quiet: the hub keeps the flag (true only) and forwards it, live and in history; an old loud is dropped", async () => {
    const { hub, page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller("main lane");
    await msg(p, { type: "allow", pair: pairOf(p) });
    await msg(c, { type: "say", text: "deployed", quiet: true });
    await msg(c, { type: "say", text: "approve?", loud: true });
    await msg(c, { type: "say", text: "plain" });
    // Not booleans: dropped. loud means nothing now: dropped, quiet kept.
    await msg(c, { type: "say", text: "junk", quiet: "yes", loud: 1 });
    await msg(c, { type: "say", text: "both", quiet: true, loud: true });
    const lines = chats(p).slice(-5);
    expect(lines.map((m) => [m.text, m.quiet, m.loud])).toEqual([
      ["deployed", true, undefined],
      ["approve?", undefined, undefined],
      ["plain", undefined, undefined],
      ["junk", undefined, undefined],
      ["both", true, undefined],
    ]);
    for (const m of lines) expect(m).not.toHaveProperty("loud");
    for (const m of lines.slice(1, 4)) expect(m).not.toHaveProperty("quiet");
    const again = page();
    await hub.history();
    const h = again.last("history") as { messages: Record<string, unknown>[] };
    expect(h.messages.find((m) => m.text === "deployed")).toMatchObject({ quiet: true });
    expect(h.messages.find((m) => m.text === "approve?")).not.toHaveProperty("loud");
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

  it("the session tag and expiry pass through only when well-formed", async () => {
    const answer = (body: unknown) => ({
      fetch: async () => Response.json(body),
    });
    const req = upgrade("/api/version/debug", { origin: "https://lianki.com", cookie: "s=1" });
    const base = { userId: "u1", email: "o@x", owner: true };
    expect(
      await debugIdentity(req, answer({ ...base, session: "a".repeat(64), sessionUntil: 5 })),
    ).toEqual({ ...base, session: "a".repeat(64), sessionUntil: 5 });
    expect(
      await debugIdentity(req, answer({ ...base, session: "raw-session-id", sessionUntil: "x" })),
    ).toEqual(base);
  });

  it("the session headers reach the hub from index.ts, and a page's own are dropped", async () => {
    const seen: Headers[] = [];
    const e = {
      HUB: { idFromName: () => "v", get: () => ({ fetch: async () => new Response("v") }) },
      DEBUG: {
        idFromName: () => "d",
        get: () => ({
          fetch: async (r: Request) => {
            seen.push(r.headers);
            return new Response("d");
          },
        }),
      },
      MAIN: {
        fetch: async () =>
          Response.json({
            userId: "u1",
            email: "o@x",
            owner: true,
            session: "a".repeat(64),
            sessionUntil: 77,
          }),
      },
    } as unknown as Env;
    await push.fetch(
      upgrade("/api/version/debug", {
        origin: "https://lianki.com",
        cookie: "s=1",
        "x-debug-session": "f".repeat(64),
      }),
      e,
    );
    expect(seen[0].get("x-debug-session")).toBe("a".repeat(64));
    expect(seen[0].get("x-debug-session-until")).toBe("77");
    // A sender cannot claim a session either.
    await push.fetch(
      upgrade("/api/version/debug/control", { "x-debug-session": "f".repeat(64) }),
      e,
    );
    expect(seen[1].get("x-debug-session")).toBeNull();
  });

  it("the dev bridge header goes to the main Worker in place of a cookie", async () => {
    const seen: Headers[] = [];
    const main = {
      fetch: async (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return Response.json({ userId: "u1", email: "o@x", owner: true });
      },
    };
    const req = upgrade("/api/version/debug", {
      origin: "https://lianki.com",
      [DEV_BRIDGE_HEADER]: "b".repeat(64),
    });
    expect(await debugIdentity(req, main)).toEqual({ userId: "u1", email: "o@x", owner: true });
    expect(seen[0].get(DEV_BRIDGE_HEADER)).toBe("b".repeat(64));
    expect(seen[0].get("cookie")).toBeNull();
    // still only from lianki.com
    const evil = upgrade("/api/version/debug", {
      origin: "https://evil.example",
      [DEV_BRIDGE_HEADER]: "b".repeat(64),
    });
    expect(await debugIdentity(evil, main)).toBeNull();
  });

  it("a refused bridge is refused, with no owner fallback", async () => {
    const calls: string[] = [];
    const req = upgrade("/api/version/debug", {
      origin: "https://lianki.com",
      [DEV_BRIDGE_HEADER]: "wrong",
    });
    expect(await debugIdentity(req, env(401, calls).MAIN)).toBeNull();
    expect(await debugIdentity(req, env(404, calls).MAIN)).toBeNull();
    expect(calls.length).toBe(2); // identity only, never /api/dev/whoami
  });

  it("the hub never sees the bridge header", async () => {
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
    };
    await push.fetch(
      upgrade("/api/version/debug", {
        origin: "https://lianki.com",
        [DEV_BRIDGE_HEADER]: "x".repeat(64),
      }),
      e,
    );
    expect(seen[0].get(DEV_BRIDGE_HEADER)).toBeNull();
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
          delete: async (k: string) => store.delete(k),
        },
      },
      {} as Env,
    );
    const publish = (b: string, headers: Record<string, string> = {}) =>
      hub.fetch(
        new Request("https://lianki-push/internal/publish", { method: "POST", body: b, headers }),
      );
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

  // Smart refresh (lib/smart-refresh.ts): each page hears what changed since its own build.
  const fpOf = (build: string, words: string, force = false) => ({
    build,
    shell: "s",
    routes: { "/words": words, "/list": "l" },
    ...(force ? { force: true } : {}),
  });
  /** As the main Worker publishes (lib/announce-build.ts): the bare id, fingerprints in a header. */
  const announce = (
    publish: (b: string, h: Record<string, string>) => Promise<Response>,
    b: string,
    words: string,
    force = false,
    fpBuild = b,
  ) =>
    publish(b, {
      [FINGERPRINTS_HEADER]: encodeURIComponent(JSON.stringify(fpOf(fpBuild, words, force))),
    });

  it("tells each page what changed since its own build", async () => {
    const { hub, sockets, publish } = make();
    await announce(publish, "b1", "w1");
    await hub.fetch(new Request("https://lianki.com/api/version/ws?b=b1"));
    await hub.fetch(new Request("https://lianki.com/api/version/ws")); // a page from before
    expect(sockets[0].sent).toEqual([
      { build: "b1", shell: false, routes: { "/words": 0, "/list": 0 } },
    ]);
    expect(sockets[1].sent).toEqual([{ build: "b1" }]);
    // b2 changes /words only.
    expect(await (await announce(publish, "b2", "w2")).json()).toEqual({ build: "b2", pushed: 2 });
    expect(sockets[0].sent[1]).toEqual({
      build: "b2",
      shell: false,
      routes: { "/words": 1, "/list": 0 },
    });
    expect(sockets[1].sent[1]).toEqual({ build: "b2" });
    // A forced deploy says so to every page.
    await announce(publish, "b3", "w2", true);
    expect(sockets[0].sent[2]).toMatchObject({ build: "b3", force: true });
    expect(sockets[1].sent[2]).toEqual({ build: "b3", force: true });
    // Fingerprints naming another build than announced are ignored.
    await announce(publish, "b4", "w9", false, "bX");
    expect(sockets[0].sent[3]).toEqual({ build: "b4" });
    // A malformed header: the build alone.
    await publish("b5", { [FINGERPRINTS_HEADER]: "%E0%A4%A" });
    expect(sockets[0].sent[4]).toEqual({ build: "b5" });
  });

  it("keeps fingerprints for the last builds only", async () => {
    const { hub, publish } = make();
    const store = (hub as unknown as { ctx: { storage: { get(k: string): Promise<unknown> } } }).ctx
      .storage;
    for (let i = 0; i < KEEP_FINGERPRINTS + 2; i++) await announce(publish, `b${i}`, `w${i}`);
    await announce(publish, "b5", "w5"); // a repeat is kept once
    expect(await store.get("fp:b0")).toBeUndefined();
    expect(await store.get("fp:b1")).toBeUndefined();
    expect(await store.get("fp:b2")).toBeDefined();
    expect(((await store.get("fp-order")) as string[]).length).toBe(KEEP_FINGERPRINTS);
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
    expect(await go("https://lianki-push/internal/signed-out", { method: "POST" })).toBe(
      "200 debug",
    );
    expect(await go("https://lianki.com/internal/signed-out", { method: "POST" })).toStartWith(
      "404",
    );
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

describe("DebugHub wake (the mic's wake-word mode, docs/wake-word.md)", () => {
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return c;
  };
  const wakes = (ws: FakeSocket) => ws.sent.filter((m) => m.type === "wake");

  it("goes to the owner's pages, unstored, and is acknowledged", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    const f = await s.friend("f1", "f1@x.com");
    const keys = s.storage.store.size;
    await s.msg(c, { type: "wake", mode: "passive" });
    expect(wakes(owner)).toEqual([{ type: "wake", mode: "passive", at: 1_000_000 }]);
    expect(wakes(f)).toEqual([]);
    expect(c.last("woke")).toEqual({
      type: "woke",
      thread: "owner",
      mode: "passive",
      delivered: 1,
      at: 1_000_000,
    });
    expect(s.storage.store.size).toBe(keys);
  });

  it("refuses an unknown mode and a friend's pairing", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    await s.msg(c, { type: "wake", mode: "asleep" });
    expect(c.last("error")?.error).toBe('wake needs mode "active", "passive" or "ignored"');
    expect(wakes(owner)).toEqual([]);
  });

  it("an owner line keeps the mode it was sent in; anything else is dropped", async () => {
    const s = setup();
    const owner = s.page();
    await agent(s, owner);
    await s.msg(owner, {
      type: "chat",
      id: "w1",
      text: "next word",
      source: "stt",
      wake: "passive",
      wakeReason: "rejects",
    });
    await s.msg(owner, {
      type: "chat",
      id: "w2",
      text: "typed",
      wake: "sleepy",
      wakeReason: "rejects",
    });
    await s.msg(owner, {
      type: "chat",
      id: "w3",
      text: "woken",
      wake: "active",
      wakeReason: "made-up",
    });
    const stored = [...s.storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as Record<string, unknown>)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(stored.map((m) => m.wake)).toEqual(["passive", undefined, "active"]);
    // The reason rides only with a mode, and only a known one.
    expect(stored.map((m) => m.wakeReason)).toEqual(["rejects", undefined, undefined]);
  });

  it("a voice line keeps its recognizer tag (stt) and forwards it; typed or malformed ones drop it", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    const local = { route: "local", engine: "sensevoice-small-2024-07-17-int8" };
    await s.msg(owner, { type: "chat", id: "t1", text: "hello", source: "stt", stt: local });
    expect(c.last("chat")?.message).toMatchObject({ id: "t1", stt: local });
    const cloud = { route: "cloud", engine: "@cf/openai/whisper-large-v3-turbo", fallback: true };
    await s.msg(owner, { type: "chat", id: "t2", text: "again", source: "stt", stt: cloud });
    await s.msg(owner, { type: "chat", id: "t3", text: "typed", stt: local });
    await s.msg(owner, {
      type: "chat",
      id: "t4",
      text: "odd",
      source: "stt",
      stt: { route: "mars" },
    });
    const stored = [...s.storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as Record<string, unknown>)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(stored.map((m) => m.stt)).toEqual([local, cloud, undefined, undefined]);
  });

  it("a voice line keeps only a speaker tag the Mac signed over exactly its words", async () => {
    const mac = await speakerKey();
    const s = setup({ STT_SPEAKER_PUB: mac.pub });
    const owner = s.page();
    await agent(s, owner);
    const tag = {
      decision: "me",
      score: 0.47,
      model: "campp",
      device: "iphone",
      speechS: 2.4,
      snrDb: 21,
    };
    const at = 1_000_000;
    const sign = (text: string, uid: string, o: Record<string, unknown> = {}) =>
      mac.sign({ ...tag, text, uid: uid.padEnd(16, "x"), thread: "owner", at, ...o });
    const say = (id: string, text: string, speakerProof: string[]) =>
      s.msg(owner, { type: "chat", id, text, source: "stt", speakerProof });
    const good = await sign("Next  word", "u1");
    // Signed, fresh, this thread, the line's words (NFKC, spaces, final punctuation only): kept.
    await say("s1", "Next word。", [good]);
    // Two utterances, in order, joined by the page: kept.
    await say("s2", "你好。 下一个!", [await sign("你好", "u2"), await sign("下一个!", "u3")]);
    // The same proof again (replayed onto another line): dropped.
    await say("s3", "Next word", [good]);
    // A page's own tag, no proof: dropped.
    await s.msg(owner, { type: "chat", id: "s4", text: "hi there", source: "stt", speaker: tag });
    // A signed word dropped (the negation): dropped.
    await say("s5", "delete all my cards", [await sign("do not delete all my cards", "u5")]);
    // A word added, or replaced: dropped.
    await say("s6", "next word now", [await sign("next word", "u6")]);
    await say("s7", "next bird", [await sign("next word", "u7")]);
    // The utterances out of order: dropped.
    await say("s8", "下一个 你好", [await sign("你好", "u8"), await sign("下一个", "u9")]);
    // Another key, another thread, stale: dropped.
    const forger = await speakerKey();
    await say("s9", "next word", [
      await forger.sign({
        ...tag,
        text: "next word",
        uid: "u10".padEnd(16, "x"),
        thread: "owner",
        at,
      }),
    ]);
    await say("s10", "next word", [await sign("next word", "u11", { thread: "friend-1" })]);
    await say("s11", "next word", [await sign("next word", "u12", { at: at - 11 * 60_000 })]);
    const stored = [...s.storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as Record<string, unknown>);
    expect(stored.map((m) => !!m.speaker)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    // The signed words ride on the stored tag (an approval must use them, not the line).
    expect(stored[0]!.speaker).toEqual({ ...tag, signed: ["Next  word"] });
    // Burned durably: a new hub on the same storage (a restart, a deploy) refuses it too.
    const again = setup({ STT_SPEAKER_PUB: mac.pub }, s.storage);
    const p2 = again.page();
    await agent(again, p2);
    await again.msg(p2, {
      type: "chat",
      id: "r1",
      text: "Next word",
      source: "stt",
      speakerProof: [good],
    });
    const r1 = [...again.storage.store.values()].find((v) => (v as { id?: string }).id === "r1") as
      | Record<string, unknown>
      | undefined;
    expect(r1?.speaker).toBeUndefined();
    expect([...s.storage.store.keys()].filter((k) => k.startsWith("proof:")).length).toBe(3);
  });

  it("without STT_SPEAKER_PUB no tag is ever kept", async () => {
    const mac = await speakerKey();
    const s = setup();
    const owner = s.page();
    await agent(s, owner);
    const p = await mac.sign({
      decision: "me",
      score: 0.5,
      text: "next word",
      uid: "u1".padEnd(16, "x"),
      thread: "owner",
      at: 1_000_000,
    });
    await s.msg(owner, {
      type: "chat",
      id: "s1",
      text: "next word",
      source: "stt",
      speakerProof: [p],
    });
    const stored = [...s.storage.store.values()].filter(
      (v) => (v as { id?: string }).id === "s1",
    ) as Record<string, unknown>[];
    expect(stored[0]?.speaker).toBeUndefined();
  });
});

/** A stand-in for the Mac's attestation key (voiceprint.py Attestor), same wire form. */
async function speakerKey() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const b64 = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const pub = b64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return {
    pub,
    async sign(payload: Record<string, unknown>) {
      const body = b64(new TextEncoder().encode(JSON.stringify({ v: 1, ...payload })));
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          kp.privateKey,
          new TextEncoder().encode(body),
        ),
      );
      return `${body}.${b64(sig)}`;
    },
  };
}

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
  const voice = (id: string, text: string, scene?: Record<string, string>) => ({
    type: "chat",
    id,
    text,
    source: "stt",
    ...(scene ? { scene } : {}),
  });
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
    await s.msg(
      owner,
      voice("v1", "fix the sink button", { path: "/words", title: "Sync button" }),
    );
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
    for (const t of ["Raw one.", "Raw, one.", "Raw one!"])
      await s.msg(c, { type: "edit", id: "v1", text: t });
    expect(owner.last("edited")).toMatchObject({ text: "Raw one!", raw: "raw one" });
    expect((owner.last("edited") as { edited: { count: number } }).edited.count).toBe(MAX_EDITS);
    await s.msg(c, { type: "edit", id: "v1", text: "Raw one?" });
    expect(c.last("error")?.error).toContain(`already polished ${MAX_EDITS} times`);
    expect(stored(s)[0]).toMatchObject({ text: "Raw one!", raw: "raw one" });
  });

  it("keeps a voice line's scene, and lets the polish draw on it and on the thread", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, { type: "chat", id: "t0", text: "我们在讲流式识别" });
    await s.msg(owner, voice("v1", "现在是流失传输吗", { path: "/words", screen: "传输" }));
    expect(stored(s)[1]).toMatchObject({ scene: { path: "/words", screen: "传输" } });
    expect(chats(c).at(-1)).toMatchObject({ scene: { path: "/words", screen: "传输" } });
    await s.msg(c, { type: "edit", id: "v1", text: "现在是流式传输吗？" });
    expect(owner.last("edited")).toMatchObject({
      text: "现在是流式传输吗？",
      raw: "现在是流失传输吗",
    });
  });

  it("refuses a polish the context does not support: the raw line stands", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "fix the sink button", { path: "/words" }));
    for (const text of [
      "Fix the sync button.", // "sync" is nowhere in the context
      "Fix the sink button and deploy.", // adds words
      "Fix the button.", // drops a word
    ]) {
      await s.msg(c, { type: "edit", id: "v1", text });
      expect(c.last("error")?.error).toContain("the raw line stands");
    }
    expect(owner.last("edited")).toBeUndefined();
    expect(stored(s)[0]).toMatchObject({ text: "fix the sink button" });
  });

  it("refuses every polish while the owner's stt.polish flag is exactly false", async () => {
    const asked: string[] = [];
    let on: unknown = false;
    const SESSIONS = {
      live: async () => "live",
      flag: async (k: string) => (k === "stt.polish" ? (asked.push(k), on) : false),
    };
    const s = setup({ SESSIONS });
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "hello world"));
    await s.msg(c, { type: "edit", id: "v1", text: "Hello, world." });
    expect(c.last("error")?.error).toContain("polish is off (stt.polish");
    expect(asked).toEqual(["stt.polish"]);
    expect(owner.last("edited")).toBeUndefined();
    on = true;
    await s.msg(c, { type: "edit", id: "v1", text: "Hello, world." });
    expect(owner.last("edited")).toMatchObject({ text: "Hello, world.", raw: "hello world" });
  });

  it("an unsure flag answer (busy, an error) keeps the raw line; no flag() polishes as before", async () => {
    for (const flag of [async () => "busy", async () => Promise.reject(new Error("d1"))]) {
      const s = setup({ SESSIONS: { live: async () => "live", flag } });
      const owner = s.page();
      const { c } = await agent(s, owner);
      await s.msg(owner, voice("v1", "hello world"));
      await s.msg(c, { type: "edit", id: "v1", text: "Hello, world." });
      expect(c.last("error")?.error).toContain("polish is off");
    }
    const s = setup({ SESSIONS: { live: async () => "live" } });
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "hello world"));
    await s.msg(c, { type: "edit", id: "v1", text: "Hello, world." });
    expect(owner.last("edited")).toMatchObject({ text: "Hello, world." });
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

  it("edits any of the owner's last EDITABLE_LINES lines; agent replies do not count; older ones are refused", async () => {
    expect(EDITABLE_LINES).toBe(5);
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    for (let i = 1; i <= 6; i++) {
      await s.msg(owner, voice(`v${i}`, `line ${i}`));
      await s.msg(c, { type: "say", text: `reply ${i}` });
    }
    await s.msg(c, { type: "edit", id: "v1", text: "Line 1." });
    expect(c.last("error")?.error).toContain("not among the owner's last 5 lines");
    await s.msg(c, { type: "edit", id: "v2", text: "Line 2." });
    expect(owner.last("edited")).toMatchObject({ id: "v2", text: "Line 2." });
    await s.msg(c, { type: "edit", id: "v6", text: "Line 6." });
    expect(owner.last("edited")).toMatchObject({ id: "v6", text: "Line 6." });
    // The agent's own line is never the target.
    const said = c.last("said")?.id as string;
    await s.msg(c, { type: "edit", id: said, text: "x" });
    expect(c.last("error")?.error).toContain("not among the owner's last");
  });

  it("an earlier line's polish draws on lines after it, the agent's replies included", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, voice("v1", "turn the fl on"));
    await s.msg(c, { type: "say", text: "Which flag do you mean?" });
    await s.msg(owner, voice("v2", "the polish one"));
    await s.msg(c, { type: "edit", id: "v1", text: "Turn the flag on." });
    expect(owner.last("edited")).toMatchObject({
      id: "v1",
      text: "Turn the flag on.",
      raw: "turn the fl on",
    });
    // A function word in a clause, no context needed.
    await s.msg(owner, voice("v3", "我在房间看书"));
    await s.msg(c, { type: "edit", id: "v3", text: "我在房间里看书。" });
    expect(owner.last("edited")).toMatchObject({ id: "v3", text: "我在房间里看书。" });
  });

  it("logs a refused polish with its reason", async () => {
    const logs: string[] = [];
    const real = console.log;
    console.log = (x: string) => void logs.push(String(x));
    try {
      const s = setup();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await s.msg(owner, voice("v1", "fix the sink button"));
      await s.msg(c, { type: "edit", id: "v1", text: "Fix the sync button." });
    } finally {
      console.log = real;
    }
    expect(
      logs.some((l) => l.includes("debug.polish-refused") && l.includes("not in the context")),
    ).toBe(true);
  });

  describe("summaries of room talk", () => {
    const ROOM = ["那个房子一个月多少钱啊我觉得太贵了", "对啊而且离地铁站还挺远的你说呢"];
    const withLog = () => {
      const reqs: { op: string; lines: Record<string, unknown>[] }[] = [];
      const SESSIONS = {
        live: async () => "live",
        chatLog: async (r: { op: string; lines: Record<string, unknown>[] }) => {
          reqs.push(structuredClone(r));
          return { ok: true, written: r.lines.length };
        },
      };
      return { reqs, s: setup({ SESSIONS }) };
    };

    it("collapses consecutive voice lines into one: kept, raw recoverable, history keeps all", async () => {
      const { reqs, s } = withLog();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await s.msg(owner, voice("r1", ROOM[0]!));
      await s.msg(owner, voice("r2", ROOM[1]!));
      reqs.length = 0;
      await s.msg(c, { type: "summary", ids: ["r2", "r1"], text: "（旁人在聊租房，嫌贵）" });
      const ev = owner.last("edited") as Record<string, unknown>;
      expect(ev).toMatchObject({
        id: "r1",
        text: "（旁人在聊租房，嫌贵）",
        raw: `${ROOM[0]}\n${ROOM[1]}`,
        summary: { by: "main lane", ids: ["r1", "r2"] },
      });
      expect(c.last("edited")).toMatchObject({ id: "r1", summary: { ids: ["r1", "r2"] } });
      // Both lines stay stored; the second is marked inside the summary.
      expect(stored(s)).toEqual([
        expect.objectContaining({
          id: "r1",
          text: "（旁人在聊租房，嫌贵）",
          raw: `${ROOM[0]}\n${ROOM[1]}`,
        }),
        expect.objectContaining({ id: "r2", text: ROOM[1], collapsedInto: "r1" }),
      ]);
      // History: the summary is added as its own line; nothing is updated or dropped.
      expect(reqs).toEqual([
        {
          op: "put",
          thread: "owner",
          lines: [
            expect.objectContaining({
              id: "r1.summary",
              from: "owner",
              text: "（旁人在聊租房，嫌贵）",
            }),
          ],
        } as never,
      ]);
    });

    it("takes his last N lines with last", async () => {
      const s = setup();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await s.msg(owner, voice("r1", ROOM[0]!));
      await s.msg(owner, voice("r2", ROOM[1]!));
      await s.msg(c, { type: "summary", last: 2, text: "（旁人在聊租房，嫌贵）" });
      expect(owner.last("edited")).toMatchObject({ id: "r1", summary: { ids: ["r1", "r2"] } });
    });

    it("refuses a typed line, a run someone spoke into, one past the last N, and a bare marker", async () => {
      const s = setup();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await s.msg(owner, { type: "chat", id: "t1", text: ROOM[0]! });
      await s.msg(c, { type: "summary", ids: ["t1"], text: "（旁人在聊租房）" });
      expect(c.last("error")?.error).toContain("typed, not spoken");
      await s.msg(owner, voice("r1", ROOM[0]!));
      await s.msg(c, { type: "say", text: "嗯？" });
      await s.msg(owner, voice("r2", ROOM[1]!));
      await s.msg(c, { type: "summary", ids: ["r1", "r2"], text: "（旁人在聊租房，嫌贵）" });
      expect(c.last("error")?.error).toContain("not consecutive");
      await s.msg(c, { type: "summary", ids: ["r2"], text: "（杂音）" });
      expect(c.last("error")?.error).toContain("not summarised");
      for (let i = 0; i < 5; i++) await s.msg(owner, voice(`x${i}`, `line ${i}`));
      await s.msg(c, { type: "summary", ids: ["r2"], text: "（旁人在聊）" });
      expect(c.last("error")?.error).toContain("not among the owner's last 5 lines");
      expect(owner.last("edited")).toBeUndefined();
    });

    it("a summary line is not polished again; the polish flag off refuses summaries too", async () => {
      const s = setup({
        SESSIONS: { live: async () => "live", flag: async (k: string) => k !== "stt.polish" },
      });
      const owner = s.page();
      const { c } = await agent(s, owner);
      await s.msg(owner, voice("r1", ROOM[0]!));
      await s.msg(c, { type: "summary", ids: ["r1"], text: "（问房租）" });
      expect(c.last("error")?.error).toContain("polish is off");
      const s2 = setup();
      const o2 = s2.page();
      const a2 = await agent(s2, o2);
      await s2.msg(o2, voice("r1", ROOM[0]!));
      await s2.msg(a2.c, { type: "summary", ids: ["r1"], text: "（问房租）" });
      await s2.msg(a2.c, { type: "edit", id: "r1", text: "旁人在问房租。" });
      expect(a2.c.last("error")?.error).toContain("is a summary");
    });

    it("pages hide the collapsed lines (applyEditTo), and show the first as the summary", () => {
      const list = [
        {
          id: "r1",
          from: "owner" as const,
          label: "",
          text: ROOM[0]!,
          at: 1,
          source: "stt" as const,
        },
        {
          id: "r2",
          from: "owner" as const,
          label: "",
          text: ROOM[1]!,
          at: 2,
          source: "stt" as const,
        },
        { id: "a", from: "agent" as const, label: "", text: "嗯", at: 3 },
      ];
      const out = applyEditTo(list, {
        id: "r1",
        thread: "owner",
        text: "（旁人在聊租房）",
        raw: ROOM.join("\n"),
        edited: { at: 4, by: "x", count: 0 },
        summary: { at: 4, by: "x", ids: ["r1", "r2"] },
      });
      expect(
        out.map((m) => [m.id, m.text, (m as { collapsedInto?: string }).collapsedInto]),
      ).toEqual([
        ["r1", "（旁人在聊租房）", undefined],
        ["r2", ROOM[1], "r1"],
        ["a", "嗯", undefined],
      ]);
    });
  });

  describe("merged passages (a run of his voice lines as one)", () => {
    const RUN = ["我想把那个按钮", "放到右边", "然后颜色改成红色"];
    const PASSAGE = "我想把那个按钮放到右边，然后把颜色改成红色。";
    const withLog = () => {
      const reqs: Record<string, unknown>[] = [];
      const SESSIONS = {
        live: async () => "live",
        chatLog: async (r: Record<string, unknown>) => {
          reqs.push(structuredClone(r));
          return { ok: true, written: 1 };
        },
      };
      return { reqs, s: setup({ SESSIONS }) };
    };
    const three = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
      for (const [i, t] of RUN.entries()) await s.msg(owner, voice(`m${i}`, t));
    };

    it("merges consecutive voice lines into one passage: originals kept, history gains it", async () => {
      const { reqs, s } = withLog();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await three(s, owner);
      reqs.length = 0;
      await s.msg(c, { type: "merge", ids: ["m2", "m0", "m1"], text: PASSAGE });
      const ev = owner.last("edited") as Record<string, unknown>;
      expect(ev).toMatchObject({
        id: "m0",
        text: PASSAGE,
        raw: RUN.join("\n"),
        passage: { by: "main lane", ids: ["m0", "m1", "m2"] },
      });
      expect(c.last("edited")).toMatchObject({ id: "m0", passage: { ids: ["m0", "m1", "m2"] } });
      expect(stored(s)).toEqual([
        expect.objectContaining({ id: "m0", text: PASSAGE, premerge: { text: RUN[0] } }),
        expect.objectContaining({ id: "m1", text: RUN[1], collapsedInto: "m0" }),
        expect.objectContaining({ id: "m2", text: RUN[2], collapsedInto: "m0" }),
      ]);
      expect(reqs).toEqual([
        {
          op: "put",
          thread: "owner",
          lines: [expect.objectContaining({ id: "m0.merged", from: "owner", text: PASSAGE })],
        },
      ]);
      // A page applying the event shows one bubble.
      const list = RUN.map((text, i) => ({
        id: `m${i}`,
        from: "owner" as const,
        label: "",
        text,
        at: i,
        source: "stt" as const,
      }));
      const shown = applyEditTo(list, ev as never).filter(
        (m) => !(m as { collapsedInto?: string }).collapsedInto,
      );
      expect(shown.map((m) => m.text)).toEqual([PASSAGE]);
    });

    it("refuses a run with any other message between: an agent reply, an ask card, a typed line", async () => {
      const s = setup();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await s.msg(owner, voice("m0", RUN[0]!));
      await s.msg(c, { type: "say", text: "嗯？" });
      await s.msg(owner, voice("m1", RUN[1]!));
      await s.msg(c, { type: "merge", ids: ["m0", "m1"], text: "我想把那个按钮放到右边。" });
      expect(c.last("error")?.error).toContain("not consecutive");
      await s.msg(c, { type: "ask", askId: "q1", question: "哪个？", options: ["A", "B"] });
      await s.msg(owner, voice("m2", RUN[2]!));
      await s.msg(c, { type: "merge", ids: ["m1", "m2"], text: "放到右边，然后颜色改成红色。" });
      expect(c.last("error")?.error).toContain("not consecutive");
      await s.msg(owner, { type: "chat", id: "t1", text: "typed" });
      await s.msg(owner, voice("m3", RUN[0]!));
      await s.msg(c, { type: "merge", ids: ["t1", "m3"], text: "typed，我想把那个按钮" });
      expect(c.last("error")?.error).toContain("typed, not spoken");
      expect(owner.last("edited")).toBeUndefined();
    });

    it("caps the length by ratio, refuses one line, empty text, and an unknown id", async () => {
      const s = setup();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await three(s, owner);
      const total = RUN.join("").length;
      await s.msg(c, {
        type: "merge",
        ids: ["m0", "m1", "m2"],
        text: "啊".repeat(Math.ceil(total * MERGE_RATIO) + MERGE_SLACK + 1),
      });
      expect(c.last("error")?.error).toContain("not merged, the lines stand");
      await s.msg(c, {
        type: "merge",
        ids: ["m0", "m1", "m2"],
        text: "啊".repeat(Math.ceil(total * MERGE_RATIO) + MERGE_SLACK),
      });
      expect(owner.last("edited")).toMatchObject({ passage: { ids: ["m0", "m1", "m2"] } });
      const s2 = setup();
      const o2 = s2.page();
      const a2 = await agent(s2, o2);
      await three(s2, o2);
      await s2.msg(a2.c, { type: "merge", ids: ["m0"], text: "x" });
      expect(a2.c.last("error")?.error).toContain("2–");
      await s2.msg(a2.c, { type: "merge", ids: ["m0", "m1"], text: "   " });
      expect(a2.c.last("error")?.error).toContain("merge needs text");
      await s2.msg(a2.c, { type: "merge", ids: ["m0", "nope"], text: "x" });
      expect(a2.c.last("error")?.error).toContain("no message nope");
      expect(o2.last("edited")).toBeUndefined();
    });

    it("undo from his page restores every line as it was; history drops the passage", async () => {
      const { reqs, s } = withLog();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await three(s, owner);
      // The first line was polished before: the undo brings the polish back, not the raw.
      await s.msg(c, { type: "edit", id: "m0", text: "我想把那个按钮，" });
      await s.msg(c, { type: "merge", ids: ["m0", "m1", "m2"], text: PASSAGE });
      reqs.length = 0;
      await s.msg(owner, { type: "unmerge", id: "m0" });
      const ev = owner.last("edited") as { restored: Record<string, unknown>[] };
      expect(ev.restored.map((m) => [m.id, m.text])).toEqual([
        ["m0", "我想把那个按钮，"],
        ["m1", RUN[1]],
        ["m2", RUN[2]],
      ]);
      expect(c.last("edited")).toMatchObject({ restored: expect.any(Array) });
      const after = stored(s);
      expect(after.map((m) => [m.id, m.text, m.collapsedInto, m.passage, m.premerge])).toEqual([
        ["m0", "我想把那个按钮，", undefined, undefined, undefined],
        ["m1", RUN[1], undefined, undefined, undefined],
        ["m2", RUN[2], undefined, undefined, undefined],
      ]);
      expect(after[0]).toMatchObject({ raw: RUN[0], edited: { count: 1 } });
      expect(reqs).toEqual([{ op: "drop", thread: "owner", ids: ["m0.merged"] }]);
      // A page applying the undo shows the three lines again.
      const merged = [
        { id: "m0", from: "owner" as const, label: "", text: PASSAGE, at: 0 },
        { id: "m1", from: "owner" as const, label: "", text: RUN[1]!, at: 1, collapsedInto: "m0" },
      ];
      const back = applyEditTo(merged, ev as never);
      expect(back.filter((m) => !m.collapsedInto).map((m) => m.text)).toEqual([
        "我想把那个按钮，",
        RUN[1],
      ]);
      // Restored lines may be merged again.
      await s.msg(c, { type: "merge", ids: ["m1", "m2"], text: "放到右边，然后颜色改成红色。" });
      expect(owner.last("edited")).toMatchObject({ passage: { ids: ["m1", "m2"] } });
    });

    it("the lane can undo too; a passage is not polished, summarised or merged again", async () => {
      const s = setup();
      const owner = s.page();
      const { c } = await agent(s, owner);
      await three(s, owner);
      await s.msg(c, { type: "merge", ids: ["m0", "m1"], text: "我想把那个按钮放到右边。" });
      await s.msg(c, { type: "edit", id: "m0", text: "我想把按钮放到右边。" });
      expect(c.last("error")?.error).toContain("merged passage");
      await s.msg(c, {
        type: "merge",
        ids: ["m0", "m2"],
        text: "我想把那个按钮放到右边，然后颜色改成红色。",
      });
      expect(c.last("error")?.error).toContain("already a merged passage");
      await s.msg(c, { type: "summary", ids: ["m0"], text: "（他在说按钮）" });
      expect(c.last("error")?.error).toContain("merged passage");
      await s.msg(c, { type: "unmerge", id: "m2" });
      expect(c.last("error")?.error).toContain("not a merged passage");
      await s.msg(c, { type: "unmerge", id: "m0" });
      expect(c.last("edited")).toMatchObject({ id: "m0", restored: expect.any(Array) });
      expect(stored(s).map((m) => m.text)).toEqual(RUN);
    });

    it("a friend's page cannot undo, a friend's pairing cannot merge, and the polish flag off refuses", async () => {
      const s = setup({
        SESSIONS: { live: async () => "live", flag: async (k: string) => k !== "stt.polish" },
      });
      const owner = s.page();
      const { c } = await agent(s, owner);
      await three(s, owner);
      await s.msg(c, { type: "merge", ids: ["m0", "m1"], text: "我想把那个按钮放到右边。" });
      expect(c.last("error")?.error).toContain("polish is off");
      const s2 = setup();
      const o2 = s2.page();
      const a2 = await agent(s2, o2);
      await three(s2, o2);
      await s2.msg(a2.c, { type: "merge", ids: ["m0", "m1"], text: "我想把那个按钮放到右边。" });
      const f = await s2.friend();
      await s2.msg(f, { type: "unmerge", id: "m0" });
      expect(f.last("error")?.error).toContain("owner");
      expect(stored(s2)[0]).toMatchObject({ passage: { ids: ["m0", "m1"] } });
    });
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

describe("DebugHub ask cards (the agent asks, a person taps)", () => {
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("main lane");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return c;
  };
  const askOne = {
    type: "ask",
    askId: "cal1",
    question: "Apply calendar changes directly?",
    options: [{ label: "Apply, with undo", recommended: true }, "Ask each time"],
  };

  it("an ask reaches the owner's pages as an agent line carrying it", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    await s.msg(c, askOne);
    const line = chats(owner).at(-1) as Record<string, unknown>;
    expect(line).toMatchObject({
      from: "agent",
      thread: "owner",
      text: "Apply calendar changes directly? — Apply, with undo / Ask each time",
      ask: {
        askId: "cal1",
        questions: [
          {
            id: "q1",
            options: [
              { id: "o1", label: "Apply, with undo", recommended: true },
              { id: "o2", label: "Ask each time" },
            ],
          },
        ],
      },
    });
    expect(c.last("asked")).toMatchObject({ askId: "cal1", thread: "owner" });
  });

  it("a tap is stamped by the hub (source tap, page, time) and reaches pages and listeners; one-shot", async () => {
    const s = setup();
    const owner = s.page("/words pwa iPhone");
    const mac = s.page("/list Macintosh");
    const c = await agent(s, owner);
    await s.msg(c, askOne);
    s.tick(7);
    // The page claims a source and a time: ignored, the hub stamps its own.
    await s.msg(owner, {
      type: "answer",
      askId: "cal1",
      choices: { q1: "o1" },
      source: "x",
      at: 1,
    });
    const ev = {
      type: "answered",
      askId: "cal1",
      answer: {
        choices: { q1: ["o1"] },
        source: "tap",
        thread: "owner",
        label: "/words pwa iPhone",
        at: 1_000_007,
      },
      labels: { q1: ["Apply, with undo"] },
    };
    expect(owner.last("answered")).toMatchObject(ev);
    expect(mac.last("answered")).toMatchObject(ev);
    expect(c.last("answered")).toMatchObject(ev);
    // Kept on the line: a page connecting later sees it answered.
    const hist = await s.hub.history();
    expect(hist.at(-1)?.answer).toMatchObject({ source: "tap", choices: { q1: ["o1"] } });
    // A second tap is refused.
    await s.msg(mac, { type: "answer", askId: "cal1", choices: { q1: "o2" } });
    expect(mac.last("error")?.error).toContain("is answered");
    expect((await s.hub.history()).at(-1)?.answer?.choices).toEqual({ q1: ["o1"] });
  });

  it("a controller can never answer (forgery guard)", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    await s.msg(c, askOne);
    await s.msg(c, { type: "answer", askId: "cal1", choices: { q1: "o1" } });
    expect(c.last("error")?.error).toContain("a controller cannot answer");
    expect(owner.last("answered")).toBeUndefined();
    expect((await s.hub.history()).at(-1)?.answer).toBeUndefined();
  });

  it("answers must fit the ask; an expired ask cannot be answered", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    await s.msg(c, {
      type: "ask",
      askId: "b1",
      questions: [
        { id: "a", question: "Which days?", options: ["Mon", "Tue", "Wed"], multi: true },
        { id: "b", question: "Remind me?", options: ["Yes", "No"] },
      ],
    });
    await s.msg(owner, { type: "answer", askId: "b1", choices: { a: ["o1"] } }); // b missing
    expect(owner.last("error")?.error).toContain("does not fit");
    await s.msg(owner, { type: "answer", askId: "b1", choices: { a: ["o1"], b: ["o1", "o2"] } });
    expect(owner.last("error")?.error).toContain("does not fit");
    await s.msg(owner, { type: "answer", askId: "b1", choices: { a: ["o1", "o3"], b: "o2" } });
    expect(owner.last("answered")).toMatchObject({ labels: { a: ["Mon", "Wed"], b: ["No"] } });
    // Expired (the hub's clock past expiresAt): refused.
    await s.msg(c, { ...askOne, askId: "soon", expiresAt: Date.now() + 60_000 });
    s.tick(Date.now() + 120_000);
    await s.msg(owner, { type: "answer", askId: "soon", choices: { q1: "o1" } });
    expect(owner.last("error")?.error).toContain("is expired");
  });

  it("a friend's page never sees the owner's asks and cannot answer them", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(c, askOne);
    expect(chats(f)).toEqual([]);
    await s.msg(f, { type: "answer", askId: "cal1", choices: { q1: "o1" } });
    expect(f.last("error")?.error).toContain("no ask cal1 in this thread");
    expect((await s.hub.history()).at(-1)?.answer).toBeUndefined();
  });

  it("an ask to a friend is answered in their thread, tagged with it", async () => {
    const s = setup();
    const owner = s.page();
    const c = await agent(s, owner);
    const f = await s.friend("f1", "f1@x.com", "/words Android");
    await s.msg(f, { type: "chat", id: "hi", text: "hello" }); // the thread exists once they chat
    await s.msg(c, { ...askOne, askId: "fa", to: "f1@x.com" });
    expect(chats(f).at(-1)).toMatchObject({ thread: "f1", ask: { askId: "fa" } });
    expect(chats(owner)).toEqual([]);
    await s.msg(f, { type: "answer", askId: "fa", choices: { q1: "o2" } });
    expect(f.last("answered")).toMatchObject({ answer: { thread: "f1", source: "tap" } });
    expect(c.last("answered")).toMatchObject({ thread: "f1", answer: { thread: "f1" } });
  });

  describe("withdraw (the agent takes back an obsolete ask)", () => {
    it("by askId or message id: stamped, kept, sent to the pages and listeners; taps refused", async () => {
      const s = setup();
      const owner = s.page();
      const mac = s.page("/list Macintosh");
      const c = await agent(s, owner);
      await s.msg(c, askOne);
      const msgId = (chats(owner).at(-1) as { id: string }).id;
      s.tick(5);
      await s.msg(c, { type: "withdraw", id: "cal1" });
      const ev = {
        type: "withdrawn",
        id: msgId,
        askId: "cal1",
        thread: "owner",
        withdrawnAt: 1_000_005,
      };
      expect(owner.last("withdrawn")).toEqual(ev);
      expect(mac.last("withdrawn")).toEqual(ev);
      expect(c.last("withdrawn")).toEqual(ev);
      expect((await s.hub.history()).at(-1)?.ask?.withdrawnAt).toBe(1_000_005);
      await s.msg(owner, { type: "answer", askId: "cal1", choices: { q1: "o1" } });
      expect(owner.last("error")?.error).toContain("is withdrawn");
      expect(owner.last("answered")).toBeUndefined();
      // Once only.
      await s.msg(c, { type: "withdraw", id: msgId });
      expect(c.last("error")?.error).toBe("ask cal1 is withdrawn");
      // By message id, on another ask.
      await s.msg(c, { ...askOne, askId: "cal2" });
      const id2 = (chats(owner).at(-1) as { id: string }).id;
      await s.msg(c, { type: "withdraw", id: id2 });
      expect(owner.last("withdrawn")).toMatchObject({ id: id2, askId: "cal2" });
    });

    it("only open asks: an answered or expired one, or a line without an ask, is refused", async () => {
      const s = setup();
      const owner = s.page();
      const c = await agent(s, owner);
      await s.msg(c, askOne);
      await s.msg(owner, { type: "answer", askId: "cal1", choices: { q1: "o1" } });
      await s.msg(c, { type: "withdraw", id: "cal1" });
      expect(c.last("error")?.error).toBe("ask cal1 is answered");
      await s.msg(c, { ...askOne, askId: "soon", expiresAt: Date.now() + 60_000 });
      // Past its expiry on the hub's clock (ticking that far would lapse the grant too).
      for (const [k, v] of s.storage.store)
        if ((v as { ask?: { askId: string } })?.ask?.askId === "soon")
          s.storage.store.set(k, {
            ...(v as object),
            ask: { ...(v as { ask: object }).ask, expiresAt: 1 },
          });
      await s.msg(c, { type: "withdraw", id: "soon" });
      expect(c.last("error")?.error).toBe("ask soon is expired");
      await s.msg(c, { type: "say", text: "plain line" });
      const plain = (chats(owner).at(-1) as { id: string }).id;
      await s.msg(c, { type: "withdraw", id: plain });
      expect(c.last("error")?.error).toContain(`no ask ${plain}`);
      expect(owner.last("withdrawn")).toBeUndefined();
    });

    it("needs a live owner grant; never a friend's pairing, a stranger, or a malformed id", async () => {
      const s = setup();
      const owner = s.page();
      const c = s.controller("agent");
      await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
      const token = c.last("approved")?.token as string;
      await s.msg(c, askOne);
      const stranger = s.controller("stranger");
      await s.msg(stranger, { type: "withdraw", id: "cal1" });
      expect(stranger.last("error")?.error).toBe("not approved yet");
      await s.msg(c, { type: "withdraw", id: "cal 1; drop" });
      expect(c.last("error")?.error).toContain("withdraw needs the askId");
      const f = await s.friend("f1", "f1@x.com");
      await s.msg(f, { type: "chat", id: "hi", text: "hello" });
      const preview = await s.forFriend(token, "f1@x.com");
      await s.msg(f, { type: "allow", pair: s.pairOf(f) });
      await s.msg(preview, { type: "withdraw", id: "cal1" });
      expect(preview.last("error")?.error).toBe("a pairing for a friend cannot withdraw");
      s.storage.store.delete(`grant:${await hashToken(token)}`);
      await s.msg(c, { type: "withdraw", id: "cal1" });
      expect(c.last("error")?.error).toBe("withdraw needs a live chat grant from the owner");
      expect((await s.hub.history()).at(-1)?.ask?.withdrawnAt).toBeUndefined();
    });

    it("thread-scoped: a friend's card only in their thread, never the owner's from there", async () => {
      const s = setup();
      const owner = s.page();
      const c = await agent(s, owner);
      const f = await s.friend("f1", "f1@x.com", "/words Android");
      await s.msg(f, { type: "chat", id: "hi", text: "hello" });
      await s.msg(c, askOne);
      await s.msg(c, { ...askOne, askId: "fa", to: "f1@x.com" });
      // The owner's thread by default: the friend's card is not there, and the reverse.
      await s.msg(c, { type: "withdraw", id: "fa" });
      expect(c.last("error")?.error).toBe("no ask fa in that thread");
      await s.msg(c, { type: "withdraw", id: "cal1", to: "f1@x.com" });
      expect(c.last("error")?.error).toBe("no ask cal1 in that thread");
      await s.msg(c, { type: "withdraw", id: "fa", to: "f1@x.com" });
      expect(f.last("withdrawn")).toMatchObject({ askId: "fa", thread: "f1" });
      expect(owner.last("withdrawn")).toBeUndefined();
      expect(c.last("withdrawn")).toMatchObject({ askId: "fa", thread: "f1" });
      expect((await s.hub.history()).at(-1)?.ask?.withdrawnAt).toBeUndefined();
      expect((await s.hub.history("f1")).at(-1)?.ask?.withdrawnAt).toBeNumber();
    });
  });
});

describe("DebugHub page errors", () => {
  const err = (over: Record<string, unknown> = {}) => ({
    type: "page-error",
    kind: "fetch",
    message: "GET /api/words/tts 503",
    path: "/api/words/tts?text=secret",
    status: 503,
    at: 999,
    rev: "abc123",
    label: "/forged",
    ...over,
  });
  const errors = (ws: FakeSocket) => ws.sent.filter((m) => m.type === "page-error");

  it("an owner page's error reaches the approved listeners only, with the hub's label, never stored", async () => {
    const s = setup();
    const owner = s.page();
    const other = s.page("/list Macintosh");
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    const waiting = s.controller("stranger");
    const before = [...s.storage.store.keys()].sort();
    await s.msg(owner, err());
    expect(errors(c)).toEqual([
      {
        type: "page-error",
        kind: "fetch",
        message: "GET /api/words/tts 503",
        path: "/api/words/tts",
        status: 503,
        at: 999,
        rev: "abc123",
        label: "/words pwa iPhone",
        hubAt: 1_000_000,
      },
    ]);
    expect(errors(waiting)).toEqual([]);
    expect(errors(owner)).toEqual([]);
    expect(errors(other)).toEqual([]);
    expect([...s.storage.store.keys()].sort()).toEqual(before);
  });

  it("a friend's page-error is dropped, even with the agent listening", async () => {
    const s = setup();
    const owner = s.page();
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    const f = await s.friend();
    await s.msg(f, err());
    expect(errors(c)).toEqual([]);
  });

  it("a friend's preview pairing never hears the owner's page errors", async () => {
    const s = setup();
    const owner = s.page();
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    const token = c.last("approved")?.token as string;
    const f = await s.friend("f1", "f1@x.com");
    const preview = await s.forFriend(token, "f1@x.com");
    await s.msg(f, { type: "allow", pair: s.pairOf(f) });
    await s.msg(owner, err());
    expect(errors(c)).toHaveLength(1);
    expect(errors(preview)).toEqual([]);
  });

  it("a malformed page-error (unknown kind, no message) is dropped; long fields are capped", async () => {
    const s = setup();
    const owner = s.page();
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    await s.msg(owner, err({ kind: "chat" }));
    await s.msg(owner, err({ message: "   " }));
    await s.msg(owner, err({ message: "x".repeat(5000), stack: "s".repeat(9000) }));
    const got = errors(c) as { message: string; stack: string }[];
    expect(got).toHaveLength(1);
    expect(got[0].message.length).toBe(500);
    expect(got[0].stack.length).toBe(1500);
  });
});

describe("DebugHub continuous speech (stt.merge)", () => {
  const T0 = 5_000_000;
  /** Page-clock marks: spoken from `start`, last voiced at `end`, ended one endpoint later. */
  const timing = (start: number, end: number) => ({
    t_speechStart: T0 + start,
    t_lastVoice: T0 + end,
    t_speechEnd: T0 + end + 600,
  });
  const say = (id: string, text: string, start: number, end: number, more = {}) => ({
    type: "chat",
    id,
    text,
    source: "stt",
    timing: timing(start, end),
    ...more,
  });
  const askOne = { type: "ask", askId: "q1", question: "Which?", options: ["X", "Y"] };
  const rig = async (flags: Record<string, unknown> = { "stt.merge": true }) => {
    const SESSIONS = {
      live: async () => "live",
      flag: async (k: string) => flags[k] ?? k === "stt.polish",
    };
    const s = setup({ SESSIONS });
    const owner = s.page();
    const c = s.controller("main lane");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    /** F1 then F2, under the 1400 ms silence: the owner's example. */
    const two = async () => {
      await s.msg(owner, say("a", "那你能不能给，", 0, 1000));
      await s.msg(owner, say("b", "给我显示一个按钮。", 2000, 4000, { continues: "a" }));
    };
    const lines = () =>
      [...s.storage.store.entries()]
        .filter(([k]) => k.startsWith("msg:"))
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([, v]) => v as Record<string, unknown>);
    const ownerIds = () =>
      lines()
        .filter((l) => l.from === "owner")
        .map((l) => l.id);
    return { s, owner, c, two, lines, ownerIds };
  };

  it("merges a continuation: one line, complete text, every part's raw kept, marked edited", async () => {
    const { owner, c, two, lines } = await rig();
    await two();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      id: "a",
      text: "那你能不能给，给我显示一个按钮。",
      raw: "那你能不能给，给我显示一个按钮。",
      edited: { by: "merge", count: 0 },
    });
    expect((lines()[0].parts as { id: string; text: string }[]).map((p) => [p.id, p.text])).toEqual(
      [
        ["a", "那你能不能给，"],
        ["b", "给我显示一个按钮。"],
      ],
    );
    // Listeners and pages: the existing edited event, the whole line, no new chat line.
    for (const ws of [c, owner]) {
      expect(ws.last("edited")).toMatchObject({
        id: "a",
        text: "那你能不能给，给我显示一个按钮。",
        merged: { id: "b", text: "给我显示一个按钮。" },
      });
      expect(chats(ws).map((m) => m.id)).toEqual(["a"]);
    }
  });

  it("flag off: today's behaviour, even for a page that asks; no stamp, no merge", async () => {
    const { owner, c, two, lines } = await rig({});
    await two();
    expect(lines().map((l) => l.id)).toEqual(["a", "b"]);
    expect(lines()[0].mergeable).toBeUndefined();
    expect(c.last("edited")).toBeUndefined();
    expect(owner.last("edited")).toBeUndefined();
  });

  it("an unsure flag (busy, an error) is off", async () => {
    for (const flag of [async () => "busy", async () => Promise.reject(new Error("d1"))]) {
      const s = setup({ SESSIONS: { live: async () => "live", flag } });
      const owner = s.page();
      await s.msg(owner, say("a", "first part,", 0, 1000));
      expect((chats(owner)[0] as { mergeable?: true }).mergeable).toBeUndefined();
    }
  });

  it("a line that only looks finished stays separate with no signed voiceprint", async () => {
    const { s, owner, lines } = await rig();
    await s.msg(owner, say("a", "那你能不能给。", 0, 1000));
    await s.msg(owner, say("b", "给我显示一个按钮。", 1700, 3000, { continues: "a" }));
    expect(lines().map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("a line that only looks finished merges when the Mac signed both as him; the tag stays honest", async () => {
    const mac = await speakerKey();
    const s = setup({
      STT_SPEAKER_PUB: mac.pub,
      SESSIONS: {
        live: async () => "live",
        flag: async (k: string) => k === "stt.merge" || k === "stt.polish",
      },
    });
    const owner = s.page();
    const proof = (text: string, uid: string) =>
      mac.sign({
        decision: "me",
        score: 0.5,
        text,
        uid: uid.padEnd(16, "x"),
        thread: "owner",
        at: 1_000_000,
      });
    await s.msg(
      owner,
      say("a", "那你能不能给。", 0, 1000, { speakerProof: [await proof("那你能不能给", "u1")] }),
    );
    await s.msg(
      owner,
      say("b", "给我显示一个按钮。", 1700, 3000, {
        continues: "a",
        speakerProof: [await proof("给我显示一个按钮", "u2")],
      }),
    );
    const [line] = [...s.storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as { text: string; speaker?: { decision: string; signed?: string[] } });
    expect(line.text).toBe("那你能不能给。给我显示一个按钮。");
    expect(line.speaker?.decision).toBe("me");
    expect(line.speaker?.signed).toEqual(["那你能不能给", "给我显示一个按钮"]);
  });

  it("no merge when the page did not ask, or asked for another line", async () => {
    const { s, owner, lines } = await rig();
    await s.msg(owner, say("a", "first part,", 0, 1000));
    await s.msg(owner, say("b", "second part.", 2000, 3000));
    await s.msg(owner, say("c", "third part.", 4000, 5000, { continues: "a" }));
    expect(lines().map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("no merge past the window, after a question, or with no timestamps", async () => {
    for (const [first, second] of [
      [say("a", "one thing,", 0, 1000), say("b", "two more.", 5000, 6000, { continues: "a" })],
      [say("a", "这是什么？", 0, 1000), say("b", "再说一遍。", 1500, 2000, { continues: "a" })],
      [
        { type: "chat", id: "a", text: "one thing,", source: "stt" },
        { type: "chat", id: "b", text: "two more.", source: "stt", continues: "a" },
      ],
    ]) {
      const { s, owner, lines } = await rig();
      await s.msg(owner, first);
      await s.msg(owner, second);
      expect(lines().map((l) => l.id)).toEqual(["a", "b"]);
    }
  });

  it("an agent's reply, or an ask card, in between keeps it a new line", async () => {
    const { s, owner, c, lines } = await rig();
    await s.msg(owner, say("a", "first part,", 0, 1000));
    await s.msg(c, { type: "say", text: "on it" });
    await s.msg(owner, say("b", "second part.", 1500, 3000, { continues: "a" }));
    expect(lines().map((l) => l.text)).toEqual(["first part,", "on it", "second part."]);
    expect(owner.last("edited")).toBeUndefined();

    const r = await rig();
    await r.s.msg(r.owner, say("a", "first part,", 0, 1000));
    await r.s.msg(r.c, askOne);
    await r.s.msg(r.owner, say("b", "second part.", 1500, 3000, { continues: "a" }));
    expect(r.ownerIds()).toEqual(["a", "b"]);
  });

  it("an agent only working on it (a busy beat) does not stop the merge; it hears the whole line", async () => {
    const { s, owner, c, lines } = await rig();
    await s.msg(owner, say("a", "那你能不能给，", 0, 1000));
    await s.msg(c, { type: "busy" });
    await s.msg(owner, say("b", "给我显示一个按钮。", 2000, 4000, { continues: "a" }));
    expect(lines()).toHaveLength(1);
    expect(c.last("edited")).toMatchObject({ text: "那你能不能给，给我显示一个按钮。" });
  });

  it("a typed line, a page moved, or a line with a selection stays separate", async () => {
    const typed = await rig();
    await typed.s.msg(typed.owner, say("a", "first part,", 0, 1000));
    await typed.s.msg(typed.owner, { type: "chat", id: "t", text: "typed", continues: "a" });
    expect(typed.lines().map((l) => l.id)).toEqual(["a", "t"]);

    const moved = await rig();
    await moved.s.msg(moved.owner, say("a", "first part,", 0, 1000));
    await moved.s.msg(moved.owner, { type: "page", label: "/review pwa iPhone" });
    await moved.s.msg(moved.owner, say("b", "second part.", 1500, 3000, { continues: "a" }));
    expect(moved.lines().map((l) => l.id)).toEqual(["a", "b"]);

    const sel = await rig();
    await sel.s.msg(sel.owner, say("a", "first part,", 0, 1000));
    await sel.s.msg(
      sel.owner,
      say("b", "second part.", 1500, 3000, { continues: "a", context: { selection: "x" } }),
    );
    expect(sel.lines().map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("another device's voice line never amends this one", async () => {
    const { s, owner, lines } = await rig();
    const other = s.page("/words Macintosh");
    await s.msg(owner, say("a", "first part,", 0, 1000));
    await s.msg(other, say("b", "second part.", 1500, 3000, { continues: "a" }));
    expect(lines().map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("a short answer stands alone: fragments cannot become an approval", async () => {
    const { s, owner, lines } = await rig();
    await s.msg(owner, say("a", "yes.", 0, 500));
    await s.msg(owner, say("b", "go ahead and do it,", 800, 2000, { continues: "a" }));
    await s.msg(owner, say("c", "ok.", 2400, 2800, { continues: "b" }));
    expect(lines().map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("an ask card waiting right before, or tapped since, keeps the fragments apart", async () => {
    const { s, owner, c, ownerIds, lines } = await rig();
    await s.msg(c, askOne);
    await s.msg(owner, say("a", "first part,", 0, 1000));
    await s.msg(owner, say("b", "second part.", 1500, 3000, { continues: "a" }));
    expect(ownerIds()).toEqual(["a", "b"]);
    // A tap is its own act, and no spoken line near it becomes part of it.
    await s.msg(owner, { type: "answer", askId: "q1", choices: { q1: ["o1"] } });
    expect(lines()[0].answer).toBeDefined();
    await s.msg(owner, say("c", "third part.", 3500, 4500, { continues: "b" }));
    expect(ownerIds()).toEqual(["a", "b", "c"]);
  });

  it("friends' threads never merge, even if a page asks", async () => {
    const { s } = await rig();
    const f = await s.friend();
    await s.msg(f, say("fa", "first part,", 0, 1000));
    await s.msg(f, say("fb", "second part.", 1500, 3000, { continues: "fa" }));
    expect(chats(f).map((m) => m.id)).toEqual(["fa", "fb"]);
    expect((chats(f)[0] as { mergeable?: true }).mergeable).toBeUndefined();
    expect(f.last("edited")).toBeUndefined();
  });

  it("the message cap holds: a merged line over MAX_CHAT stays two lines", async () => {
    const { s, owner, lines } = await rig();
    await s.msg(owner, say("a", `${"字".repeat(3000)}，`, 0, 1000));
    await s.msg(owner, say("b", `${"词".repeat(1500)}。`, 1500, 3000, { continues: "a" }));
    expect(lines().map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("undo splits it back into the original lines, in place, for pages and listeners", async () => {
    const { s, owner, c, two, lines } = await rig();
    await two();
    await s.msg(c, { type: "say", text: "reply" });
    await s.msg(owner, { type: "unmerge", id: "a" });
    expect(lines().map((l) => l.text)).toEqual(["那你能不能给，", "给我显示一个按钮。", "reply"]);
    expect(lines()[0].parts).toBeUndefined();
    expect(lines()[0].edited).toBeUndefined();
    expect(lines()[1].source).toBe("stt");
    expect(lines()[1].timing).toMatchObject({ t_speechStart: T0 + 2000 });
    const ev = c.last("edited") as { split: { id: string }[] };
    expect(ev.split.map((x) => x.id)).toEqual(["a", "b"]);
    expect(owner.last("edited")).toEqual(ev);
    // The next line goes after the reply, and the history a page reconnects to agrees.
    await s.msg(owner, say("n", "next.", 9000, 9500));
    expect(
      lines()
        .map((l) => l.text)
        .at(-1),
    ).toBe("next.");
    expect((await s.hub.history()).map((m) => m.text)).toEqual(
      lines().map((l) => l.text as string),
    );
    // Only a merged line.
    await s.msg(owner, { type: "unmerge", id: "b" });
    expect(owner.last("error")?.error).toContain("not a merged line");
  });

  it("split lines merge no further", async () => {
    const { s, owner, two, lines } = await rig();
    await two();
    await s.msg(owner, { type: "unmerge", id: "a" });
    await s.msg(owner, say("c", "more.", 4200, 4800, { continues: "b" }));
    expect(lines().map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("undo does not reach a friend's page", async () => {
    const { s, owner, two, lines } = await rig();
    const f = await s.friend();
    await two();
    await s.msg(f, { type: "unmerge", id: "a" });
    expect(f.last("error")?.error).toContain("owner");
    expect(
      lines()
        .filter((l) => l.from === "owner")
        .map((l) => l.id),
    ).toEqual(["a"]);
    expect(owner.last("edited")?.split).toBeUndefined();
  });

  it("undo works after the flag went off", async () => {
    const flags: Record<string, unknown> = { "stt.merge": true };
    const { s, owner, two, lines } = await rig(flags);
    await two();
    flags["stt.merge"] = false;
    s.tick(60_000);
    await s.msg(owner, { type: "unmerge", id: "a" });
    expect(lines().map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("re-polish: refused while spoken, due once at the passage's end, read from the merged raw", async () => {
    const { s, owner, c, two, lines } = await rig();
    await two();
    const polished = "那你能不能给。给我显示一个按钮。";
    await s.msg(c, { type: "edit", id: "a", text: polished });
    expect(c.last("error")?.error).toContain("still being spoken");
    await s.msg(owner, { type: "passage-end" });
    expect(c.last("polish-due")).toMatchObject({
      id: "a",
      raw: "那你能不能给，给我显示一个按钮。",
      parts: 2,
    });
    await s.msg(c, { type: "edit", id: "a", text: polished });
    expect(lines()[0]).toMatchObject({
      text: polished,
      raw: "那你能不能给，给我显示一个按钮。",
      edited: { count: 1 },
    });
    // Settled: nothing more joins it; the next passage is a new line.
    await s.msg(owner, say("c", "more.", 4500, 5000, { continues: "a" }));
    expect(lines().map((l) => l.id)).toEqual(["a", "c"]);
    // Told twice, due once.
    await s.msg(owner, { type: "passage-end" });
    expect(c.sent.filter((m) => m.type === "polish-due")).toHaveLength(1);
  });

  it("later words may correct earlier ones: the parts are the polish's context", async () => {
    const { s, owner, c, lines } = await rig();
    await s.msg(owner, say("a", "我们用流失传输，", 0, 1000));
    await s.msg(owner, say("b", "流式传输比较快。", 1500, 3000, { continues: "a" }));
    await s.msg(owner, { type: "passage-end" });
    await s.msg(c, { type: "edit", id: "a", text: "我们用流式传输，流式传输比较快。" });
    expect(lines()[0].text).toBe("我们用流式传输，流式传输比较快。");
  });

  it("a polish of the first fragment is dropped by the merge, and cannot land after it", async () => {
    const { s, owner, c, lines } = await rig();
    await s.msg(owner, say("a", "hello world,", 0, 1000));
    await s.msg(c, { type: "edit", id: "a", text: "Hello world," });
    await s.msg(owner, say("b", "and more.", 1500, 3000, { continues: "a" }));
    expect(lines()[0]).toMatchObject({
      text: "hello world, and more.",
      raw: "hello world, and more.",
      edited: { by: "merge", count: 1 },
    });
    await s.msg(owner, { type: "passage-end" });
    await s.msg(c, { type: "edit", id: "a", text: "Hello world," });
    expect(c.last("error")?.error).toContain("not polished");
  });

  it("stt.polish off: merges with no rewrite, and no lane is woken to polish", async () => {
    const { s, owner, c, two, lines } = await rig({ "stt.merge": true, "stt.polish": false });
    await two();
    await s.msg(owner, { type: "passage-end" });
    expect(lines()[0].text).toBe("那你能不能给，给我显示一个按钮。");
    expect(c.last("polish-due")).toBeUndefined();
  });

  it("no polish-due for a line that was not merged, and a single line polishes as before", async () => {
    const { s, owner, c, lines } = await rig();
    await s.msg(owner, say("a", "only one.", 0, 1000));
    await s.msg(owner, { type: "passage-end" });
    expect(c.last("polish-due")).toBeUndefined();
    await s.msg(c, { type: "edit", id: "a", text: "Only one." });
    expect(lines()[0]).toMatchObject({ text: "Only one.", raw: "only one." });
  });

  it("the flag is asked at most once per 30 s, and never for a typed line", async () => {
    const asked: string[] = [];
    const s = setup({
      SESSIONS: { live: async () => "live", flag: async (k: string) => (asked.push(k), false) },
    });
    const owner = s.page();
    await s.msg(owner, { type: "chat", id: "t", text: "typed" });
    expect(asked).toEqual([]);
    await s.msg(owner, say("a", "first.", 0, 1000));
    await s.msg(owner, say("b", "second.", 5000, 6000));
    expect(asked).toEqual(["stt.merge"]);
  });
});

describe("DebugHub ETA pings (/internal/eta, lib/eta-ping.ts)", () => {
  const ping = {
    id: "/words/swipe",
    title: "Native swipe",
    etaAt: 999_000,
    assignee: "swipe-agent",
  };
  const post = (s: ReturnType<typeof setup>, body: unknown = ping) =>
    s.hub.fetch(
      new Request("https://lianki-push/internal/eta", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  const on = (flags: Record<string, unknown> = { "chat.eta-bar": true }) => ({
    SESSIONS: { live: async () => "live", flag: async (k: string) => flags[k] ?? false },
  });
  const lane = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("chat lane (fast)");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return c;
  };

  it("with the flag on: one quiet agent-side line in the owner's thread, heard by the lane like his lines", async () => {
    const s = setup(on());
    const owner = s.page();
    const c = await lane(s, owner);
    const res = await post(s);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, delivered: true });
    const line = chats(owner).at(-1) as Record<string, unknown>;
    expect(line).toMatchObject({
      from: "agent",
      thread: "owner",
      to: "/",
      agentId: "eta",
      source: "eta",
      quiet: true,
      eta: { id: "/words/swipe", etaAt: 999_000 },
    });
    // It tells the owning lane exactly what to do: the reason and a new ETA, in one call.
    expect(line.text).toContain("ETA reached for Native swipe (/words/swipe)");
    expect(line.text).toContain('--late "');
    expect(line.text).toContain("Native swipe 超时，未说明原因");
    // Never the owner, never rich text, never an answer.
    expect(line.ownerGrant).toBeUndefined();
    expect(line.answer).toBeUndefined();
    const heard = c.sent.filter((m) => m.type === "chat").at(-1) as {
      message: Record<string, unknown>;
      observed?: boolean;
    };
    expect(heard.message).toMatchObject({ source: "eta", from: "agent" });
    expect(heard.observed).toBeUndefined();
  });

  it("the owner's lines (late, silent) are read aloud: not quiet, his words", async () => {
    const s = setup(on());
    const owner = s.page();
    await post(s, { ...ping, title: "Swipe: drag it", kind: "silent" });
    const silent = chats(owner).at(-1) as Record<string, unknown>;
    expect(silent.text).toBe("Swipe 超时，未说明原因");
    expect(silent.quiet).toBeUndefined();
    await post(s, { ...ping, kind: "late", reason: "CI 排队", etaAt: Date.now() + 20 * 60_000 });
    const late = chats(owner).at(-1) as Record<string, unknown>;
    expect(late.text).toMatch(/^Native swipe 超时：CI 排队。再要 \d+ 分钟$/);
    expect(late.quiet).toBeUndefined();
    // A "late" without its reason is not one.
    expect((await post(s, { ...ping, kind: "late" })).status).toBe(400);
  });

  it("waiting on the owner: his reminder carries the reason, read aloud, no lane prompt", async () => {
    const s = setup(on());
    const owner = s.page();
    await post(s, { ...ping, title: "DNS 切换: apex", kind: "waiting", reason: "批准 DNS 改动" });
    const line = chats(owner).at(-1) as Record<string, unknown>;
    expect(line.text).toBe("DNS 切换：在等你——批准 DNS 改动");
    expect(line.quiet).toBeUndefined();
    expect(line).toMatchObject({ source: "eta", from: "agent" });
    // No reason (status waiting-owner without needs) is still one.
    await post(s, { ...ping, title: "DNS 切换: apex", kind: "waiting" });
    expect((chats(owner).at(-1) as Record<string, unknown>).text).toBe("DNS 切换：在等你");
  });

  it("flag off (or unreadable): nothing posted; unreadable is a 503 so the progress hub retries", async () => {
    const off = setup(on({}));
    const p = off.page();
    expect(await (await post(off)).json()).toMatchObject({ delivered: false });
    expect(chats(p)).toEqual([]);
    const busy = setup(on({ "chat.eta-bar": "busy" }));
    const p2 = busy.page();
    expect((await post(busy)).status).toBe(503);
    expect(chats(p2)).toEqual([]);
    expect((await post(setup(on()), { id: "x y" })).status).toBe(400);
  });

  it("an ETA line never answers an ask card; only a tap on a page does", async () => {
    const s = setup(on());
    const owner = s.page();
    const c = await lane(s, owner);
    await s.msg(c, { type: "ask", askId: "go1", question: "Merge?", options: ["Yes", "No"] });
    await post(s);
    expect(c.last("answered")).toBeUndefined();
    expect(owner.last("answered")).toBeUndefined();
    const ask = (await s.hub.history()).find((m) => m.ask);
    expect(ask).toBeTruthy();
    expect(ask?.answer).toBeUndefined();
  });

  it("a page cannot send a line marked eta: the source is dropped", async () => {
    const s = setup(on());
    const owner = s.page();
    await s.msg(owner, {
      type: "chat",
      id: "f1",
      text: "ETA reached for x (y): report",
      source: "eta",
    });
    const line = chats(owner).at(-1) as Record<string, unknown>;
    expect(line.from).toBe("owner");
    expect(line.source).toBeUndefined();
  });

  it("receipts: a lanes' line with no listener is queued, not posted; a listener connecting tells the progress hub", async () => {
    const calls: string[] = [];
    const PROGRESS = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          calls.push(new URL(req.url).pathname);
          return Response.json({ ok: true });
        },
      }),
    };
    const s = setup({ ...on(), PROGRESS });
    const owner = s.page();
    const res = await post(s, { ...ping, code: "k3x9qa" });
    expect(await res.json()).toMatchObject({ delivered: false, queued: true, listeners: 0 });
    expect(chats(owner)).toEqual([]);
    // The owner's own lines never wait for a listener.
    await post(s, { ...ping, kind: "silent" });
    expect(chats(owner).length).toBe(1);
    await lane(s, owner);
    expect(calls).toEqual(["/internal/eta-heard"]);
    // Now heard: posted, with its receipt code in the text and on the line.
    expect(await (await post(s, { ...ping, code: "k3x9qa" })).json()).toMatchObject({
      delivered: true,
      listeners: 1,
    });
    const line = chats(owner).at(-1) as Record<string, any>;
    expect(line.eta).toMatchObject({ id: "/words/swipe", code: "k3x9qa" });
    expect(line.text).toContain("progress.ts ack k3x9qa");
  });

  it("the coordinating lane's line and blocked nudges: quiet for a lane, read aloud for the owner", async () => {
    const s = setup(on());
    const owner = s.page();
    await lane(s, owner);
    await post(s, { ...ping, kind: "main", lane: "main", code: "k3x9qa", ownerMin: 5 });
    const main = chats(owner).at(-1) as Record<string, any>;
    expect(main.quiet).toBe(true);
    expect(main.eta).toMatchObject({ kind: "main", lane: "main" });
    expect(main.text).toStartWith("@main: swipe-agent has not acked");
    await post(s, {
      ...ping,
      title: "Rebase: x",
      kind: "blocked",
      lane: "codex",
      reason: "合并 #812",
    });
    const nudge = chats(owner).at(-1) as Record<string, any>;
    expect(nudge.quiet).toBe(true);
    expect(nudge.eta).toMatchObject({ kind: "blocked", lane: "codex" });
    expect(nudge.text).toContain("@codex: Rebase: x (/words/swipe) is blocked on you: 合并 #812");
    await post(s, { ...ping, title: "DNS: apex", kind: "blocked", lane: "owner", reason: "批准" });
    const his = chats(owner).at(-1) as Record<string, any>;
    expect(his.quiet).toBeUndefined();
    expect(his.text).toBe("DNS 卡住了，等你——批准");
    // A nudge must name who.
    expect((await post(s, { ...ping, kind: "blocked" })).status).toBe(400);
  });
});

describe("DebugHub chat history (lib/chat-log.ts over SESSIONS.chatLog)", () => {
  type Req = { op: string; thread: string; id?: string; lines: Record<string, unknown>[] };
  const withLog = (fail = false) => {
    const reqs: Req[] = [];
    const SESSIONS = {
      live: async () => "live",
      chatLog: async (r: Req) => {
        if (fail) throw new Error("d1 down");
        reqs.push(structuredClone(r));
        return { ok: true, written: r.lines.length };
      },
    };
    return { reqs, s: setup({ SESSIONS }) };
  };
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("main lane");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return c;
  };

  it("each kept line is written: text, lane, time; never the page's context or screen", async () => {
    const { reqs, s } = withLog();
    const owner = s.page("/vibe pwa iPhone");
    const c = await agent(s, owner);
    await s.msg(owner, {
      type: "chat",
      id: "m1",
      text: "what did she say",
      context: { text: "PRIVATE TRANSCRIPT", url: "https://lianki.com/vibe/abc" },
    });
    await s.msg(c, { type: "say", text: "【codex】 looking", lane: "codex" });
    expect(reqs.map((r) => [r.op, r.thread])).toEqual([
      ["put", "owner"],
      ["put", "owner"],
    ]);
    expect(reqs[0]!.lines).toEqual([
      {
        id: "m1",
        from: "owner",
        lane: null,
        text: "what did she say",
        at: 1_000_000,
        ask: false,
        answer: null,
      },
    ]);
    expect(reqs[1]!.lines[0]).toMatchObject({ from: "agent", lane: "codex", text: "looking" });
    expect(JSON.stringify(reqs)).not.toContain("PRIVATE");
    expect(JSON.stringify(reqs)).not.toContain("/vibe");
  });

  it("an ask card is flagged, and its answer updates it", async () => {
    const { reqs, s } = withLog();
    const owner = s.page();
    const c = await agent(s, owner);
    await s.msg(c, { type: "ask", askId: "k1", question: "Ship?", options: ["Yes", "No"] });
    await s.msg(owner, { type: "answer", askId: "k1", choices: { q1: "o2" } });
    expect(reqs.map((r) => r.op)).toEqual(["put", "update"]);
    expect(reqs[0]!.lines[0]).toMatchObject({ ask: true, answer: null });
    expect(reqs[1]!.lines[0]).toMatchObject({ ask: true, answer: "No" });
  });

  it("a friend's line goes to their own thread", async () => {
    const { reqs, s } = withLog();
    const f = await s.friend("f9", "f9@x.com");
    await s.msg(f, { type: "chat", id: "x1", text: "hello partner" });
    expect(reqs[0]).toMatchObject({ op: "put", thread: "f9" });
    expect(reqs[0]!.lines[0]).toMatchObject({ from: "friend", text: "hello partner" });
  });

  it("the history being down never stops the chat", async () => {
    const { s } = withLog(true);
    const owner = s.page();
    await s.msg(owner, { type: "chat", id: "m1", text: "still here" });
    expect(chats(owner).at(-1)).toMatchObject({ id: "m1", text: "still here" });
  });

  it("POST /internal/chat-backfill writes the owner thread's stored lines; 503 without the binding", async () => {
    const { reqs, s } = withLog();
    const owner = s.page();
    await s.msg(owner, { type: "chat", id: "m1", text: "one" });
    await s.msg(owner, { type: "chat", id: "m2", text: "two" });
    const res = await s.hub.fetch(
      new Request("https://lianki-push/internal/chat-backfill", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const last = reqs.at(-1)!;
    expect(last.op).toBe("backfill");
    expect(last.thread).toBe("owner");
    expect(last.lines.map((l) => l.id)).toEqual(["m1", "m2"]);
    const bare = setup();
    const r2 = await bare.hub.fetch(
      new Request("https://lianki-push/internal/chat-backfill", { method: "POST" }),
    );
    expect(r2.status).toBe(503);
  });
});
