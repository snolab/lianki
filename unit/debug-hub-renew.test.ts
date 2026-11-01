/**
 * The owner's eval grant renews itself (workers/push/src/debug.ts, "Renewal";
 * docs/monitoring.md, "Renewal"): only on the device and sign-in session that
 * approved it, before it ends, up to EVAL_CHAIN_MS from the tap — never after
 * End or sign-out, never for a friend, never from another device.
 */
import { describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage, hashToken } from "@/workers/push/src/debug";
import {
  APPROVAL_MS,
  CHAT_MS,
  EVAL_CHAIN_MS,
  EVAL_GRANT_MS,
  EVAL_RENEW_BEFORE_MS,
  sessionTag,
  isSessionTag,
} from "@/lib/dev-eval";
import { readFileSync } from "node:fs";
import {
  type NoticeDeps,
  type OutboxDb,
  RETRY_MS,
  flushSignedOut,
  flushSignedOutSoon,
  notifySignedOut,
  outboxBackoff,
} from "@/lib/push-signed-out";
import { sessionLive } from "@/lib/debug-session";
import { TestD1Database } from "@/lib/d1/testDb";

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

function fakeStorage(store = new Map<string, unknown>()) {
  const s: Storage & { store: Map<string, unknown>; alarm: number | null } = {
    store,
    alarm: null,
    async getAlarm() {
      return s.alarm;
    },
    async setAlarm(at: number) {
      s.alarm = at;
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
  return s;
}

const T0 = 1_000_000;
const SESSION = "a".repeat(64);
const DEVICE = "phone-device-01";
const OTHER_DEVICE = "mac-device-00001";
const FAR = T0 + 400 * 24 * 60 * 60_000;
/** From a fresh grant into its renewal window: less than EVAL_RENEW_BEFORE_MS left. */
const INTO_WINDOW = EVAL_GRANT_MS - EVAL_RENEW_BEFORE_MS + 1;

type Opts = { device?: string; session?: string; sessionUntil?: number; tab?: string };
type Stored = {
  until: number;
  renew?: { device: string; session: string; user?: string; start: number; count: number };
};

/**
 * The main Worker's /api/debug/session-live, as the auth db would answer it:
 * `live` holds the owner's sessions still signed in. `mode` breaks it.
 */
function fakeMain() {
  const m = {
    live: new Set<string>([SESSION]),
    mode: "db" as "db" | "throw" | "500" | "odd",
    calls: [] as { url: string; body: { user: string; session: string } }[],
    fetch: async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      m.calls.push({ url, body });
      if (m.mode === "throw") throw new Error("main down");
      if (m.mode === "500") return new Response("no", { status: 500 });
      if (m.mode === "odd") return Response.json({ live: "yes" });
      return Response.json({ live: body.user === "owner1" && m.live.has(body.session) });
    },
  };
  return m;
}

function setup(o: { noMain?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  let t = T0;
  const storage = fakeStorage();
  const main = fakeMain();
  const hub = new DebugHub(
    { acceptWebSocket: () => {}, getWebSockets: () => sockets, storage },
    o.noMain ? undefined : { MAIN: main },
    () => t,
  );
  const add = () => {
    const ws = new FakeSocket();
    sockets.push(ws);
    return ws;
  };
  /** The owner's page as index.ts passes it: signed in, a session tag, a device id. */
  const ownerPage = async (o: Opts = {}) => {
    const { device = DEVICE, session = SESSION, sessionUntil = FAR, tab = "phone-tab-1" } = o;
    const ws = add();
    await hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=/words&tab=${tab}&dev=${device}`),
      {
        userId: "owner1",
        email: "o@x.com",
        owner: true,
        ...(session ? { session, sessionUntil } : {}),
      },
    );
    return ws;
  };
  /** A signed-in friend's page, even one claiming the owner's session and device. */
  const friendPage = async () => {
    const ws = add();
    await hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=/words&dev=${DEVICE}`),
      { userId: "f1", email: "f1@x.com", owner: false, session: SESSION, sessionUntil: FAR },
    );
    return ws;
  };
  const controller = (q = "") => {
    const ws = add();
    void hub.connectController(
      ws,
      new URL(`https://lianki.com/api/version/debug/control?label=agent${q}`),
    );
    return ws;
  };
  const resume = async (token: string, q = "") => {
    const ws = add();
    await hub.connectController(
      ws,
      new URL(`https://lianki.com/api/version/debug/control?label=${q}`),
      token,
    );
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const pairOf = (p: FakeSocket) =>
    (p.last("state") as { pending: { pair: string } | null }).pending?.pair ?? "";
  const leave = (ws: FakeSocket, code = 1001) => {
    ws.close(code);
    hub.webSocketClose(ws, code);
  };
  /** Pair an eval controller and Allow it on `p` (all pages). */
  const grant = async (p: FakeSocket) => {
    const c = controller();
    await msg(p, { type: "allow", pair: pairOf(p), pages: "all" });
    const token = c.last("approved")?.token as string;
    return { c, token, hash: await hashToken(token) };
  };
  const stored = (hash: string) => storage.store.get(`grant:${hash}`) as Stored | undefined;
  const signOut = (session = SESSION) =>
    hub.fetch(
      new Request("https://lianki-push/internal/signed-out", {
        method: "POST",
        body: JSON.stringify({ session }),
      }),
    );
  return {
    hub,
    storage,
    main,
    ownerPage,
    friendPage,
    controller,
    resume,
    msg,
    pairOf,
    leave,
    grant,
    stored,
    signOut,
    now: () => t,
    tick: (ms: number) => (t += ms),
  };
}

const renewals = (ws: FakeSocket) => ws.sent.filter((m) => m.type === "renewed");
const evals = (ws: FakeSocket) => ws.sent.filter((m) => m.type === "eval");

describe("eval grant renewal: what the Allow binds", () => {
  it("binds the grant to the answering page's device and session, and sets one alarm", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, hash } = await s.grant(p);
    expect(s.stored(hash)?.renew).toEqual({
      device: DEVICE,
      session: SESSION,
      user: "owner1",
      start: T0,
      count: 0,
    });
    expect(c.last("approved")).toMatchObject({ until: T0 + EVAL_GRANT_MS });
    expect(c.last("approved")).toMatchObject({ renewsUntil: T0 + EVAL_CHAIN_MS });
    expect(s.storage.alarm).toBe(T0 + EVAL_GRANT_MS - EVAL_RENEW_BEFORE_MS);
  });

  it("a page with no session (the dev bridge, an older main Worker) binds nothing", async () => {
    const s = setup();
    const p = await s.ownerPage({ session: "" });
    const { c, hash } = await s.grant(p);
    expect(s.stored(hash)?.renew).toBeUndefined();
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    expect(renewals(c)).toEqual([]);
  });
});

