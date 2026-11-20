/**
 * Cross-device echo in the chat hub (docs/echo-suppression.md, layer (b),
 * "The verdict" and "UI"): his pages report what they read aloud; a voice
 * line from another of his devices that overlaps it in time and holds its
 * words is a read-aloud echo — never posted, sent to a lane or a token
 * listener, answered by Li, polished or written to the account's history —
 * and goes to his pages in its own `echo` frame, collapsed there, until
 * "This was me" (unmerge) posts it after all.
 *
 * Includes a replay of the 2026-11-19 ~14:25 JST incident: an agent line read
 * aloud on his phone and recaptured by the Mac's mic, "GitHub Actions" mangled.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DebugHub, type HubTimer, type Socket, type Storage } from "@/workers/push/src/debug";
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

/** The agent line of 2026-11-19 ~14:25 JST. */
const AGENT =
  "先放一个占位首页，通过 GitHub Actions 自动部署到 Cloudflare Pages，等域名解析好了再换成正式的首页。";
/** What the Mac's mic made of it. */
const HEARD = "先放一个占位首页，通过给他不爱可信自动部署";

let logs: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logs = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(String(a[0])));
});
afterEach(() => spy.mockRestore());

function setup(flags: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    "voice.echo-dedupe": true,
    "voice.echo-reports": true,
    ...flags,
  };
  const history: { op: string; lines: { id: string }[] }[] = [];
  const SESSIONS = {
    live: async () => "live",
    flag: async (k: string) => all[k] ?? false,
    config: async (k: string) => config[k],
    chatLog: async (r: { op: string; lines: { id: string }[] }) => {
      history.push(r);
      return { ok: true };
    },
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
  const page = async (label: string, tab: string, extra = "") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(
      ws,
      new URL(
        `https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}&tab=${tab}${extra}`,
      ),
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
  /** A voice line spoken from `ago` to `ago - len` ms before it was sent (now), page clock. */
  const voice = (
    id: string,
    text: string,
    o: { endAgo?: number; len?: number; hubSpan?: object } = {},
  ) => ({
    type: "chat",
    id,
    text,
    source: "stt",
    timing: {
      t_speechStart: 50_000 - (o.endAgo ?? 1500) - (o.len ?? 4000),
      t_speechEnd: 50_000 - (o.endAgo ?? 1500),
      t_sent: 50_000,
    },
    ...(o.hubSpan ? { hubSpan: o.hubSpan } : {}),
  });
  const posted = () =>
    [...storage.store.entries()]
      .filter(([k]) => k.startsWith("msg:"))
      .map(([, v]) => v as { id: string; from: string; text: string });
  const heard = (c: FakeSocket) => c.all("chat").map((x) => (x.message as { id: string }).id);
  const logged = () => history.flatMap((r) => r.lines.map((l) => l.id));
  return {
    hub,
    page,
    agent,
    msg,
    voice,
    posted,
    heard,
    logged,
    storage,
    now: () => t,
    tick: (ms: number) => (t += ms),
  };
}

type S = ReturnType<typeof setup>;
/** The phone reads `text` for line `line` from now for `ms`. */
async function play(
  s: S,
  phone: FakeSocket,
  ref: string,
  text: string,
  ms: number,
  voice = "device",
) {
  await s.msg(phone, { type: "playing", ref, text, voice, from: s.now(), synced: true });
  s.tick(ms);
  await s.msg(phone, { type: "played", ref, to: s.now(), synced: true });
}

describe("play reports in the hub", () => {
  it("replays 2026-11-19 14:25: read aloud on the phone, heard by the Mac, kept as an echo", async () => {
    const s = setup();
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    const lane = await s.agent(phone);
    await s.msg(lane, { type: "say", text: AGENT });
    const agentLine = s.posted().find((x) => x.from === "agent")!;
    // A long queue: the phone reaches it 75 s later (past today's 60 s window).
    s.tick(75_000);
    await play(s, phone, `${agentLine.id}#1`, AGENT, 8000);
    // The Mac posts the fragment it heard from 76 s to 80 s.
    s.tick(500);
    await s.msg(mac, s.voice("m1", HEARD, { endAgo: 3500, len: 4000 }));
    expect(s.posted().map((x) => x.id)).toEqual([agentLine.id]);
    expect(s.heard(lane)).not.toContain("m1");
    expect(s.logged()).not.toContain("m1");
    expect(mac.last("chat-ack")).toMatchObject({ id: "m1" });
    for (const p of [phone, mac]) {
      const e = p.last("echo") as {
        line: { id: string; text: string; echo: Record<string, unknown> };
      };
      expect(e.line).toMatchObject({ id: "m1", text: HEARD });
      expect(e.line.echo).toMatchObject({
        kind: "read-aloud",
        layer: "report",
        of: agentLine.id,
        voice: "device",
        shown: true,
      });
      expect(e.line).not.toHaveProperty("raw");
    }
    expect(lane.all("echo")).toEqual([]);
    // Logged with numbers only: never the words.
    const line = logs.find((l) => l.includes('"debug.echo"'))!;
    expect(JSON.parse(line)).toMatchObject({ id: "m1", layer: "report", voice: "device" });
    expect(line).not.toContain("占位");
    // A page that joins now gets it in the snapshot.
    const ipad = await s.page("/ pwa iPad", "ipad1");
    expect((ipad.last("echoes") as { lines: { id: string }[] }).lines.map((l) => l.id)).toEqual([
      "m1",
    ]);
    // "This was me": posted after all, reaches the lane, gone from every page's rows.
    await s.msg(mac, { type: "unmerge", id: "m1" });
    expect(s.posted().map((x) => x.id)).toEqual([agentLine.id, "m1"]);
    expect(s.heard(lane)).toContain("m1");
    expect(s.logged()).toContain("m1");
    for (const p of [phone, mac, ipad])
      expect(p.last("echo-gone")).toEqual({ type: "echo-gone", ids: ["m1"] });
    // The next page sees no echoes any more.
    const again = await s.page("/ pwa iPad", "ipad2");
    expect(again.all("echoes")).toEqual([]);
  });

  it("flag voice.echo-reports off: exactly today's behaviour (the incident line got through)", async () => {
    const s = setup({ "voice.echo-reports": false });
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    const lane = await s.agent(phone);
    await s.msg(lane, { type: "say", text: AGENT });
    const id = s.posted()[0]!.id;
    s.tick(75_000);
    await play(s, phone, `${id}#1`, AGENT, 8000);
    s.tick(500);
    await s.msg(mac, s.voice("m1", HEARD, { endAgo: 3500 }));
    expect(s.posted().map((x) => x.id)).toEqual([id, "m1"]);
    expect(mac.all("echo")).toEqual([]);
    // Today's rule still keeps a close copy aside, hidden: no echo frame, no snapshot.
    await s.msg(lane, { type: "say", text: "表里 alive 只表示进程活着，忙不忙要看 state。" });
    s.tick(20_000);
    await s.msg(mac, s.voice("m2", "表里机费，只表示进程活着，忙不忙要看 state"));
    expect(s.storage.store.get("echo:m2")).toMatchObject({
      echo: { kind: "read-aloud", layer: "landed" },
    });
    expect(s.storage.store.get("echo:m2")).not.toHaveProperty("echo.shown");
    expect(mac.all("echo")).toEqual([]);
    expect((await s.page("/ pwa iPad", "ipad1")).all("echoes")).toEqual([]);
  });

  it("his own words while the phone reads, or the same words at another time: his lines", async () => {
    const s = setup();
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    await play(s, phone, "x#1", AGENT, 8000);
    s.tick(500);
    await s.msg(mac, s.voice("m1", "我们明天去公园散步吧", { endAgo: 3500 }));
    // 30 s later, nothing playing: reading it aloud himself is his line.
    s.tick(30_000);
    await s.msg(mac, s.voice("m2", HEARD));
    expect(s.posted().map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(mac.all("echo")).toEqual([]);
  });

  it("uses the page's own hub span when it sent one", async () => {
    const s = setup();
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    const start = s.now();
    await play(s, phone, "x#1", AGENT, 8000);
    // Sent much later (an outbox resend): its timing says nothing, its hub span does.
    s.tick(40_000);
    await s.msg(mac, {
      ...s.voice("m1", HEARD),
      timing: { t_speechEnd: 0, t_sent: 200_000 },
      hubSpan: { from: start + 1000, to: start + 5000 },
    });
    expect(s.posted()).toEqual([]);
    expect((mac.last("echo") as { line: { echo: { of: string } } }).line.echo.of).toBe("x");
  });

  it("his clone's read-back heard by the other device; a page sound names no line", async () => {
    const s = setup();
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    await play(s, phone, "p7", "the quick brown fox jumps over the lazy dog", 3000, "words");
    await s.msg(
      mac,
      s.voice("m1", "quick brown fox jumps over the lazy", { endAgo: 500, len: 2000 }),
    );
    const e = mac.last("echo") as { line: { echo: Record<string, unknown> } };
    expect(e.line.echo).toMatchObject({ layer: "report", voice: "words", of: "" });
  });

  it("only his own pages report: a page framed in another site is ignored", async () => {
    const s = setup();
    const framed = await s.page("/embed", "emb1", "&frame=foreign");
    const mac = await s.page("/dev mac Chrome", "mac1");
    await play(s, framed, "x#1", AGENT, 8000);
    s.tick(500);
    await s.msg(mac, s.voice("m1", HEARD, { endAgo: 3500 }));
    expect(s.posted().map((x) => x.id)).toEqual(["m1"]);
    expect(framed.all("echo")).toEqual([]);
  });

  it("reports age out after voice.echoPlayKeepMs; a garbled frame is dropped", async () => {
    const s = setup({}, { "voice.echoPlayKeepMs": 10_000 });
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    // Read the config once (a first line near a report), so the store keeps reports 10 s.
    await play(s, phone, "w#1", "今天的天气非常好", 1000);
    await s.msg(mac, s.voice("m0", "好的我先看一下再说", { endAgo: 0, len: 500 }));
    // Garbled (no words): dropped, nothing answered.
    const before = phone.sent.length;
    await s.msg(phone, { type: "playing", ref: "x#1", voice: "device", from: s.now() });
    expect(phone.sent.length).toBe(before);
    await play(s, phone, "x#1", AGENT, 8000);
    s.tick(30_000);
    // Overlapping in time by its span, but the report is gone.
    await s.msg(mac, {
      ...s.voice("m1", HEARD),
      hubSpan: { from: s.now() - 32_000, to: s.now() - 29_000 },
    });
    expect(s.posted().map((x) => x.id)).toEqual(["m0", "m1"]);
  });

  it("today's rule, with the flag on: an agent line read back is shown; his other device's copy stays hidden", async () => {
    const s = setup();
    const a = await s.page("/words pwa iPhone", "a1");
    const b = await s.page("/words pwa Pixel", "b1");
    const c = await s.agent(a);
    await s.msg(c, { type: "say", text: "表里 alive 只表示进程活着，忙不忙要看 state。" });
    s.tick(20_000);
    await s.msg(b, s.voice("v1", "表里机费，只表示进程活着，忙不忙要看 state"));
    expect((a.last("echo") as { line: { echo: Record<string, unknown> } }).line.echo).toMatchObject(
      {
        layer: "landed",
        kind: "read-aloud",
        shown: true,
      },
    );
    expect(JSON.parse(logs.find((l) => l.includes('"debug.echo"'))!)).toHaveProperty("head");
    await s.msg(a, s.voice("v2", "我们明天去公园散步吧"));
    s.tick(3000);
    await s.msg(b, s.voice("v3", "我们明天去公园散步吧"));
    expect(s.storage.store.get("echo:v3")).toMatchObject({ echo: { kind: "other-device" } });
    expect(a.all("echo").map((e) => (e.line as { id: string }).id)).toEqual(["v1"]);
  });

  it("keeps at most voice.echoShowMax echoes; an evicted one leaves the pages' rows", async () => {
    const s = setup({}, { "voice.echoShowMax": 1 });
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    await play(s, phone, "x#1", AGENT, 8000);
    await s.msg(mac, s.voice("m1", HEARD, { endAgo: 1000 }));
    await play(s, phone, "y#1", "我们先看一下日志然后再决定要不要回滚", 3000);
    await s.msg(mac, s.voice("m2", "我们先看一下日志然后再决定", { endAgo: 500, len: 2000 }));
    expect(mac.all("echo").map((e) => (e.line as { id: string }).id)).toEqual(["m1", "m2"]);
    expect(mac.last("echo-gone")).toEqual({ type: "echo-gone", ids: ["m1"] });
    expect(s.storage.store.has("echo:m1")).toBe(false);
    expect(s.storage.store.has("echo:m2")).toBe(true);
  });

  it("flag voice.echo-dedupe off: no echo step at all, reports or not", async () => {
    const s = setup({ "voice.echo-dedupe": false });
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    await play(s, phone, "x#1", AGENT, 8000);
    await s.msg(mac, s.voice("m1", HEARD, { endAgo: 1000 }));
    expect(s.posted().map((x) => x.id)).toEqual(["m1"]);
  });
});
