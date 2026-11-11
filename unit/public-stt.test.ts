/**
 * The page's routes to Lianki's speech servers for other accounts
 * (packages/debug-chat/src/public-stt.ts): a v2 session, the registry's signal
 * socket, a WebRTC DataChannel that looks like the WebSocket the mic's race
 * already speaks; any failure loses the race (the cloud then), and the
 * availability check never leaves lianki.com.
 */
import { describe, expect, test } from "bun:test";
import { createLocalStt } from "../packages/debug-chat/src/local-stt";
import {
  CONSENT_KEY,
  PUBLIC_ROUTE_LIST,
  PUBLIC_RTC_URL,
  PUBLIC_WSS_URL,
  isPublicRoutes,
  publicOpen,
  publicSttAvailable,
  readConsent,
  writeConsent,
} from "../packages/debug-chat/src/public-stt";

const SESSION = {
  ticket: "tk.sig",
  exp: 1,
  signal: "/api/version/stt/signal",
  iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
  limits: { utteranceS: 40, sessionS: 900 },
};

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeSock {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  binaryType = "";
  constructor(
    public url: string,
    public protocols: string[],
  ) {}
  send(d: unknown) {
    this.sent.push(typeof d === "string" ? d : `<${(d as Uint8Array).length} bytes>`);
  }
  close() {
    this.closed = true;
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

class FakeChannel {
  readyState = "connecting";
  binaryType = "";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {}
}

class FakePeer {
  dc = new FakeChannel();
  remote?: string;
  added: unknown[] = [];
  closed = false;
  connectionState = "new";
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(public cfg: { iceServers: unknown[] }) {}
  createDataChannel(label: string) {
    expect(label).toBe("stt");
    return this.dc;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription() {
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "c1" }) } });
  }
  async setRemoteDescription(d: { sdp: string }) {
    this.remote = d.sdp;
  }
  async addIceCandidate(c: unknown) {
    this.added.push(c);
  }
  close() {
    this.closed = true;
  }
}

function rig(session: unknown = SESSION, status = 200) {
  const socks: FakeSock[] = [];
  const peers: FakePeer[] = [];
  const asked: string[] = [];
  const open = publicOpen({
    fetch: async (u, init) => {
      asked.push(`${init?.method} ${u}`);
      return new Response(status === 200 ? JSON.stringify(session) : null, { status });
    },
    socket: (u, p) => {
      const s = new FakeSock(u, p);
      socks.push(s);
      return s;
    },
    peer: (o) => {
      const p = new FakePeer(o);
      peers.push(p);
      return p as never;
    },
    origin: () => "wss://lianki.com",
  });
  return { open, socks, peers, asked };
}

describe("rtc:lianki", () => {
  test("session → signal socket with the v2 ticket → offer → answer → the channel is the socket", async () => {
    const r = rig();
    const ws = r.open(PUBLIC_RTC_URL);
    let opened = false;
    const got: unknown[] = [];
    ws.onopen = () => (opened = true);
    ws.onmessage = (e) => got.push(e.data);
    await tick();
    expect(r.asked).toEqual(["POST /api/stt/session"]);
    const sig = r.socks[0];
    expect(sig.url).toBe("wss://lianki.com/api/version/stt/signal");
    expect(sig.protocols).toEqual(["lianki-stt2", "tk.sig"]);
    sig.push({ t: "ready", sid: "s1" });
    await tick();
    const pc = r.peers[0];
    expect(pc.cfg.iceServers).toEqual(SESSION.iceServers);
    expect(sig.sent.map((s) => JSON.parse(s).t)).toEqual(["ice", "offer"]);
    sig.push({ t: "answer", sdp: "v=0 answer" });
    sig.push({ t: "ice", candidate: { candidate: "c2" } });
    await tick();
    expect(pc.remote).toBe("v=0 answer");
    expect(pc.added).toEqual([{ candidate: "c2" }]);
    expect(opened).toBe(false);
    pc.dc.onopen?.();
    expect(opened).toBe(true);
    expect(ws.readyState).toBe(1);
    ws.send('{"t":"begin","id":1}');
    ws.send(new Uint8Array(3));
    expect(pc.dc.sent).toHaveLength(2);
    pc.dc.onmessage?.({ data: '{"t":"ready"}' });
    expect(got).toEqual(['{"t":"ready"}']);
  });

  test("no session (flag off, not allowed, a quota): closed before it opens", async () => {
    const r = rig(null, 404);
    const ws = r.open(PUBLIC_RTC_URL);
    const closed = new Promise<{ code: number }>(
      (res) => (ws.onclose = (e) => res(e as { code: number })),
    );
    expect((await closed).code).toBe(4001);
    expect(r.socks).toHaveLength(0);
  });

  test("the registry has no worker (signal closed) or ends it: closed, everything torn down", async () => {
    const r = rig();
    const ws = r.open(PUBLIC_RTC_URL);
    let code = 0;
    ws.onclose = (e) => (code = (e as { code: number }).code);
    await tick();
    r.socks[0].push({ t: "ready", sid: "s1" });
    await tick();
    r.socks[0].push({ t: "end", reason: "worker-gone" });
    await tick();
    expect(code).toBe(4007);
    expect(r.peers[0].closed).toBe(true);
    expect(r.socks[0].closed).toBe(true);
  });
});

