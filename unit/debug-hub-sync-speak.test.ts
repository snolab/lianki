/**
 * Synchronized read-aloud, the hub's half (packages/debug-chat/src/sync-speak.ts;
 * docs/li-sound-hub.md, "Synchronized read-aloud"): with two or more of his
 * devices connected and flag voice.sync-speak on, each agent line (and each
 * edit, for the read-back) reaches his pages stamped `speakAt` = hubNow +
 * voice.syncLeadMs; it is never stored, never sent to a lane. A clock ping is
 * answered with the hub's time. Nothing here plays audio.
 */
import { describe, expect, it } from "bun:test";
import { DebugHub, type HubTimer, type Socket, type Storage } from "@/workers/push/src/debug";
import { SYNC_LEAD_MS } from "@lianki/debug-chat/sync-speak";
import { rpcStub } from "./support/rpc-stub";
class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
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
  all(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
  last(type: string) {
    return this.all(type).at(-1);
  }
}

function fakeStorage(): Storage & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
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

/** Timers the suite fires by hand: `fire()` runs every pending one. */
function fakeTimer(): HubTimer & { pending: { f: () => void; ms: number }[]; fire(): number } {
  const pending: { f: () => void; ms: number }[] = [];
  return {
    pending,
    set(f, ms) {
      const h = { f, ms };
      pending.push(h);
      return h;
    },
    clear(h) {
      const i = pending.indexOf(h as { f: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
    fire() {
      const due = pending.splice(0);
      for (const { f } of due) f();
      return due.length;
    },
  };
}

function setup(opts: { flags?: Record<string, unknown>; config?: Record<string, unknown> } = {}) {
  const flags: Record<string, unknown> = { "voice.sync-speak": true, ...opts.flags };
  const config: Record<string, unknown> = { ...opts.config };
  const SESSIONS = {
    live: async () => "live",
    flag: async (k: string) => flags[k] ?? false,
    config: async (k: string) => config[k],
  };
  const sockets: FakeSocket[] = [];
  let t = 1_000_000;
  const storage = fakeStorage();
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    { SESSIONS: rpcStub(SESSIONS) },
    () => t,
    fakeTimer(),
  );
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** One of his pages, on `dev` (a device id), signed in. */
  const owner = async (dev: string, tab: string) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=/words&tab=${tab}&dev=${dev}`),
      { userId: "u_owner", email: "o@x", owner: true },
    );
    await flush();
    return ws;
  };
  const agent = async (page: FakeSocket) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL("https://lianki.com/api/version/debug/control?label=agent"),
    );
    await flush();
    const pair = (page.last("state") as { pending: { pair: string } }).pending.pair;
    await hub.webSocketMessage(page, JSON.stringify({ type: "allow", pair, scope: "chat" }));
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const stored = () =>
    [...storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as Record<string, unknown>);
  return {
    hub,
    owner,
    agent,
    msg,
    flush,
    stored,
    flags,
    now: () => t,
    tick: (ms: number) => (t += ms),
  };
}

describe("synchronized read-aloud: the hub", () => {
  it("two devices: an agent line reaches both pages stamped speakAt = now + lead", async () => {
    const s = setup();
    const mac = await s.owner("mac-device-00001", "tab-mac-01");
    const phone = await s.owner("phone-device-01", "tab-phone-1");
    const c = await s.agent(mac);
    await s.msg(c, { type: "say", text: "おはよう" });
    for (const p of [mac, phone])
      expect(p.last("chat")).toMatchObject({
        message: { text: "おはよう", from: "agent" },
        speakAt: s.now() + SYNC_LEAD_MS,
      });
    // Never stored, never sent to the lane.
    expect(s.stored().some((m) => "speakAt" in m)).toBe(false);
    expect(c.all("chat").some((m) => "speakAt" in m)).toBe(false);
  });

  it("the lead is the live config value", async () => {
    const s = setup({ config: { "voice.syncLeadMs": 450 } });
    const mac = await s.owner("mac-device-00001", "tab-mac-01");
    await s.owner("phone-device-01", "tab-phone-1");
    const c = await s.agent(mac);
    await s.msg(c, { type: "say", text: "hi" });
    expect(mac.last("chat")).toMatchObject({ speakAt: s.now() + 450 });
  });

  it("one device (even with two tabs) never waits: no stamp", async () => {
    const s = setup();
    const a = await s.owner("mac-device-00001", "tab-mac-01");
    const b = await s.owner("mac-device-00001", "tab-mac-02");
    const c = await s.agent(a);
    await s.msg(c, { type: "say", text: "hi" });
    expect(a.last("chat")).toBeDefined();
    expect(a.last("chat")).not.toHaveProperty("speakAt");
    expect(b.last("chat")).not.toHaveProperty("speakAt");
  });

  it("flag off, or unreadable: no stamp", async () => {
    for (const v of [false, "busy"]) {
      const s = setup({ flags: { "voice.sync-speak": v } });
      const mac = await s.owner("mac-device-00001", "tab-mac-01");
      await s.owner("phone-device-01", "tab-phone-1");
      const c = await s.agent(mac);
      await s.msg(c, { type: "say", text: "hi" });
      expect(mac.last("chat")).toBeDefined();
      expect(mac.last("chat")).not.toHaveProperty("speakAt");
    }
  });

  it("his own line is not stamped (nothing reads it aloud)", async () => {
    const s = setup();
    const mac = await s.owner("mac-device-00001", "tab-mac-01");
    const phone = await s.owner("phone-device-01", "tab-phone-1");
    await s.msg(mac, { type: "chat", id: "o1", text: "typed" });
    expect(phone.last("chat")).toMatchObject({ message: { id: "o1" } });
    expect(phone.last("chat")).not.toHaveProperty("speakAt");
  });

  it("an edit (the read-back) is stamped on his pages too", async () => {
    const s = setup({ flags: { "stt.polish": true } });
    const mac = await s.owner("mac-device-00001", "tab-mac-01");
    const phone = await s.owner("phone-device-01", "tab-phone-1");
    const c = await s.agent(mac);
    await s.msg(mac, { type: "chat", id: "v1", text: "现在是流失传输吗", source: "stt" });
    await s.msg(c, { type: "edit", id: "v1", text: "现在是流式传输吗？" });
    await s.flush();
    for (const p of [mac, phone])
      expect(p.last("edited")).toMatchObject({ id: "v1", speakAt: s.now() + SYNC_LEAD_MS });
    expect(c.last("edited") ?? {}).not.toHaveProperty("speakAt");
  });

  it("a clock ping is answered with the hub's time", async () => {
    const s = setup();
    const mac = await s.owner("mac-device-00001", "tab-mac-01");
    await s.msg(mac, { type: "clock", t0: 42 });
    expect(mac.last("clock")).toEqual({ type: "clock", t0: 42, t1: s.now(), t2: s.now() });
  });
});
