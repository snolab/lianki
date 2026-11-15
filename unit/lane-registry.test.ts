/**
 * The lane registry (workers/push/src/lane-registry.ts; docs/lane-listen.md,
 * "Every agent joins"): mode transitions and their system lines, pure and
 * through the real DebugHub (token-chat.ts), mute enforcement, the presence
 * payload's mode, and that nothing changes with flag chat.lane-events off.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import {
  LANE_EVENT_LABEL,
  type LaneHost,
  type LaneReg,
  LaneRegistry,
  MUTED_REASON,
  isPinnedLane,
  laneEventLine,
  laneRegKey,
  laneStep,
} from "@/workers/push/src/lane-registry";
import { laneShownName } from "@/workers/push/src/token-chat";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { createToken, type ScopeId } from "@/lib/api-tokens";
import { chatTokenCheck, type ChatTokenDb } from "@/lib/chat-token";
import type { Present } from "@/packages/debug-chat/src/presence";
import type { ChatMessage } from "@/packages/debug-chat/src/wire";

const T0 = Date.parse("2026-11-15T01:00:00Z");
const DAY = 86_400_000;
const ctx = (now = T0, lane = "rechrome") => ({ lane, thread: "owner", now });

describe("laneStep: the transitions", () => {
  it("a first use joins as a reader; a listen makes it a listener", () => {
    const a = laneStep(undefined, { type: "seen" }, ctx());
    expect(a.next).toMatchObject({ lane: "rechrome", state: "reader", seenAt: T0 });
    expect(a.event).toBe("joined");
    const b = laneStep(a.next, { type: "seen" }, ctx(T0 + 5));
    expect(b.event).toBeUndefined();
    expect(b.next.seenAt).toBe(T0 + 5);
    const c = laneStep(b.next, { type: "listen" }, ctx(T0 + 6));
    expect(c).toMatchObject({ event: "listening", next: { state: "listener" } });
    // A second socket of a listener says nothing.
    expect(laneStep(c.next, { type: "listen" }, ctx(T0 + 7)).event).toBeUndefined();
    // A use while it listens keeps it a listener.
    expect(laneStep(c.next, { type: "seen" }, ctx(T0 + 8)).next.state).toBe("listener");
  });
  it("a listener going down turns reader after the grace, and a reconnect in it says nothing", () => {
    const l = laneStep(undefined, { type: "listen" }, ctx()).next;
    const down = laneStep(l, { type: "unlisten", graceMs: 30_000 }, ctx(T0 + 1));
    expect(down).toMatchObject({
      dueAt: T0 + 30_001,
      next: { state: "listener", downAt: T0 + 30_001 },
    });
    expect(down.event).toBeUndefined();
    // Not yet due.
    expect(laneStep(down.next, { type: "due" }, ctx(T0 + 2)).event).toBeUndefined();
    // Back within the grace: still a listener, the downAt gone.
    const back = laneStep(down.next, { type: "listen" }, ctx(T0 + 3));
    expect(back.event).toBeUndefined();
    expect(back.next.downAt).toBeUndefined();
    // Due: a reader.
    const due = laneStep(down.next, { type: "due" }, ctx(T0 + 30_001));
    expect(due).toMatchObject({ event: "reader", next: { state: "reader" } });
    expect(due.next.downAt).toBeUndefined();
    // No grace: at once.
    expect(laneStep(l, { type: "unlisten", graceMs: 0 }, ctx()).event).toBe("reader");
    // Not a listener: nothing.
    const r = laneStep(undefined, { type: "seen" }, ctx()).next;
    expect(laneStep(r, { type: "unlisten", graceMs: 0 }, ctx()).next).toBe(r);
    expect(laneStep(r, { type: "due" }, ctx()).next).toBe(r);
    expect(laneStep(undefined, { type: "due" }, ctx()).next.state).toBe("left");
  });
  it("reader, leave, rejoin", () => {
    const l = laneStep(undefined, { type: "listen" }, ctx()).next;
    expect(laneStep(l, { type: "reader" }, ctx()).event).toBe("reader");
    expect(laneStep(undefined, { type: "reader" }, ctx()).event).toBe("joined");
    const r = laneStep(undefined, { type: "seen" }, ctx()).next;
    const again = laneStep(r, { type: "reader" }, ctx(T0 + 9));
    expect(again.event).toBeUndefined();
    expect(again.next).toMatchObject({ state: "reader", seenAt: T0 + 9 });
    const left = laneStep(r, { type: "leave" }, ctx());
    expect(left).toMatchObject({ event: "left", next: { state: "left" } });
    expect(laneStep(left.next, { type: "leave" }, ctx()).event).toBeUndefined();
    expect(laneStep(undefined, { type: "leave" }, ctx()).event).toBeUndefined();
    // Back after leaving: joined again.
    expect(laneStep(left.next, { type: "seen" }, ctx()).event).toBe("joined");
  });
  it("mute and unmute, once each", () => {
    const r = laneStep(undefined, { type: "seen" }, ctx()).next;
    const m = laneStep(r, { type: "mute", muted: true }, ctx());
    expect(m).toMatchObject({ event: "muted", next: { muted: true, state: "reader" } });
    expect(laneStep(m.next, { type: "mute", muted: true }, ctx()).event).toBeUndefined();
    const u = laneStep(m.next, { type: "mute", muted: false }, ctx());
    expect(u.event).toBe("unmuted");
    expect(u.next.muted).toBeUndefined();
    expect(laneStep(undefined, { type: "mute", muted: false }, ctx()).event).toBeUndefined();
  });
  it("Li (the main lane) is always a listener: never downgraded, never leaves", () => {
    expect(isPinnedLane("main")).toBe(true);
    expect(isPinnedLane("chat")).toBe(true);
    expect(isPinnedLane("codex")).toBe(false);
    const c = ctx(T0, "main");
    const first = laneStep(undefined, { type: "seen" }, c);
    expect(first).toMatchObject({ event: "listening", next: { state: "listener" } });
    expect(laneStep(first.next, { type: "unlisten", graceMs: 0 }, c).next.state).toBe("listener");
    expect(laneStep(first.next, { type: "reader" }, c).next.state).toBe("listener");
    expect(laneStep(first.next, { type: "leave" }, c).event).toBeUndefined();
  });
  it("the system line: quiet, labelled lanes, laneEvent set, text in the locale", () => {
    const l = laneEventLine(
      { lane: "codex", name: "coco", kind: "listening" },
      "owner",
      T0,
      "zh",
      "abc",
    );
    expect(l).toMatchObject({
      id: "abc",
      from: "agent",
      label: LANE_EVENT_LABEL,
      text: "coco 开始实时监听",
      quiet: true,
      laneEvent: { lane: "codex", name: "coco", kind: "listening" },
    });
    expect(laneEventLine({ lane: "x", name: "x", kind: "left" }, "owner", T0, "en", "i").text).toBe(
      "x went offline",
    );
  });
  it("a lane's shown name: the owner's for it, its lane's, else the token's", () => {
    expect(laneShownName("codex")).toBe("coco");
    expect(laneShownName("agy")).toBe("哈基米");
    expect(laneShownName("codex", "Coco!")).toBe("Coco!");
    expect(laneShownName("rechrome-codex-1")).toBe("rechrome-codex-1");
    expect(laneShownName("main")).toBe("main");
  });
});

/** A registry over a Map, with its posts and schedules recorded. */
function fakeRegistry(enabled = true, list = true) {
  const store = new Map<string, unknown>();
  const posts: ChatMessage[] = [];
  const due: number[] = [];
  const touched: string[] = [];
  let now = T0;
  const host: LaneHost = {
    now: () => now,
    kv: {
      get: async <T>(k: string) => store.get(k) as T | undefined,
      put: async (k, v) => void store.set(k, v),
      ...(list
        ? {
            list: async <T>(prefix: string) =>
              [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v as T),
          }
        : {}),
    },
    post: async (m) => void posts.push(m),
    enabled: async () => enabled,
    graceMs: async () => 1000,
    locale: async () => "en",
    schedule: async (at) => void due.push(at),
    presence: (thread) => void touched.push(thread),
  };
  return {
    reg: new LaneRegistry(host),
    store,
    posts,
    due,
    touched,
    at: (t: number) => {
      now = t;
    },
  };
}

