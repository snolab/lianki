import { beforeEach, describe, expect, it } from "bun:test";
import { DebugHub, type HubTimer, type Socket, type Storage } from "@/workers/push/src/debug";
import { OwnerAi, isRollCall, ownerLineWanted } from "@/workers/push/src/owner-ai";
import {
  OWNER_REPLY_DELAY_KEY,
  OWNER_REPLY_DELAY_MAX,
  OWNER_REPLY_DELAY_MS,
  PARTNER_AI_FLAG,
  PARTNER_AI_LABEL,
  PARTNER_AI_MODEL,
  PARTNER_OWNER_FLAG,
  type PartnerRequest,
  type PartnerResult,
} from "@/lib/partner-ai-config";
import { hourOf } from "@/lib/rolling-window";
import { partnerReply, type PartnerDb } from "@/lib/partner-ai";
import { FLAGS } from "@/lib/flags";
import { CONFIG } from "@/lib/config";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { getBalance, type D1WithBatch } from "@/lib/payments/credits-store";
import { rpcStub } from "./support/rpc-stub";

/** Li in the owner's own thread (flag partner.owner-thread, workers/push/src/owner-ai.ts). */
class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  private att: unknown = null;
  send(d: string) {
    this.sent.push(JSON.parse(d));
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
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}
type Msg = { from: string; text: string; label: string; lane?: string };
const chats = (ws: FakeSocket) =>
  ws.sent.filter((m) => m.type === "chat").map((m) => m.message as Msg);

function fakeStorage(store = new Map<string, unknown>()): Storage & {
  store: Map<string, unknown>;
} {
  return {
    store,
    getAlarm: async () => null,
    setAlarm: async () => {},
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

/** Timers fired by hand: `fire()` runs every one set and not cleared. */
function fakeTimer() {
  let n = 0;
  const live = new Map<number, { f: () => void; ms: number }>();
  const timer: HubTimer = {
    set: (f, ms) => {
      live.set(++n, { f, ms });
      return n;
    },
    clear: (h) => void live.delete(h as number),
  };
  const fire = async () => {
    const due = [...live.values()];
    live.clear();
    for (const t of due) t.f();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { timer, live, fire };
}

const T0 = 1_800_000_000_000;

function setup(opts: { ai?: boolean; owner?: boolean; delay?: unknown } = {}) {
  const sockets: FakeSocket[] = [];
  let t = T0;
  const calls: PartnerRequest[] = [];
  const flags: Record<string, unknown> = {
    [PARTNER_AI_FLAG]: opts.ai ?? true,
    [PARTNER_OWNER_FLAG]: opts.owner ?? true,
  };
  let reply = async (_req: PartnerRequest): Promise<PartnerResult> => ({
    ok: true,
    text: "Li here.",
    tokensIn: 500,
    tokensOut: 40,
    ms: 900,
    model: PARTNER_AI_MODEL,
  });
  const sessions = {
    live: async () => "live",
    flag: async (k: string) => flags[k] ?? false,
    config: async (k: string) => (k === OWNER_REPLY_DELAY_KEY ? opts.delay : undefined),
    partnerReply: async (req: PartnerRequest) => {
      calls.push(structuredClone(req));
      return reply(req);
    },
  };
  const storage = fakeStorage();
  const timers = fakeTimer();
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    { SESSIONS: rpcStub(sessions) },
    () => t,
    timers.timer,
  );
  const ownerPage = async (session = true) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(ws, new URL("https://lianki.com/api/version/debug?label=%2Fwords"), {
      userId: "owner1",
      email: "o@x.com",
      owner: true,
      ...(session ? { session: "tag1", sessionUntil: T0 + 3600_000 } : {}),
    });
    return ws;
  };
  const friend = async (userId = "f1") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(ws, new URL("https://lianki.com/api/version/debug?label=%2Fwords"), {
      userId,
      email: `${userId}@x.com`,
      owner: false,
    });
    return ws;
  };
  /** A lane paired for chat (answered on a plain page of his, as the suites do). */
  const lane = async () => {
    const owner = new FakeSocket();
    sockets.push(owner);
    await hub.connectPage(owner, new URL("https://lianki.com/api/version/debug?label=%2Fx"));
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL("https://lianki.com/api/version/debug/control?label=main%20lane"),
    );
    const pair = (owner.last("state") as { pending: { pair: string } }).pending.pair;
    await hub.webSocketMessage(owner, JSON.stringify({ type: "allow", pair, scope: "chat" }));
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  return {
    hub,
    calls,
    storage,
    timers,
    ownerPage,
    friend,
    lane,
    msg,
    tick: (ms: number) => (t += ms),
    setReply: (f: typeof reply) => (reply = f),
  };
}