describe("eval grant renewal: when it renews", () => {
  it("on use, once less than EVAL_RENEW_BEFORE_MS is left, to EVAL_GRANT_MS from now", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, hash } = await s.grant(p);
    const logs: string[] = [];
    const log = console.log;
    console.log = (x: unknown) => void logs.push(String(x));
    try {
      // Not in the window yet: a use changes nothing.
      s.tick(60_000);
      await s.msg(c, { type: "eval", code: "secretThing()" });
      expect(renewals(c)).toEqual([]);
      s.tick(INTO_WINDOW - 60_000);
      await s.msg(c, { type: "eval", code: "secretThing()" });
    } finally {
      console.log = log;
    }
    const now = T0 + INTO_WINDOW;
    expect(renewals(c)).toEqual([{ type: "renewed", until: now + EVAL_GRANT_MS, count: 1 }]);
    expect(s.stored(hash)).toMatchObject({ until: now + EVAL_GRANT_MS, renew: { count: 1 } });
    // The command that triggered it still ran, and the socket lives past the old end.
    expect(evals(p)).toHaveLength(2);
    s.tick(EVAL_RENEW_BEFORE_MS + 60_000);
    await s.msg(c, { type: "eval", code: "1" });
    expect(c.last("expired")).toBeUndefined();
    expect(evals(p)).toHaveLength(3);
    // Logged with the count and the device, never the code.
    const line = logs.find((l) => l.includes('"debug.renew"')) ?? "{}";
    expect(JSON.parse(line)).toMatchObject({ via: "use", device: DEVICE, count: 1 });
    expect(line).not.toContain("secretThing");
    // The pages' session list shows the new end.
    const st = p.last("state") as unknown as { sessions: { until: number }[] };
    expect(st.sessions[0].until).toBe(now + EVAL_GRANT_MS);
    // The next window: renewed again, the count goes on.
    s.tick(EVAL_GRANT_MS - EVAL_RENEW_BEFORE_MS - 60_000 - 60_000 + 1);
    await s.msg(c, { type: "say", text: "hi" });
    expect(renewals(c).at(-1)).toMatchObject({ count: 2 });
  });

  it("on a resume: `approved` carries the new until", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, token } = await s.grant(p);
    s.leave(c, 1006);
    s.tick(INTO_WINDOW);
    const again = await s.resume(token);
    expect(again.last("approved")).toMatchObject({
      resumed: true,
      until: T0 + INTO_WINDOW + EVAL_GRANT_MS,
    });
  });

  it("at the alarm while the page is there; when the page comes back otherwise", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, hash } = await s.grant(p);
    s.tick(INTO_WINDOW);
    await s.hub.alarm();
    expect(renewals(c)).toHaveLength(1);
    const first = s.stored(hash)?.until as number;
    expect(s.storage.alarm).toBe(first - EVAL_RENEW_BEFORE_MS);
    // The next window opens while the page is away: the alarm finds no page …
    s.leave(p);
    s.tick(INTO_WINDOW);
    await s.hub.alarm();
    expect(renewals(c)).toHaveLength(1);
    // … and the page's return is the event that renews.
    await s.ownerPage();
    expect(renewals(c)).toHaveLength(2);
    expect(s.stored(hash)?.until).toBe(T0 + 2 * INTO_WINDOW + EVAL_GRANT_MS);
  });

  it("never after it ended: a lapsed grant needs a tap", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, token } = await s.grant(p);
    s.leave(c, 1006);
    s.tick(EVAL_GRANT_MS + 1);
    await s.ownerPage({ tab: "phone-tab-2" });
    await s.hub.alarm();
    expect((await s.resume(token)).closed).toBe(4498);
    void p;
  });
});