describe("laneStep: scope (tier ① all messages vs ② the owner's)", () => {
  it("a listener with scope all says so; a reconnect says nothing; only an upgrade is said", () => {
    const a = laneStep(undefined, { type: "listen", scope: "all" }, ctx());
    expect(a).toMatchObject({ event: "listeningAll", next: { state: "listener", scope: "all" } });
    // Again with all, or with no scope (the alarm, an older client): nothing.
    expect(laneStep(a.next, { type: "listen", scope: "all" }, ctx(T0 + 1)).event).toBeUndefined();
    const kept = laneStep(a.next, { type: "listen" }, ctx(T0 + 1));
    expect(kept.event).toBeUndefined();
    expect(kept.next.scope).toBe("all");
    // A drop to the owner's with no grace: at once, silently (it still listens).
    const down = laneStep(a.next, { type: "listen", scope: "owner" }, ctx(T0 + 2));
    expect(down.event).toBeUndefined();
    expect(down.next).toMatchObject({ state: "listener", changedAt: T0 + 2 });
    expect(down.next.scope).toBeUndefined();
    const up = laneStep(down.next, { type: "listen", scope: "all" }, ctx(T0 + 3));
    expect(up).toMatchObject({ event: "listeningAll", next: { scope: "all" } });
    // A listener with no scope: the owner's; turned reader, the scope goes.
    expect(laneStep(undefined, { type: "listen" }, ctx()).event).toBe("listening");
    const r = laneStep(up.next, { type: "unlisten", graceMs: 0 }, ctx(T0 + 4));
    expect(r.event).toBe("reader");
    expect(r.next.scope).toBeUndefined();
    // Muting keeps the scope.
    expect(laneStep(up.next, { type: "mute", muted: true }, ctx(T0 + 5)).next.scope).toBe("all");
  });
});