describe("Li in the owner's thread: the hub", () => {
  it("flag on: his line gets Li's reply after the delay, metered on his own user id", async () => {
    const s = setup();
    const o = await s.ownerPage();
    await s.msg(o, { type: "chat", id: "a1", text: "今天学什么好呢" });
    // Nothing yet: the lanes have the delay to answer first.
    expect(s.calls).toEqual([]);
    expect([...s.timers.live.values()].map((x) => x.ms)).toEqual([OWNER_REPLY_DELAY_MS]);
    await s.timers.fire();
    expect(s.calls).toHaveLength(1);
    const req = s.calls[0];
    expect(req.userId).toBe("owner1");
    expect(req.owner).toBe(true);
    expect(req.msgId).toBe("a1");
    expect(req.history).toEqual([{ role: "user", text: "今天学什么好呢" }]);
    const li = chats(o).at(-1)!;
    expect(li).toMatchObject({
      from: "agent",
      label: PARTNER_AI_LABEL,
      text: "Li here.",
      lane: "main",
    });
    // No admin bypass: his account's counter (this UTC hour's bucket) is the one charged.
    expect(s.storage.store.get("ai:u:owner1")).toEqual({ [hourOf(T0)]: 540 });
  });

  it("history: his lines as user, lane and Li lines as assistant", async () => {
    const s = setup();
    const o = await s.ownerPage();
    const l = await s.lane();
    await s.msg(o, { type: "chat", id: "a1", text: "first" });
    s.tick(1000);
    await s.msg(l, { type: "say", text: "lane answer" });
    await s.timers.fire();
    expect(s.calls).toEqual([]);
    s.tick(1000);
    await s.msg(o, { type: "chat", id: "a2", text: "second" });
    await s.timers.fire();
    expect(s.calls.at(-1)?.history).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "lane answer" },
      { role: "user", text: "second" },
    ]);
  });

  it("a lane line within the delay cancels Li's reply", async () => {
    const s = setup();
    const o = await s.ownerPage();
    const l = await s.lane();
    await s.msg(o, { type: "chat", id: "a1", text: "hello" });
    s.tick(3000);
    await s.msg(l, { type: "say", text: "lane here" });
    await s.timers.fire();
    expect(s.calls).toEqual([]);
    expect(chats(o).map((m) => m.text)).toEqual(["hello", "lane here"]);
  });

  it("a newer line of his replaces the pending reply (one reply, for the newest)", async () => {
    const s = setup();
    const o = await s.ownerPage();
    await s.msg(o, { type: "chat", id: "a1", text: "one" });
    await s.msg(o, { type: "chat", id: "a2", text: "two" });
    expect(s.timers.live.size).toBe(1);
    await s.timers.fire();
    expect(s.calls.map((c) => c.msgId)).toEqual(["a2"]);
  });

  it("a line addressed to a lane never gets Li, and cancels a pending one", async () => {
    const s = setup();
    const o = await s.ownerPage();
    await s.msg(o, { type: "chat", id: "a1", text: "hello" });
    await s.msg(o, { type: "chat", id: "a2", text: "codex，看一下这个 bug" });
    await s.msg(o, { type: "chat", id: "a3", text: "for the node", to: "/plan/x" });
    expect(s.timers.live.size).toBe(0);
    await s.timers.fire();
    expect(s.calls).toEqual([]);
  });

  it("flag off (or partner.ai-reply off): nothing is scheduled, nothing posted", async () => {
    for (const opts of [{ owner: false }, { ai: false }]) {
      const s = setup(opts);
      const o = await s.ownerPage();
      await s.msg(o, { type: "chat", id: "a1", text: "hello" });
      expect(s.timers.live.size).toBe(0);
      await s.timers.fire();
      expect(s.calls).toEqual([]);
      expect(chats(o).map((m) => m.from)).toEqual(["owner"]);
    }
  });

  it("a chat-only page of his (no session) is metered on his other page's user id; none: no call", async () => {
    const s = setup();
    const bare = await s.ownerPage(false);
    await s.msg(bare, { type: "chat", id: "a1", text: "hello" });
    await s.timers.fire();
    expect(s.calls).toEqual([]);
    await s.ownerPage(true);
    await s.msg(bare, { type: "chat", id: "a2", text: "again" });
    await s.timers.fire();
    expect(s.calls.map((c) => c.userId)).toEqual(["owner1"]);
  });

  it("the delay comes from config partner.ownerReplyDelayMs (bounded)", async () => {
    for (const [delay, want] of [
      [2000, 2000],
      [10 ** 9, OWNER_REPLY_DELAY_MAX],
      ["x", OWNER_REPLY_DELAY_MS],
    ] as const) {
      const s = setup({ delay });
      const o = await s.ownerPage();
      await s.msg(o, { type: "chat", id: "a1", text: "hello" });
      expect([...s.timers.live.values()].map((x) => x.ms)).toEqual([want]);
    }
  });

  it("friend threads are unchanged: replied at once, never through the owner's timer", async () => {
    const s = setup();
    const f = await s.friend();
    await s.msg(f, { type: "chat", id: "f-a", text: "hi" });
    expect(s.timers.live.size).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].userId).toBe("f1");
    expect(s.calls[0].owner).toBeUndefined();
    const li = chats(f).at(-1)!;
    expect(li.from).toBe("agent");
    expect(li.lane).toBeUndefined();
  });
});