describe("eval grant renewal: what stops it", () => {
  it("End on the live session: the grant is gone, nothing renews", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { token, hash } = await s.grant(p);
    const st = p.last("state") as unknown as { sessions: { pair: string }[] };
    await s.msg(p, { type: "revoke", pair: st.sessions[0].pair });
    s.tick(INTO_WINDOW);
    await s.hub.alarm();
    await s.ownerPage({ tab: "phone-tab-2" });
    expect(s.stored(hash)).toBeUndefined();
    expect((await s.resume(token)).closed).toBe(4498);
  });

  it("End on the sleeping entry: the same", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, token, hash } = await s.grant(p);
    s.leave(c, 1006);
    const st = p.last("state") as unknown as { sessions: { pair: string; code: string }[] };
    expect(st.sessions[0].code).toBe("idle");
    await s.msg(p, { type: "revoke", pair: st.sessions[0].pair });
    s.tick(INTO_WINDOW);
    await s.hub.alarm();
    expect(s.stored(hash)).toBeUndefined();
    expect((await s.resume(token)).closed).toBe(4498);
  });

  it("sign-out: renewal stops at once, the grant ends at its current until", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, token, hash } = await s.grant(p);
    expect(await (await s.signOut()).json()).toEqual({ ok: true, stopped: 1 });
    expect(s.stored(hash)?.renew).toBeUndefined();
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    await s.hub.alarm();
    await s.ownerPage({ tab: "phone-tab-2" });
    expect(renewals(c)).toEqual([]);
    expect(s.stored(hash)?.until).toBe(T0 + EVAL_GRANT_MS);
    s.tick(EVAL_RENEW_BEFORE_MS);
    await s.msg(c, { type: "eval", code: "1" });
    expect(c.last("expired")).toBeTruthy();
    expect((await s.resume(token)).closed).toBe(4498);
  });

  it("another session's sign-out leaves it alone; a malformed notice is refused", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { hash } = await s.grant(p);
    expect(await (await s.signOut("b".repeat(64))).json()).toEqual({ ok: true, stopped: 0 });
    expect((await s.signOut("nope")).status).toBe(400);
    const at = "https://lianki-push/internal/signed-out";
    expect((await s.hub.fetch(new Request(at))).status).toBe(405);
    expect((await s.hub.fetch(new Request(at, { method: "POST", body: "{" }))).status).toBe(400);
    expect(s.stored(hash)?.renew).toBeTruthy();
  });

  it("a new session on the same device (signed out and in again) does not renew", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c } = await s.grant(p);
    s.leave(p);
    await s.ownerPage({ session: "c".repeat(64) });
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    await s.hub.alarm();
    expect(renewals(c)).toEqual([]);
  });

  it("an expired session's page does not renew", async () => {
    const s = setup();
    const p = await s.ownerPage({ sessionUntil: T0 + 60_000 });
    const { c } = await s.grant(p);
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    expect(renewals(c)).toEqual([]);
  });

  it("a page of a different device, same session, does not renew", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c } = await s.grant(p);
    s.leave(p);
    await s.ownerPage({ device: OTHER_DEVICE, tab: "mac-tab-0001" });
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    await s.hub.alarm();
    expect(renewals(c)).toEqual([]);
  });

  it("the chain cap: never past EVAL_CHAIN_MS from the tap, then it lapses", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, token, hash } = await s.grant(p);
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(500);
      const g = s.stored(hash) as Stored;
      s.tick(Math.max(0, g.until - EVAL_RENEW_BEFORE_MS + 1 - s.now()));
      const before = renewals(c).length;
      await s.msg(c, { type: "eval", code: "1" });
      if (renewals(c).length === before) break;
    }
    const last = renewals(c).at(-1) as { until: number; count: number };
    expect(last.until).toBe(T0 + EVAL_CHAIN_MS);
    expect(s.stored(hash)?.until).toBe(T0 + EVAL_CHAIN_MS);
    // At the cap the alarm and the page change nothing either.
    await s.hub.alarm();
    await s.ownerPage({ tab: "phone-tab-2" });
    expect(renewals(c).length).toBe(last.count);
    s.tick(T0 + EVAL_CHAIN_MS - s.now());
    await s.msg(c, { type: "eval", code: "1" });
    expect(c.closed).toBe(4408);
    expect((await s.resume(token)).closed).toBe(4498);
    void p;
  });
});

