/**
 * Echoes of the owner's voice lines (docs/dev-debug-widget.md, "Echoes";
 * lib/echo-match.ts): his other phone's copy of a sentence, or Li's read-aloud
 * heard back, is kept aside in the hub — never posted, read back, polished or
 * sent to a lane — and the owner's undo posts it after all.
 */
import { describe, expect, it } from "bun:test";
import {
  AUTO_POLISH_BY,
  DebugHub,
  type HubTimer,
  type Socket,
  type Storage,
} from "@/workers/push/src/debug";
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

const timer: HubTimer = { set: () => ({}), clear: () => {} };

function setup(flags: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { "stt.polish": true, "voice.echo-dedupe": true, ...flags };
  const SESSIONS = {
    live: async () => "live",
    flag: async (k: string) => all[k] ?? false,
    config: async () => undefined,
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
    timer,
  );
  const page = async (label: string) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}`),
      { userId: "u_owner", email: "o@x", owner: true },
    );
    return ws;
  };
  const agent = async (p: FakeSocket) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL("https://lianki.com/api/version/debug/control?label=agent"),
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    const pair = (p.last("state") as { pending: { pair: string } }).pending.pair;
    await hub.webSocketMessage(p, JSON.stringify({ type: "allow", pair, scope: "chat" }));
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const voice = (id: string, text: string) => ({ type: "chat", id, text, source: "stt" });
  const posted = () =>
    [...storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as { id: string; from: string; text: string });
  /** Owner lines a listener (a lane) was sent. */
  const heard = (c: FakeSocket) =>
    c.all("chat").map((x) => (x.message as { id: string; from: string }).id);
  return { hub, page, agent, msg, voice, posted, heard, storage, tick: (ms: number) => (t += ms) };
}

describe("echoes", () => {
  it("the same device repeating itself: both lines stand", async () => {
    const s = setup();
    const a = await s.page("/words pwa iPhone");
    await s.msg(a, s.voice("v1", "我们明天去公园散步吧"));
    s.tick(2000);
    await s.msg(a, s.voice("v2", "我们明天去公园散步吧"));
    expect(s.posted().map((x) => x.id)).toEqual(["v1", "v2"]);
  });

  it("his other phone's copy within the window: kept aside, never sent to a lane; undo posts it", async () => {
    const s = setup();
    const a = await s.page("/words pwa iPhone");
    const b = await s.page("/words pwa Pixel");
    const c = await s.agent(a);
    await s.msg(a, s.voice("v1", "我们明天去公园散步吧"));
    s.tick(6000);
    await s.msg(b, s.voice("v2", "我们明天去公园散布吧。"));
    expect(s.posted().map((x) => x.id)).toEqual(["v1"]);
    expect(s.heard(c)).toEqual(["v1"]);
    expect(b.all("chat").map((x) => (x.message as { id: string }).id)).toEqual(["v1"]);
    expect(s.storage.store.get("echo:v2")).toMatchObject({
      text: "我们明天去公园散布吧。",
      raw: "我们明天去公园散布吧。",
      edited: { by: AUTO_POLISH_BY, count: 0 },
      echo: { reason: "echo", kind: "other-device", of: "v1", by: AUTO_POLISH_BY },
    });
    const ack = b.last("chat-ack");
    expect(ack).toEqual({ type: "chat-ack", id: "v2", seq: 2 });
    await s.msg(b, s.voice("v2", "我们明天去公园散布吧。"));
    expect(b.last("chat-ack")).toEqual(ack);
    expect(s.posted().map((x) => x.id)).toEqual(["v1"]);
    // Undo (the page's unmerge with the echo's id): posted as heard.
    await s.msg(a, { type: "unmerge", id: "v2" });
    expect(s.posted().map((x) => x.id)).toEqual(["v1", "v2"]);
    expect(s.posted()[1]).not.toHaveProperty("echo");
    expect(s.storage.store.has("echo:v2")).toBe(false);
    expect(s.heard(c)).toEqual(["v1", "v2"]);
  });

  it("outside the window: his other phone's line stands", async () => {
    const s = setup();
    const a = await s.page("/words pwa iPhone");
    const b = await s.page("/words pwa Pixel");
    await s.msg(a, s.voice("v1", "我们明天去公园散步吧"));
    s.tick(9000);
    await s.msg(b, s.voice("v2", "我们明天去公园散步吧"));
    expect(s.posted().map((x) => x.id)).toEqual(["v1", "v2"]);
  });

  it("an agent line read aloud and heard back as his: dropped", async () => {
    const s = setup();
    const a = await s.page("/words pwa iPhone");
    const b = await s.page("/words pwa Pixel");
    const c = await s.agent(a);
    await s.msg(c, { type: "say", text: "表里 alive 只表示进程活着，忙不忙要看 state。" });
    s.tick(20_000);
    await s.msg(b, s.voice("v1", "表里机费，只表示进程活着，忙不忙要看 state"));
    expect(s.posted().map((x) => x.from)).toEqual(["agent"]);
    expect(s.heard(c).filter((id) => id === "v1")).toEqual([]);
    expect(s.storage.store.get("echo:v1")).toMatchObject({ echo: { kind: "read-aloud" } });
    // His own words after it still go through.
    await s.msg(b, s.voice("v2", "好的，那我明天再看一下"));
    expect(
      s
        .posted()
        .map((x) => x.id)
        .at(-1),
    ).toBe("v2");
  });

  it("flag voice.echo-dedupe off: nothing is kept aside", async () => {
    const s = setup({ "voice.echo-dedupe": false });
    const a = await s.page("/words pwa iPhone");
    const b = await s.page("/words pwa Pixel");
    const c = await s.agent(a);
    await s.msg(c, { type: "say", text: "表里 alive 只表示进程活着，忙不忙要看 state。" });
    await s.msg(a, s.voice("v1", "我们明天去公园散步吧"));
    s.tick(5000);
    await s.msg(b, s.voice("v2", "我们明天去公园散步吧"));
    await s.msg(b, s.voice("v3", "表里机费，只表示进程活着，忙不忙要看 state"));
    expect(
      s
        .posted()
        .filter((x) => x.from === "owner")
        .map((x) => x.id),
    ).toEqual(["v1", "v2", "v3"]);
    expect([...s.storage.store.keys()].filter((k) => k.startsWith("echo:"))).toEqual([]);
  });
});