describe("Li in the owner's thread: which lines", () => {
  it("a roll call (报数/点名) gets Li's presence line at once, flag on, no model; off: nothing", async () => {
    expect(isRollCall("@小克 @coco @杰咪 报数")).toBe(true);
    expect(isRollCall("全体点名")).toBe(true);
    expect(isRollCall("今天学什么")).toBe(false);
    const timers = fakeTimer();
    let on = true;
    const present: string[] = [];
    const replies: string[] = [];
    const ai = new OwnerAi<null>({
      now: () => 0,
      timer: timers.timer,
      flag: async () => on,
      config: async () => undefined,
      aiOn: async () => false,
      agentAt: () => 0,
      reply: async (l) => void replies.push(l.id),
      present: async (l) => void present.push(l.id),
    });
    await ai.line({ id: "r1", text: "@小克 @coco 报数", at: 1 }, null);
    expect(present).toEqual(["r1"]);
    expect(replies).toEqual([]);
    // Another voice's roll call, or one for a node: nothing.
    await ai.line({ id: "r2", text: "报数", at: 2, speaker: { decision: "other" } }, null);
    await ai.line({ id: "r3", text: "报数", at: 3, to: "/x" }, null);
    expect(present).toEqual(["r1"]);
    // Flag off: nothing (the conf is cached; a fresh instance reads it).
    on = false;
    const off = new OwnerAi<null>({
      now: () => 0,
      timer: timers.timer,
      flag: async () => on,
      config: async () => undefined,
      aiOn: async () => true,
      agentAt: () => 0,
      reply: async () => {},
      present: async (l) => void present.push(l.id),
    });
    await off.line({ id: "r4", text: "报数", at: 4 }, null);
    expect(present).toEqual(["r1"]);
    // A failing post is logged, not thrown.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => void logs.push(String(s));
    try {
      const bad = new OwnerAi<null>({
        now: () => 0,
        timer: timers.timer,
        flag: async () => true,
        config: async () => undefined,
        aiOn: async () => true,
        agentAt: () => 0,
        reply: async () => {},
        present: async () => {
          throw new Error("hub down");
        },
      });
      await bad.line({ id: "r5", text: "报数", at: 5 }, null);
    } finally {
      console.log = orig;
    }
    expect(logs.some((s) => s.includes("partner.owner-rollcall-failed"))).toBe(true);
  });

  const line = { id: "x", text: "今天学什么", at: 1 };
  it("unaddressed, not another voice: wanted", () => {
    expect(ownerLineWanted(line)).toBe(true);
    expect(ownerLineWanted({ ...line, speaker: { decision: "me" } })).toBe(true);
    expect(ownerLineWanted({ ...line, speaker: { decision: "unknown" } })).toBe(false);
  });
  it("another voice, a lane named, or a node address: never", () => {
    expect(ownerLineWanted({ ...line, speaker: { decision: "other" } })).toBe(false);
    expect(ownerLineWanted({ ...line, text: "agy，帮我看看" })).toBe(false);
    expect(ownerLineWanted({ ...line, to: "/plan" })).toBe(false);
  });

  it("OwnerAi: an other-voice line schedules nothing; an unreadable flag is off; the conf is cached", async () => {
    const timers = fakeTimer();
    let flagReads = 0;
    let throws = true;
    const replies: string[] = [];
    let now = 0;
    const ai = new OwnerAi<null>({
      now: () => now,
      timer: timers.timer,
      flag: async () => {
        flagReads++;
        if (throws) throw new Error("down");
        return true;
      },
      config: async () => {
        throw new Error("down");
      },
      aiOn: async () => true,
      agentAt: () => 0,
      reply: async (l) => {
        replies.push(l.id);
        throw new Error("model down");
      },
      present: async () => {},
    });
    await ai.line({ ...line, speaker: { decision: "other" } }, null);
    expect(flagReads).toBe(0);
    await ai.line(line, null);
    expect(timers.live.size).toBe(0);
    throws = false;
    await ai.line(line, null);
    expect(timers.live.size).toBe(0);
    now = 60_000;
    const logs: string[] = [];
    const was = console.log;
    console.log = (m: unknown) => void logs.push(String(m));
    try {
      await ai.line(line, null);
      expect([...timers.live.values()].map((x) => x.ms)).toEqual([OWNER_REPLY_DELAY_MS]);
      await timers.fire();
    } finally {
      console.log = was;
    }
    expect(replies).toEqual(["x"]);
    expect(logs.some((l) => l.includes("partner.owner-failed"))).toBe(true);
    expect(flagReads).toBe(2);
  });

  it("OwnerAi: a line whose flag read ends after a newer line began is dropped", async () => {
    const timers = fakeTimer();
    let release!: () => void;
    let first = true;
    const ai = new OwnerAi<null>({
      now: () => 0,
      timer: timers.timer,
      flag: async () => true,
      config: async () => undefined,
      aiOn: async () => {
        if (!first) return true;
        first = false;
        await new Promise<void>((r) => (release = r));
        return true;
      },
      agentAt: () => 0,
      reply: async () => {},
      present: async () => {},
    });
    const one = ai.line({ ...line, id: "one" }, null);
    await new Promise((r) => setTimeout(r, 0));
    await ai.line({ ...line, id: "two" }, null);
    release();
    await one;
    expect(timers.live.size).toBe(1);
  });
});

