/**
 * Meetings in the browser, the pure parts (lib/meetings/queue.ts,
 * lib/meetings/pcm.ts, core's clusterTimecode; docs/meetings.md): the piece
 * queue's order, retries and stops, the upload request, the 16 kHz PCM hook's
 * offsets, and a WebM Cluster's time.
 */
import { describe, expect, it } from "bun:test";
import { clusterTimecode } from "@/lib/meetings/core";
import { PCM_RATE, PcmHub, Resampler, toMono } from "@/lib/meetings/pcm";
import {
  type QueuedPiece,
  RETRY_DELAYS_MS,
  Uploader,
  memoryStore,
  pieceKey,
  retryDelay,
  sendPiece,
  verdictOf,
} from "@/lib/meetings/queue";

const piece = (seq: number, o: Partial<QueuedPiece> = {}): QueuedPiece => ({
  meeting: "m1",
  track: "av",
  seq,
  startMs: seq * 30_000,
  durMs: 30_000,
  fragOff: null,
  fragMs: null,
  sha256: "a".repeat(64),
  bytes: new Uint8Array([seq]).buffer,
  at: 1000 + seq,
  ...o,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(answers: (number | null | "throw")[]) {
  const store = memoryStore();
  const sent: string[] = [];
  const timers: { f: () => void; ms: number }[] = [];
  const online: (() => void)[] = [];
  const stops: [string, number][] = [];
  const changes: number[] = [];
  const u = new Uploader({
    store,
    async send(p) {
      sent.push(pieceKey(p));
      const a = answers.length ? answers.shift()! : 200;
      if (a === "throw") throw new Error("net");
      return a;
    },
    setTimer(f, ms) {
      const t = { f, ms };
      timers.push(t);
      return t;
    },
    clearTimer(t) {
      const i = timers.indexOf(t as never);
      if (i >= 0) timers.splice(i, 1);
    },
    onOnline(f) {
      online.push(f);
      return () => {
        const i = online.indexOf(f);
        if (i >= 0) online.splice(i, 1);
      };
    },
    onStop: (m, s) => stops.push([m, s]),
    onChange: (n) => changes.push(n),
  });
  return { u, store, sent, timers, online, stops, changes };
}

describe("verdicts and delays", () => {
  it("classifies answers", () => {
    expect(verdictOf(200)).toBe("done");
    expect(verdictOf(null)).toBe("retry");
    expect(verdictOf(500)).toBe("retry");
    expect(verdictOf(429)).toBe("retry");
    expect(verdictOf(408)).toBe("retry");
    expect(verdictOf(400)).toBe("drop");
    for (const s of [401, 403, 404, 409, 413]) expect(verdictOf(s)).toBe("stop");
    expect(RETRY_DELAYS_MS).toEqual([2000, 10000, 30000, 60000]);
    expect(retryDelay(0)).toBe(2000);
    expect(retryDelay(3)).toBe(60000);
    expect(retryDelay(4)).toBeNull();
    expect(pieceKey(piece(7))).toBe("m1/av/000007");
  });
});

describe("Uploader", () => {
  it("stores first, uploads in order, forgets confirmed pieces", async () => {
    const h = harness([200, 200]);
    await h.u.add(piece(0));
    await h.u.add(piece(1));
    await flush();
    await h.u.idle();
    expect(h.sent).toEqual(["m1/av/000000", "m1/av/000001"]);
    expect(h.store.map.size).toBe(0);
    expect(h.u.count).toBe(0);
    expect(h.changes.at(-1)).toBe(0);
    await h.u.idle();
  });

  it("retries after 2, 10, 30, 60 s, then waits for online", async () => {
    const h = harness([503, null, "throw", 429, 500, 200]);
    await h.u.add(piece(0));
    await flush();
    for (const ms of RETRY_DELAYS_MS) {
      expect(h.timers.map((t) => t.ms)).toEqual([ms]);
      expect(h.u.pending("m1")).toBe(1);
      h.timers.shift()!.f();
      await flush();
    }
    expect(h.timers).toEqual([]);
    expect(h.online).toHaveLength(1);
    expect(h.store.map.size).toBe(1);
    h.online[0]();
    await flush();
    expect(h.store.map.size).toBe(0);
    expect(h.sent).toHaveLength(6);
  });

  it("a kick cancels the wait and retries at once", async () => {
    const h = harness([503, 200]);
    await h.u.add(piece(0));
    await flush();
    expect(h.timers).toHaveLength(1);
    h.u.kick();
    await flush();
    expect(h.timers).toHaveLength(0);
    expect(h.store.map.size).toBe(0);
  });

  it("drops a 400 piece and goes on; a stop answer stops that meeting only", async () => {
    const h = harness([400, 404, 200]);
    await h.u.add(piece(0));
    await h.u.add(piece(1));
    await h.u.add(piece(2));
    await h.u.add(piece(0, { meeting: "m2" }));
    await flush();
    await flush();
    expect(h.stops).toEqual([["m1", 404]]);
    // m1/2 was forgotten unsent after the stop; m2's piece went.
    expect(h.sent).toEqual(["m1/av/000000", "m1/av/000001", "m2/av/000000"]);
    expect(h.store.map.size).toBe(0);
    await h.u.add(piece(3));
    expect(h.store.map.size).toBe(0);
  });

  it("loads left-overs oldest first, skipping the live meeting and those already queued", async () => {
    const h = harness([]);
    await h.store.put(piece(1, { at: 20 }));
    await h.store.put(piece(0, { at: 10 }));
    await h.store.put(piece(0, { meeting: "live", at: 5 }));
    const ms = await h.u.loadLeftovers("live");
    expect(ms).toEqual(["m1"]);
    await flush();
    await h.u.idle();
    expect(h.sent).toEqual(["m1/av/000000", "m1/av/000001"]);
    expect([...h.store.map.keys()]).toEqual(["live/av/000000"]);
    expect(await h.u.loadLeftovers()).toEqual(["live"]);
  });

  it("a failing store delete does not stop the queue", async () => {
    const h = harness([200]);
    h.store.delete = async () => {
      throw new Error("idb");
    };
    await h.u.add(piece(0));
    await flush();
    expect(h.u.count).toBe(0);
  });
});

describe("sendPiece", () => {
  it("PUTs raw bytes with the x-lk headers", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendPiece(piece(2, { track: "others", fragOff: 9, fragMs: 60_000.4 }), f)).toBe(
      201,
    );
    expect(seen!.url).toBe("/api/my/meetings/m1/chunks/others/2");
    const h = seen!.init.headers as Record<string, string>;
    expect(h["x-lk-start-ms"]).toBe("60000");
    expect(h["x-lk-frag-off"]).toBe("9");
    expect(h["x-lk-frag-ms"]).toBe("60000");
    await sendPiece(piece(0), f);
    expect((seen!.init.headers as Record<string, string>)["x-lk-frag-off"]).toBe("");
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await sendPiece(piece(0), broken)).toBeNull();
  });
});