describe("eval grant renewal: never for anyone but the owner", () => {
  it("never a friend's preview (one socket, APPROVAL_MS, no token)", async () => {
    const s = setup();
    const owner = await s.ownerPage();
    const chat = s.controller("&scope=chat");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner) });
    const chatToken = chat.last("approved")?.token as string;
    const f = await s.friendPage();
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const preview = new FakeSocket();
    (s.hub as unknown as { ctx: { getWebSockets(): FakeSocket[] } }).ctx
      .getWebSockets()
      .push(preview);
    await s.hub.connectController(
      preview,
      new URL("https://lianki.com/api/version/debug/control?label=agent&for=f1%40x.com"),
      chatToken,
    );
    await s.msg(f, { type: "allow", pair: s.pairOf(f) });
    expect(preview.last("approved")).toMatchObject({ until: T0 + APPROVAL_MS });
    expect(preview.last("approved")?.token).toBeUndefined();
    s.tick(APPROVAL_MS - 60_000);
    await s.msg(preview, { type: "eval", code: "1" });
    await s.hub.alarm();
    expect(renewals(preview)).toEqual([]);
    s.tick(60_000);
    await s.msg(preview, { type: "eval", code: "1" });
    expect(preview.last("expired")).toBeTruthy();
    // A friend's page holds no session nor device in the hub, whatever it claims.
    const fa = f.deserializeAttachment() as { session?: string; device?: string };
    expect(fa.session).toBeUndefined();
    expect(fa.device).toBeUndefined();
  });

  it("a friend's page (claiming the owner's session and device) cannot renew the owner's grant", async () => {
    const s = setup();
    const owner = await s.ownerPage();
    const { c } = await s.grant(owner);
    s.leave(owner);
    await s.friendPage();
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    await s.hub.alarm();
    expect(renewals(c)).toEqual([]);
  });

  it("a chat grant is never renewed", async () => {
    const s = setup();
    const owner = await s.ownerPage();
    const chat = s.controller("&scope=chat");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner) });
    const hash = await hashToken(chat.last("approved")?.token as string);
    expect(s.stored(hash)?.renew).toBeUndefined();
    s.tick(CHAT_MS - 60_000);
    await s.msg(chat, { type: "say", text: "hi" });
    expect(renewals(chat)).toEqual([]);
    expect(s.stored(hash)?.until).toBe(T0 + CHAT_MS);
  });
});