describe("Li in the owner's thread: the main Worker", () => {
  let d1: TestD1Database;
  const env = () => ({
    DB: d1 as unknown as PartnerDb,
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_AI_TOKEN: "tok",
  });
  const ok = {
    choices: [{ message: { content: "Hi owner" } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  };
  const fetchOk = (async () => new Response(JSON.stringify(ok))) as unknown as typeof fetch;
  const req = (userId: string, owner: boolean) => ({
    userId,
    msgId: `m-${userId}`,
    ...(owner ? { owner: true } : {}),
    history: [{ role: "user", text: "hello" }],
  });
  beforeEach(() => {
    d1 = createTestD1(testSchema());
    const db = d1.raw();
    db.exec(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES ('owner@x.com', 'dev', 'test', 1)",
    );
    db.exec(`INSERT INTO user (id, email, createdAt, updatedAt) VALUES
      ('u_alice', 'alice@x.com', 'x', 'x'), ('u_owner', 'owner@x.com', 'x', 'x')`);
    db.exec(
      `INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u_owner', 100, 'x'), ('u_alice', 100, 'x')`,
    );
    db.exec(
      `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('${PARTNER_AI_FLAG}', 1, 0, 'owner')`,
    );
  });
  const balance = (id: string) => getBalance(d1 as unknown as D1WithBatch, id);

  it("the flag and its config are registered: on by default, owner-only, 30 s", () => {
    expect(FLAGS[PARTNER_OWNER_FLAG as keyof typeof FLAGS]).toMatchObject({
      default: true,
      audience: "owner",
      group: "ai",
    });
    expect(CONFIG[OWNER_REPLY_DELAY_KEY as keyof typeof CONFIG].default).toBe(OWNER_REPLY_DELAY_MS);
  });

  it("his thread: answered for his account and paid from his own credits (no bypass)", async () => {
    const res = await partnerReply(env(), req("u_owner", true), { fetch: fetchOk });
    expect(res).toMatchObject({ ok: true, text: "Hi owner" });
    // Reserved and settled on his wallet: the charge row is his.
    const charges = await d1.prepare("SELECT * FROM credit_ai_charge").all();
    expect(JSON.stringify(charges.results)).toContain("u_owner:m-u_owner");
    // No credits: his thread is refused like anyone's, the model never called.
    d1.raw().exec("UPDATE credit_balance SET balance = 0 WHERE userId = 'u_owner'");
    let fetched = 0;
    const counting = (async () => {
      fetched++;
      return new Response(JSON.stringify(ok));
    }) as unknown as typeof fetch;
    const again = await partnerReply(
      env(),
      { ...req("u_owner", true), msgId: "m2" },
      { fetch: counting },
    );
    expect(again).toMatchObject({ ok: false, error: "no-credits" });
    expect(fetched).toBe(0);
  });

  it("without the owner mark his account is still refused; with it, anyone else is", async () => {
    expect(await partnerReply(env(), req("u_owner", false), { fetch: fetchOk })).toEqual({
      ok: false,
      error: "owner",
    });
    expect(await partnerReply(env(), req("u_alice", true), { fetch: fetchOk })).toEqual({
      ok: false,
      error: "bad-input",
    });
    expect(await balance("u_alice")).toBe(100);
  });

  it("partner.owner-thread off (a stored row): his thread is off", async () => {
    d1.raw().exec(
      `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('${PARTNER_OWNER_FLAG}', 0, 0, 'owner')`,
    );
    expect(await partnerReply(env(), req("u_owner", true), { fetch: fetchOk })).toEqual({
      ok: false,
      error: "off",
    });
    expect(await balance("u_owner")).toBe(100);
  });
});