describe("laneStep: one lane, several sockets", () => {
  it("a drop from all waits the grace; an upgrade in it says nothing; due drops it silently", () => {
    const a = laneStep(undefined, { type: "listen", scope: "all" }, ctx()).next;
    const down = laneStep(a, { type: "listen", scope: "owner", graceMs: 30_000 }, ctx(T0 + 1));
    expect(down).toMatchObject({
      dueAt: T0 + 30_001,
      next: { scope: "all", scopeDownAt: T0 + 30_001 },
    });
    expect(down.event).toBeUndefined();
    // Another owner-only socket in the grace keeps the first deadline.
    const again = laneStep(
      down.next,
      { type: "listen", scope: "owner", graceMs: 30_000 },
      ctx(T0 + 9),
    );
    expect(again.next.scopeDownAt).toBe(T0 + 30_001);
    // No scope (the alarm): kept, the pending drop too.
    expect(laneStep(down.next, { type: "listen" }, ctx(T0 + 2)).next.scopeDownAt).toBe(T0 + 30_001);
    // Back to all in the grace: nothing said, the drop gone.
    const up = laneStep(down.next, { type: "listen", scope: "all", graceMs: 30_000 }, ctx(T0 + 3));
    expect(up.event).toBeUndefined();
    expect(up.next.scope).toBe("all");
    expect(up.next.scopeDownAt).toBeUndefined();
    // Not yet due: unchanged.
    expect(laneStep(down.next, { type: "due" }, ctx(T0 + 5)).next).toBe(down.next);
    // Due: the owner's, silently, still a listener.
    const due = laneStep(down.next, { type: "due" }, ctx(T0 + 30_001));
    expect(due.event).toBeUndefined();
    expect(due.next).toMatchObject({ state: "listener" });
    expect(due.next.scope).toBeUndefined();
    expect(due.next.scopeDownAt).toBeUndefined();
    // Then all again: one line.
    expect(laneStep(due.next, { type: "listen", scope: "all" }, ctx(T0 + 30_002)).event).toBe(
      "listeningAll",
    );
    // The last socket closes after it: the reader line, the pending drop gone with the scope.
    const gone = laneStep(down.next, { type: "unlisten", graceMs: 0 }, ctx(T0 + 4));
    expect(gone.event).toBe("reader");
    expect(gone.next.scopeDownAt).toBeUndefined();
  });
});

describe("laneStep: scope system (tier ⓪, owner 2026-11-16 02:16 JST)", () => {
  it("system says its own line; all → system widens, system → all narrows (graced, silent)", () => {
    const a = laneStep(undefined, { type: "listen", scope: "system" }, ctx());
    expect(a).toMatchObject({
      event: "listeningSystem",
      next: { state: "listener", scope: "system" },
    });
    expect(
      laneStep(a.next, { type: "listen", scope: "system" }, ctx(T0 + 1)).event,
    ).toBeUndefined();
    // all → system: widened, said once.
    const all = laneStep(undefined, { type: "listen", scope: "all" }, ctx()).next;
    const up = laneStep(all, { type: "listen", scope: "system" }, ctx(T0 + 1));
    expect(up).toMatchObject({ event: "listeningSystem", next: { scope: "system" } });
    // system → all with no grace: at once, silent.
    const now = laneStep(up.next, { type: "listen", scope: "all" }, ctx(T0 + 2));
    expect(now.event).toBeUndefined();
    expect(now.next.scope).toBe("all");
    // system → all with a grace: pending to "all", then due.
    const down = laneStep(up.next, { type: "listen", scope: "all", graceMs: 1000 }, ctx(T0 + 2));
    expect(down).toMatchObject({
      dueAt: T0 + 1002,
      next: { scope: "system", scopeDownAt: T0 + 1002, scopeDownTo: "all" },
    });
    // The alarm with no scope keeps the pending narrowing, target and all.
    expect(laneStep(down.next, { type: "listen" }, ctx(T0 + 3)).next).toMatchObject({
      scopeDownAt: T0 + 1002,
      scopeDownTo: "all",
    });
    // Narrower still (owner) while pending: the same time, down to the owner's.
    const lower = laneStep(
      down.next,
      { type: "listen", scope: "owner", graceMs: 1000 },
      ctx(T0 + 4),
    );
    expect(lower.next.scopeDownAt).toBe(T0 + 1002);
    expect(lower.next.scopeDownTo).toBeUndefined();
    const due = laneStep(down.next, { type: "due" }, ctx(T0 + 1002));
    expect(due.event).toBeUndefined();
    expect(due.next.scope).toBe("all");
    expect(due.next.scopeDownAt).toBeUndefined();
    expect(due.next.scopeDownTo).toBeUndefined();
    // A system socket is back before the end: the narrowing is off.
    const back = laneStep(down.next, { type: "listen", scope: "system" }, ctx(T0 + 5));
    expect(back.event).toBeUndefined();
    expect(back.next).toMatchObject({ scope: "system" });
    expect(back.next.scopeDownAt).toBeUndefined();
    expect(back.next.scopeDownTo).toBeUndefined();
    // Turned reader: the scope and any pending narrowing go.
    const r = laneStep(down.next, { type: "unlisten", graceMs: 0 }, ctx(T0 + 6));
    expect(r.next.scope).toBeUndefined();
    expect(r.next.scopeDownTo).toBeUndefined();
  });
});