describe("wss:session", () => {
  test("no WSS route in the session: fails at once; with one, its socket with the ticket", async () => {
    const none = rig();
    const a = none.open(PUBLIC_WSS_URL);
    const closed = new Promise<{ code: number }>(
      (res) => (a.onclose = (e) => res(e as { code: number })),
    );
    expect((await closed).code).toBe(4008);
    const some = rig({ ...SESSION, wss: "wss://speech.example/x" });
    const b = some.open(PUBLIC_WSS_URL);
    let opened = false;
    b.onopen = () => (opened = true);
    await tick();
    expect(some.socks[0].url).toBe("wss://speech.example/x");
    expect(some.socks[0].protocols).toEqual(["lianki-stt2", "tk.sig"]);
    some.socks[0].onopen?.({});
    expect(opened).toBe(true);
  });
});

describe("in the mic's race", () => {
  test("WebRTC wins, the utterance streams over the channel and its final comes back", async () => {
    const r = rig();
    const stt = createLocalStt(PUBLIC_ROUTE_LIST, {
      open: r.open,
      connectTimeoutMs: 5000,
      watch: () => () => {},
    });
    stt.warm();
    await tick();
    r.socks[0].push({ t: "ready", sid: "s1" });
    await tick();
    const pc = r.peers[0];
    pc.dc.onopen?.();
    pc.dc.onmessage?.({ data: JSON.stringify({ t: "ready", engine: "sensevoice", model: "m" }) });
    await tick();
    expect(stt.connected()).toBe(true);
    const u = stt.begin(() => {})!;
    u.frame(new Float32Array(512));
    const fin = u.end(new Float32Array(512));
    await tick();
    const begin = pc.dc.sent
      .map((x) => (typeof x === "string" ? JSON.parse(x) : null))
      .find((m) => m?.t === "begin");
    pc.dc.onmessage?.({
      data: JSON.stringify({
        t: "final",
        id: begin.id,
        text: "你好。",
        lang: "zh",
        model: "m",
        ms: 40,
        audioMs: 1000,
      }),
    });
    expect((await fin).text).toBe("你好。");
    stt.close();
  });
});

describe("helpers", () => {
  test("the route list is recognised; the owner's URLs are not", () => {
    expect(isPublicRoutes(PUBLIC_ROUTE_LIST)).toBe(true);
    expect(isPublicRoutes("wss://taku.onca-tint.ts.net/lianki-stt wss://stt.lianki.com")).toBe(
      false,
    );
  });

  test("availability: only on lianki.com, 204 only", async () => {
    let asked = 0;
    const f = (status: number) => async () => (asked++, new Response(null, { status }));
    expect(await publicSttAvailable(f(204), "https://evil.example")).toBe(false);
    expect(asked).toBe(0);
    expect(await publicSttAvailable(f(204), "https://lianki.com")).toBe(true);
    expect(await publicSttAvailable(f(404), "https://lianki.com")).toBe(false);
  });

  test("consent per device: on, off, or ask", () => {
    const m = new Map<string, string>();
    const s = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    expect(readConsent(s)).toBeNull();
    writeConsent("on", s);
    expect(m.get(CONSENT_KEY)).toBe("on");
    expect(readConsent(s)).toBe("on");
    m.set(CONSENT_KEY, "maybe");
    expect(readConsent(s)).toBeNull();
  });
});

