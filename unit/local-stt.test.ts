import { describe, expect, it } from "bun:test";
import {
  CONNECT_TIMEOUT_MS,
  FINAL_TIMEOUT_MS,
  type WsLike,
  createLocalStt,
  localSttFrom,
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

  it("a socket that cannot even be made is down", () => {
    const stt = createLocalStt("wss://x", {
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
