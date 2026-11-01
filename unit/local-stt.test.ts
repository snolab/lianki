import { describe, expect, it } from "bun:test";
import {
  BACKOFF_BASE_MS,
  CONNECT_TIMEOUT_MS,
  STABLE_MS,
  FINAL_TIMEOUT_MS,
  RACE_STAGGER_MS,
  STT_TICKET_PATH,
  type WsLike,
  createLocalStt,
  fetchSttTicket,
  localSttFrom,
  needsTicket,
  packPcm,
} from "@lianki/debug-chat/local-stt";
import { encodeWav } from "@lianki/debug-chat/mic";
import { connectLocalStt, readWav } from "../scripts/local-stt/stream-clip-lib";

/** A WebSocket the test drives: what was sent, and server messages on demand. */
function fakeWs() {
  const socks: (WsLike & {
    sent: (string | Uint8Array)[];
    say: (m: object) => void;
    drop: () => void;
  })[] = [];
  const open = () => {
    const s = {
      readyState: 0,
      binaryType: "blob",
      sent: [] as (string | Uint8Array)[],
      send(d: string | Uint8Array) {
        s.sent.push(d);
      },
      close() {
        s.drop();
      },
      onopen: null as WsLike["onopen"],
      onclose: null as WsLike["onclose"],
      onerror: null as WsLike["onerror"],
      onmessage: null as WsLike["onmessage"],
      say(m: object) {
        s.onmessage?.({ data: JSON.stringify(m) });
      },
      drop() {
        s.readyState = 3;
        s.onclose?.({});
      },
    };
    socks.push(s);
    return s;
  };
  return { socks, open };
}

function setup() {
  const w = fakeWs();
  let t = 0;
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const stt = createLocalStt("wss://mac.ts.net/lianki-stt", {
    open: w.open,
    now: () => t,
    setTimer: (f, ms) => {
      const x = { f, ms, live: true };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => {
      if (x) (x as { live: boolean }).live = false;
    },
  });
  const connect = () => {
    stt.warm();
    const s = w.socks.at(-1)!;
    s.readyState = 1;
    s.say({ t: "ready", engine: "sensevoice", model: "m" });
    return s;
  };
  return { w, stt, timers, connect, advance: (ms: number) => (t += ms) };
}

const json = (x: string | Uint8Array) => JSON.parse(x as string);

describe("stream-clip-lib", () => {
  it("reads a 16-bit mono WAV the mic made", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), 16000);
    const { rate, samples } = readWav(wav);
    expect(rate).toBe(16000);
    expect([...samples].map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.5, -0.5]);
    expect(() => readWav(wav.subarray(0, 36))).toThrow("no data");
  });

  it("gives up on a server that never says ready", async () => {
    await expect(connectLocalStt("ws://127.0.0.1:9/none", 30)).rejects.toThrow("could not reach");
  });
});

describe("localSttFrom", () => {
  it("takes wss anywhere, ws only on localhost", () => {
    expect(localSttFrom("wss://mac.ts.net/lianki-stt")).toBe("wss://mac.ts.net/lianki-stt");
    expect(localSttFrom("ws://localhost:5193")).toBe("ws://localhost:5193/");
    expect(localSttFrom("ws://evil.example/x")).toBeUndefined();
    expect(localSttFrom("https://mac.ts.net")).toBeUndefined();
    expect(localSttFrom("nonsense")).toBeUndefined();
    expect(localSttFrom(null)).toBeUndefined();
  });

  it("takes a list, in order, dropping what it would not take alone and repeats", () => {
    expect(localSttFrom(" wss://mac.ts.net/lianki-stt, wss://stt.lianki.com ")).toBe(
      "wss://mac.ts.net/lianki-stt wss://stt.lianki.com/",
    );
    expect(
      localSttFrom("ws://evil.example wss://stt.lianki.com wss://stt.lianki.com/ nonsense"),
    ).toBe("wss://stt.lianki.com/");
    expect(localSttFrom(" , ")).toBeUndefined();
  });
});

