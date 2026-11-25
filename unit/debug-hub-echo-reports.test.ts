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

function setup(
  flags: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
) {
  const all: Record<string, unknown> = {
    "voice.echo-dedupe": true,
    "voice.echo-reports": true,
    "voice.echo-window": true,
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
    { SESSIONS: rpcStub(SESSIONS), ...env },
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

  it("other words while the phone reads: collapsed by the play window; the same words later: his", async () => {
    const s = setup();
    const phone = await s.page("/ pwa iPhone", "phone1");
    const mac = await s.page("/dev mac Chrome", "mac1");
    await play(s, phone, "x#1", AGENT, 8000);
    s.tick(500);
    await s.msg(mac, s.voice("m1", "我们明天去公园散步吧", { endAgo: 3500 }));
    // Spoken while the phone read (2026-11-26): an echo whatever the words, one tap restores it.
    expect(
      (mac.last("echo") as { line: { id: string; echo: { layer: string } } }).line,
    ).toMatchObject({
      id: "m1",
      echo: { layer: "window", kind: "read-aloud", shown: true },
    });
    // 30 s later, nothing playing: reading it aloud himself is his line.
    s.tick(30_000);
    await s.msg(mac, s.voice("m2", HEARD));
    expect(s.posted().map((x) => x.id)).toEqual(["m2"]);
    // From the Mac's own recogniser (another device): left to the words, his line.
    await play(s, phone, "z#1", AGENT, 8000);
    await s.msg(mac, {
      ...s.voice("m3", "我们明天去公园散步吧", { endAgo: 3500 }),
      stt: { route: "local", engine: "sensevoice" },
    });
    expect(s.posted().map((x) => x.id)).toEqual(["m2", "m3"]);
    // Flag voice.echo-window off: the words alone decide, as before.
    const off = setup({ "voice.echo-window": false });
    const p2 = await off.page("/ pwa iPhone", "phone1");
    const m2 = await off.page("/dev mac Chrome", "mac1");
    await play(off, p2, "x#1", AGENT, 8000);
    off.tick(500);
    await off.msg(m2, off.voice("m1", "我们明天去公园散步吧", { endAgo: 3500 }));
    expect(off.posted().map((x) => x.id)).toEqual(["m1"]);
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
    // Past the play window's tail: his.
    s.tick(3000);
    await s.msg(mac, s.voice("m0", "好的我先看一下再说", { endAgo: 0, len: 500 }));
    // No words: a time-only report, nothing answered.
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

describe("our own TTS voice (the Mac's self print, M4)", () => {
  const SAID = "今天的天气比较温和，西边吹来一阵微风";
  const selfTag = {
    decision: "self",
    score: 0.12,
    selfScore: 0.71,
    selfVoice: "melo-zh",
    model: "campp",
    device: "mac",
    speechS: 3.1,
    snrDb: 24,
  };
  async function rig(flags: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
    const mac = await speakerKey();
    const s = setup({ "stt.self-voice": true, ...flags }, config, { STT_SPEAKER_PUB: mac.pub });
    const sign = (text: string, uid: string, tag: Record<string, unknown> = selfTag) =>
      mac.sign({ ...tag, text, uid: uid.padEnd(16, "x"), thread: "owner", at: s.now() });
    return { s, mac, sign };
  }

  it("a signed self line is an echo with no report and no agent line: shown collapsed, never routed", async () => {
    const { s, sign } = await rig();
    const phone = await s.page("/ pwa iPhone", "phone1");
    const macPage = await s.page("/dev mac Chrome", "mac1");
    const lane = await s.agent(phone);
    await s.msg(macPage, { ...s.voice("q1", SAID), speakerProof: [await sign(SAID, "q1")] });
    expect(s.posted().map((x) => x.id)).toEqual([]);
    expect(s.heard(lane)).not.toContain("q1");
    expect(s.logged()).not.toContain("q1");
    const e = macPage.last("echo") as { line: { id: string; echo: Record<string, unknown> } };
    expect(e.line.id).toBe("q1");
    expect(e.line.echo).toMatchObject({
      kind: "self-voice",
      layer: "self",
      sim: 0.71,
      voice: "melo-zh",
      shown: true,
    });
    expect(lane.all("echo")).toEqual([]);
    const line = logs.find((l) => l.includes('"debug.echo"'))!;
    expect(JSON.parse(line)).toMatchObject({ id: "q1", layer: "self", kind: "self-voice" });
    expect(line).not.toContain("天气"); // numbers only
    // "This was me" posts it after all.
    await s.msg(macPage, { type: "unmerge", id: "q1" });
    expect(s.posted().map((x) => x.id)).toEqual(["q1"]);
    expect(s.heard(lane)).toContain("q1");
  });

  it("flag stt.self-voice off, a forged key, or a page's own claim: his line as before", async () => {
    const off = await rig({ "stt.self-voice": false });
    const p1 = await off.s.page("/dev mac Chrome", "mac1");
    await off.s.msg(p1, { ...off.s.voice("q1", SAID), speakerProof: [await off.sign(SAID, "q1")] });
    expect(off.s.posted().map((x) => x.id)).toEqual(["q1"]);

    const { s } = await rig({ "stt.self-voice": true });
    const forger = await speakerKey();
    const p2 = await s.page("/dev mac Chrome", "mac1");
    const forged = await forger.sign({
      ...selfTag,
      text: SAID,
      uid: "q2".padEnd(16, "x"),
      thread: "owner",
      at: s.now(),
    });
    await s.msg(p2, { ...s.voice("q2", SAID), speakerProof: [forged] });
    // A page cannot send a speaker tag at all: only proofs count.
    await s.msg(p2, { ...s.voice("q3", "我们一起去散步吧，好不好"), speaker: selfTag });
    expect(s.posted().map((x) => x.id)).toEqual(["q2", "q3"]);
    expect(p2.all("echo")).toEqual([]);
  });

  it("a signed me close to our self print does not outvote a play report (stt.selfMeMargin)", async () => {
    const meTag = { ...selfTag, decision: "me", score: 0.5, selfScore: 0.45, selfVoice: undefined };
    const { s, sign } = await rig();
    const phone = await s.page("/ pwa iPhone", "phone1");
    const macPage = await s.page("/dev mac Chrome", "mac1");
    await play(s, phone, "x#1", AGENT, 8000);
    await s.msg(macPage, {
      ...s.voice("m1", HEARD, { endAgo: 1000 }),
      speakerProof: [await sign(HEARD, "m1", meTag)],
    });
    expect(s.storage.store.get("echo:m1")).toMatchObject({
      echo: { kind: "read-aloud", layer: "report" },
    });
    // Clearly him (his print far over ours): his line, as a strong me always was.
    const clear = { ...meTag, score: 0.62, selfScore: 0.2 };
    await play(s, phone, "y#1", AGENT, 8000);
    await s.msg(macPage, {
      ...s.voice("m2", HEARD, { endAgo: 1000 }),
      speakerProof: [await sign(HEARD, "m2", clear)],
    });
    expect(s.posted().map((x) => x.id)).toEqual(["m2"]);
  });

  it("the play window: a Mac-checked line from another device is left to its words; the playing device's own is not", async () => {
    const unknownTag = {
      ...selfTag,
      decision: "unknown",
      score: 0.3,
      selfScore: 0.2,
      selfVoice: undefined,
    };
    const { s, sign } = await rig();
    const phone = await s.page("/ pwa iPhone", "phone1");
    const macPage = await s.page("/dev mac Chrome", "mac1");
    await play(s, phone, "x#1", AGENT, 8000);
    await s.msg(macPage, {
      ...s.voice("m1", "120", { endAgo: 1000, len: 1500 }),
      speakerProof: [await sign("120", "m1", unknownTag)],
    });
    expect(s.posted().map((x) => x.id)).toEqual(["m1"]);
    // The same short answer on the phone that is reading: folded.
    await play(s, phone, "y#1", AGENT, 8000);
    await s.msg(phone, s.voice("p1", "120", { endAgo: 1000, len: 1500 }));
    expect(s.posted().map((x) => x.id)).toEqual(["m1"]);
    expect(s.storage.store.get("echo:p1")).toMatchObject({ echo: { layer: "window" } });
  });
});

/**
 * 2026-11-26 00:30–00:55 JST: his phone on /words read agent lines and word
 * examples aloud; its own mic sent them to cloud Whisper, which wrote back
 * words sharing nothing with what played. The transcripts below are the ones
 * posted as his lines that night (/tmp/lianki-chat-fast.jsonl), replayed with
 * the timing of a phone that reports what it plays.
 */
describe("the play window: 2026-11-26 replay", () => {
  const MCP =
    "MCP metrics 超时：Verification waits on card c8d97cc0. Resuming instrumentation items 1/2/6";
  it("garbled read-aloud on the same phone is collapsed, never routed; his words after the tail are his", async () => {
    const s = setup();
    const phone = await s.page("/words pwa Android", "phone1");
    const mac = await s.page("/home mac Chrome", "mac1");
    const lane = await s.agent(mac);
    await s.msg(lane, { type: "say", text: MCP });
    const agentLine = s.posted().find((x) => x.from === "agent")!;
    // The phone reads it for 6 s; its mic hears it, Whisper writes nonsense.
    await play(s, phone, `${agentLine.id}#1`, MCP, 6000);
    await s.msg(phone, s.voice("w1", "面对超时 给互相优惯存在87群。", { endAgo: 500, len: 3000 }));
    // Just after the end, inside the tail.
    s.tick(1500);
    await s.msg(
      phone,
      s.voice("w2", "One, two, six and serial in the group.", { endAgo: 200, len: 1200 }),
    );
    // A word clip with no words reported (a file: time only), heard as Icelandic.
    await s.msg(phone, {
      type: "playing",
      ref: "p9",
      voice: "li-player",
      from: s.now(),
      synced: true,
    });
    s.tick(2000);
    await s.msg(phone, { type: "played", ref: "p9", to: s.now(), synced: true });
    await s.msg(phone, s.voice("w3", "Sennsjánssjánssjánssjánssjáns.", { endAgo: 300, len: 1500 }));
    // 10 s on, past the tail: Whisper's subtitle credit, with something read lately.
    s.tick(10_000);
    await s.msg(
      phone,
      s.voice("w4", "明镜需要您的支持 欢迎收看订阅明镜。", { endAgo: 300, len: 5000 }),
    );
    const echoes = ["w1", "w2", "w3", "w4"];
    expect(s.posted().map((x) => x.id)).toEqual([agentLine.id]);
    for (const id of echoes) {
      expect(s.heard(lane)).not.toContain(id);
      expect(s.logged()).not.toContain(id);
    }
    expect(lane.all("echo")).toEqual([]);
    const shown = mac
      .all("echo")
      .map((e) => (e as { line: { id: string; echo: { layer: string } } }).line);
    expect(shown.map((l) => [l.id, l.echo.layer])).toEqual([
      ["w1", "window"],
      ["w2", "window"],
      ["w3", "window"],
      ["w4", "noise"],
    ]);
    expect(shown[0]).toMatchObject({ echo: { kind: "read-aloud", of: agentLine.id, shown: true } });
    // Numbers only in the log, never the words.
    for (const l of logs.filter((x) => x.includes('"debug.echo"'))) expect(l).not.toContain("超时");
    // A minute later, nothing playing: his own line, routed as always.
    s.tick(60_000);
    await s.msg(
      mac,
      s.voice("m1", "你听到了没？这一大堆乱乱的东西都是你听到你自己念出来的东西的。"),
    );
    expect(s.posted().map((x) => x.id)).toEqual([agentLine.id, "m1"]);
    expect(s.heard(lane)).toContain("m1");
    // "This was me" on a window echo posts it after all.
    await s.msg(mac, { type: "unmerge", id: "w2" });
    expect(s.heard(lane)).toContain("w2");
  });

  it("a subtitle credit with nothing played lately is left alone (not ours to call an echo)", async () => {
    const s = setup();
    const phone = await s.page("/words pwa Android", "phone1");
    await s.msg(phone, s.voice("w1", "明镜需要您的支持 欢迎收看订阅明镜。"));
    expect(s.posted().map((x) => x.id)).toEqual(["w1"]);
  });
});