describe("the main Worker's sign-out notice", () => {
  /** A PUSH binding that fails while `down`, recording what it was sent. */
  const pushStub = (route?: (req: Request) => Promise<Response>) => {
    const p = {
      down: false as boolean | "throw",
      seen: [] as { url: string; body: string }[],
      fetch: async (url: string, init?: RequestInit) => {
        p.seen.push({ url, body: String(init?.body) });
        if (p.down === "throw") throw new Error("push down");
        if (p.down) return new Response("no", { status: 503 });
        return route ? route(new Request(url, init)) : new Response("{}");
      },
    };
    return p;
  };
  /** Deps with a D1 outbox (the real migration), a clock, and waitUntil collected. */
  const deps = async (push: ReturnType<typeof pushStub> | null) => {
    const db = new TestD1Database();
    await db.exec(readFileSync("db/migrations/0023_debug_signout_outbox.sql", "utf8"));
    let t = T0;
    const pending: Promise<unknown>[] = [];
    const d: NoticeDeps = {
      push,
      db: db as unknown as OutboxDb,
      now: () => t,
      sleep: async () => {},
      later: (p) => void pending.push(p),
    };
    const rows = async () =>
      (await db.prepare("SELECT * FROM debug_signout_outbox").all<Record<string, number>>())
        .results;
    return { d, db, rows, pending, tick: (ms: number) => (t += ms) };
  };
  const quiet = async (f: () => Promise<unknown>) => {
    const err = console.error;
    console.error = () => {};
    try {
      await f();
    } finally {
      console.error = err;
    }
  };

  it("posts only the session's tag to lianki-push; nothing queued once acknowledged", async () => {
    const push = pushStub();
    const x = await deps(push);
    await notifySignedOut("sess-1", x.d);
    expect(push.seen).toEqual([
      {
        url: "https://lianki-push/internal/signed-out",
        body: JSON.stringify({ session: await sessionTag("sess-1") }),
      },
    ]);
    expect(push.seen[0].body).not.toContain("sess-1");
    expect(await x.rows()).toEqual([]);
    // No binding (dev, QA), or no id: nothing at all. The real deps off a Worker: none.
    await notifySignedOut("sess-1", { ...x.d, push: null });
    await notifySignedOut("", x.d);
    await notifySignedOut("sess-1");
    await flushSignedOut();
    flushSignedOutSoon();
    expect(push.seen).toHaveLength(1);
  });

  it("a failed notice is kept in the outbox before sign-out returns, then retried until acknowledged", async () => {
    const push = pushStub();
    push.down = true;
    const x = await deps(push);
    const tag = await sessionTag("sess-1");
    await quiet(() => notifySignedOut("sess-1", x.d));
    expect(await x.rows()).toMatchObject([{ tag, tries: 0, next_ms: T0 + outboxBackoff(0) }]);
    // The in-request retries (waitUntil) all fail: the row stays.
    await quiet(() => Promise.all(x.pending));
    expect(push.seen).toHaveLength(1 + RETRY_MS.length);
    expect(await x.rows()).toHaveLength(1);
    // A later event: not due yet, then due but failing (backoff grows), then acknowledged.
    await quiet(() => flushSignedOut(x.d));
    expect(push.seen).toHaveLength(1 + RETRY_MS.length);
    x.tick(outboxBackoff(0));
    push.down = "throw";
    await quiet(() => flushSignedOut(x.d));
    expect(await x.rows()).toMatchObject([
      { tries: 1, next_ms: T0 + outboxBackoff(0) + outboxBackoff(1) },
    ]);
    x.tick(outboxBackoff(1));
    push.down = false;
    await flushSignedOut(x.d);
    expect(await x.rows()).toEqual([]);
    expect(outboxBackoff(20)).toBe(60 * 60_000);
  });

  it("an in-request retry that gets through clears the outbox", async () => {
    const push = pushStub();
    push.down = true;
    const x = await deps(push);
    await quiet(() => notifySignedOut("sess-1", x.d));
    push.down = false;
    await Promise.all(x.pending);
    expect(await x.rows()).toEqual([]);
  });

  it("a notice no chain could still use is dropped unsent; a broken outbox never throws", async () => {
    const push = pushStub();
    push.down = true;
    const x = await deps(push);
    await quiet(async () => {
      await notifySignedOut("sess-1", x.d);
      await Promise.all(x.pending);
    });
    x.tick(EVAL_CHAIN_MS + 1);
    const before = push.seen.length;
    await flushSignedOut(x.d);
    expect(await x.rows()).toEqual([]);
    expect(push.seen).toHaveLength(before);
    const broken = {
      prepare: () => {
        throw new Error("no such table");
      },
    } as unknown as OutboxDb;
    await quiet(async () => {
      await notifySignedOut("sess-2", { ...x.d, db: broken });
      await Promise.all(x.pending);
    });
    await quiet(() => flushSignedOut({ ...x.d, db: broken }));
    const later: Promise<unknown>[] = [];
    flushSignedOutSoon({ ...x.d, later: (p) => void later.push(p) });
    expect(later).toHaveLength(1);
  });

  it("reaches the hub end to end: the grant stops renewing, the page loses the session", async () => {
    const s = setup();
    const tag = await sessionTag("sess-9");
    s.main.live.add(tag);
    const p = await s.ownerPage({ session: tag });
    const { hash } = await s.grant(p);
    const x = await deps(pushStub((req) => s.hub.fetch(req)));
    await notifySignedOut("sess-9", x.d);
    expect(s.stored(hash)?.renew).toBeUndefined();
    const a = p.deserializeAttachment() as {
      session?: string;
      sessionUntil?: number;
      user?: string;
    };
    expect([a.session, a.sessionUntil, a.user]).toEqual([undefined, undefined, undefined]);
  });

  it("a lost notice: the next renewal asks the auth db, which says gone — no renewal", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, hash } = await s.grant(p);
    // Sign-out: the session leaves the auth db, but lianki-push never hears of it.
    const push = pushStub();
    push.down = "throw";
    const x = await deps(push);
    await quiet(() => notifySignedOut("whatever-id", x.d));
    await quiet(() => Promise.all(x.pending));
    s.main.live.delete(SESSION);
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    expect(renewals(c)).toEqual([]);
    expect(s.main.calls.at(-1)?.body).toEqual({ user: "owner1", session: SESSION });
    // "Gone" is definite: the chain is dropped and the stale page no longer vouches.
    expect(s.stored(hash)?.renew).toBeUndefined();
    expect((p.deserializeAttachment() as { session?: string }).session).toBeUndefined();
  });
});