describe("needsTicket / fetchSttTicket", () => {
  it("the tunnel needs a ticket; the tailnet and localhost do not", () => {
    expect(needsTicket("wss://stt.lianki.com/")).toBe(true);
    expect(needsTicket("wss://mac.onca-tint.ts.net/lianki-stt")).toBe(false);
    expect(needsTicket("ws://localhost:5193/")).toBe(false);
    expect(needsTicket("ws://127.0.0.1:5193/")).toBe(false);
    // A ticket goes to the tunnel only, never to another host a stored value names.
    expect(needsTicket("wss://evil.example/")).toBe(false);
    expect(needsTicket("wss://stt.lianki.com.evil.example/")).toBe(false);
  });

  it("POSTs to the owner route with the session cookie and returns the ticket", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = (async (u: string, init?: RequestInit) => {
      calls.push([u, init]);
      return new Response(JSON.stringify({ ticket: "a.b", exp: 1 }));
    }) as unknown as typeof fetch;
    expect(await fetchSttTicket(f)).toBe("a.b");
    expect(calls).toEqual([[STT_TICKET_PATH, { method: "POST", credentials: "same-origin" }]]);
    const no = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchSttTicket(no)).rejects.toThrow("HTTP 404");
    const empty = (async () => new Response("{}")) as unknown as typeof fetch;
    await expect(fetchSttTicket(empty)).rejects.toThrow("none");
  });
});