describe("LaneRegistry", () => {
  it("two inputs at once on one row: one line (they run in turn)", async () => {
    const f = fakeRegistry();
    await Promise.all([
      f.reg.listen("owner", "agy", "owner"),
      f.reg.listen("owner", "agy", "owner"),
    ]);
    expect(f.posts.map((p) => p.text)).toEqual(["agy is now listening live"]);
  });
  it("the sweep drops a lost all once its grace is over, and keeps it while a socket hears all", async () => {
    const f = fakeRegistry();
    await f.reg.listen("owner", "claude", "all");
    await f.reg.listen("owner", "claude", "owner");
    expect(f.due).toEqual([T0 + 1000]);
    // An all-socket is back by the alarm: kept, nothing scheduled.
    await f.reg.sweep(() => "all");
    expect((f.store.get(laneRegKey("owner", "claude")) as LaneReg).scopeDownAt).toBeUndefined();
    await f.reg.listen("owner", "claude", "owner");
    // Still owner-only and not yet due: scheduled again.
    await f.reg.sweep(() => "owner");
    f.at(T0 + 1000);
    await f.reg.sweep(() => "owner");
    const r = f.store.get(laneRegKey("owner", "claude")) as LaneReg;
    expect(r).toMatchObject({ state: "listener" });
    expect(r.scope).toBeUndefined();
    expect(f.posts).toHaveLength(1);
    // A presence refresh for the scope change.
    expect(f.touched.length).toBeGreaterThanOrEqual(2);
  });

  it("applies, posts, keeps the name, schedules, sweeps", async () => {
    const f = fakeRegistry();
    await f.reg.apply("owner", "rechrome", { type: "listen" }, "小镀");
    expect(f.posts.map((p) => p.text)).toEqual(["小镀 is now listening live"]);
    expect((f.store.get(laneRegKey("owner", "rechrome")) as LaneReg).name).toBe("小镀");
    expect(f.touched).toEqual(["owner"]);
    await f.reg.unlisten("owner", "rechrome");
    expect(f.due).toEqual([T0 + 1000]);
    // Swept before it is due: scheduled again, nothing said.
    await f.reg.sweep(() => false);
    expect(f.due).toEqual([T0 + 1000, T0 + 1000]);
    f.at(T0 + 1000);
    await f.reg.sweep(() => false);
    // The kept name names it on the alarm's line.
    expect(f.posts.at(-1)?.text).toBe("小镀 switched to read-only");
    expect(await f.reg.list("owner")).toHaveLength(1);
    expect(await f.reg.list()).toHaveLength(1);
    expect(await f.reg.muted("owner", "rechrome")).toBe(false);
    await f.reg.apply("owner", "rechrome", { type: "mute", muted: true });
    expect(await f.reg.muted("owner", "rechrome")).toBe(true);
  });
  it("a sweep finds the lane listening again: back to a listener, no line", async () => {
    const f = fakeRegistry();
    await f.reg.apply("owner", "x", { type: "listen" });
    await f.reg.unlisten("owner", "x");
    f.at(T0 + 5000);
    await f.reg.sweep(() => true);
    expect(f.posts).toHaveLength(1);
    expect((f.store.get(laneRegKey("owner", "x")) as LaneReg).downAt).toBeUndefined();
  });
  it("off: nothing kept, nothing said, nothing muted", async () => {
    const f = fakeRegistry(false);
    expect(await f.reg.apply("owner", "x", { type: "listen" })).toBeNull();
    await f.reg.sweep(() => false);
    expect(await f.reg.muted("owner", "x")).toBe(false);
    expect(f.store.size).toBe(0);
    expect(f.posts).toHaveLength(0);
    // A storage without list: no rows to list.
    expect(await fakeRegistry(true, false).reg.list()).toEqual([]);
  });
});

// ---- Through the hub -----------------------------------------------------

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
  lastPresent() {
    return (this.of("present").at(-1)?.list ?? []) as Present[];
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
const CHAT: ScopeId[] = ["chat:read", "chat:write", "chat:ask"];
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  d1 = createTestD1(testSchema());
  t = T0;
  const raw = d1.raw();
  raw
    .prepare(
      "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-11-01', '2026-11-01')",
    )
    .run(OWNER.userId, OWNER.email);
  raw.prepare("DELETE FROM account_permission").run();
  raw
    .prepare(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES (?, 'dev', 'test', 1)",
    )
    .run(OWNER.email);
});

const mint = (name: string, scopes = CHAT) =>
  createToken(db(), OWNER, { name, scopes, expiresAt: new Date(t + 30 * DAY) }, t);