describe("eval grant renewal: the live-session check fails closed", () => {
  for (const mode of ["throw", "500", "odd"] as const)
    it(`main Worker ${mode}: no renewal, the chain is kept for when it answers`, async () => {
      const s = setup();
      const p = await s.ownerPage();
      const { c, hash } = await s.grant(p);
      s.main.mode = mode;
      s.tick(INTO_WINDOW);
      await s.msg(c, { type: "eval", code: "1" });
      expect(renewals(c)).toEqual([]);
      expect(s.stored(hash)?.renew).toBeTruthy();
      s.main.mode = "db";
      await s.msg(c, { type: "eval", code: "1" });
      expect(renewals(c)).toHaveLength(1);
    });

  it("no MAIN binding: never renews", async () => {
    const s = setup({ noMain: true });
    const p = await s.ownerPage();
    const { c } = await s.grant(p);
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    expect(renewals(c)).toEqual([]);
  });

  it("a grant bound without the owner's user id (an older hub) never renews", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, hash } = await s.grant(p);
    const g = s.storage.store.get(`grant:${hash}`) as { renew: Record<string, unknown> };
    delete g.renew.user;
    (s.hub as unknown as { grants?: unknown }).grants = undefined;
    s.tick(INTO_WINDOW);
    await s.msg(c, { type: "eval", code: "1" });
    expect(renewals(c)).toEqual([]);
    expect(s.main.calls).toEqual([]);
  });

  it("the check is made only when a renewal is otherwise due", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c } = await s.grant(p);
    s.tick(60_000);
    await s.msg(c, { type: "eval", code: "1" });
    await s.hub.alarm();
    expect(s.main.calls).toEqual([]);
  });
});