describe("createLocalStt: racing the tailnet and the tunnel", () => {
  const TAILNET = "wss://mac.ts.net/lianki-stt";
  const TUNNEL = "wss://stt.lianki.com/";

  function race(ticket: () => Promise<string> = async () => "tk.sig") {
    const socks: (ReturnType<ReturnType<typeof fakeWs>["open"]> & {
      url: string;
      protocols?: string[];
      closedByUs: boolean;
    })[] = [];
    const w = fakeWs();
    const timers: { f: () => void; ms: number; live: boolean }[] = [];
    const logs: Record<string, unknown>[] = [];
    let tickets = 0;
    const stt = createLocalStt(`${TAILNET} ${TUNNEL}`, {
      open: (url, protocols) => {
        const s = Object.assign(w.open(), { url, protocols, closedByUs: false });
        s.close = () => {
          s.closedByUs = true;
          s.drop();
        };
        socks.push(s);
        return s;
      },
      ticket: () => {
        tickets++;
        return ticket();
      },
      setTimer: (f, ms) => {
        const x = { f, ms, live: true };
        timers.push(x);
        return x;
      },
      clearTimer: (x) => {
        if (x) (x as { live: boolean }).live = false;
      },
      log: (ev) => logs.push(ev),
    });
    /** Fire the live timers of this length (the stagger, the connect deadline). */
    const fire = (ms: number) => {
      for (const t of timers.filter((x) => x.live && x.ms === ms)) {
        t.live = false;
        t.f();
      }
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const ready = (s: (typeof socks)[number]) => {
      s.readyState = 1;
      s.say({ t: "ready", engine: "sensevoice", model: "m" });
    };
    return { stt, socks, fire, flush, ready, logs, tickets: () => tickets };
  }

  it("the tailnet at once, the tunnel 150 ms later with its ticket as a subprotocol", async () => {
    const h = race();
    h.stt.warm();
    expect(h.socks.map((s) => s.url)).toEqual([TAILNET]);
    expect(h.socks[0].protocols).toBeUndefined();
    expect(h.tickets()).toBe(1); // asked for at once, so it is there in time
    h.fire(RACE_STAGGER_MS);
    await h.flush();
    expect(h.socks.map((s) => s.url)).toEqual([TAILNET, TUNNEL]);
    expect(h.socks[1].protocols).toEqual(["lianki-stt", "tk.sig"]);
    expect(h.stt.state()).toBe("connecting");
  });

  it("the tunnel says ready first: it is used and the tailnet closed", async () => {
    const h = race();
    h.stt.warm();
    h.fire(RACE_STAGGER_MS);
    await h.flush();
    h.ready(h.socks[1]);
    expect(h.stt.state()).toBe("ready");
    expect(h.socks[0].closedByUs).toBe(true);
    expect(h.logs.at(-1)).toMatchObject({ state: "ready", via: "stt.lianki.com" });
    // The utterance goes over the winner, and the loser's late close changes nothing.
    const u = h.stt.begin(() => {})!;
    expect(JSON.parse(h.socks[1].sent[0] as string)).toEqual({ t: "begin", id: 1 });
    expect(h.socks[0].sent).toHaveLength(0);
    const f = u.end(new Float32Array(0));
    h.socks[1].say({ t: "final", id: 1, text: "好", model: "m", ms: 50 });
    expect((await f).text).toBe("好");
    expect(h.stt.connected()).toBe(true);
  });

  it("the tailnet ready within 150 ms: the tunnel is never opened", async () => {
    const h = race();
    h.stt.warm();
    h.ready(h.socks[0]);
    h.fire(RACE_STAGGER_MS); // cleared: nothing happens
    await h.flush();
    expect(h.socks).toHaveLength(1);
    expect(h.stt.state()).toBe("ready");
  });

  it("the tailnet failing (Tailscale off) starts the tunnel at once, without the wait", async () => {
    const h = race();
    h.stt.warm();
    h.socks[0].drop();
    await h.flush();
    expect(h.socks.map((s) => s.url)).toEqual([TAILNET, TUNNEL]);
    expect(h.stt.state()).toBe("connecting");
    h.ready(h.socks[1]);
    expect(h.stt.state()).toBe("ready");
  });

  it("both fail: down; the next utterance races again, and goes to the cloud if that fails too", async () => {
    const h = race();
    h.stt.warm();
    h.socks[0].drop();
    await h.flush();
    h.socks[1].drop();
    expect(h.stt.state()).toBe("down");
    expect(h.logs.at(-1)).toMatchObject({ state: "unreachable" });
    const u = h.stt.begin(() => {})!; // held while a new race runs
    expect(h.socks).toHaveLength(3);
    expect(h.tickets()).toBe(2); // a fresh ticket per race: each is single-use
    const f = u.end(new Float32Array(10));
    h.socks[2].drop();
    await h.flush();
    h.socks[3].drop();
    await expect(f).rejects.toThrow("unreachable");
  });

  it("no ticket (not the owner, or tickets off): the tunnel is out, the tailnet still races", async () => {
    const h = race(async () => {
      throw new Error("stt ticket: HTTP 404");
    });
    h.stt.warm();
    h.fire(RACE_STAGGER_MS);
    await h.flush();
    expect(h.socks).toHaveLength(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ state: "lost-race", via: "stt.lianki.com", why: "ticket" }),
    );
    expect(h.stt.state()).toBe("connecting");
    h.socks[0].drop();
    expect(h.stt.state()).toBe("down");
  });

  it("neither ready by the deadline: both closed, down", async () => {
    const h = race();
    h.stt.warm();
    h.fire(RACE_STAGGER_MS);
    await h.flush();
    h.fire(CONNECT_TIMEOUT_MS);
    expect(h.socks.every((s) => s.closedByUs)).toBe(true);
    expect(h.stt.state()).toBe("down");
  });

  it("close() mid-race closes every socket and stays idle", async () => {
    const h = race();
    h.stt.warm();
    h.fire(RACE_STAGGER_MS);
    await h.flush();
    h.stt.close();
    expect(h.socks.every((s) => s.closedByUs)).toBe(true);
    expect(h.stt.state()).toBe("idle");
  });

  it("the winner dropping later: down, and the next utterance races again", async () => {
    const h = race();
    h.stt.warm();
    h.ready(h.socks[0]);
    h.socks[0].drop();
    expect(h.stt.state()).toBe("down");
    expect(h.stt.begin(() => {})).not.toBeNull(); // held, not lost
    expect(h.socks.at(-1)?.url).toBe(TAILNET);
    expect(h.stt.state()).toBe("connecting");
  });
});

describe("packPcm", () => {
  it("a tag byte, then int16 little-endian, clipped", () => {
    const b = packPcm(1, new Float32Array([0, 1, -1, 2, 0.5]));
    expect(b[0]).toBe(1);
    const v = new DataView(b.buffer);
    expect([1, 3, 5, 7, 9].map((o) => v.getInt16(o, true))).toEqual([
      0, 32767, -32768, 32767, 16383,
    ]);
  });
});

