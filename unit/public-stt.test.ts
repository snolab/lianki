/**
 * The page's routes to Lianki's speech servers for other accounts
 * (packages/debug-chat/src/public-stt.ts): a v2 session, the registry's signal
 * socket, a WebRTC DataChannel that looks like the WebSocket the mic's race
 * already speaks; any failure loses the race (the cloud then), and the
 * availability check never leaves lianki.com.
 */
import { describe, expect, test } from "bun:test";
import { globalDescriptor, restoreGlobal, setGlobal, stubGlobals } from "./support/globals";
import { createLocalStt } from "../packages/debug-chat/src/local-stt";
import {
  SPARE_MIN_LEFT_MS,
  CONSENT_KEY,
  DISCONNECTED_GRACE_MS,
  RESTART_TIMEOUT_MS,
  RESUME_GRACE_MS,
  PUBLIC_ROUTE_LIST,
  PUBLIC_RTC_URL,
  PUBLIC_WSS_URL,
  isMixedRoutes,
  isPublicRoutes,
  mixedOpen,
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
    // The session, then a spare for the next race (a failover should not wait for lianki.com).
    expect(r.asked).toEqual(["POST /api/stt/session", "POST /api/stt/session"]);
    const sig = r.socks[0];
    expect(sig.url).toBe("wss://lianki.com/api/version/stt/signal?lobby=1");
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

  test("a mixed list: his own Mac over WebRTC beside the tailnet", () => {
    const own = "wss://taku.onca-tint.ts.net/lianki-stt";
    expect(isMixedRoutes(`${PUBLIC_RTC_URL} ${own}`)).toBe(true);
    expect(isMixedRoutes(PUBLIC_ROUTE_LIST)).toBe(false);
    expect(isMixedRoutes(own)).toBe(false);
  });

  test("mixedOpen: a public route through publicOpen, any other a plain socket with its protocols", () => {
    const plain: { url: string; protocols?: string[] }[] = [];
    const open = mixedOpen(
      { fetch: async () => new Response(null, { status: 404 }) },
      (url, protocols) => {
        plain.push({ url, protocols });
        return { readyState: 0 } as never;
      },
    );
    open("wss://taku.onca-tint.ts.net/lianki-stt", ["lianki-stt", "tk"]);
    expect(plain).toEqual([
      { url: "wss://taku.onca-tint.ts.net/lianki-stt", protocols: ["lianki-stt", "tk"] },
    ]);
    const rtc = open(PUBLIC_RTC_URL);
    expect(plain).toHaveLength(1); // not a plain socket
    expect(rtc.readyState).toBe(0);
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
      fetch: globalDescriptor("fetch"),
      WebSocket: globalDescriptor("WebSocket"),
      RTC: globalDescriptor("RTCPeerConnection"),
      location: globalDescriptor("location"),
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
    setGlobal("location", { origin: "https://lianki.com" });
    try {
      const ws = publicOpen()(PUBLIC_RTC_URL);
      await tick();
      expect(socks[0].url).toBe("wss://lianki.com/api/version/stt/signal?lobby=1");
      socks[0].push({ t: "ready", sid: "s1" });
      await tick();
      expect(peers).toHaveLength(1);
      ws.close();
      expect(peers[0].closed).toBe(true);
      expect(socks[0].closed).toBe(true);
    } finally {
      restoreGlobal("fetch", saved.fetch);
      restoreGlobal("WebSocket", saved.WebSocket);
      restoreGlobal("RTCPeerConnection", saved.RTC);
      restoreGlobal("location", saved.location);
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

describe("rtc:lianki: routes that come and go (docs/local-stt.md)", () => {
  /** A rig with the page's events, timers and clock in the test's hands, at an open channel. */
  async function moving() {
    const socks: FakeSock[] = [];
    const peers: (FakePeer & { offers: unknown[] })[] = [];
    const logs: Record<string, unknown>[] = [];
    let fire: ((why: "online" | "visible") => void) | null = null;
    let t = 0;
    const timers: { f: () => void; ms: number; live: boolean }[] = [];
    let available = 0;
    const open = publicOpen({
      fetch: async () => new Response(JSON.stringify(SESSION)),
      socket: (u, p) => {
        const x = new FakeSock(u, p);
        socks.push(x);
        return x;
      },
      peer: (o) => {
        const p = Object.assign(new FakePeer(o), { offers: [] as unknown[] });
        const plain = p.createOffer.bind(p);
        p.createOffer = async (opts?: { iceRestart?: boolean }) => {
          p.offers.push(opts ?? {});
          return opts?.iceRestart ? { type: "offer", sdp: "v=0 restart" } : plain();
        };
        peers.push(p);
        return p as never;
      },
      origin: () => "wss://lianki.com",
      log: (ev) => logs.push(ev),
      events: (f) => {
        fire = f;
        return () => (fire = null);
      },
      setTimer: (f, ms) => {
        const x = { f, ms, live: true };
        timers.push(x);
        return x;
      },
      clearTimer: (x) => {
        if (x) (x as { live: boolean }).live = false;
      },
      now: () => t,
      available: () => void available++,
    });
    const ws = open(PUBLIC_RTC_URL);
    const closes: { code?: number; reason?: string }[] = [];
    ws.onclose = (e) => closes.push(e as { code?: number; reason?: string });
    await tick();
    const sig = socks[0];
    sig.readyState = 1;
    sig.push({ t: "ready", sid: "s1", resume: "r1" });
    await tick();
    const pc = peers[0];
    sig.push({ t: "answer", sdp: "v=0 answer" });
    await tick();
    pc.dc.onopen?.();
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    const state = (st: string) => {
      pc.connectionState = st;
      pc.onconnectionstatechange?.();
    };
    const run = (ms: number) => {
      for (const x of timers.filter((y) => y.live && y.ms === ms)) {
        x.live = false;
        x.f();
      }
    };
    const offers = (x: FakeSock) => x.sent.map((m) => JSON.parse(m)).filter((m) => m.t === "offer");
    return {
      ws,
      socks,
      sig,
      pc,
      logs,
      closes,
      state,
      run,
      offers,
      fire: (why: "online" | "visible") => fire?.(why),
      advance: (ms: number) => void (t += ms),
      available: () => available,
    };
  }

  test("online (a new network): an ICE restart on the same peer connection; the route stays open", async () => {
    const h = await moving();
    h.fire("online");
    await tick();
    expect(h.pc.offers.at(-1)).toEqual({ iceRestart: true });
    expect(h.offers(h.sig).at(-1)).toEqual({ t: "offer", sdp: "v=0 restart" });
    h.sig.push({ t: "answer", sdp: "v=0 answer 2" });
    await tick();
    expect(h.pc.remote).toBe("v=0 answer 2");
    h.state("connected");
    expect(h.logs).toContainEqual(expect.objectContaining({ state: "restarted" }));
    h.run(RESTART_TIMEOUT_MS); // cleared: nothing fails
    expect(h.closes).toHaveLength(0);
    expect(h.ws.readyState).toBe(1);
  });

  test("ICE disconnected past DISCONNECTED_GRACE_MS: a restart; not connected in time, the route is lost", async () => {
    const h = await moving();
    h.state("disconnected");
    expect(h.pc.offers).toHaveLength(1); // the first offer only, for now
    h.run(DISCONNECTED_GRACE_MS);
    await tick();
    expect(h.pc.offers.at(-1)).toEqual({ iceRestart: true });
    h.run(RESTART_TIMEOUT_MS);
    expect(h.closes.at(-1)).toMatchObject({ code: 4012 });
  });

  test("disconnected that comes back by itself: no restart", async () => {
    const h = await moving();
    h.state("disconnected");
    h.state("connected");
    h.run(DISCONNECTED_GRACE_MS);
    await tick();
    expect(h.pc.offers).toHaveLength(1);
  });

  test("ICE failed: one restart; failing again during it loses the route", async () => {
    const h = await moving();
    h.state("failed");
    await tick();
    expect(h.pc.offers.at(-1)).toEqual({ iceRestart: true });
    h.state("failed");
    expect(h.closes.at(-1)).toMatchObject({ code: 4004 });
  });

  test("the signal socket drops: resumed on a new one (same session), then an ICE restart there", async () => {
    const h = await moving();
    h.sig.readyState = 3;
    h.sig.onclose?.({ code: 1006 });
    const next = h.socks[1];
    expect(next.protocols).toEqual(["lianki-stt2-resume", "s1.r1"]);
    expect(h.closes).toHaveLength(0);
    next.readyState = 1;
    next.push({ t: "ready", sid: "s1", resume: "r2", resumed: true });
    await tick();
    expect(h.offers(next).at(-1)).toEqual({ t: "offer", sdp: "v=0 restart" });
    // A later drop resumes with the new token.
    next.readyState = 3;
    next.onclose?.({ code: 1006 });
    expect(h.socks[2].protocols).toEqual(["lianki-stt2-resume", "s1.r2"]);
  });

  test("a resume the registry refuses: the route is lost once the grace is over", async () => {
    const h = await moving();
    h.sig.readyState = 3;
    h.sig.onclose?.({ code: 1006 });
    const next = h.socks[1];
    next.readyState = 3;
    next.onclose?.({ code: 1006 }); // 401 before ready
    expect(h.closes).toHaveLength(0); // the peer connection may still carry it a while
    h.run(RESUME_GRACE_MS);
    expect(h.closes.at(-1)).toMatchObject({ code: 4011 });
  });

  test("the network changes while the signal socket is gone: resume first, then restart", async () => {
    const h = await moving();
    h.sig.readyState = 3; // dropped, its close not here yet (a suspended page)
    h.fire("online");
    await tick();
    expect(h.socks[1]?.protocols).toEqual(["lianki-stt2-resume", "s1.r1"]);
  });

  test("the worker's registry socket blips: away is only noted; back while disconnected restarts", async () => {
    const h = await moving();
    h.sig.push({ t: "worker-away" });
    await tick();
    expect(h.closes).toHaveLength(0);
    h.pc.connectionState = "disconnected";
    h.sig.push({ t: "worker-back" });
    await tick();
    expect(h.pc.offers.at(-1)).toEqual({ iceRestart: true });
  });

  test("no worker free (wait): the route fails at once; the lobby hears available and tells the page", async () => {
    const r = rig();
    let available = 0;
    const open = publicOpen({
      fetch: async () => new Response(JSON.stringify(SESSION)),
      socket: (u, p) => {
        const x = new FakeSock(u, p);
        r.socks.push(x);
        return x;
      },
      origin: () => "wss://lianki.com",
      events: () => () => {},
      available: () => void available++,
    });
    const ws = open(PUBLIC_RTC_URL);
    let code = 0;
    ws.onclose = (e) => (code = (e as { code: number }).code);
    await tick();
    const lobby = r.socks[0];
    lobby.push({ t: "wait" });
    await tick();
    expect(code).toBe(4010);
    expect(lobby.closed).toBe(false); // it waits on
    lobby.push({ t: "available" });
    expect(available).toBe(1);
    expect(lobby.closed).toBe(true);
  });
});

describe("rtc:lianki: the page's own events and the lobby's edges", () => {
  test("by default: online and visible from the page; available as a window event", async () => {
    const on = new Map<string, () => void>();
    const fired: string[] = [];
    const target = () => ({
      addEventListener: (k: string, f: () => void) => on.set(k, f),
      removeEventListener: (k: string) => on.delete(k),
      dispatchEvent: (e: Event) => void fired.push(e.type),
    });
    const doc = { ...target(), visibilityState: "hidden" };
    const restore = stubGlobals({ window: target(), document: doc });
    try {
      const socks: FakeSock[] = [];
      const peers: FakePeer[] = [];
      const open = publicOpen({
        fetch: async () => new Response(JSON.stringify(SESSION)),
        socket: (u, p) => {
          const x = new FakeSock(u, p);
          socks.push(x);
          return x;
        },
        peer: (o) => {
          const p = new FakePeer(o);
          peers.push(p);
          return p as never;
        },
        origin: () => "wss://lianki.com",
      });
      const ws = open(PUBLIC_RTC_URL);
      await tick();
      expect([...on.keys()].sort()).toEqual(["online", "visibilitychange"]);
      const sig = socks[0];
      sig.readyState = 1;
      sig.push({ t: "ready", sid: "s1", resume: "r1" });
      await tick();
      peers[0].dc.onopen?.();
      peers[0].connectionState = "disconnected";
      on.get("visibilitychange")!(); // hidden: nothing
      doc.visibilityState = "visible";
      on.get("visibilitychange")!(); // visible and not connected: a restart
      await tick();
      expect(sig.sent.map((m) => JSON.parse(m).t).filter((t) => t === "offer")).toHaveLength(2);
      ws.close();
      expect(on.size).toBe(0); // unwatched with the route
      // The lobby's default: a window event the mic's watcher hears.
      const ws2 = open(PUBLIC_RTC_URL);
      ws2.onclose = () => {};
      await tick();
      socks.at(-1)!.push({ t: "wait" });
      await tick();
      socks.at(-1)!.push({ t: "available" });
      expect(fired).toEqual(["lk-stt-available"]);
    } finally {
      restore();
    }
  });

  test("a newer lobby replaces the older; a lobby that closes is forgotten; noise is ignored", async () => {
    const socks: FakeSock[] = [];
    let available = 0;
    const open = publicOpen({
      fetch: async () => new Response(JSON.stringify(SESSION)),
      socket: (u, p) => {
        const x = new FakeSock(u, p);
        socks.push(x);
        return x;
      },
      origin: () => "wss://lianki.com",
      events: () => () => {},
      available: () => void available++,
    });
    for (let i = 0; i < 2; i++) {
      open(PUBLIC_RTC_URL).onclose = () => {};
      await tick();
      socks.at(-1)!.push({ t: "wait" });
      await tick();
    }
    expect(socks[0].closed).toBe(true); // replaced
    socks[1].onmessage?.({ data: "not json" });
    socks[1].push({ t: "other" });
    expect(available).toBe(0);
    socks[1].onclose?.({});
    socks[0].push({ t: "available" }); // the replaced one may still hear it: harmless
    expect(available).toBe(1);
  });

  test("a resumed ready on a stale socket, and a restart offer that throws, are handled", async () => {
    const socks: FakeSock[] = [];
    const peers: FakePeer[] = [];
    let fire: ((w: "online" | "visible") => void) | null = null;
    const open = publicOpen({
      fetch: async () => new Response(JSON.stringify(SESSION)),
      socket: (u, p) => {
        const x = new FakeSock(u, p);
        socks.push(x);
        return x;
      },
      peer: (o) => {
        const p = new FakePeer(o);
        peers.push(p);
        return p as never;
      },
      origin: () => "wss://lianki.com",
      events: (f) => ((fire = f), () => {}),
      setTimer: () => 0,
      clearTimer: () => {},
      now: () => 0,
    });
    const ws = open(PUBLIC_RTC_URL);
    let code = 0;
    ws.onclose = (e) => (code = (e as { code: number }).code);
    await tick();
    socks[0].readyState = 1;
    socks[0].push({ t: "ready", sid: "s1", resume: "r1" });
    await tick();
    peers[0].dc.onopen?.();
    peers[0].createOffer = async () => {
      throw new Error("no");
    };
    fire!("online");
    await tick();
    expect(code).toBe(4005);
  });
});

describe("rtc:lianki: a spare session for the next race", () => {
  function spareRig(exps: number[], now: () => number) {
    const asked: number[] = [];
    let n = 0;
    const socks: FakeSock[] = [];
    const open = publicOpen({
      fetch: async () => {
        const exp = exps[n++] ?? 0;
        asked.push(exp);
        return new Response(JSON.stringify({ ...SESSION, ticket: `t${n}`, exp }));
      },
      socket: (u, p) => {
        const x = new FakeSock(u, p);
        socks.push(x);
        return x;
      },
      peer: (o) => new FakePeer(o) as never,
      origin: () => "wss://lianki.com",
      events: () => () => {},
      now,
    });
    return { open, asked, socks };
  }

  test("the next race uses the spare at once, and a new spare is fetched behind it", async () => {
    const h = spareRig([100, 100, 100], () => 0);
    h.open(PUBLIC_RTC_URL).onclose = () => {};
    await tick();
    await tick();
    expect(h.socks[0].protocols[1]).toBe("t1");
    h.open(PUBLIC_RTC_URL).onclose = () => {};
    await tick();
    expect(h.socks[1].protocols[1]).toBe("t2"); // the spare, no wait for a new one
    await tick();
    expect(h.asked).toHaveLength(3);
  });

  test("a spare with too little of its ticket left is not used: a fresh session instead", async () => {
    let t = 0;
    const h = spareRig([100, 100, 200, 200], () => t);
    h.open(PUBLIC_RTC_URL).onclose = () => {};
    await tick();
    await tick();
    t = 100_000 - SPARE_MIN_LEFT_MS + 1; // the spare (exp 100 s) is nearly spent
    h.open(PUBLIC_RTC_URL).onclose = () => {};
    await tick();
    await tick();
    expect(h.socks[1].protocols[1]).toBe("t3");
  });
});