describe("eval grant renewal: the alarm always moves forward", () => {
  it("at exactly EVAL_RENEW_BEFORE_MS left it renews, and the next alarm is later", async () => {
    const s = setup();
    const p = await s.ownerPage();
    const { c, hash } = await s.grant(p);
    s.tick(EVAL_GRANT_MS - EVAL_RENEW_BEFORE_MS);
    expect(s.storage.alarm).toBe(s.now());
    await s.hub.alarm();
    expect(renewals(c)).toHaveLength(1);
    expect(s.storage.alarm as number).toBeGreaterThan(s.now());
    expect(s.storage.alarm).toBe((s.stored(hash)?.until as number) - EVAL_RENEW_BEFORE_MS);
  });

  it("not due yet: the alarm is set strictly after now", async () => {
    const s = setup();
    const p = await s.ownerPage();
    await s.grant(p);
    s.storage.alarm = null;
    s.tick(EVAL_GRANT_MS - EVAL_RENEW_BEFORE_MS - 1);
    await s.hub.alarm();
    expect(s.storage.alarm as number | null).toBe(s.now() + 1);
  });
});

describe("the main Worker's live-session lookup", () => {
  const OWNER = "owner@x.com";
  const lookup = (sessions: { id: string; expiresAt: Date | number }[], email = OWNER) => ({
    emailOf: async (id: string) => (id === "u1" ? email : null),
    sessionsOf: async () => sessions,
    isOwner: (e: string | null | undefined) => e === OWNER,
    now: () => T0,
  });

  it("live only for the owner's unexpired session with that tag", async () => {
    const tag = await sessionTag("s1");
    const db = lookup([{ id: "s1", expiresAt: new Date(T0 + 1) }]);
    expect(await sessionLive("u1", tag, db)).toBe(true);
    expect(await sessionLive("u1", await sessionTag("s2"), db)).toBe(false);
    expect(await sessionLive("u1", tag, lookup([{ id: "s1", expiresAt: T0 }]))).toBe(false);
    expect(await sessionLive("u1", tag, lookup([{ id: "s1", expiresAt: T0 + 1 }], "f@x.com"))).toBe(
      false,
    );
    expect(await sessionLive("u2", tag, db)).toBe(false);
    expect(await sessionLive("u1", "s1", db)).toBe(false);
    expect(await sessionLive(undefined, tag, db)).toBe(false);
    expect(await sessionLive("u1", tag, { ...db, now: undefined })).toBe(false);
  });
});

describe("session tags", () => {
  it("are a SHA-256 hex of the session id, never the id", async () => {
    const tag = await sessionTag("sess-123");
    expect(isSessionTag(tag)).toBe(true);
    expect(tag).not.toContain("sess-123");
    expect(await sessionTag("sess-123")).toBe(tag);
    expect(await sessionTag("sess-124")).not.toBe(tag);
    expect(isSessionTag("A".repeat(64))).toBe(false);
  });
});