describe("createLocalStt", () => {
  it("not connected: begin holds the utterance and opens the socket", () => {
    const h = setup();
    expect(h.stt.begin(() => {})).not.toBeNull();
    expect(h.w.socks).toHaveLength(1);
    expect(h.w.socks[0].sent).toHaveLength(0); // nothing until ready
    expect(h.stt.connected()).toBe(false);
  });

  it("no URL at all: begin is null", () => {
    const stt = createLocalStt("", { open: fakeWs().open });
    expect(stt.begin(() => {})).toBeNull();
  });

  it("streams frames, shows partials, and resolves the final with its timings", async () => {
    const h = setup();
    const s = h.connect();
    const partials: string[] = [];
    const u = h.stt.begin((t) => partials.push(t))!;
    expect(json(s.sent[0])).toEqual({ t: "begin", id: 1 });
    u.frame(new Float32Array(512));
    u.frame(new Float32Array(512));
    expect((s.sent[1] as Uint8Array)[0]).toBe(1);
    h.advance(400);
    s.say({ t: "partial", id: 1, text: "你好" });
    expect(partials).toEqual(["你好"]);
    const done = u.end(new Float32Array(512 * 2 + 300));
    // The pre-pad (the 300 samples before the first frame), then end.
    expect((s.sent[3] as Uint8Array)[0]).toBe(2);
    expect((s.sent[3] as Uint8Array).length).toBe(1 + 300 * 2);
    expect(json(s.sent[4])).toEqual({ t: "end", id: 1 });
    s.say({ t: "partial", id: 1, text: "ignored after end" });
    h.advance(60);
    s.say({ t: "final", id: 1, text: "你好。", model: "sv", lang: "zh", ms: 40 });
    expect(await done).toEqual({
      text: "你好。",
      model: "local:sv",
      lang: "zh",
      ms: 40,
      endToFinalMs: 60,
      firstPartialMs: 400,
    });
    expect(partials).toEqual(["你好"]);
  });

  it("a dropped socket rejects the final; the next begin reconnects", async () => {
    const h = setup();
    const s = h.connect();
    const u = h.stt.begin(() => {})!;
    const done = u.end(new Float32Array(10));
    s.drop();
    await expect(done).rejects.toThrow("closed");
    expect(h.stt.begin(() => {})).not.toBeNull(); // held while it reconnects
    expect(h.w.socks).toHaveLength(2);
  });

  it("no final in time, or an error: rejects", async () => {
    const h = setup();
    const s = h.connect();
    const a = h.stt.begin(() => {})!.end(new Float32Array(10));
    h.timers
      .filter((t) => t.ms === FINAL_TIMEOUT_MS && t.live)
      .at(-1)!
      .f();
    await expect(a).rejects.toThrow("timed out");
    const b = h.stt.begin(() => {})!.end(new Float32Array(10));
    s.say({ t: "error", id: 2, error: "boom" });
    await expect(b).rejects.toThrow("boom");
  });

  it("a server that never says ready is closed after the connect timeout", () => {
    const h = setup();
    h.stt.warm();
    const s = h.w.socks[0];
    s.readyState = 1;
    h.timers.find((t) => t.ms === CONNECT_TIMEOUT_MS)!.f();
    expect(s.readyState).toBe(3);
    expect(h.stt.connected()).toBe(false);
  });

  it("reports its state for the mic's dot: connecting, ready, down, idle", () => {
    const h = setup();
    const seen: string[] = [];
    const off = h.stt.subscribe((s) => seen.push(s));
    expect(h.stt.state()).toBe("idle");
    const s = h.connect();
    s.drop();
    h.stt.warm();
    h.stt.close();
    off();
    h.stt.warm();
    expect(seen).toEqual(["connecting", "ready", "down", "connecting", "idle"]);
  });

  it("ignores what is not JSON, and a send that throws", async () => {
    const h = setup();
    const s = h.connect();
    s.onmessage?.({ data: "not json" });
    s.onmessage?.({ data: new Uint8Array(2) });
    expect(h.stt.connected()).toBe(true);
    s.send = () => {
      throw new Error("socket busy");
    };
    const u = h.stt.begin(() => {}); // the begin message throws: swallowed
    expect(u).not.toBeNull();
  });

  it("ending an utterance whose socket went away rejects at once", async () => {
    const h = setup();
    const s = h.connect();
    const u = h.stt.begin(() => {})!;
    s.readyState = 3; // closing, before onclose
    await expect(u.end(new Float32Array(10))).rejects.toThrow("not connected");
  });

  it("works with the real WebSocket and timers by default", async () => {
    const stt = createLocalStt("ws://127.0.0.1:9/none");
    const down = new Promise<void>((res) => stt.subscribe((s) => s === "down" && res()));
    stt.warm();
    expect(stt.state()).toBe("connecting");
    await down;
    stt.close();
    expect(stt.state()).toBe("idle");
  });

  it("a socket that cannot even be made is down", () => {
    const stt = createLocalStt("wss://x.ts.net", {
      open: () => {
        throw new Error("blocked");
      },
    });
    stt.warm();
    expect(stt.state()).toBe("down");
  });

  it("cancel tells the server and drops the utterance", () => {
    const h = setup();
    const s = h.connect();
    const u = h.stt.begin(() => {})!;
    u.cancel();
    expect(json(s.sent.at(-1)!)).toEqual({ t: "cancel", id: 1 });
    u.cancel(); // once only
    expect(s.sent).toHaveLength(2);
  });
});