describe("every failure loses the race, nothing throws", () => {
  const closedCode = (ws: { onclose: ((e: unknown) => void) | null }) =>
    new Promise<number>((res) => (ws.onclose = (e) => res((e as { code: number }).code)));

  test("a bad session answer, a route that is not public, sending before open", async () => {
    const bad = rig({ ticket: 5 });
    expect(await closedCode(bad.open(PUBLIC_RTC_URL))).toBe(4001);
    const other = rig();
    const ws = other.open("wss://x.example");
    expect(() => ws.send("x")).toThrow("not open");
    expect(await closedCode(ws)).toBe(4000);
  });

  test("ICE failed, the offer or the answer refused, a candidate refused, junk on the signal socket", async () => {
    const r = rig();
    const ws = r.open(PUBLIC_RTC_URL);
    const code = closedCode(ws);
    await tick();
    r.socks[0].onmessage?.({ data: "not json" });
    r.socks[0].push({ t: "ready", sid: "s1" });
    await tick();
    const pc = r.peers[0];
    pc.addIceCandidate = async () => {
      throw new Error("no");
    };
    r.socks[0].push({ t: "ice", candidate: { candidate: "x" } });
    await tick();
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(await code).toBe(4004);

    const r2 = rig();
    const w2 = r2.open(PUBLIC_RTC_URL);
    const c2 = closedCode(w2);
    await tick();
    const realPeer = r2.peers;
    r2.socks[0].push({ t: "ready", sid: "s1" });
    await tick();
    realPeer[0].setRemoteDescription = async () => {
      throw new Error("bad sdp");
    };
    r2.socks[0].push({ t: "answer", sdp: "x" });
    await tick();
    expect(await c2).toBe(4006);
  });

  test("the offer cannot be made; the signal socket closes", async () => {
    const r = rig();
    const ws = r.open(PUBLIC_RTC_URL);
    const code = closedCode(ws);
    await tick();
    FakePeer.prototype.createOffer = async function () {
      throw new Error("no");
    } as never;
    r.socks[0].push({ t: "ready", sid: "s1" });
    await tick();
    await tick();
    expect(await code).toBe(4005);
    FakePeer.prototype.createOffer = async () => ({ type: "offer", sdp: "v=0 offer" });
    const r2 = rig();
    const w2 = r2.open(PUBLIC_RTC_URL);
    const c2 = closedCode(w2);
    await tick();
    r2.socks[0].onclose?.({ code: 4429, reason: "" });
    expect(await c2).toBe(4429);
  });

  test("wss: no session; its socket closing; close() tears it down", async () => {
    expect(await closedCode(rig(null, 429).open(PUBLIC_WSS_URL))).toBe(4001);
    const r = rig({ ...SESSION, wss: "wss://speech.example/x" });
    const ws = r.open(PUBLIC_WSS_URL);
    const got: unknown[] = [];
    ws.onmessage = (e) => got.push(e.data);
    await tick();
    r.socks[0].onopen?.({});
    r.socks[0].onmessage?.({ data: "hi" });
    expect(got).toEqual(["hi"]);
    ws.close();
    expect(r.socks[0].closed).toBe(true);
    const r2 = rig({ ...SESSION, wss: "wss://speech.example/x" });
    const w2 = r2.open(PUBLIC_WSS_URL);
    const c2 = closedCode(w2);
    await tick();
    r2.socks[0].onclose?.({ code: 1006 });
    expect(await c2).toBe(1006);
  });

  test("storage and fetch that throw read as nothing", async () => {
    const boom = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(readConsent(boom)).toBeNull();
    writeConsent("on", boom);
    const f = async () => {
      throw new Error("offline");
    };
    expect(await publicSttAvailable(f, "https://lianki.com")).toBe(false);
  });
});

describe("the browser's own pieces by default", () => {
  test("fetch, WebSocket, RTCPeerConnection and the page's origin from the globals", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = {
      fetch: g.fetch,
      WebSocket: g.WebSocket,
      RTC: g.RTCPeerConnection,
      location: g.location,
    };
    const socks: FakeSock[] = [];
    const peers: FakePeer[] = [];
    g.fetch = async () => Response.json(SESSION);
    g.WebSocket = function (u: string, p: string[]) {
      const s = new FakeSock(u, p);
      socks.push(s);
      return s;
    };
    g.RTCPeerConnection = function (o: { iceServers: unknown[] }) {
      const p = new FakePeer(o);
      peers.push(p);
      return p;
    };
    Object.defineProperty(globalThis, "location", {
      value: { origin: "https://lianki.com" },
      configurable: true,
    });
    try {
      const ws = publicOpen()(PUBLIC_RTC_URL);
      await tick();
      expect(socks[0].url).toBe("wss://lianki.com/api/version/stt/signal");
      socks[0].push({ t: "ready", sid: "s1" });
      await tick();
      expect(peers).toHaveLength(1);
      ws.close();
      expect(peers[0].closed).toBe(true);
      expect(socks[0].closed).toBe(true);
    } finally {
      g.fetch = saved.fetch;
      g.WebSocket = saved.WebSocket;
      g.RTCPeerConnection = saved.RTC;
      Object.defineProperty(globalThis, "location", { value: saved.location, configurable: true });
    }
  });
});

describe("errors on the carriers", () => {
  test("a socket error is left to its close; a peer that cannot be made keeps the chain going", async () => {
    const r = rig();
    const ws = r.open(PUBLIC_RTC_URL);
    await tick();
    r.socks[0].onerror?.({});
    const w = rig({ ...SESSION, wss: "wss://speech.example/x" });
    w.open(PUBLIC_WSS_URL);
    await tick();
    w.socks[0].onerror?.({});
    // The peer throws: that message is dropped, the next ones still run.
    const broken = publicOpen({
      fetch: async () => Response.json(SESSION),
      socket: (u, p) => {
        const s = new FakeSock(u, p);
        r.socks.push(s);
        return s;
      },
      peer: () => {
        throw new Error("no WebRTC here");
      },
      origin: () => "wss://lianki.com",
    });
    const b = broken(PUBLIC_RTC_URL);
    let code = 0;
    b.onclose = (e) => (code = (e as { code: number }).code);
    await tick();
    const sig = r.socks.at(-1)!;
    sig.push({ t: "ready", sid: "s1" });
    await tick();
    sig.push({ t: "end", reason: "x" });
    await tick();
    expect(code).toBe(4007);
    ws.close();
  });
});
