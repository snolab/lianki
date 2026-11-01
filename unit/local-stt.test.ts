import { describe, expect, it } from "bun:test";
import {
  CONNECT_TIMEOUT_MS,
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

  it("both fail: down, and begin() is null so the utterance goes to the cloud", async () => {
    const h = race();
    h.stt.warm();
    h.socks[0].drop();
    await h.flush();
    h.socks[1].drop();
    expect(h.stt.state()).toBe("down");
    expect(h.logs.at(-1)).toMatchObject({ state: "unreachable" });
    expect(h.stt.begin(() => {})).toBeNull(); // and a new race starts for next time
    expect(h.socks).toHaveLength(3);
    expect(h.tickets()).toBe(2); // a fresh ticket per race: each is single-use
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
    expect(h.stt.begin(() => {})).toBeNull();
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
  it("not connected: begin is null and opens the socket for next time", () => {
    const h = setup();
    expect(h.stt.begin(() => {})).toBeNull();
    expect(h.w.socks).toHaveLength(1);
    expect(h.stt.connected()).toBe(false);
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
    expect(h.stt.begin(() => {})).toBeNull();
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