describe("PCM hook", () => {
  it("48 kHz becomes 16 kHz with continuous offsets across frames", () => {
    const r = new Resampler(48_000);
    const ramp = (from: number, n: number) => Float32Array.from({ length: n }, (_, i) => from + i);
    const a = r.push(ramp(0, 480));
    expect(a.offset).toBe(0);
    expect(a.samples.length).toBe(160);
    expect(a.samples[1]).toBeCloseTo(3);
    const b = r.push(ramp(480, 480));
    expect(b.offset).toBe(160);
    expect(b.samples[0]).toBeCloseTo(480);
    expect(r.offset).toBe(320);
    expect(r.push(new Float32Array()).samples.length).toBe(0);
  });

  it("44.1 kHz interpolates across a frame boundary; a late start gets its offset", () => {
    const r = new Resampler(44_100, 44_100);
    expect(r.offset).toBe(PCM_RATE);
    const one = r.push(Float32Array.from({ length: 441 }, (_, i) => i));
    expect(one.offset).toBe(16_000);
    let total = one.samples.length;
    const two = r.push(Float32Array.from({ length: 441 }, (_, i) => 441 + i));
    total += two.samples.length;
    expect(total).toBe(320);
    expect(two.offset).toBe(16_000 + one.samples.length);
    // Each output sample sits at its input position: k * 44100/16000.
    const k = two.offset - 16_000;
    expect(two.samples[0]).toBeCloseTo((k * 44_100) / 16_000, 3);
  });

  it("mixes to mono; the hub survives a throwing listener", () => {
    const m = new Float32Array([1, 1]);
    expect(toMono([m])).toBe(m);
    expect([...toMono([new Float32Array([1, 0]), new Float32Array([0, 1])])]).toEqual([0.5, 0.5]);
    expect(toMono([]).length).toBe(0);
    const hub = new PcmHub();
    const got: number[] = [];
    const off = hub.on(() => {
      throw new Error("x");
    });
    hub.on((f) => got.push(f.offset));
    expect(hub.size).toBe(2);
    hub.emit({ track: "me", offset: 7, samples: new Float32Array(1) });
    off();
    expect(hub.size).toBe(1);
    expect(got).toEqual([7]);
  });
});

describe("clusterTimecode", () => {
  it("reads the Timecode of a WebM Cluster", () => {
    // Cluster id, unknown size (01 FF×7), Timecode E7 size 0x82 → 2 bytes: 0x7530 = 30000.
    const b = new Uint8Array([
      0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x82, 0x75,
      0x30,
    ]);
    expect(clusterTimecode(b, 0)).toBe(30_000);
    expect(
      clusterTimecode(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x81, 0xe7, 0x81, 0x05]), 0),
    ).toBe(5);
    expect(clusterTimecode(b, 1)).toBeNull();
    expect(clusterTimecode(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x00]), 0)).toBeNull();
    expect(clusterTimecode(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x81, 0xa3]), 0)).toBeNull();
    expect(
      clusterTimecode(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x81, 0xe7, 0x00]), 0),
    ).toBeNull();
    // A size that runs past the end.
    expect(
      clusterTimecode(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x81, 0xe7, 0x84, 0x01]), 0),
    ).toBeNull();
  });
});