/**
 * A clock, one-shot timers and the page's events the test drives: the held
 * utterance, reopening while the mic is on, and the close log.
 */
function page(o: { visible?: boolean } = {}) {
  type Sock = WsLike & {
    sent: (string | Uint8Array)[];
    say: (m: object) => void;
    drop: (e?: { code?: number; reason?: string; wasClean?: boolean }) => void;
  };
  const socks: Sock[] = [];
  let t = 0;
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const logs: Record<string, unknown>[] = [];
  let fire: ((why: "visible" | "online") => void) | null = null;
  let watching = 0;
  let visible = o.visible ?? true;
  const stt = createLocalStt("wss://mac.ts.net/lianki-stt", {
    open: () => {
      const s: Sock = {
        readyState: 0,
        binaryType: "blob",
        sent: [],
        send: (d) => void s.sent.push(d),
        close: () => s.drop({ code: 1000, reason: "", wasClean: true }),
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        say: (m) => s.onmessage?.({ data: JSON.stringify(m) }),
        drop: (e = {}) => {
          s.readyState = 3;
          s.onclose?.(e);
        },
      };
      socks.push(s);
      return s;
    },
    now: () => t,
    setTimer: (f, ms) => {
      const x = { f, ms, live: true };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => {
      if (x) (x as { live: boolean }).live = false;
    },
    log: (ev) => logs.push(ev),
    watch: (f) => {
      fire = f;
      watching++;
      return () => {
        fire = null;
        watching--;
      };
    },
    visible: () => visible,
  });
  const ready = (s = socks.at(-1)!) => {
    s.readyState = 1;
    s.say({ t: "ready", engine: "sensevoice", model: "m" });
    return s;
  };
  const live = (ms?: number) => timers.filter((x) => x.live && (ms === undefined || x.ms === ms));
  const run = (ms: number) => {
    for (const x of live(ms)) {
      x.live = false;
      x.f();
    }
  };
  return {
    stt,
    socks,
    logs,
    ready,
    live,
    run,
    advance: (ms: number) => void (t += ms),
    event: (why: "visible" | "online") => fire?.(why),
    watching: () => watching,
    setVisible: (v: boolean) => void (visible = v),
  };
}

describe("createLocalStt: an utterance begun while the socket is down", () => {
  it("is held, then streamed in order the moment the socket is ready", async () => {
    const h = page();
    const partials: string[] = [];
    const u = h.stt.begin((x) => partials.push(x))!;
    u.frame(new Float32Array(512).fill(0.1));
    u.frame(new Float32Array(512).fill(0.2));
    const s = h.socks[0];
    expect(s.sent).toHaveLength(0);
    h.advance(300);
    h.ready(s);
    // begin, then the two held frames, in order.
    expect(json(s.sent[0])).toEqual({ t: "begin", id: 1 });
    expect(s.sent.slice(1).map((x) => (x as Uint8Array).length)).toEqual([1025, 1025]);
    u.frame(new Float32Array(512)); // live from here on
    expect(s.sent).toHaveLength(4);
    h.advance(200);
    s.say({ t: "partial", id: 1, text: "你好" });
    expect(partials).toEqual(["你好"]);
    const f = u.end(new Float32Array(512 * 3));
    expect(json(s.sent.at(-1)!)).toEqual({ t: "end", id: 1 });
    s.say({ t: "final", id: 1, text: "你好。", model: "sv", ms: 30 });
    const out = await f;
    expect(out.text).toBe("你好。");
    expect(out.firstPartialMs).toBe(500); // measured from begin, the wait included
    expect(h.logs).toContainEqual(
      expect.objectContaining({ state: "held-streamed", heldMs: 300, frames: 2, ended: false }),
    );
  });

  it("an end() before ready: begin, frames, pre-pad and end all go out on ready", async () => {
    const h = page();
    const u = h.stt.begin(() => {})!;
    u.frame(new Float32Array(100));
    const f = u.end(new Float32Array(100 + 40));
    u.frame(new Float32Array(100)); // after the end: dropped
    const s = h.ready();
    expect(json(s.sent[0])).toEqual({ t: "begin", id: 1 });
    expect((s.sent[1] as Uint8Array)[0]).toBe(1);
    expect((s.sent[2] as Uint8Array)[0]).toBe(2); // the 40-sample pre-pad
    expect((s.sent[2] as Uint8Array).length).toBe(1 + 40 * 2);
    expect(json(s.sent[3])).toEqual({ t: "end", id: 1 });
    expect(s.sent).toHaveLength(4);
    s.say({ t: "final", id: 1, text: "ok", ms: 5 });
    expect((await f).text).toBe("ok");
  });

  it("opening fails within CONNECT_TIMEOUT_MS: the end() rejects, so the cloud takes it", async () => {
    const h = page();
    const u = h.stt.begin(() => {})!;
    u.frame(new Float32Array(100));
    const f = u.end(new Float32Array(100));
    h.run(CONNECT_TIMEOUT_MS);
    await expect(f).rejects.toThrow("unreachable");
    // A held utterance whose socket failed before its end rejects at once too.
    const v = h.stt.begin(() => {})!;
    h.socks.at(-1)!.drop();
    await expect(v.end(new Float32Array(1))).rejects.toThrow("unreachable");
  });

  it("cancelled while held: nothing of it is sent on ready", () => {
    const h = page();
    const u = h.stt.begin(() => {})!;
    u.frame(new Float32Array(100));
    u.cancel();
    const s = h.ready();
    expect(s.sent).toHaveLength(0);
  });

  it("the steady state is unchanged: with the socket up nothing is held and no timer is added", () => {
    const h = page();
    h.stt.warm();
    const s = h.ready();
    const timersBefore = h.live().length;
    const logsBefore = h.logs.length;
    const u = h.stt.begin(() => {})!;
    // Sent at once, no buffering: begin, then each frame as it comes.
    expect(json(s.sent[0])).toEqual({ t: "begin", id: 1 });
    u.frame(new Float32Array(10));
    expect(s.sent).toHaveLength(2);
    expect(h.live().length).toBe(timersBefore);
    expect(h.logs.length).toBe(logsBefore);
    void u.end(new Float32Array(10)).catch(() => {});
    expect(h.live(FINAL_TIMEOUT_MS)).toHaveLength(1); // only the final's own timeout, as before
  });
});

describe("createLocalStt: reopening while the mic is on (keep), event-driven", () => {
  it("a close reopens at once while kept; not once keep(false)", () => {
    const h = page();
    h.stt.keep(true);
    expect(h.watching()).toBe(1);
    const s = h.ready();
    h.advance(STABLE_MS);
    s.drop({ code: 1006, reason: "", wasClean: false });
    expect(h.socks).toHaveLength(2);
    expect(h.stt.state()).toBe("connecting");
    expect(h.logs).toContainEqual(expect.objectContaining({ state: "reconnect", why: "close" }));
    h.ready();
    h.stt.keep(false);
    expect(h.watching()).toBe(0);
    h.socks[1].drop();
    expect(h.socks).toHaveLength(2);
    expect(h.stt.state()).toBe("down");
  });

  it("visible and online reopen a socket that is down, and do nothing while it is up", () => {
    const h = page();
    h.stt.keep(true);
    h.ready();
    h.event("visible");
    h.event("online");
    expect(h.socks).toHaveLength(1);
    h.stt.keep(false);
    h.socks[0].drop();
    h.stt.keep(true); // mic on again
    expect(h.socks).toHaveLength(2);
    h.socks[1].drop(); // that open fails
    h.advance(10 * BACKOFF_BASE_MS);
    h.event("online");
    expect(h.socks).toHaveLength(3);
    expect(h.logs.at(-1)).toMatchObject({ state: "reconnect", why: "online" });
  });

  it("a socket left closed without its onclose (back from suspend) is replaced on visible", () => {
    const h = page();
    h.stt.keep(true);
    const s = h.ready();
    s.readyState = 3; // iOS: dead, no close event yet
    h.event("visible");
    expect(h.socks).toHaveLength(2);
    expect(h.logs).toContainEqual(expect.objectContaining({ state: "stale", readyState: 3 }));
    h.ready();
    s.onclose?.({}); // its late close changes nothing
    expect(h.stt.state()).toBe("ready");
  });

  it("a hidden page does not reopen on close; visible does", () => {
    const h = page();
    h.stt.keep(true);
    const s = h.ready();
    h.advance(STABLE_MS);
    h.setVisible(false);
    s.drop();
    expect(h.socks).toHaveLength(1);
    h.setVisible(true);
    h.event("visible");
    expect(h.socks).toHaveLength(2);
  });

  it("backs off after failures: one deferred attempt per event, 1 s then 2 s, never a loop", () => {
    const h = page();
    h.stt.keep(true);
    h.socks[0].drop(); // the first open fails: fails = 1
    expect(h.live().filter((x) => x.ms !== CONNECT_TIMEOUT_MS)).toHaveLength(0);
    h.event("online");
    h.event("visible"); // coalesced into the same deferred attempt
    expect(h.socks).toHaveLength(1);
    expect(h.live().map((x) => x.ms)).toEqual([BACKOFF_BASE_MS]);
    h.advance(BACKOFF_BASE_MS);
    h.run(BACKOFF_BASE_MS);
    expect(h.socks).toHaveLength(2);
    h.socks[1].drop(); // fails = 2, and nothing is scheduled by the failure itself
    expect(h.live().filter((x) => x.ms !== CONNECT_TIMEOUT_MS)).toHaveLength(0);
    h.event("online");
    expect(h.live().map((x) => x.ms)).toEqual([2 * BACKOFF_BASE_MS]);
    // An utterance does not wait for the backoff: it opens at once.
    h.stt.begin(() => {});
    expect(h.socks).toHaveLength(3);
    expect(h.live(2 * BACKOFF_BASE_MS)).toHaveLength(0);
  });

  it("a socket that drops soon after ready counts as a failure; one that lived STABLE_MS resets", () => {
    const h = page();
    h.stt.keep(true);
    h.ready().drop(); // dropped at once: fails = 1, the reopen waits
    expect(h.socks).toHaveLength(1);
    expect(
      h
        .live()
        .filter((x) => x.ms !== CONNECT_TIMEOUT_MS)
        .map((x) => x.ms),
    ).toEqual([BACKOFF_BASE_MS]);
    h.advance(BACKOFF_BASE_MS);
    h.run(BACKOFF_BASE_MS);
    h.ready();
    h.advance(STABLE_MS);
    h.socks[1].drop(); // lived long enough: reopened at once
    expect(h.socks).toHaveLength(3);
  });

  it("close() stops watching the page", () => {
    const h = page();
    h.stt.keep(true);
    h.stt.close();
    expect(h.watching()).toBe(0);
    expect(h.stt.state()).toBe("idle");
  });
});

describe("createLocalStt: the browser's close code", () => {
  it("logs local-stt-close {code, reason, wasClean} for a close that was not ours", () => {
    const h = page();
    h.stt.warm();
    h.advance(5);
    const s = h.ready();
    h.advance(1200);
    s.drop({ code: 1006, reason: "", wasClean: false });
    expect(h.logs).toContainEqual({
      ev: "local-stt-close",
      code: 1006,
      reason: "",
      wasClean: false,
      via: "mac.ts.net",
      livedMs: 1200,
    });
  });

  it("logs a race socket's close too, and never one we closed", () => {
    const h = page();
    h.stt.warm();
    h.socks[0].drop({ code: 1015, reason: "TLS", wasClean: false });
    expect(h.logs).toContainEqual(
      expect.objectContaining({ ev: "local-stt-close", code: 1015, reason: "TLS", phase: "race" }),
    );
    const n = h.logs.filter((x) => x.ev === "local-stt-close").length;
    h.stt.warm();
    h.ready();
    h.stt.close();
    expect(h.logs.filter((x) => x.ev === "local-stt-close")).toHaveLength(n);
  });
});
