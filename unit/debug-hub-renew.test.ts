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
import { notifySignedOut } from "@/lib/push-signed-out";

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
  renew?: { device: string; session: string; start: number; count: number };
};

function setup() {
  const sockets: FakeSocket[] = [];
  let t = T0;
  const storage = fakeStorage();
  const hub = new DebugHub(
    { acceptWebSocket: () => {}, getWebSockets: () => sockets, storage },
    undefined,
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
  it("posts only the session's tag to lianki-push, and never throws", async () => {
    const seen: { url: string; body: string }[] = [];
    const ok = {
      fetch: async (url: string, init?: RequestInit) => {
        seen.push({ url, body: String(init?.body) });
        return new Response("{}");
      },
    };
    await notifySignedOut("sess-1", ok);
    expect(seen).toEqual([
      {
        url: "https://lianki-push/internal/signed-out",
        body: JSON.stringify({ session: await sessionTag("sess-1") }),
      },
    ]);
    expect(seen[0].body).not.toContain("sess-1");
    const err = console.error;
    console.error = () => {};
    try {
      await notifySignedOut("sess-1", { fetch: async () => new Response("no", { status: 500 }) });
      await notifySignedOut("sess-1", {
        fetch: async () => {
          throw new Error("down");
        },
      });
    } finally {
      console.error = err;
    }
    // No binding (dev, QA), or no id: nothing at all.
    await notifySignedOut("sess-1", null);
    await notifySignedOut("", ok);
    await notifySignedOut("sess-1");
    expect(seen).toHaveLength(1);
  });

  it("reaches the hub end to end: the bound grant stops renewing", async () => {
    const s = setup();
    const p = await s.ownerPage({ session: await sessionTag("sess-9") });
    const { hash } = await s.grant(p);
    await notifySignedOut("sess-9", { fetch: (url, init) => s.hub.fetch(new Request(url, init)) });
    expect(s.stored(hash)?.renew).toBeUndefined();
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