function hubSetup(opts: { flag?: boolean; graceSec?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const store = new Map<string, unknown>();
  /** A hub over the store and the sockets; a second one is the same Durable Object woken from hibernation. */
  const make = () =>
    new DebugHub(
      {
        acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
        getWebSockets: () => sockets,
        storage: fakeStorage(store),
      },
      {
        SESSIONS: {
          live: async () => "gone",
          chatToken: (req: unknown) => chatTokenCheck(db(), req, t),
          flag: async (key: string) => (key === "chat.lane-events" ? (opts.flag ?? true) : false),
          config: async (key: string) =>
            key === "lanes.modeGraceSec"
              ? (opts.graceSec ?? 0)
              : key === "lanes.eventLocale"
                ? "zh"
                : key === "chat.presenceReadMin"
                  ? 5
                  : undefined,
        },
      },
      () => t,
    );
  let hub = make();
  const http = async (token: string, body: unknown) => {
    const r = await hub.fetch(
      new Request("https://lianki.com/api/version/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const listen = async (token: string, extra: Record<string, unknown> = {}, client?: string) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    hub["tokens"].opened(ws, client);
    await hub.webSocketMessage(ws, JSON.stringify({ type: "auth", token, ...extra }));
    await flush();
    return ws;
  };
  const ownerPage = async () => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(ws, new URL("https://lianki.com/api/version/debug?label=%2Fwords"), {
      ...OWNER,
      owner: true,
      session: "sess1",
      sessionUntil: t + DAY,
    });
    await flush();
    return ws;
  };
  const leave = async (ws: FakeSocket) => {
    ws.readyState = 3;
    await hub.webSocketClose(ws, 1000);
    await flush();
  };
  /** The system lines a page got, as text. */
  const events = (page: FakeSocket) =>
    page
      .of("chat")
      .map((m) => m.message as ChatMessage)
      .filter((m) => m.laneEvent)
      .map((m) => m.text);
  /** Hibernation: the in-memory hub is gone; a new one wakes over the same storage and attached sockets. */
  const wake = () => {
    hub = make();
    return hub;
  };
  return {
    get hub() {
      return hub;
    },
    wake,
    sockets,
    store,
    http,
    listen,
    ownerPage,
    leave,
    events,
  };
}

describe("the hub: modes and system lines", () => {
  it("scope all: its own line, the presence row carries it; an older client is owner", async () => {
    const h = hubSetup({ graceSec: 30 });
    const page = await h.ownerPage();
    const k = await mint("claude");
    const ws = await h.listen(k.token, { mode: "listener", scope: "all" });
    expect(h.events(page)).toEqual(["小克 开始实时监听（全部消息）"]);
    expect(page.lastPresent().find((x) => x.key === "lane:claude")).toMatchObject({
      mode: "listener",
      scope: "all",
    });
    expect(ws.deserializeAttachment()).toMatchObject({ listener: true, scope: "all" });
    // {type:"lane", state:"listener"} on that socket keeps its scope: nothing new said.
    await h.hub.webSocketMessage(ws, JSON.stringify({ type: "lane", state: "listener" }));
    await flush();
    expect(h.events(page)).toEqual(["小克 开始实时监听（全部消息）"]);
    // A reconnect inside the grace with scope all: nothing; the alarm keeps the scope.
    await h.leave(ws);
    const again = await h.listen(k.token, { scope: "all" });
    t += 31_000;
    await h.hub.alarm();
    await flush();
    expect(h.events(page)).toEqual(["小克 开始实时监听（全部消息）"]);
    expect(page.lastPresent().find((x) => x.key === "lane:claude")?.scope).toBe("all");
    await h.leave(again);
    // An older client (no scope) and a reader asking for all: the owner's only.
    const c = await mint("codex");
    await h.listen(c.token);
    expect(h.events(page).at(-1)).toBe("coco 开始实时监听");
    expect(page.lastPresent().find((x) => x.key === "lane:codex")?.scope).toBeUndefined();
    const r = await mint("lanes");
    const rs = await h.listen(r.token, { mode: "reader", scope: "all" });
    expect(rs.deserializeAttachment()).not.toHaveProperty("scope");
    await h.hub.webSocketMessage(rs, JSON.stringify({ type: "lane", state: "listener" }));
    await flush();
    expect(h.events(page).at(-1)).toBe("lanes 开始实时监听");
  });
  it("scope system: its own line, the presence row carries it; the widest socket wins", async () => {
    const h = hubSetup({ graceSec: 30 });
    const page = await h.ownerPage();
    const k = await mint("claude");
    const all = await h.listen(k.token, { mode: "listener", scope: "all" });
    const sys = await h.listen(k.token, { mode: "listener", scope: "system" });
    expect(sys.deserializeAttachment()).toMatchObject({ listener: true, scope: "system" });
    expect(h.events(page)).toEqual([
      "小克 开始实时监听（全部消息）",
      "小克 开始实时监听（全部消息 + 系统通知）",
    ]);
    expect(page.lastPresent().find((x) => x.key === "lane:claude")).toMatchObject({
      mode: "listener",
      scope: "system",
    });
    // Closing the all-socket while the system one is open: nothing.
    await h.leave(all);
    expect(h.events(page)).toHaveLength(2);
    // Closing the system one while an all-socket is open: graced, then silently "all".
    const all2 = await h.listen(k.token, { scope: "all" });
    await h.leave(sys);
    t += 31_000;
    await h.hub.alarm();
    await flush();
    expect(h.events(page)).toHaveLength(2);
    expect(page.lastPresent().find((x) => x.key === "lane:claude")?.scope).toBe("all");
    await h.leave(all2);
  });
  it("listen → listener line, close → reader line, read → joined; presence carries the mode", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const coco = await mint("codex");
    const ws = await h.listen(coco.token);
    expect(h.events(page)).toEqual(["coco 开始实时监听"]);
    expect(page.lastPresent()[0]).toMatchObject({
      key: "lane:codex",
      mode: "listener",
      live: true,
    });
    await h.leave(ws);
    expect(h.events(page)).toEqual(["coco 开始实时监听", "coco 转为只读"]);
    const r = await mint("rechrome-codex-71565");
    await h.http(r.token, { op: "read", limit: 1 });
    await flush();
    expect(h.events(page).at(-1)).toBe("rechrome-codex-71565 入群（只读）");
    const p = page.lastPresent().find((x) => x.name === "rechrome-codex-71565");
    expect(p).toMatchObject({ mode: "reader" });
    // A system line is no one speaking: main is not listed for it.
    expect(page.lastPresent().some((x) => x.key === "lane:main")).toBe(false);
  });
  it("a listener's second socket, and a reconnect within the grace, say nothing", async () => {
    const h = hubSetup({ graceSec: 30 });
    const page = await h.ownerPage();
    const a = await mint("agy");
    const one = await h.listen(a.token);
    const two = await h.listen(a.token);
    await h.leave(one);
    expect(h.events(page)).toEqual(["哈基米 开始实时监听"]);
    await h.leave(two);
    // In the grace: still listening.
    expect(h.events(page)).toEqual(["哈基米 开始实时监听"]);
    const three = await h.listen(a.token);
    t += 31_000;
    await h.hub.alarm();
    await flush();
    expect(h.events(page)).toEqual(["哈基米 开始实时监听"]);
    await h.leave(three);
    t += 31_000;
    await h.hub.alarm();
    await flush();
    expect(h.events(page)).toEqual(["哈基米 开始实时监听", "哈基米 转为只读"]);
  });
  it("one lane, an all-socket and an owner-only one: one line; losing all is graced and silent", async () => {
    const h = hubSetup({ graceSec: 30 });
    const page = await h.ownerPage();
    const k = await mint("claude");
    const all = await h.listen(k.token, { mode: "listener", scope: "all" });
    const own = await h.listen(k.token, { mode: "listener" });
    expect(h.events(page)).toEqual(["小克 开始实时监听（全部消息）"]);
    // The all-socket restarts within the grace: nothing.
    await h.leave(all);
    expect(page.lastPresent().find((x) => x.key === "lane:claude")?.scope).toBe("all");
    const all2 = await h.listen(k.token, { mode: "listener", scope: "all" });
    t += 31_000;
    await h.hub.alarm();
    await flush();
    expect(h.events(page)).toEqual(["小克 开始实时监听（全部消息）"]);
    // The owner-only feed restarting says nothing either.
    await h.leave(own);
    await h.listen(k.token, { mode: "listener" });
    expect(h.events(page)).toEqual(["小克 开始实时监听（全部消息）"]);
    // The all-socket gone for good: after the grace the scope drops, silently.
    await h.leave(all2);
    t += 31_000;
    await h.hub.alarm();
    await flush();
    expect(h.events(page)).toEqual(["小克 开始实时监听（全部消息）"]);
    expect(page.lastPresent().find((x) => x.key === "lane:claude")).toMatchObject({
      mode: "listener",
    });
    expect(page.lastPresent().find((x) => x.key === "lane:claude")?.scope).toBeUndefined();
    // A real upgrade: one line.
    const all3 = await h.listen(k.token, { mode: "listener", scope: "all" });
    expect(h.events(page)).toEqual([
      "小克 开始实时监听（全部消息）",
      "小克 开始实时监听（全部消息）",
    ]);
    // The all-socket reads only while the owner-only one listens: still live, the drop graced.
    await h.hub.webSocketMessage(all3, JSON.stringify({ type: "lane", state: "reader" }));
    await flush();
    expect(all3.of("lane").at(-1)).toMatchObject({ state: "listener" });
    expect(h.events(page)).toHaveLength(2);
    // Every socket gone: one "转为只读" after the grace.
    for (const s of h.sockets.filter((x) => x !== page && x.readyState === 1)) await h.leave(s);
    expect(h.events(page)).toHaveLength(2);
    t += 31_000;
    await h.hub.alarm();
    await flush();
    expect(h.events(page).at(-1)).toBe("小克 转为只读");
    expect(h.events(page)).toHaveLength(3);
  });
  it("an MCP client's socket, or mode reader, is a reader; {type:'lane'} switches it", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const m = await mint("mcp-bot");
    await h.listen(m.token, {}, "mcp/1.2.3 tool=lianki_chat_wait");
    expect(h.events(page)).toEqual(["mcp-bot 入群（只读）"]);
    const k = await mint("lanes");
    const ws = await h.listen(k.token, { mode: "reader" });
    expect(h.events(page).at(-1)).toBe("lanes 入群（只读）");
    await h.hub.webSocketMessage(ws, JSON.stringify({ type: "lane", state: "listener" }));
    await flush();
    expect(ws.of("lane").at(-1)).toEqual({ type: "lane", state: "listener" });
    expect(h.events(page).at(-1)).toBe("lanes 开始实时监听");
    await h.hub.webSocketMessage(ws, JSON.stringify({ type: "lane", state: "reader" }));
    await flush();
    expect(h.events(page).at(-1)).toBe("lanes 转为只读");
    // Closing a reader's socket says nothing more.
    const before = h.events(page).length;
    await h.leave(ws);
    expect(h.events(page)).toHaveLength(before);
    const bad = await h.listen(k.token);
    await h.hub.webSocketMessage(bad, JSON.stringify({ type: "lane", state: "boss" }));
    expect(bad.of("error").at(-1)?.error).toMatch(/state must be/);
    await h.hub.webSocketMessage(bad, JSON.stringify({ type: "lane", state: "left" }));
    await flush();
    expect(h.events(page).at(-1)).toBe("lanes 下线");
  });
  it("reading only while another socket still listens keeps the lane a listener", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const a = await mint("codex");
    await h.listen(a.token);
    const two = await h.listen(a.token);
    await h.hub.webSocketMessage(two, JSON.stringify({ type: "lane", state: "reader" }));
    await flush();
    expect(two.of("lane").at(-1)).toEqual({ type: "lane", state: "listener" });
    expect(h.events(page)).toEqual(["coco 开始实时监听"]);
  });
  it("hibernation: a hub woken over the same storage and sockets keeps a live listener", async () => {
    const h = hubSetup({ graceSec: 30 });
    const page = await h.ownerPage();
    const a = await mint("codex");
    const resident = await h.listen(a.token);
    // A wait of the same lane (a reader socket) comes and goes before the hub sleeps.
    const wait = await h.listen(a.token, { mode: "reader" });
    // The Durable Object hibernates: nothing in memory survives, the sockets stay attached.
    h.wake();
    await h.leave(wait);
    t += 31_000;
    await h.hub.alarm();
    await flush();
    // An old socket of the resident (a reconnect earlier in the night) closes only now.
    const ghost = await h.listen(a.token);
    h.wake();
    await h.leave(ghost);
    t += 31_000;
    await h.hub.alarm();
    await flush();
    expect(resident.closed).toBeUndefined();
    expect(h.events(page)).toEqual(["coco 开始实时监听"]);
    expect(h.store.get(laneRegKey("owner", "codex"))).toMatchObject({ state: "listener" });
    expect((h.store.get(laneRegKey("owner", "codex")) as LaneReg).downAt).toBeUndefined();
  });
  it("op lane reader over HTTP while a socket of the lane still listens: still a listener, no line", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const a = await mint("codex");
    await h.listen(a.token);
    expect((await h.http(a.token, { op: "lane", state: "reader" })).body.state).toBe("listener");
    await flush();
    expect(h.events(page)).toEqual(["coco 开始实时监听"]);
  });
  it("a listener that reconnects after the grace (its socket had died unseen) is a listener again", async () => {
    const h = hubSetup({ graceSec: 30 });
    const page = await h.ownerPage();
    const a = await mint("codex");
    await h.leave(await h.listen(a.token));
    t += 31_000;
    await h.hub.alarm();
    await flush();
    // `lianki chat listen` says mode listener on every socket it opens.
    await h.listen(a.token, { mode: "listener" });
    expect(h.events(page)).toEqual(["coco 开始实时监听", "coco 转为只读", "coco 开始实时监听"]);
  });
  it("op lane over HTTP: reader or left, checked as a read", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const r = await mint("otoji-codex-54566", ["chat:read"]);
    expect((await h.http(r.token, { op: "lane", state: "boss" })).status).toBe(400);
    expect((await h.http(r.token, { op: "lane", state: "reader" })).body).toEqual({
      ok: true,
      lane: "otoji-codex-54566",
      state: "reader",
    });
    expect((await h.http(r.token, { op: "lane", state: "left" })).body.state).toBe("left");
    await flush();
    expect(h.events(page)).toEqual(["otoji-codex-54566 入群（只读）", "otoji-codex-54566 下线"]);
    // Leaving needs a read permission at least: a token without one is refused.
    const w = await mint("writer", ["chat:write"]);
    expect((await h.http(w.token, { op: "lane", state: "left" })).status).toBe(403);
  });
  it("mute: the owner mutes from his page; say and ask get 403 with the reason; unmute", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const a = await mint("rgui-claude-1");
    const ws = await h.listen(a.token);
    const tag = a.id.slice(0, 16);
    await h.hub.webSocketMessage(
      page,
      JSON.stringify({ type: "participant", tok: tag, muted: "yes" }),
    );
    expect(page.of("participant-result").at(-1)).toMatchObject({ ok: false });
    await h.hub.webSocketMessage(
      page,
      JSON.stringify({ type: "participant", tok: tag, muted: true }),
    );
    await flush();
    expect(h.events(page).at(-1)).toBe("rgui-claude-1 已禁言");
    expect(page.lastPresent()[0]).toMatchObject({ muted: true });
    const said = await h.http(a.token, { op: "say", text: "hi" });
    expect(said).toEqual({
      status: 403,
      body: { ok: false, error: "muted", reason: MUTED_REASON },
    });
    expect((await h.http(a.token, { op: "ask", question: "q?", options: ["a", "b"] })).status).toBe(
      403,
    );
    await h.hub.webSocketMessage(ws, JSON.stringify({ type: "say", text: "hi" }));
    await flush();
    expect(ws.of("error").at(-1)).toMatchObject({ error: "muted", reason: MUTED_REASON });
    // It still reads.
    expect((await h.http(a.token, { op: "read", limit: 1 })).status).toBe(200);
    await h.hub.webSocketMessage(
      page,
      JSON.stringify({ type: "participant", tok: tag, muted: false }),
    );
    await flush();
    expect(h.events(page).at(-1)).toBe("rgui-claude-1 解除禁言");
    expect((await h.http(a.token, { op: "say", text: "hi again" })).status).toBe(200);
  });
  it("flag off: no rows, no lines, no mode; op lane answers with state null", async () => {
    const h = hubSetup({ flag: false });
    const page = await h.ownerPage();
    const a = await mint("codex");
    const ws = await h.listen(a.token);
    await h.leave(ws);
    expect(h.events(page)).toEqual([]);
    expect((await h.http(a.token, { op: "lane", state: "left" })).body).toEqual({
      ok: true,
      lane: "codex",
      state: null,
    });
    expect([...h.store.keys()].some((k) => k.startsWith("lanereg:"))).toBe(false);
    await h.http(a.token, { op: "read", limit: 1 });
    await flush();
    expect(page.lastPresent()[0]?.mode).toBeUndefined();
  });
});

describe("LaneRegistry.apply: one lane's inputs run in order, a failed one does not jam the chain", () => {
  it("a store write that throws rejects that input; the next input on the lane still applies", async () => {
    const f = fakeRegistry();
    const set = f.store.set.bind(f.store);
    let failOnce = true;
    f.store.set = ((k: string, v: unknown) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("kv down");
      }
      return set(k, v);
    }) as typeof f.store.set;
    await expect(f.reg.listen("owner", "agy", "owner")).rejects.toThrow("kv down");
    // The chain's catch swallows the failure, so the lane's next input runs and lands.
    expect((await f.reg.listen("owner", "agy", "owner"))?.state).toBe("listener");
    expect(await f.reg.list("owner")).toHaveLength(1);
  });
});

describe("busy: the lanes manager's word about its agent (the page's ring)", () => {
  it("laneStep: busy, stuck, idle; the same word twice changes nothing; a leave clears it", () => {
    const r = laneStep(undefined, { type: "seen" }, ctx()).next;
    const b = laneStep(r, { type: "busy", busy: true }, ctx(T0 + 1));
    expect(b.next).toMatchObject({ state: "reader", busy: true, busyAt: T0 + 1 });
    expect(b.event).toBeUndefined();
    expect(b.next.stuck).toBeUndefined();
    expect(laneStep(b.next, { type: "busy", busy: true }, ctx(T0 + 2)).next).toBe(b.next);
    const s = laneStep(b.next, { type: "busy", busy: true, stuck: true }, ctx(T0 + 3)).next;
    expect(s).toMatchObject({ busy: true, stuck: true, busyAt: T0 + 3 });
    // stuck without busy is not stuck.
    const idle = laneStep(s, { type: "busy", busy: false, stuck: true }, ctx(T0 + 4)).next;
    expect(idle.busy).toBeUndefined();
    expect(idle.stuck).toBeUndefined();
    expect(idle.busyAt).toBe(T0 + 4);
    // A mode change keeps it; leaving clears it.
    const l = laneStep(b.next, { type: "listen" }, ctx(T0 + 5)).next;
    expect(l).toMatchObject({ state: "listener", busy: true });
    const gone = laneStep(l, { type: "leave" }, ctx(T0 + 6)).next;
    expect(gone.state).toBe("left");
    expect(gone.busy).toBeUndefined();
    expect(gone.busyAt).toBeUndefined();
  });
  it("over HTTP: stored on the row, pushed in presence on a change only, no line; bad values refused", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const a = await mint("codex");
    await h.http(a.token, { op: "say", text: "hi" });
    await flush();
    const before = page.of("present").length;
    const lines = h.events(page).length;
    expect((await h.http(a.token, { op: "lane", busy: "yes" })).status).toBe(400);
    expect((await h.http(a.token, { op: "lane", busy: true, stuck: "no" })).status).toBe(400);
    expect((await h.http(a.token, { op: "lane", busy: true })).body).toEqual({
      ok: true,
      lane: "codex",
      state: "reader",
      busy: true,
    });
    await flush();
    const row = h.store.get(laneRegKey("owner", "codex")) as LaneReg;
    expect(row).toMatchObject({ busy: true, busyAt: T0 });
    expect(page.lastPresent().find((p) => p.key === "lane:codex")).toMatchObject({ busy: true });
    const afterBusy = page.of("present").length;
    expect(afterBusy).toBeGreaterThan(before);
    // The same word again: no new presence push.
    await h.http(a.token, { op: "lane", busy: true });
    await flush();
    expect(page.of("present").length).toBe(afterBusy);
    await h.http(a.token, { op: "lane", busy: true, stuck: true });
    await flush();
    expect(page.lastPresent().find((p) => p.key === "lane:codex")).toMatchObject({
      busy: true,
      stuck: true,
    });
    expect((await h.http(a.token, { op: "lane", busy: false })).body.busy).toBe(false);
    await flush();
    expect(page.lastPresent().find((p) => p.key === "lane:codex")?.busy).toBeUndefined();
    // Never a system line for it.
    expect(h.events(page).length).toBe(lines);
    // Checked as a read: a token without one is refused.
    const w = await mint("writer", ["chat:write"]);
    expect((await h.http(w.token, { op: "lane", busy: true })).status).toBe(403);
  });
  it("flag off: busy answers null and keeps nothing", async () => {
    const h = hubSetup({ flag: false });
    const a = await mint("codex");
    expect((await h.http(a.token, { op: "lane", busy: true })).body).toEqual({
      ok: true,
      lane: "codex",
      state: null,
      busy: null,
    });
    expect([...h.store.keys()].some((k) => k.startsWith("lanereg:"))).toBe(false);
  });
});
